/****************************************************
 * TEMED — проверка пересечений сделок по типам назначений.
 *
 * Перед созданием новой сделки в воронке 114 ищем открытые
 * сделки того же пациента и сравниваем наборы типов услуг:
 *
 * пересечение пустое      → доназначение (обе сделки актуальны,
 *                           стадии не меняем, ставим комментарии);
 * пересечение непустое    → пересечение (новая сделка создаётся
 *                           в стадии «Пересечения», старая туда же
 *                           переводится, кроме стадий «Записался»
 *                           и «Запись по горящей акции»).
 *
 * Сделки не закрываются и не удаляются ни в каком сценарии —
 * решение принимает оператор по комментариям в таймлайне.
 ****************************************************/

const BITRIX_DEAL_STAGE_INTERSECTION = 'C114:UC_C7PDQC'; // стадия «Пересечения»

// Стадии, где сделка считается открытой для проверки:
const BITRIX_INTERSECTION_CHECK_STAGE_IDS = [
  'C114:UC_2ITBVA',        // Ожидание
  'C114:NEW',              // Связаться
  'C114:UC_712DNY',        // Для реанимации
  'C114:PREPARATION',      // В работе
  'C114:PREPAYMENT_INVOI', // Связаться позже
  'C114:UC_C3O5EH',        // Связаться по горящей акции
  'C114:UC_XR0QG1',        // Повторные касания. Не дозвоны
  'C114:EXECUTING',        // Записался
  'C114:UC_G5EXVL',        // Запись по горящей акции
  'C114:UC_C7PDQC'         // Пересечения
];
// «Не вышел на связь» (C114:UC_1GZCBR) и «Отказ» (C114:UC_8I6LEA) — транзитные:
// робот сразу переводит их в «Провал», сделки там не живут, в проверку не входят.

// Из этих стадий сделки НЕ переводятся в «Пересечения» (только комментарий):
const BITRIX_INTERSECTION_KEEP_STAGE_IDS = ['C114:EXECUTING', 'C114:UC_G5EXVL'];

// Консультация не считается пересечением, если в сделке есть другие услуги
// (та же логика, что в Deal_Status_Sync.gs).
const BITRIX_INTERSECTION_CONSULTATION_CODE = 'C';
const BITRIX_INTERSECTION_IGNORED_CODE = '-';

/**
 * Полный ответ Bitrix (result + next + total) — bitrixCall_ отдаёт только result
 * и не умеет пагинацию. Сигнатуру bitrixCall_ не меняем, чтобы не задеть
 * существующие вызовы.
 */
function bitrixCallFull_(method, payload) {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = props.getProperty('BITRIX_WEBHOOK_BASE_URL');

  if (!baseUrl) {
    throw new Error('Не задано свойство BITRIX_WEBHOOK_BASE_URL');
  }

  const url = baseUrl.replace(/\/+$/, '') + '/' + method + '.json';

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });

  const text = response.getContentText();
  let data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Bitrix вернул не JSON: ' + text);
  }

  if (data.error) {
    throw new Error(data.error + ': ' + (data.error_description || ''));
  }

  return data;
}

/**
 * Постраничная выгрузка списочного метода Bitrix по полю next.
 * extractItems — необязательный распаковщик result (например, result.items
 * у crm.stagehistory.list).
 */
function bitrixFetchAllPages_(method, payload, extractItems) {
  const items = [];
  let start = 0;
  let pages = 0;

  while (true) {
    const request = Object.assign({}, payload || {}, { start: start });
    const data = bitrixCallFull_(method, request);
    const raw = extractItems ? extractItems(data.result) : data.result;
    const page = Array.isArray(raw) ? raw : [];

    items.push.apply(items, page);
    pages += 1;

    if (!page.length || data.next === undefined || data.next === null) {
      break;
    }

    if (pages > 500) {
      throw new Error('Слишком много страниц в ответе Bitrix для метода ' + method + '.');
    }

    start = Number(data.next);
  }

  return items;
}

function getBitrixPortalUrl_() {
  const baseUrl = String(
    PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK_BASE_URL') || ''
  ).trim();
  const match = /^(https?:\/\/[^\/]+)/i.exec(baseUrl);

  return match ? match[1] : '';
}

function buildBitrixDealReference_(dealId, title) {
  const text = '#' + dealId + (title ? ' «' + title + '»' : '');
  const portalUrl = getBitrixPortalUrl_();

  if (!portalUrl) {
    return text;
  }

  return '[URL=' + portalUrl + '/crm/deal/details/' + dealId + '/]' + text + '[/URL]';
}

/**
 * Набор типов услуг для сравнения: только допустимые коды, без «-»;
 * если типов больше одного — консультация C из сравнения исключается.
 */
function normalizeIntersectionTypeCodes_(value) {
  const codes = new Set();

  String(value === null || value === undefined ? '' : value)
    .toUpperCase()
    .split('')
    .forEach(code => {
      if (APPOINTMENT_TYPE_CODE_SET.has(code) && code !== BITRIX_INTERSECTION_IGNORED_CODE) {
        codes.add(code);
      }
    });

  if (codes.size > 1) {
    codes.delete(BITRIX_INTERSECTION_CONSULTATION_CODE);
  }

  return codes;
}

function formatIntersectionTypeCodes_(codes) {
  const set = codes instanceof Set ? codes : new Set(codes || []);

  return APPOINTMENT_TYPE_CODE_ORDER.filter(code => set.has(code)).join('');
}

function intersectIntersectionTypeCodes_(newCodes, oldCodes) {
  const overlap = new Set();

  newCodes.forEach(code => {
    if (oldCodes.has(code)) {
      overlap.add(code);
    }
  });

  return overlap;
}

/**
 * Классификация одной найденной сделки относительно новой.
 * Возвращает { category: 'intersection' | 'addition', overlap: Set }.
 */
function classifyDealIntersection_(newCodes, oldCodes) {
  const overlap = intersectIntersectionTypeCodes_(newCodes, oldCodes);

  return {
    category: overlap.size ? 'intersection' : 'addition',
    overlap: overlap
  };
}

function findOpenPatientDealsForIntersection_(patientCode) {
  const filter = {
    CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID,
    STAGE_ID: BITRIX_INTERSECTION_CHECK_STAGE_IDS
  };
  filter[BITRIX_DEAL_PATIENT_CODE_FIELD] = patientCode;

  return bitrixFetchAllPages_('crm.deal.list', {
    filter: filter,
    select: ['ID', 'TITLE', 'STAGE_ID', BITRIX_DEAL_TYPES_FIELD],
    order: { ID: 'ASC' }
  });
}

/**
 * Проверка пересечений перед созданием сделки.
 * Ошибка поиска не блокирует создание: возвращаем стандартную стадию
 * и текст предупреждения для колонки «Ошибка».
 */
function prepareDealIntersectionCheck_(row) {
  const result = {
    checked: false,
    overrideStageId: '',
    newTypeCodes: '',
    intersections: [],
    additions: [],
    warnings: []
  };

  const patientCode = normalizePatientCodeForBitrix_(row['Пациент.Код']);
  const newTypeCodesRaw = mergeAppointmentTypeCodes_([row['Типы назначений'] || '']);
  const newCodes = normalizeIntersectionTypeCodes_(newTypeCodesRaw);

  if (!patientCode || !newCodes.size) {
    return result;
  }

  result.newTypeCodes = formatIntersectionTypeCodes_(newCodes);

  let deals;

  try {
    deals = findOpenPatientDealsForIntersection_(patientCode);
  } catch (err) {
    const errorText = err && err.message ? err.message : String(err);
    result.warnings.push(
      'Не удалось проверить пересечения по коду пациента ' + patientCode +
      ': ' + errorText + '. Сделка создана в обычной стадии.'
    );
    return result;
  }

  result.checked = true;

  deals.forEach(deal => {
    const oldCodes = normalizeIntersectionTypeCodes_(deal[BITRIX_DEAL_TYPES_FIELD]);
    const classified = classifyDealIntersection_(newCodes, oldCodes);
    const item = {
      dealId: String(deal.ID || ''),
      title: String(deal.TITLE || ''),
      stageId: String(deal.STAGE_ID || ''),
      typeCodes: formatIntersectionTypeCodes_(oldCodes),
      overlap: formatIntersectionTypeCodes_(classified.overlap)
    };

    if (classified.category === 'intersection') {
      result.intersections.push(item);
    } else {
      result.additions.push(item);
    }
  });

  if (result.intersections.length) {
    result.overrideStageId = BITRIX_DEAL_STAGE_INTERSECTION;
  }

  return result;
}

/**
 * Комментарии и перевод стадий после успешного создания сделки.
 * Возвращает массив предупреждений — их дописываем в колонку «Ошибка».
 */
function applyDealIntersectionOutcome_(check, newDealId, newDealTitle) {
  const warnings = [];

  if (!check || !newDealId) {
    return warnings;
  }

  const newReference = buildBitrixDealReference_(newDealId, newDealTitle);
  const newTypes = check.newTypeCodes;

  check.additions.forEach(item => {
    const oldReference = buildBitrixDealReference_(item.dealId, item.title);

    addIntersectionComment_(
      item.dealId,
      'Создано доназначение: сделка ' + newReference + ', типы: ' + newTypes +
      '. Типы текущей сделки (' + item.typeCodes + ') не пересекаются — обе сделки актуальны.',
      warnings
    );

    addIntersectionComment_(
      newDealId,
      'У пациента есть активная сделка ' + oldReference + ', типы: ' + item.typeCodes +
      '. Пересечений с текущей сделкой нет — это доназначение.',
      warnings
    );
  });

  check.intersections.forEach(item => {
    const oldReference = buildBitrixDealReference_(item.dealId, item.title);

    addIntersectionComment_(
      item.dealId,
      'ПЕРЕСЕЧЕНИЕ: ' + newReference + ', типы: ' + newTypes +
      '. Совпадающие типы: ' + item.overlap +
      '. Решите: объединить сделки или одну перевести в неактуальные.',
      warnings
    );

    addIntersectionComment_(
      newDealId,
      'ПЕРЕСЕЧЕНИЕ: ' + oldReference + ', типы: ' + item.typeCodes +
      '. Совпадающие типы: ' + item.overlap +
      '. Решите: объединить сделки или одну перевести в неактуальные.',
      warnings
    );

    moveDealToIntersectionStage_(item, warnings);
  });

  return warnings;
}

function addIntersectionComment_(dealId, text, warnings) {
  try {
    addBitrixDealComment_(dealId, text);
  } catch (err) {
    const errorText = err && err.message ? err.message : String(err);
    warnings.push('Не удалось добавить комментарий о пересечении в сделку #' + dealId + ': ' + errorText);
  }
}

function moveDealToIntersectionStage_(item, warnings) {
  if (BITRIX_INTERSECTION_KEEP_STAGE_IDS.indexOf(item.stageId) !== -1) {
    return;
  }

  if (item.stageId === BITRIX_DEAL_STAGE_INTERSECTION) {
    return;
  }

  try {
    bitrixCall_('crm.deal.update', {
      id: item.dealId,
      fields: { STAGE_ID: BITRIX_DEAL_STAGE_INTERSECTION }
    });
  } catch (err) {
    const errorText = err && err.message ? err.message : String(err);
    warnings.push(
      'Не удалось перевести сделку #' + item.dealId + ' в стадию «Пересечения»: ' + errorText
    );
  }
}


function testDealIntersectionClassification_() {
  const assert = function(condition, message) {
    if (!condition) {
      throw new Error('Проверка пересечений не пройдена: ' + message);
    }
  };

  const normalizationChecks = [
    { name: 'обычный набор', value: 'ML', expected: 'LM' },
    { name: 'порядок кодов', value: 'FLM', expected: 'LMF' },
    { name: 'игнор «-»', value: 'L-M', expected: 'LM' },
    { name: 'только «-»', value: '-', expected: '' },
    { name: 'C отбрасывается при других услугах', value: 'LC', expected: 'L' },
    { name: 'одна консультация сохраняется', value: 'C', expected: 'C' },
    { name: 'консультация с «-»', value: 'C-', expected: 'C' },
    { name: 'нижний регистр', value: 'ml', expected: 'LM' },
    { name: 'мусорные символы', value: 'L, M; X', expected: 'LM' },
    { name: 'пустое значение', value: '', expected: '' }
  ];

  normalizationChecks.forEach(check => {
    const actual = formatIntersectionTypeCodes_(normalizeIntersectionTypeCodes_(check.value));
    assert(
      actual === check.expected,
      'нормализация «' + check.name + '»: ожидалось "' + check.expected + '", получено "' + actual + '".'
    );
  });

  const classificationChecks = [
    { name: 'ML и F — доназначение', oldValue: 'ML', newValue: 'F', category: 'addition', overlap: '' },
    { name: 'ML и MF — пересечение по M', oldValue: 'ML', newValue: 'MF', category: 'intersection', overlap: 'M' },
    { name: 'ML и LM — полное пересечение', oldValue: 'ML', newValue: 'LM', category: 'intersection', overlap: 'LM' },
    { name: 'C и LC — консультация не считается', oldValue: 'C', newValue: 'LC', category: 'addition', overlap: '' },
    { name: 'C и C — одна консультация пересекается', oldValue: 'C', newValue: 'C', category: 'intersection', overlap: 'C' },
    { name: 'L- и -L — «-» игнорируется', oldValue: 'L-', newValue: '-L', category: 'intersection', overlap: 'L' }
  ];

  classificationChecks.forEach(check => {
    const oldCodes = normalizeIntersectionTypeCodes_(check.oldValue);
    const newCodes = normalizeIntersectionTypeCodes_(check.newValue);
    const classified = classifyDealIntersection_(newCodes, oldCodes);
    const overlap = formatIntersectionTypeCodes_(classified.overlap);

    assert(
      classified.category === check.category,
      'классификация «' + check.name + '»: ожидалось "' + check.category +
      '", получено "' + classified.category + '".'
    );
    assert(
      overlap === check.overlap,
      'совпадающие типы «' + check.name + '»: ожидалось "' + check.overlap +
      '", получено "' + overlap + '".'
    );
  });

  const keepStageChecks = [
    { stageId: 'C114:EXECUTING', shouldMove: false },
    { stageId: 'C114:UC_G5EXVL', shouldMove: false },
    { stageId: BITRIX_DEAL_STAGE_INTERSECTION, shouldMove: false },
    { stageId: 'C114:NEW', shouldMove: true },
    { stageId: 'C114:UC_2ITBVA', shouldMove: true }
  ];

  keepStageChecks.forEach(check => {
    const shouldMove = BITRIX_INTERSECTION_KEEP_STAGE_IDS.indexOf(check.stageId) === -1 &&
      check.stageId !== BITRIX_DEAL_STAGE_INTERSECTION;

    assert(
      shouldMove === check.shouldMove,
      'перевод стадии ' + check.stageId + ': ожидалось ' + check.shouldMove + ', получено ' + shouldMove + '.'
    );
  });

  return 'Проверки пересечений сделок пройдены: ' +
    (normalizationChecks.length + classificationChecks.length + keepStageChecks.length);
}

/****************************************************
 * Проверка пересечений сделок по типам назначений
 *
 * Перед созданием новой сделки в воронке 114 проверяем открытые
 * сделки того же пациента. Если типы услуг пересекаются — новая
 * сделка попадает в стадию «Пересечения», а найденные сделки (кроме
 * записанных) переводятся туда же. Если типы не пересекаются — это
 * доназначение: обе сделки остаются актуальными, добавляются только
 * комментарии.
 *
 * Переиспользуются константы и хелперы из Code.gs:
 *   BITRIX_DEAL_CATEGORY_ID, BITRIX_DEAL_TYPES_FIELD,
 *   BITRIX_DEAL_PATIENT_CODE_FIELD, APPOINTMENT_TYPE_CODE_ORDER,
 *   APPOINTMENT_TYPE_CODE_SET, mergeAppointmentTypeCodes_,
 *   normalizePatientCodeForBitrix_, buildBitrixDealTitle_,
 *   addBitrixDealComment_, bitrixCall_.
 ****************************************************/

// Стадия «Пересечения» в воронке 114.
const BITRIX_DEAL_STAGE_INTERSECTION = 'C114:UC_C7PDQC';

// Стадии, где сделка считается открытой для проверки пересечений.
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
  'C114:UC_1GZCBR',        // Не вышел на связь
  'C114:UC_C7PDQC'         // Пересечения
];

// Из этих стадий сделки НЕ переводятся в «Пересечения» (только комментарий).
const BITRIX_INTERSECTION_KEEP_STAGE_IDS = ['C114:EXECUTING', 'C114:UC_G5EXVL'];

/**
 * Нормализует строку кодов типов в множество для сравнения:
 * оставляет только допустимые коды, исключая '-'; если типов больше
 * одного — убирает 'C' (консультация не считается пересечением при
 * наличии других услуг). Та же логика, что и в Deal_Status_Sync.gs.
 */
function normalizeIntersectionTypeSet_(rawTypes) {
  const set = new Set();
  String(rawTypes || '').toUpperCase().split('').forEach(code => {
    if (APPOINTMENT_TYPE_CODE_SET.has(code) && code !== '-') set.add(code);
  });
  if (set.size > 1) set.delete('C');
  return set;
}

/**
 * Сортирует коды типов из множества по каноническому порядку
 * APPOINTMENT_TYPE_CODE_ORDER и склеивает в строку для вывода.
 */
function sortIntersectionTypeCodes_(set) {
  return APPOINTMENT_TYPE_CODE_ORDER.filter(code => set.has(code)).join('');
}

/**
 * Классифицирует отношение новой сделки к найденной по пересечению
 * множеств типов: пустое пересечение — «доназначение», непустое —
 * «пересечение».
 */
function classifyDealIntersection_(newSet, otherSet) {
  const overlap = new Set();
  newSet.forEach(code => { if (otherSet.has(code)) overlap.add(code); });
  return {
    category: overlap.size ? 'intersection' : 'addon',
    overlap: overlap
  };
}

/**
 * Получает список сделок Bitrix через crm.deal.list с пагинацией по
 * `next`. Отдельный запрос по образцу bitrixCall_, чтобы не менять его
 * сигнатуру (в bitrixCall_ пагинации нет).
 */
function bitrixDealListPaginated_(filter, select) {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = props.getProperty('BITRIX_WEBHOOK_BASE_URL');

  if (!baseUrl) {
    throw new Error('Не задано свойство BITRIX_WEBHOOK_BASE_URL');
  }

  const url = baseUrl.replace(/\/+$/, '') + '/crm.deal.list.json';
  const results = [];
  let start = 0;

  while (true) {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ filter: filter, select: select, start: start }),
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

    const batch = Array.isArray(data.result) ? data.result : [];
    results.push.apply(results, batch);

    if (typeof data.next === 'number' && batch.length) {
      start = data.next;
    } else {
      break;
    }
  }

  return results;
}

/**
 * Проверяет пересечения новой сделки (строка листа) с открытыми
 * сделками того же пациента.
 *
 * Всегда возвращает объект:
 *   {
 *     overrideStageId: string|null, // стадия «Пересечения» либо null
 *     newTypeSet: Set|null,         // нормализованные типы новой сделки
 *     matches: Array,               // [{ deal, category, overlap, otherSet }]
 *     warnings: string[]            // предупреждения для колонки «Ошибка»
 *   }
 *
 * Ошибка поиска не блокирует создание сделки: логируется и попадает в
 * warnings, сделка создаётся в обычной стадии (matches остаётся пустым).
 */
function checkPatientDealIntersections_(row) {
  const result = { overrideStageId: null, newTypeSet: null, matches: [], warnings: [] };

  const patientCode = normalizePatientCodeForBitrix_(row['Пациент.Код']);
  const newTypes = mergeAppointmentTypeCodes_([row['Типы назначений'] || '']);

  if (!patientCode || !newTypes) {
    return result;
  }

  const newSet = normalizeIntersectionTypeSet_(newTypes);
  result.newTypeSet = newSet;

  if (!newSet.size) {
    return result;
  }

  let deals;
  try {
    const filter = { CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID, STAGE_ID: BITRIX_INTERSECTION_CHECK_STAGE_IDS };
    filter[BITRIX_DEAL_PATIENT_CODE_FIELD] = patientCode;
    deals = bitrixDealListPaginated_(filter, ['ID', 'TITLE', 'STAGE_ID', BITRIX_DEAL_TYPES_FIELD]);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    Logger.log('Ошибка поиска пересечений сделок пациента ' + patientCode + ': ' + message);
    result.warnings.push('Проверка пересечений не выполнена, сделка создана в обычной стадии: ' + message);
    return result;
  }

  let hasIntersection = false;
  deals.forEach(deal => {
    const otherSet = normalizeIntersectionTypeSet_(deal[BITRIX_DEAL_TYPES_FIELD]);
    const classified = classifyDealIntersection_(newSet, otherSet);
    result.matches.push({
      deal: deal,
      category: classified.category,
      overlap: classified.overlap,
      otherSet: otherSet
    });
    if (classified.category === 'intersection') hasIntersection = true;
  });

  if (hasIntersection) {
    result.overrideStageId = BITRIX_DEAL_STAGE_INTERSECTION;
  }

  return result;
}

/**
 * Текстовая ссылка на сделку для комментария таймлайна.
 */
function formatIntersectionDealReference_(dealId, title, types) {
  return 'сделка #' + dealId + ' «' + String(title || '') + '», типы: ' + types;
}

/**
 * После успешного создания новой сделки выполняет действия по найденным
 * пересечениям: комментарии в старые и новую сделки, перевод старых
 * пересекающихся сделок в стадию «Пересечения».
 *
 * Ошибки комментариев и обновлений не роняют процесс: собираются в
 * массив предупреждений и возвращаются для колонки «Ошибка».
 */
function applyPatientDealIntersectionOutcomes_(newDealId, row, intersection) {
  const warnings = [];

  if (!newDealId || !intersection || !intersection.matches.length) {
    return warnings;
  }

  const newTitle = buildBitrixDealTitle_(row);
  const newTypes = sortIntersectionTypeCodes_(intersection.newTypeSet);

  const addComment = function(dealId, text, context) {
    try {
      addBitrixDealComment_(dealId, text);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      warnings.push('Не удалось добавить комментарий ' + context + ' (сделка #' + dealId + '): ' + message);
    }
  };

  intersection.matches.forEach(match => {
    const oldId = match.deal.ID;
    const oldTitle = String(match.deal.TITLE || '');
    const oldTypes = sortIntersectionTypeCodes_(match.otherSet);

    if (match.category === 'addon') {
      addComment(
        oldId,
        'Создано доназначение: сделка #' + newDealId + ' «' + newTitle + '», типы: ' + newTypes +
        '. Типы текущей сделки (' + oldTypes + ') не пересекаются — обе сделки актуальны.',
        'о доназначении в старую сделку'
      );
      addComment(
        newDealId,
        'У пациента есть активная сделка #' + oldId + ' «' + oldTitle + '», типы: ' + oldTypes +
        '. Пересечений с текущей сделкой нет — это доназначение.',
        'о доназначении в новую сделку'
      );
      return;
    }

    // Категория «пересечение».
    const overlap = sortIntersectionTypeCodes_(match.overlap);

    addComment(
      oldId,
      'ПЕРЕСЕЧЕНИЕ: ' + formatIntersectionDealReference_(newDealId, newTitle, newTypes) +
      '. Совпадающие типы: ' + overlap + '. Решите: объединить сделки или одну перевести в неактуальные.',
      'о пересечении в старую сделку'
    );
    addComment(
      newDealId,
      'ПЕРЕСЕЧЕНИЕ: ' + formatIntersectionDealReference_(oldId, oldTitle, oldTypes) +
      '. Совпадающие типы: ' + overlap + '. Решите: объединить сделки или одну перевести в неактуальные.',
      'о пересечении в новую сделку'
    );

    const oldStage = String(match.deal.STAGE_ID || '');
    const keepStage = BITRIX_INTERSECTION_KEEP_STAGE_IDS.indexOf(oldStage) !== -1;

    if (!keepStage && oldStage !== BITRIX_DEAL_STAGE_INTERSECTION) {
      try {
        bitrixCall_('crm.deal.update', {
          id: oldId,
          fields: { STAGE_ID: BITRIX_DEAL_STAGE_INTERSECTION }
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        warnings.push('Не удалось перевести сделку #' + oldId + ' в стадию «Пересечения»: ' + message);
      }
    }
  });

  return warnings;
}

/****************************************************
 * Разовая миграция стадии FINAL_INVOICE → WON (воронка 114)
 ****************************************************/

const BITRIX_DEAL_STAGE_FINAL_INVOICE = 'C114:FINAL_INVOICE';
const BITRIX_DEAL_STAGE_WON = 'C114:WON';

/**
 * Переводит все сделки воронки 114 из стадии «Дошёл» C114:FINAL_INVOICE
 * (удаляемый дубликат) в C114:WON. Ручной запуск с подтверждением.
 */
function migrateFinalInvoiceToWon() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Миграция стадии «Дошёл»',
    'Все сделки воронки 114 из стадии ' + BITRIX_DEAL_STAGE_FINAL_INVOICE +
    ' будут переведены в ' + BITRIX_DEAL_STAGE_WON + '. Продолжить?',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    ui.alert('Миграция отменена.');
    return;
  }

  let migrated = 0;
  let errors = 0;

  while (true) {
    const deals = bitrixCall_('crm.deal.list', {
      filter: { CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID, STAGE_ID: BITRIX_DEAL_STAGE_FINAL_INVOICE },
      select: ['ID'],
      start: 0
    });

    if (!Array.isArray(deals) || !deals.length) {
      break;
    }

    let movedInPass = 0;
    deals.forEach(deal => {
      try {
        bitrixCall_('crm.deal.update', {
          id: deal.ID,
          fields: { STAGE_ID: BITRIX_DEAL_STAGE_WON }
        });
        migrated += 1;
        movedInPass += 1;
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        Logger.log('Ошибка перевода сделки #' + deal.ID + ' в ' + BITRIX_DEAL_STAGE_WON + ': ' + message);
        errors += 1;
      }
    });

    // Защита от бесконечного цикла: если за проход ничего не переведено
    // (например, все сделки прохода дали ошибку) — прерываем.
    if (!movedInPass) {
      break;
    }
  }

  ui.alert('Миграция завершена. Переведено: ' + migrated + ', ошибок: ' + errors + '.');
}

/****************************************************
 * Тесты чистых функций (без обращений к Bitrix)
 ****************************************************/

function testDealIntersectionClassification_() {
  const assertEqual = (actual, expected, message) => {
    if (actual !== expected) {
      throw new Error(message + ' Ожидалось: ' + expected + ', получено: ' + actual + '.');
    }
  };
  const assertTrue = (actual, message) => { if (!actual) throw new Error(message); };

  // Нормализация типов: '-' игнорируется, 'C' убирается при наличии других услуг.
  assertEqual(sortIntersectionTypeCodes_(normalizeIntersectionTypeSet_('ML')), 'LM',
    'Нормализация ML должна давать LM в каноническом порядке.');
  assertEqual(sortIntersectionTypeCodes_(normalizeIntersectionTypeSet_('L-M')), 'LM',
    'Символ «-» должен игнорироваться.');
  assertEqual(sortIntersectionTypeCodes_(normalizeIntersectionTypeSet_('LC')), 'L',
    'При наличии других услуг тип C должен убираться.');
  assertEqual(sortIntersectionTypeCodes_(normalizeIntersectionTypeSet_('C')), 'C',
    'Единственный тип C должен сохраняться.');
  assertEqual(normalizeIntersectionTypeSet_('-').size, 0,
    'Только «-» должен давать пустое множество.');
  assertEqual(normalizeIntersectionTypeSet_('').size, 0,
    'Пустая строка должна давать пустое множество.');

  const classify = (newTypes, otherTypes) =>
    classifyDealIntersection_(normalizeIntersectionTypeSet_(newTypes), normalizeIntersectionTypeSet_(otherTypes));

  // Открытая ML, новая F → доназначение (пересечений нет).
  let r = classify('F', 'ML');
  assertEqual(r.category, 'addon', 'ML и F не должны пересекаться (доназначение).');
  assertEqual(r.overlap.size, 0, 'Пересечение ML и F должно быть пустым.');

  // Открытая ML, новая MF → пересечение по M.
  r = classify('MF', 'ML');
  assertEqual(r.category, 'intersection', 'ML и MF должны пересекаться.');
  assertEqual(sortIntersectionTypeCodes_(r.overlap), 'M', 'Совпадающий тип должен быть M.');

  // Старая C, новая LC → C игнорируется в новой (остаётся L), пересечения нет.
  r = classify('LC', 'C');
  assertEqual(r.category, 'addon', 'C (одиночная) и LC (→L) не должны пересекаться.');
  assertEqual(r.overlap.size, 0, 'Пересечение C и LC должно быть пустым (C игнорируется).');

  // Полное совпадение.
  r = classify('ML', 'ML');
  assertEqual(r.category, 'intersection', 'Одинаковые типы должны пересекаться.');
  assertEqual(sortIntersectionTypeCodes_(r.overlap), 'LM', 'Пересечение ML и ML должно быть LM.');

  assertTrue(true, 'Проверки классификации пересечений пройдены.');
  return 'Проверки классификации пересечений сделок пройдены.';
}

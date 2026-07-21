/****************************************************
 * TEMED — пошаговая сверка сделок Bitrix с заявками.
 * Каждый публичный этап запускается только вручную из меню.
 *
 * Для заявок с кабинетами ФТЛ и магнитотерапии тип
 * определяется по кабинету независимо от номенклатуры:
 *
 * ФТЛ    → L
 * Магнит → S
 *
 * Для остальных заявок тип определяется по общему
 * справочнику номенклатуры.
 *
 * Филиал заявки при сопоставлении со сделкой не проверяется.
 ****************************************************/

const DSS_CONFIG = Object.freeze({
  timezone: 'Europe/Moscow',
  sheets: {
    requests: 'Заявки',
    registry: 'Реестр отправки Bitrix',
    aggregated: 'Заявки агрегированные',
    deals: 'Сделки Bitrix',
    actualization: 'Актуализация сделок',
    log: 'Журнал статусов Bitrix',
    stages: 'Стадии Bitrix'
  },
  categoryId: 114,
  requestColumns: { patientCode: 'КлиентКод', patientName: 'Клиент', startDate: 'ДатаНачала', state: 'Состояние', nomenclature: 'НоменклатураНаименование', cabinet: 'Кабинет' },
  stageNames: { booked: 'Записался', attended: 'Дошёл' },
  ignoredCode: '-', consultationCode: 'C', serviceCodeOrder: 'LMSFCDUP', batchSize: 50,
  doneStates: ['Начато', 'Выполнена', 'Выполнено', 'Завершена', 'Завершено', 'Оказана', 'Оказано', 'Прием состоялся', 'Приём состоялся', 'Состоялась', 'Состоялся'],
  plannedStates: ['Запланирована', 'Запланировано', 'Подтвердил запись', 'Подтверждена', 'Подтверждено', 'Записан', 'Записана', 'Недозвон. Отправить смс'],
  cancelledMarkers: ['отменена', 'отменено', 'отменен', 'отменён', 'отказ', 'не состоялась', 'не состоялся', 'неявка', 'не явился', 'не явилась', 'удалена', 'удалено']
});

const DSS_TYPE_CODES_SPREADSHEET_ID =
  '1Q1iPI7z4DteweJT1lg5lyO35AwBU5NtxANIUjSyd1-M';
const DSS_TYPE_CODES_SHEET_NAME =
  'Коды типов назначений';
const DSS_DEAL_TYPE_CODES_FIELD =
  'UF_CRM_1784225678';
const DSS_DEAL_APPOINTMENT_DATE_FIELD =
  'UF_CRM_1784267448';
const DSS_ALLOWED_TYPE_CODES = [
  'L', 'M', 'S', 'F', 'C', 'D', 'U', 'P', '-'
];
const DSS_REQUEST_HEADERS = ['КлиентКод', 'Пациент', 'Дата', 'Запланированы', 'Выполнены', 'Дата обработки'];
const DSS_DEAL_HEADERS = ['ID сделки', 'Название', 'ФИО пациента', 'CATEGORY_ID', 'Текущая стадия ID', 'Текущая стадия', 'Код пациента', 'Сумма сделки', 'Дата создания сделки', 'Дата назначения', 'Первый день лечения', 'Состав назначения', 'Типы назначений', 'Дата загрузки', 'Ошибка данных'];
const DSS_ACTUALIZATION_HEADERS = ['Отправить', 'ID сделки', 'Название сделки', 'Код пациента', 'Дата назначения', 'Первый день лечения', 'Типы назначений', 'Найденные запланированные типы', 'Найденные выполненные типы', 'Текущая стадия ID', 'Текущая стадия', 'Предлагаемая стадия ID', 'Предлагаемая стадия', 'Результат проверки', 'Причина', 'Дата загрузки сделок', 'Дата обработки заявок', 'Дата актуализации', 'Статус отправки', 'Ошибка отправки'];
const DSS_STAGE_HEADERS = ['Название стадии', 'Код стадии'];

function onOpen(e) { DSS_addDealStatusSyncMenu_(); }
function DSS_addDealStatusSyncMenu_() {
  SpreadsheetApp.getUi().createMenu('Сверка сделок Bitrix')
    .addItem('Инициализировать служебные листы', 'initializeBitrixDealStageSync').addSeparator()
    .addItem('1. Обработать заявки', 'DSS_processRequests')
    .addItem('2. Загрузить сделки из Bitrix', 'DSS_loadDealsFromBitrix')
    .addItem('3. Актуализировать сделки по заявкам', 'DSS_actualizeDeals').addSeparator()
    .addItem('Загрузить стадии Bitrix', 'DSS_loadStagesFromBitrix')
    .addItem('4. Отправить изменения в Bitrix', 'DSS_sendChangesToBitrixWithConfirmation').addToUi();
}

function initializeBitrixDealStageSync() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  DSS_prepareSheet_(ss, DSS_CONFIG.sheets.aggregated, DSS_REQUEST_HEADERS);
  DSS_prepareSheet_(ss, DSS_CONFIG.sheets.deals, DSS_DEAL_HEADERS);
  DSS_prepareSheet_(ss, DSS_CONFIG.sheets.actualization, DSS_ACTUALIZATION_HEADERS);
  DSS_ensureLogSheet_(ss);
  SpreadsheetApp.getActive().toast('Служебные листы созданы.', 'Сверка сделок Bitrix', 5);
}

function DSS_processRequests() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const requests = DSS_readObjects_(DSS_requiredSheet_(ss, DSS_CONFIG.sheets.requests));
  let directory;
  try { directory = DSS_readSharedTypeCodesMap_(); }
  catch (e) { DSS_alert_('Обработка заявок остановлена', DSS_safeError_(e)); return; }

  const nomenclatures = new Map();
  requests.forEach(row => {
    const cabinet = String(row[DSS_CONFIG.requestColumns.cabinet] || '').trim();
    const cabinetTypeCode = DSS_serviceCodeByCabinet_(cabinet);
    if (cabinetTypeCode) return;

    const name = String(row[DSS_CONFIG.requestColumns.nomenclature] || '').trim();
    const key = DSS_normalizeTypeNomenclature_(name);
    if (key && !nomenclatures.has(key)) nomenclatures.set(key, name);
  });
  let added = 0;
  try { added = DSS_appendMissingSharedTypeCodes_(directory, nomenclatures); }
  catch (e) { DSS_alert_('Обработка заявок остановлена', DSS_safeError_(e)); return; }
  // Re-read after writing so concurrent additions and current types are evaluated consistently.
  try { directory = DSS_readSharedTypeCodesMap_(); }
  catch (e) { DSS_alert_('Обработка заявок остановлена', DSS_safeError_(e)); return; }
  let empty = 0, invalid = 0;
  nomenclatures.forEach((name, key) => {
    const type = directory.map.get(key);
    if (!type) empty += 1;
    else if (DSS_ALLOWED_TYPE_CODES.indexOf(type) === -1) invalid += 1;
  });
  if (added || empty || invalid) {
    DSS_alert_('Обработка заявок остановлена', DSS_incompleteTypeCodesMessage_(added, empty, invalid));
    return;
  }

  const now = new Date(), groups = new Map(); let excluded = 0, byCabinetFtl = 0, byCabinetMagnet = 0, byDirectory = 0;
  requests.forEach(row => {
    const code = DSS_patientCode_(row[DSS_CONFIG.requestColumns.patientCode]);
    const date = DSS_date_(row[DSS_CONFIG.requestColumns.startDate]);
    const name = String(row[DSS_CONFIG.requestColumns.nomenclature] || '').trim();
    const cabinet = String(row[DSS_CONFIG.requestColumns.cabinet] || '').trim();
    const cabinetTypeCode = DSS_serviceCodeByCabinet_(cabinet);
    const state = DSS_requestState_(row[DSS_CONFIG.requestColumns.state]);
    if (state === 'CANCEL') { excluded += 1; return; }
    if (!code || !date || !state) return;
    if (!cabinetTypeCode && !name) return;

    // Для ФТЛ и магнитотерапии кабинет является
    // приоритетным источником типа. Номенклатура,
    // включая тип "-", в этих случаях игнорируется.
    const nomenclatureTypeCode = directory.map.get(DSS_normalizeTypeNomenclature_(name));
    const typeCode = cabinetTypeCode || nomenclatureTypeCode;
    if (!typeCode || typeCode === DSS_CONFIG.ignoredCode) return;
    if (cabinetTypeCode) {
      if (cabinetTypeCode === 'L') byCabinetFtl += 1;
      else if (cabinetTypeCode === 'S') byCabinetMagnet += 1;
      if (nomenclatureTypeCode && nomenclatureTypeCode !== cabinetTypeCode) {
        Logger.log('Заявка пациента ' + code + ': кабинет «' + cabinet + '» определил тип ' + cabinetTypeCode + '; тип номенклатуры «' + nomenclatureTypeCode + '» проигнорирован.');
      }
    } else {
      byDirectory += 1;
    }
    const key = code + '|' + DSS_iso_(date);
    if (!groups.has(key)) groups.set(key, { code, patient: String(row[DSS_CONFIG.requestColumns.patientName] || '').trim(), date, planned: new Set(), done: new Set() });
    groups.get(key)[state === 'DONE' ? 'done' : 'planned'].add(typeCode);
  });
  const rows = Array.from(groups.values()).sort((a,b) => a.code.localeCompare(b.code) || a.date - b.date).map(x => [x.code, x.patient, x.date, DSS_codes_(x.planned), DSS_codes_(x.done), now]);
  DSS_writeSheet_(ss, DSS_CONFIG.sheets.aggregated, DSS_REQUEST_HEADERS, rows, { dates: [3], dateTimes: [6] });
  DSS_log_(ss, 'Обработка заявок', now);
  DSS_alert_('Обработка заявок завершена.', ['Строк исходного листа обработано: ' + requests.length + '.', 'Агрегированных строк создано: ' + rows.length + '.', 'Отменённых строк исключено: ' + excluded + '.', 'Определено по кабинету ФТЛ: ' + byCabinetFtl + '.', 'Определено по кабинету магнитотерапии: ' + byCabinetMagnet + '.', 'Определено по справочнику номенклатуры: ' + byDirectory + '.'].join('\n'));
}
function DSS_loadDealsFromBitrix() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const now = new Date(); const base = DSS_webhook_();
  // Patient code is deliberately read only from this explicit Bitrix field.
  const raw = DSS_list_(base, 'crm.deal.list', {
    order: { ID: 'ASC' },
    filter: { CATEGORY_ID: DSS_CONFIG.categoryId },
    select: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'DATE_CREATE', 'UF_CRM_1737550182812', 'UF_CRM_1783751141', DSS_DEAL_APPOINTMENT_DATE_FIELD, 'UF_CRM_1783751996', 'UF_CRM_1783752197', DSS_DEAL_TYPE_CODES_FIELD]
  });
  const categoryId = Number(DSS_CONFIG.categoryId);
  const deals = raw.filter(item => Number(item.CATEGORY_ID || 0) === categoryId);
  const unexpectedDeals = raw.length - deals.length;
  if (unexpectedDeals) Logger.log('Bitrix вернул сделки вне CATEGORY_ID ' + categoryId + ': ' + unexpectedDeals + '.');
  const stages = DSS_stageDirectory_(base, deals); let noPatient = 0; let incomplete = 0;
  const rows = deals.map(item => {
    const id = String(item.ID || ''); const firstTreatment = DSS_date_(item.UF_CRM_1783751996); const appointmentDate = DSS_date_(item[DSS_DEAL_APPOINTMENT_DATE_FIELD]); const createdAt = DSS_date_(item.DATE_CREATE);
    const title = String(item.TITLE || ''); const patientName = String(item.UF_CRM_1737550182812 || '').trim();
    const patient = DSS_normalizePatientCode_(item.UF_CRM_1783751141);
    const rawTypeCodes = String(item[DSS_DEAL_TYPE_CODES_FIELD] || '').replace(/\s+/g, ''); const codes = DSS_normalizeDealTypeCodes_(rawTypeCodes);
    const errors = [];
    if (!patientName) errors.push('В сделке Bitrix не заполнено поле ФИО пациента UF_CRM_1737550182812.');
    if (!patient) { noPatient += 1; errors.push('В сделке Bitrix не заполнен код пациента UF_CRM_1783751141.'); }
    if (!firstTreatment) errors.push('В сделке Bitrix не заполнен первый день лечения UF_CRM_1783751996.');
    if (!appointmentDate) errors.push('В сделке Bitrix не заполнена дата назначения UF_CRM_1784267448.');
    if (!rawTypeCodes) { incomplete += 1; errors.push('В сделке Bitrix не заполнено поле типов назначений UF_CRM_1784225678.'); }
    else if (!codes) { incomplete += 1; errors.push('Поле типов назначений UF_CRM_1784225678 не содержит допустимых типов.'); }
    const category = Number(item.CATEGORY_ID || 0); const stageId = String(item.STAGE_ID || ''); const stage = (stages.get(category) || { byId: new Map() }).byId.get(stageId) || stageId;
    const opportunity = item.OPPORTUNITY === undefined || item.OPPORTUNITY === null || item.OPPORTUNITY === '' ? 0 : Number(item.OPPORTUNITY) || 0;
    return [id, title, patientName || title, category, stageId, stage, patient, opportunity, createdAt || '', appointmentDate || '', firstTreatment || '', String(item.UF_CRM_1783752197 || ''), codes, now, errors.join('\n')];
  }).filter(row => row[0]);
  DSS_saveStageDirectory_(stages); DSS_writeSheet_(ss, DSS_CONFIG.sheets.deals, DSS_DEAL_HEADERS, rows, { numbers: [8], dateTimes: [9, 14], dates: [10, 11], wraps: [12, 15], widths: { 1: 110, 2: 220, 3: 220, 7: 120, 8: 120, 9: 165, 10: 120, 11: 120, 12: 300, 13: 130, 14: 165, 15: 360 } }); DSS_log_(ss, 'Загрузка сделок Bitrix', now);
  DSS_alert_('Загрузка сделок из Bitrix завершена.', 'Направление: ' + categoryId + '.\nПолучено сделок направления: ' + deals.length + '.\nЗаписано на лист: ' + rows.length + '.\nБез кода пациента: ' + noPatient + '.\nБез заполненных типов назначений: ' + incomplete + '.');
}
function DSS_loadStagesFromBitrix() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const base = DSS_webhook_(); const categoryId = DSS_CONFIG.categoryId;
  const entityId = categoryId === 0 ? 'DEAL_STAGE' : 'DEAL_STAGE_' + categoryId;
  const statuses = DSS_list_(base, 'crm.status.list', { order: { SORT: 'ASC' }, filter: { ENTITY_ID: entityId } });
  const rows = statuses.map(status => [String(status.NAME || ''), String(status.STATUS_ID || '')]);
  DSS_writeSheet_(ss, DSS_CONFIG.sheets.stages, DSS_STAGE_HEADERS, rows);
}

function DSS_actualizeDeals() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const dealSheet = ss.getSheetByName(DSS_CONFIG.sheets.deals); const requestSheet = ss.getSheetByName(DSS_CONFIG.sheets.aggregated);
  if (!dealSheet || dealSheet.getLastRow() < 2) throw new Error('Сначала выполните пункт «2. Загрузить сделки из Bitrix».');
  if (!requestSheet || requestSheet.getLastRow() < 2) throw new Error('Сначала выполните пункт «1. Обработать заявки».');
  const deals = DSS_readObjects_(dealSheet); const requests = DSS_readObjects_(requestSheet); const dealTime = DSS_latestDate_(deals, 'Дата загрузки'); const requestTime = DSS_latestDate_(requests, 'Дата обработки');
  if (!DSS_isToday_(dealTime) || !DSS_isToday_(requestTime)) { const ui = SpreadsheetApp.getUi(); if (ui.alert('Предупреждение', 'Данные были подготовлены не сегодня. Рекомендуется повторно обработать заявки и загрузить сделки из Bitrix.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return; }
  const index = new Map(); requests.forEach(r => { const code = DSS_normalizePatientCode_(r['КлиентКод']); if (!code) return; if (!index.has(code)) index.set(code, []); index.get(code).push(r); });
  const stageInfo = DSS_loadStageDirectory_(); const now = new Date(); let booked = 0, attended = 0, unchanged = 0, errors = 0;
  const rows = deals.map(d => {
    const id = String(d['ID сделки'] || ''); const patient = DSS_normalizePatientCode_(d['Код пациента']); const appointmentDate = DSS_date_(d['Дата назначения']); const firstTreatment = DSS_date_(d['Первый день лечения']); const codes = DSS_codeSet_(d['Типы назначений']);
    const startDate = DSS_getRequestMatchingStartDate_(appointmentDate, firstTreatment); let planned = new Set(), done = new Set(), targetId = '', targetName = '', result = 'Без изменений', reason = '';
    if (!patient) { result = 'Не найден код пациента'; reason = 'В сделке отсутствует код пациента UF_CRM_1783751141.'; errors += 1; }
    else if (!startDate) { result = 'Недостаточно данных'; reason = 'Невозможно проверить заявки: отсутствует дата назначения.'; errors += 1; }
    else if (!codes.size) { result = d['Ошибка данных'] ? 'Неизвестная номенклатура' : 'Недостаточно данных'; reason = String(d['Ошибка данных'] || 'Не указаны коды назначения.'); errors += 1; }
    else {
      const effective = new Set(codes); if (effective.size > 1) effective.delete(DSS_CONFIG.consultationCode);
      (index.get(patient) || []).forEach(r => { const rd = DSS_date_(r['Дата']); if (!rd || rd < startDate) return; DSS_codeSet_(r['Запланированы']).forEach(c => { if (effective.has(c)) planned.add(c); }); DSS_codeSet_(r['Выполнены']).forEach(c => { if (effective.has(c)) done.add(c); }); });
      const cat = Number(d['CATEGORY_ID'] || 0); const si = stageInfo.get(cat); const onlyC = effective.size === 1 && effective.has('C');
      if (si && onlyC && (planned.has('C') || done.has('C'))) { targetId = si.attendedId; result = 'Дошёл'; reason = 'Назначена только консультация C.'; }
      else if (si && done.size) { targetId = si.attendedId; result = 'Дошёл'; reason = 'Найдена выполненная заявка.'; }
      else if (si && planned.size) { targetId = si.bookedId; result = 'Записался'; reason = 'Найдена действующая запланированная заявка.'; }
      else { result = 'Подходящие заявки не найдены'; reason = 'После нижней границы совпадений нет.'; }
      if (!si) { result = 'Недостаточно данных'; reason = 'Не найдены стадии воронки.'; errors += 1; targetId = ''; }
      if (targetId === String(d['Текущая стадия ID'] || '') || String(d['Текущая стадия'] || '') === DSS_CONFIG.stageNames.attended) { targetId = ''; targetName = ''; result = 'Без изменений'; reason = 'Обратный переход не рассчитывается или стадия уже целевая.'; }
      if (targetId) targetName = si.byId.get(targetId) || result;
    }
    if (result === 'Записался' && targetId) booked += 1; else if (result === 'Дошёл' && targetId) attended += 1; else unchanged += 1;
    return [Boolean(targetId), id, d['Название'], patient, appointmentDate || '', firstTreatment || '', DSS_codes_(codes), DSS_codes_(planned), DSS_codes_(done), d['Текущая стадия ID'], d['Текущая стадия'], targetId, targetName, result, reason, d['Дата загрузки'], requestTime || '', now, '', ''];
  });
  DSS_writeActualization_(ss, rows); DSS_log_(ss, 'Актуализация сделок', now);
  DSS_alert_('Актуализация сделок завершена.', 'Сделок проверено: ' + deals.length + '.\nПредлагается «Записался»: ' + booked + '.\nПредлагается «Дошёл»: ' + attended + '.\nБез изменений: ' + unchanged + '.\nСтрок с ошибками данных: ' + errors + '.');
}
function DSS_sendChangesToBitrixWithConfirmation() {
  const ui = SpreadsheetApp.getUi(); if (ui.alert('Отправка изменений в Bitrix', 'Будут обновлены стадии сделок, отмеченных флажком «Отправить» на листе «Актуализация сделок». Продолжить?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const sheet = ss.getSheetByName(DSS_CONFIG.sheets.actualization); if (!sheet || sheet.getLastRow() < 2) throw new Error('Нет подготовленных изменений для отправки.');
  const rows = DSS_readObjects_(sheet); const actualized = DSS_latestDate_(rows, 'Дата актуализации'); const deals = DSS_readObjects_(DSS_requiredSheet_(ss, DSS_CONFIG.sheets.deals)); const requests = DSS_readObjects_(DSS_requiredSheet_(ss, DSS_CONFIG.sheets.aggregated));
  if (DSS_latestDate_(deals, 'Дата загрузки') > actualized || DSS_latestDate_(requests, 'Дата обработки') > actualized) throw new Error('После актуализации исходные данные изменились. Повторно выполните пункт «3. Актуализировать сделки по заявкам».');
  const candidates = rows.map((r, i) => ({ r, row: i + 2 })).filter(x => x.r['Отправить'] === true && x.r['ID сделки'] && x.r['Предлагаемая стадия ID'] && x.r['Предлагаемая стадия ID'] !== x.r['Текущая стадия ID'] && x.r['Статус отправки'] !== 'Отправлено');
  if (!candidates.length) { DSS_alert_('Отправка изменений в Bitrix', 'Нет подготовленных изменений для отправки.'); return; }
  const base = DSS_webhook_(); let success = 0, failed = 0, skipped = 0; const verified = [];
  candidates.forEach(item => { try { const current = DSS_call_(base, 'crm.deal.get', { id: item.r['ID сделки'] }).result || {}; if (String(current.STAGE_ID || '') !== String(item.r['Текущая стадия ID'])) { DSS_sendStatus_(sheet, item.row, 'Пропущено: стадия изменилась в Bitrix.', ''); skipped += 1; } else verified.push(item); } catch (e) { DSS_sendStatus_(sheet, item.row, 'Ошибка', DSS_safeError_(e)); failed += 1; } });
  for (let offset = 0; offset < verified.length; offset += DSS_CONFIG.batchSize) { const result = DSS_sendBitrixBatch_(base, verified.slice(offset, offset + DSS_CONFIG.batchSize)); result.forEach(x => { if (x.ok) { DSS_sendStatus_(sheet, x.item.row, 'Отправлено ' + DSS_datetime_(new Date()), ''); success += 1; } else { DSS_sendStatus_(sheet, x.item.row, 'Ошибка', x.error); failed += 1; } }); }
  DSS_log_(ss, 'Отправка изменений в Bitrix', new Date()); DSS_alert_('Отправка изменений в Bitrix завершена.', 'Отправлено успешно: ' + success + '.\nОшибок: ' + failed + '.\nПропущено: ' + skipped + '.');
}

/* Внутренние функции */
function DSS_webhook_() { const v = String(PropertiesService.getScriptProperties().getProperty('BITRIX_WEBHOOK_BASE_URL') || '').trim(); if (!v) throw new Error('Не задано свойство скрипта BITRIX_WEBHOOK_BASE_URL.'); return v.replace(/\/+$/, '') + '/'; }
function DSS_call_(base, method, payload) { const response = UrlFetchApp.fetch(base + method + '.json', { method: 'post', contentType: 'application/json; charset=utf-8', payload: JSON.stringify(payload || {}), muteHttpExceptions: true }); const body = response.getContentText() || ''; let parsed; try { parsed = body ? JSON.parse(body) : {}; } catch (e) { throw new Error('Bitrix вернул некорректный ответ. HTTP ' + response.getResponseCode() + '.'); } if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || parsed.error) throw new Error('Ошибка Bitrix: ' + String(parsed.error_description || parsed.error || 'HTTP ' + response.getResponseCode()).slice(0, 500)); return parsed; }
function DSS_list_(base, method, params) {
  let start = 0, guard = 0, result = [];
  while (guard++ < 10000) {
    let out;
    try {
      out = DSS_call_(base, method, Object.assign({}, params, { start }));
    } catch (error) {
      throw new Error('Ошибка при выполнении ' + method + ', start=' + start + ', уже загружено=' + result.length + '. ' + DSS_safeError_(error));
    }
    const page = Array.isArray(out.result) ? out.result : [];
    result = result.concat(page);
    if (out.next === undefined || out.next === null || out.next === '') break;
    const next = Number(out.next);
    if (!Number.isFinite(next) || next <= start) {
      throw new Error('Bitrix вернул некорректное значение next для ' + method + ': ' + String(out.next));
    }
    start = next;
  }
  return result;
}
function DSS_stageDirectory_(base, deals) { const categories = Array.from(new Set(deals.map(d => Number(d.CATEGORY_ID || 0)))); const out = new Map(); categories.forEach(c => { const statuses = DSS_list_(base, 'crm.status.list', { order: { SORT: 'ASC' }, filter: { ENTITY_ID: c ? 'DEAL_STAGE_' + c : 'DEAL_STAGE' } }); const byId = new Map(), byName = new Map(); statuses.forEach(s => { byId.set(String(s.STATUS_ID), String(s.NAME)); byName.set(DSS_text_(s.NAME), String(s.STATUS_ID)); }); out.set(c, { byId, bookedId: byName.get(DSS_text_(DSS_CONFIG.stageNames.booked)), attendedId: byName.get(DSS_text_(DSS_CONFIG.stageNames.attended)) }); }); return out; }
function DSS_stageDirectoryFromDeals_(deals) { const out = new Map(); deals.forEach(d => { const c = Number(d.CATEGORY_ID || 0); if (!out.has(c)) out.set(c, { byId: new Map(), bookedId: '', attendedId: '' }); const x = out.get(c), id = String(d['Текущая стадия ID'] || ''), name = String(d['Текущая стадия'] || ''); if (id) x.byId.set(id, name); if (DSS_text_(name) === DSS_text_(DSS_CONFIG.stageNames.booked)) x.bookedId = id; if (DSS_text_(name) === DSS_text_(DSS_CONFIG.stageNames.attended)) x.attendedId = id; }); return out; }
function DSS_normalizeTypeNomenclature_(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function DSS_serviceCodeByCabinet_(cabinet) {
  const text = DSS_text_(cabinet);
  if (text.indexOf('фтл') !== -1) return 'L';
  if (text.indexOf('магнит') !== -1) return 'S';
  return '';
}
function DSS_requestTypeByCabinetOrDirectory_(cabinet, nomenclature, directory) {
  const cabinetTypeCode = DSS_serviceCodeByCabinet_(cabinet);
  return cabinetTypeCode || directory.map.get(DSS_normalizeTypeNomenclature_(nomenclature)) || '';
}
function DSS_shouldProcessRequestByCabinetAndName_(code, date, state, cabinetTypeCode, name) {
  if (!code || !date || !state) return false;
  if (!cabinetTypeCode && !name) return false;
  return true;
}
function DSS_normalizeSharedTypeCode_(value) { return String(value || '').replace(/\s+/g, '').toUpperCase(); }
function DSS_readSharedTypeCodesMap_() {
  let spreadsheet;
  try { spreadsheet = SpreadsheetApp.openById(DSS_TYPE_CODES_SPREADSHEET_ID); }
  catch (e) { throw new Error('Не удалось открыть общий справочник типов назначений.\n\nПроверьте, что аккаунт, от имени которого выполняется Deal_Status_Sync.gs, имеет доступ на редактирование таблицы:\n' + DSS_TYPE_CODES_SPREADSHEET_ID); }
  const sheet = spreadsheet.getSheetByName(DSS_TYPE_CODES_SHEET_NAME);
  if (!sheet) throw new Error('В общем справочнике не найден лист «' + DSS_TYPE_CODES_SHEET_NAME + '».');
  const values = sheet.getDataRange().getValues(); const headers = (values[0] || []).map(x => String(x || '').trim());
  const nameColumn = headers.indexOf('Номенклатура'), typeColumn = headers.indexOf('Тип');
  if (nameColumn === -1 || typeColumn === -1) throw new Error('В листе «' + DSS_TYPE_CODES_SHEET_NAME + '» должны быть колонки «Номенклатура» и «Тип».');
  const map = new Map();
  values.slice(1).forEach(row => { const key = DSS_normalizeTypeNomenclature_(row[nameColumn]); if (key && !map.has(key)) map.set(key, DSS_normalizeSharedTypeCode_(row[typeColumn])); });
  return { sheet, nameColumn, typeColumn, map };
}
function DSS_appendMissingSharedTypeCodes_(directory, nomenclatures) {
  // Read again immediately before appending to avoid duplicating entries added by Code.gs.
  const current = DSS_readSharedTypeCodesMap_(); const missing = [];
  nomenclatures.forEach((name, key) => { if (!current.map.has(key)) missing.push(name); });
  if (!missing.length) return 0;
  const width = Math.max(current.sheet.getLastColumn(), current.nameColumn + 1, current.typeColumn + 1);
  const rows = missing.map(name => { const row = Array(width).fill(''); row[current.nameColumn] = name; return row; });
  current.sheet.getRange(current.sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
  return rows.length;
}
function DSS_incompleteTypeCodesMessage_(added, empty, invalid) {
  return 'Не для всей номенклатуры заявок указаны типы.\n\nДобавлено новых позиций в общий справочник: ' + added + '.\nПозиций с пустым типом: ' + empty + '.\nПозиций с ошибочным типом: ' + invalid + '.\n\nОткройте таблицу:\n' + DSS_TYPE_CODES_SPREADSHEET_ID + '\n\nЛист:\n«' + DSS_TYPE_CODES_SHEET_NAME + '»\n\nЗаполните колонку «Тип» и повторно выполните «1. Обработать заявки».\n\nНе продолжать обработку с неполным справочником, поскольку это может привести к неправильному переводу стадий сделок.';
}
function DSS_normalizeDealTypeCodes_(value) {
  const raw = String(value || '').replace(/\s+/g, '').toUpperCase(); const present = new Set(raw.split(''));
  return DSS_ALLOWED_TYPE_CODES.filter(code => code !== '-' && present.has(code)).join('');
}
function DSS_requestState_(v) { const t = DSS_text_(v); if (DSS_CONFIG.cancelledMarkers.some(x => t.indexOf(DSS_text_(x)) !== -1)) return 'CANCEL'; if (DSS_CONFIG.doneStates.some(x => t === DSS_text_(x))) return 'DONE'; if (DSS_CONFIG.plannedStates.some(x => t === DSS_text_(x))) return 'PLAN'; return ''; }
function DSS_writeSheet_(ss, name, headers, rows, formats) {
  if (rows.some(row => row.length !== headers.length)) throw new Error('Количество значений строки не соответствует количеству заголовков листа «' + name + '».');
  const s = DSS_prepareSheet_(ss, name, headers);
  if (rows.length) s.getRange(2, 1, rows.length, headers.length).setValues(rows);
  s.setFrozenRows(1); s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  const dataRows = Math.max(rows.length, 1);
  ((formats && formats.numbers) || []).forEach(c => s.getRange(2, c, dataRows, 1).setNumberFormat('#,##0.00'));
  ((formats && formats.dates) || []).forEach(c => s.getRange(2, c, dataRows, 1).setNumberFormat('dd.MM.yyyy'));
  ((formats && formats.dateTimes) || []).forEach(c => s.getRange(2, c, dataRows, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss'));
  ((formats && formats.wraps) || []).forEach(c => s.getRange(2, c, dataRows, 1).setWrap(true));
  Object.keys((formats && formats.widths) || {}).forEach(c => s.setColumnWidth(Number(c), formats.widths[c]));
  if (s.getFilter()) s.getFilter().remove();
  s.getRange(1, 1, Math.max(rows.length + 1, 1), headers.length).createFilter();
}
function DSS_writeActualization_(ss, rows) { DSS_writeSheet_(ss, DSS_CONFIG.sheets.actualization, DSS_ACTUALIZATION_HEADERS, rows, { dates: [5,6], dateTimes: [16,17,18] }); const s = ss.getSheetByName(DSS_CONFIG.sheets.actualization); s.getRange(2,1,Math.max(rows.length,1),1).insertCheckboxes(); }
function DSS_prepareSheet_(ss, name, headers) { let s = ss.getSheetByName(name); if(!s) s = ss.insertSheet(name); if (s.getFilter()) s.getFilter().remove(); s.clear(); s.getRange(1,1,1,headers.length).setValues([headers]); return s; }
function DSS_requiredSheet_(ss, name) { const s = ss.getSheetByName(name); if(!s) throw new Error('Не найден обязательный лист "' + name + '".'); return s; }
function DSS_readObjects_(sheet) { const values = sheet.getDataRange().getValues(), display = sheet.getDataRange().getDisplayValues(); if(!values.length) return []; const h = display[0].map(x => String(x || '').trim()); return values.slice(1).map((row,i) => { const x = {}; h.forEach((k,j) => x[k] = row[j]); return x; }); }
function DSS_sendStatus_(sheet, row, status, error) { sheet.getRange(row,19,1,2).setValues([[status,error]]); }
function DSS_ensureLogSheet_(ss) { let s = ss.getSheetByName(DSS_CONFIG.sheets.log); if(!s) s = ss.insertSheet(DSS_CONFIG.sheets.log); if(!s.getLastRow()) s.appendRow(['Дата и время','Этап']); return s; }
function DSS_log_(ss, stage, date) { DSS_ensureLogSheet_(ss).appendRow([date, stage]); }
function DSS_alert_(title, text) { SpreadsheetApp.getUi().alert(title, text, SpreadsheetApp.getUi().ButtonSet.OK); }
function DSS_cleanName_(v) { return String(v || '').replace(/\s*\|.*$/,'').replace(/\s+/g,' ').trim(); }
function DSS_text_(v) { return String(v || '').toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function DSS_normalizePatientCode_(value) { return String(value || '').replace(/\s+/g, '').trim(); }
function DSS_patientCode_(v) { return DSS_normalizePatientCode_(v); }
function DSS_serviceCode_(v) { const x = String(v || '').trim().toUpperCase(); return DSS_ALLOWED_TYPE_CODES.indexOf(x) !== -1 ? x : ''; }
function DSS_codeSet_(v) { return new Set(String(v || '').split('').map(DSS_serviceCode_).filter(x => x && x !== DSS_CONFIG.ignoredCode)); }
function DSS_codes_(set) { return Array.from(set || []).filter(x => x && x !== '-').sort((a,b) => DSS_CONFIG.serviceCodeOrder.indexOf(a) - DSS_CONFIG.serviceCodeOrder.indexOf(b)).join(''); }
function DSS_date_(v) { if(v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(),v.getMonth(),v.getDate()); const t = String(v || '').trim(), m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/); if(m) return m[1].length === 4 ? new Date(+m[1],+m[2]-1,+m[3]) : new Date(+m[3],+m[2]-1,+m[1]); const d = new Date(t); return isNaN(d) ? null : new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
function DSS_getRequestMatchingStartDate_(appointmentDate, firstTreatmentDate) {
  const appointment = DSS_date_(appointmentDate);
  if (!appointment) return null;
  const nextDay = new Date(appointment.getFullYear(), appointment.getMonth(), appointment.getDate());
  nextDay.setDate(nextDay.getDate() + 1);
  const treatment = DSS_date_(firstTreatmentDate);
  if (!treatment) return nextDay;
  const treatmentMinus30 = new Date(treatment.getFullYear(), treatment.getMonth(), treatment.getDate());
  treatmentMinus30.setDate(treatmentMinus30.getDate() - 30);
  return treatmentMinus30 > nextDay ? treatmentMinus30 : nextDay;
}
function DSS_testRequestMatchingStartDate_() {
  const d = (year, month, day) => new Date(year, month - 1, day);
  const equalDate = (actual, expected, message) => { if (!actual || actual.getTime() !== expected.getTime()) throw new Error(message); };
  equalDate(DSS_getRequestMatchingStartDate_(d(2026, 7, 17), d(2026, 8, 1)), d(2026, 7, 18), 'Дата назначения должна сдвигаться на следующий день.');
  equalDate(DSS_getRequestMatchingStartDate_(d(2026, 6, 1), d(2026, 8, 1)), d(2026, 7, 2), 'Должен использоваться максимум с первым днём минус 30.');
  equalDate(DSS_getRequestMatchingStartDate_(d(2026, 7, 17), null), d(2026, 7, 18), 'Без первого дня используется следующий день назначения.');
  if (DSS_getRequestMatchingStartDate_(null, d(2026, 8, 1)) !== null) throw new Error('Без даты назначения нижняя граница должна отсутствовать.');
  const start = DSS_getRequestMatchingStartDate_(d(2026, 7, 17), null);
  if (!(d(2026, 7, 17) < start && d(2026, 7, 18) >= start)) throw new Error('Заявки в дату назначения исключаются, со следующего дня учитываются для всех типов.');
  return 'DSS_testRequestMatchingStartDate_: OK';
}

function DSS_testCabinetPriorityTypeDetection_() {
  const assertEqual = (actual, expected, message) => { if (actual !== expected) throw new Error(message + ' Ожидалось: ' + expected + ', получено: ' + actual + '.'); };
  const directory = { map: new Map([
    [DSS_normalizeTypeNomenclature_('ignored'), '-'],
    [DSS_normalizeTypeNomenclature_('massage'), 'M'],
    [DSS_normalizeTypeNomenclature_('laser'), 'L']
  ]) };

  assertEqual(DSS_serviceCodeByCabinet_('4 ФТЛ-К'), 'L', 'Кабинет ФТЛ должен давать тип L.');
  assertEqual(DSS_serviceCodeByCabinet_('Кабинет магнитотерапии'), 'S', 'Кабинет магнитотерапии должен давать тип S.');
  assertEqual(DSS_serviceCodeByCabinet_('фтл'), 'L', 'Определение ФТЛ должно быть устойчиво к регистру.');
  assertEqual(DSS_serviceCodeByCabinet_('Массажный кабинет'), '', 'Нейтральный кабинет не должен определять тип.');
  assertEqual(DSS_requestTypeByCabinetOrDirectory_('4 ФТЛ-К', 'ignored', directory), 'L', 'ФТЛ должен иметь приоритет над типом номенклатуры "-".');
  assertEqual(DSS_requestTypeByCabinetOrDirectory_('ФТЛ', 'massage', directory), 'L', 'ФТЛ должен иметь приоритет над ошибочным типом M.');
  assertEqual(DSS_requestTypeByCabinetOrDirectory_('Магнит-К', 'laser', directory), 'S', 'Магнит должен иметь приоритет над ошибочным типом L.');
  assertEqual(DSS_requestTypeByCabinetOrDirectory_('Процедурный кабинет', 'massage', directory), 'M', 'Без специального кабинета тип берётся из справочника.');
  if (!DSS_shouldProcessRequestByCabinetAndName_('001', new Date(2026, 6, 21), 'PLAN', DSS_serviceCodeByCabinet_('ФТЛ'), '')) throw new Error('Пустая номенклатура допустима для ФТЛ.');
  if (DSS_shouldProcessRequestByCabinetAndName_('001', new Date(2026, 6, 21), 'PLAN', DSS_serviceCodeByCabinet_('Кабинет №1'), '')) throw new Error('Пустая номенклатура без специального кабинета должна исключать заявку.');
  // Филиал не участвует в сопоставлении заявок со сделками.
  return 'DSS_testCabinetPriorityTypeDetection_: OK';
}
function DSS_scriptTimeZone_() { return Session.getScriptTimeZone(); }
function DSS_today_() { return DSS_date_(Utilities.formatDate(new Date(), DSS_scriptTimeZone_(), 'yyyy-MM-dd')); }
function DSS_iso_(d) { return Utilities.formatDate(d, DSS_scriptTimeZone_(), 'yyyy-MM-dd'); }
function DSS_datetime_(d) { return Utilities.formatDate(d, DSS_scriptTimeZone_(), 'dd.MM.yyyy HH:mm:ss'); }
function DSS_addDays_(d,n) { const x = new Date(d.getFullYear(),d.getMonth(),d.getDate()); x.setDate(x.getDate()+n); return x; }
function DSS_latestDate_(rows, field) { return rows.reduce((max,r) => { const d = r[field] instanceof Date ? r[field] : new Date(r[field]); return !isNaN(d) && (!max || d > max) ? d : max; }, null); }
function DSS_isToday_(d) { return d && DSS_iso_(d) === DSS_iso_(DSS_today_()); }
function DSS_safeError_(e) { return String(e && e.message || e || 'Неизвестная ошибка').replace(/https?:\/\/[^\s]+/g, '[скрыто]').slice(0,500); }
function DSS_saveStageDirectory_(directory) { const data = {}; directory.forEach((x, category) => { data[category] = { stages: Array.from(x.byId.entries()), bookedId: x.bookedId || '', attendedId: x.attendedId || '' }; }); PropertiesService.getDocumentProperties().setProperty('DSS_STAGE_DIRECTORY', JSON.stringify(data)); }
function DSS_loadStageDirectory_() { const raw = PropertiesService.getDocumentProperties().getProperty('DSS_STAGE_DIRECTORY'); const result = new Map(); if (!raw) return result; try { const data = JSON.parse(raw); Object.keys(data).forEach(category => { const x = data[category]; result.set(Number(category), { byId: new Map(x.stages || []), bookedId: x.bookedId || '', attendedId: x.attendedId || '' }); }); } catch (e) { return new Map(); } return result; }
function DSS_sendBitrixBatch_(base, items) { const cmd = {}; items.forEach((item, i) => { cmd['d' + i] = 'crm.deal.update?id=' + encodeURIComponent(item.r['ID сделки']) + '&fields[STAGE_ID]=' + encodeURIComponent(item.r['Предлагаемая стадия ID']); }); try { const out = DSS_call_(base, 'batch', { halt: 0, cmd }).result || {}; const success = out.result || {}, errors = out.result_error || {}; return items.map((item, i) => ({ item, ok: success['d' + i] === true, error: DSS_safeError_(errors['d' + i] || 'Bitrix не подтвердил обновление.') })); } catch (e) { return items.map(item => ({ item, ok: false, error: DSS_safeError_(e) })); } }

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
 *
 * Для актуализации из Bitrix загружаются сделки только
 * из отбираемых стадий воронки 114 (DSS_ACTUALIZATION_STAGE_IDS).
 * Стадия «Не вышел на связь» учитывается только в течение
 * 30 дней с даты создания сделки.
 *
 * Из стадии «Записался в клинике» рассчитывается только
 * переход в «Дошёл»: перевод в «Записался» движением
 * вперёд не является.
 *
 * Контроль пропуска записи — отдельный шаг актуализации.
 * Вечером, по свежей выгрузке заявок, сделки в стадиях
 * записи с прошедшей датой «Записан на дату» проверяются:
 * есть новая плановая заявка с совпадающими типами записи
 * → перенос даты, нет → «Пропустил запись». Плановая
 * консультация C записью не считается.
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
  ignoredCode: '-', consultationCode: 'C', serviceCodeOrder: 'LMSFCDUPB', batchSize: 50,
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
// «Записан на дату» — дата плановой заявки, по которой сделка считается
// записанной. Поле типа «дата», без времени.
const DSS_DEAL_BOOKED_DATE_FIELD =
  'UF_CRM_1739201665696';
const DSS_ALLOWED_TYPE_CODES = [
  'L', 'M', 'S', 'F', 'C', 'D', 'U', 'P', 'B', '-'
];
// Для актуализации из Bitrix загружаются сделки только этих стадий воронки 114.
// Стадия «Не вышел на связь» (UC_1GZCBR) учитывается лишь в течение 30 дней
// с даты создания сделки — см. DSS_RECENT_ONLY_STAGE_ID и DSS_RECENT_ONLY_DAYS.
const DSS_ACTUALIZATION_STAGE_IDS = [
  'C114:UC_2ITBVA',        // Ожидание
  'C114:NEW',              // Связаться
  'C114:PREPARATION',      // В работе
  'C114:PREPAYMENT_INVOI', // Cвязаться позже
  'C114:UC_XR0QG1',        // Повторные касание Не дозвоны
  'C114:EXECUTING',        // Записался
  'C114:UC_LZO5RC',        // Записался в клинике
  'C114:UC_VMJ62D',        // Пропустил запись
  'C114:UC_1GZCBR'         // Не вышел на связь (только свежие сделки)
];
const DSS_RECENT_ONLY_STAGE_ID = 'C114:UC_1GZCBR';
const DSS_RECENT_ONLY_DAYS = 30;
// Стадии сделок, созданных по назначениям пациентов, уже находящихся в клинике.
// «Начал в клинике» — транзитная: робот Bitrix сразу переводит её в «Дошёл»,
// поэтому в актуализацию она не попадает.
const DSS_STAGE_CLINIC_BOOKED = 'C114:UC_LZO5RC';   // Записался в клинике
const DSS_STAGE_CLINIC_STARTED = 'C114:UC_WR9VJQ';  // Начал в клинике
// Контроль пропуска записи: сделка с прошедшей датой записи, по которой нет
// ни начатой/выполненной, ни новой плановой заявки с совпадающими типами.
// «Пропустил запись» входит и в отбор сделок (DSS_ACTUALIZATION_STAGE_IDS):
// если пациент снова записался или дошёл, обычные шаги вернут сделку в работу.
const DSS_STAGE_MISSED_APPOINTMENT = 'C114:UC_VMJ62D'; // Пропустил запись
// Стадии, в которых проверяется пропуск записи. «Запись по горящей акции»
// (UC_G5EXVL) попадает в проверку, только если сделки этой стадии выгружены
// на лист «Сделки Bitrix»: в DSS_ACTUALIZATION_STAGE_IDS она не входит.
const DSS_MISSED_APPOINTMENT_STAGE_IDS = [
  'C114:EXECUTING',        // Записался
  'C114:UC_G5EXVL',        // Запись по горящей акции
  'C114:UC_LZO5RC'         // Записался в клинике
];
// Ежедневный отчёт по воронке 114 в групповой чат Bitrix.
// Отчётные сутки: [reportDate 06:00; reportDate + 1 день 06:00),
// поэтому запуск до 06:00 относится к предыдущему календарному дню.
const DAILY_REPORT_CHAT_ID = 'chat229018';
const DSS_DAILY_REPORT_DAY_START_HOUR = 6;
const DSS_DAILY_REPORT_TRIGGER_HOUR = 20;
const DSS_DAILY_REPORT_FUNCTION = 'sendDailySalesReport';
const DSS_REPORT_STAGE_CONTACT = 'C114:NEW';              // Связаться
const DSS_REPORT_STAGE_WAITING = 'C114:UC_2ITBVA';        // Ожидание
const DSS_REPORT_STAGE_INTERSECTION = 'C114:UC_C7PDQC';   // Пересечения
const DSS_REPORT_STAGE_BOOKED = 'C114:EXECUTING';         // Записался
const DSS_REPORT_STAGE_MISSED = 'C114:UC_VMJ62D';         // Пропустил запись
const DSS_REPORT_STAGE_WON = 'C114:WON';                  // Дошёл
const DSS_REPORT_STAGE_LOSE = 'C114:LOSE';                // Провалено
const DSS_REPORT_STAGE_REFUSAL = 'C114:UC_8I6LEA';        // Отказ (транзитная)
const DSS_REPORT_STAGE_NO_CONTACT = 'C114:UC_1GZCBR';     // Не вышел на связь (транзитная)

const DSS_REQUEST_HEADERS = ['КлиентКод', 'Пациент', 'Дата', 'Запланированы', 'Выполнены', 'Дата обработки'];
const DSS_DEAL_HEADERS = ['ID сделки', 'Название', 'ФИО пациента', 'CATEGORY_ID', 'Текущая стадия ID', 'Текущая стадия', 'Код пациента', 'Сумма сделки', 'Дата создания сделки', 'Дата назначения', 'Первый день лечения', 'Записан на дату', 'Состав назначения', 'Типы назначений', 'Дата загрузки', 'Ошибка данных'];
const DSS_ACTUALIZATION_HEADERS = ['Отправить', 'ID сделки', 'Название сделки', 'Код пациента', 'Дата назначения', 'Первый день лечения', 'Типы назначений', 'Найденные запланированные типы', 'Найденные выполненные типы', 'Текущая стадия ID', 'Текущая стадия', 'Предлагаемая стадия ID', 'Предлагаемая стадия', 'Записан на дату', 'Результат проверки', 'Причина', 'Дата загрузки сделок', 'Дата обработки заявок', 'Дата актуализации', 'Статус отправки', 'Ошибка отправки'];
const DSS_STAGE_HEADERS = ['Название стадии', 'Код стадии'];

function onOpen(e) { DSS_addDealStatusSyncMenu_(); }
function DSS_addDealStatusSyncMenu_() {
  SpreadsheetApp.getUi().createMenu('Сверка сделок Bitrix')
    .addItem('Инициализировать служебные листы', 'initializeBitrixDealStageSync').addSeparator()
    .addItem('1. Обработать заявки', 'DSS_processRequests')
    .addItem('2. Загрузить сделки из Bitrix', 'DSS_loadDealsFromBitrix')
    .addItem('3. Актуализировать сделки по заявкам', 'DSS_actualizeDeals')
    .addItem('4. Проверить пропуск записи (вечером)', 'DSS_actualizeMissedAppointments').addSeparator()
    .addItem('Загрузить стадии Bitrix', 'DSS_loadStagesFromBitrix')
    .addItem('5. Отправить изменения в Bitrix', 'DSS_sendChangesToBitrixWithConfirmation').addSeparator()
    .addItem('Отправить итог дня в чат', 'sendDailySalesReport')
    .addItem('Установить триггер ежедневного отчёта', 'DSS_installDailyReportTrigger').addToUi();
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
    filter: { CATEGORY_ID: DSS_CONFIG.categoryId, STAGE_ID: DSS_ACTUALIZATION_STAGE_IDS },
    select: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'DATE_CREATE', 'UF_CRM_1737550182812', 'UF_CRM_1783751141', DSS_DEAL_APPOINTMENT_DATE_FIELD, DSS_DEAL_BOOKED_DATE_FIELD, 'UF_CRM_1783751996', 'UF_CRM_1783752197', DSS_DEAL_TYPE_CODES_FIELD]
  });
  const categoryId = Number(DSS_CONFIG.categoryId);
  const inCategory = raw.filter(item => Number(item.CATEGORY_ID || 0) === categoryId);
  const unexpectedDeals = raw.length - inCategory.length;
  if (unexpectedDeals) Logger.log('Bitrix вернул сделки вне CATEGORY_ID ' + categoryId + ': ' + unexpectedDeals + '.');
  // Bitrix уже фильтрует по STAGE_ID, но перепроверяем стадии на стороне скрипта и
  // отбрасываем «Не вышел на связь» старше 30 дней с даты создания сделки.
  const allowedStages = new Set(DSS_ACTUALIZATION_STAGE_IDS);
  const recentCutoff = DSS_addDays_(DSS_today_(), -DSS_RECENT_ONLY_DAYS);
  let unexpectedStages = 0, staleRecentOnly = 0;
  const deals = inCategory.filter(item => {
    const stageId = String(item.STAGE_ID || '');
    if (!allowedStages.has(stageId)) { unexpectedStages += 1; return false; }
    if (stageId === DSS_RECENT_ONLY_STAGE_ID) {
      const createdAt = DSS_date_(item.DATE_CREATE);
      if (!createdAt || createdAt < recentCutoff) { staleRecentOnly += 1; return false; }
    }
    return true;
  });
  if (unexpectedStages) Logger.log('Bitrix вернул сделки вне отбираемых стадий: ' + unexpectedStages + '.');
  const stages = DSS_stageDirectory_(base, deals); let noPatient = 0; let incomplete = 0;
  const rows = deals.map(item => {
    const id = String(item.ID || ''); const firstTreatment = DSS_date_(item.UF_CRM_1783751996); const appointmentDate = DSS_date_(item[DSS_DEAL_APPOINTMENT_DATE_FIELD]); const bookedDate = DSS_date_(item[DSS_DEAL_BOOKED_DATE_FIELD]); const createdAt = DSS_date_(item.DATE_CREATE);
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
    return [id, title, patientName || title, category, stageId, stage, patient, opportunity, createdAt || '', appointmentDate || '', firstTreatment || '', bookedDate || '', String(item.UF_CRM_1783752197 || ''), codes, now, errors.join('\n')];
  }).filter(row => row[0]);
  DSS_saveStageDirectory_(stages); DSS_writeSheet_(ss, DSS_CONFIG.sheets.deals, DSS_DEAL_HEADERS, rows, { numbers: [8], dateTimes: [9, 15], dates: [10, 11, 12], wraps: [13, 16], widths: { 1: 110, 2: 220, 3: 220, 7: 120, 8: 120, 9: 165, 10: 120, 11: 120, 12: 120, 13: 300, 14: 130, 15: 165, 16: 360 } }); DSS_log_(ss, 'Загрузка сделок Bitrix', now);
  DSS_alert_('Загрузка сделок из Bitrix завершена.', 'Направление: ' + categoryId + '.\nОтбираемых стадий: ' + DSS_ACTUALIZATION_STAGE_IDS.length + '.\nПолучено сделок отбираемых стадий: ' + deals.length + '.\nЗаписано на лист: ' + rows.length + '.\n«Не вышел на связь» старше ' + DSS_RECENT_ONLY_DAYS + ' дней исключено: ' + staleRecentOnly + '.\nБез кода пациента: ' + noPatient + '.\nБез заполненных типов назначений: ' + incomplete + '.');
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
  const stageInfo = DSS_loadStageDirectory_(); const now = new Date(); const today = DSS_today_(); let booked = 0, attended = 0, unchanged = 0, errors = 0;
  const rows = deals.map(d => {
    const id = String(d['ID сделки'] || ''); const patient = DSS_normalizePatientCode_(d['Код пациента']); const appointmentDate = DSS_date_(d['Дата назначения']); const firstTreatment = DSS_date_(d['Первый день лечения']); const codes = DSS_codeSet_(d['Типы назначений']);
    const startDate = DSS_getRequestMatchingStartDate_(appointmentDate, firstTreatment); let planned = new Set(), done = new Set(), plannedDates = [], bookedDate = '', targetId = '', targetName = '', result = 'Без изменений', reason = '';
    if (!patient) { result = 'Не найден код пациента'; reason = 'В сделке отсутствует код пациента UF_CRM_1783751141.'; errors += 1; }
    else if (!startDate) { result = 'Недостаточно данных'; reason = 'Невозможно проверить заявки: отсутствует дата назначения.'; errors += 1; }
    else if (!codes.size) { result = d['Ошибка данных'] ? 'Неизвестная номенклатура' : 'Недостаточно данных'; reason = String(d['Ошибка данных'] || 'Не указаны коды назначения.'); errors += 1; }
    else {
      const effective = DSS_effectiveDealCodes_(codes);
      const match = DSS_matchRequestsToDeal_(index.get(patient) || [], startDate, effective);
      planned = match.planned; done = match.done; plannedDates = match.plannedDates;
      const cat = Number(d['CATEGORY_ID'] || 0); const si = stageInfo.get(cat); const onlyC = effective.size === 1 && effective.has('C');
      if (si && onlyC && (planned.has('C') || done.has('C'))) { targetId = si.attendedId; result = 'Дошёл'; reason = 'Назначена только консультация C.'; }
      else if (si && done.size) { targetId = si.attendedId; result = 'Дошёл'; reason = 'Найдена выполненная заявка.'; }
      else if (si && planned.size) { targetId = si.bookedId; result = 'Записался'; reason = 'Найдена действующая запланированная заявка.'; }
      else { result = 'Подходящие заявки не найдены'; reason = 'После нижней границы совпадений нет.'; }
      if (!si) { result = 'Недостаточно данных'; reason = 'Не найдены стадии воронки.'; errors += 1; targetId = ''; }
      if (targetId === String(d['Текущая стадия ID'] || '') || String(d['Текущая стадия'] || '') === DSS_CONFIG.stageNames.attended) { targetId = ''; targetName = ''; result = 'Без изменений'; reason = 'Обратный переход не рассчитывается или стадия уже целевая.'; }
      else if (DSS_isClinicBookedToBookedTransition_(d['Текущая стадия ID'], targetId, si)) { targetId = ''; targetName = ''; result = 'Без изменений'; reason = 'Из «Записался в клинике» перевод в «Записался» движением вперёд не является.'; }
      if (targetId) targetName = si.byId.get(targetId) || result;
      // При переводе в «Записался» вместе со стадией уходит дата плановой
      // заявки, по которой засчитан переход: она нужна контролю пропуска записи.
      if (targetId && result === 'Записался') bookedDate = DSS_pickBookedAppointmentDate_(plannedDates, today) || '';
    }
    if (result === 'Записался' && targetId) booked += 1; else if (result === 'Дошёл' && targetId) attended += 1; else unchanged += 1;
    return [Boolean(targetId), id, d['Название'], patient, appointmentDate || '', firstTreatment || '', DSS_codes_(codes), DSS_codes_(planned), DSS_codes_(done), d['Текущая стадия ID'], d['Текущая стадия'], targetId, targetName, bookedDate, result, reason, d['Дата загрузки'], requestTime || '', now, '', ''];
  });
  DSS_writeActualization_(ss, rows); DSS_log_(ss, 'Актуализация сделок', now);
  DSS_alert_('Актуализация сделок завершена.', 'Сделок проверено: ' + deals.length + '.\nПредлагается «Записался»: ' + booked + '.\nПредлагается «Дошёл»: ' + attended + '.\nБез изменений: ' + unchanged + '.\nСтрок с ошибками данных: ' + errors + '.');
}
// Из «Записался в клинике» рассчитывается только переход в «Дошёл»:
// перевод в «Записался» движением вперёд не является.
function DSS_isClinicBookedToBookedTransition_(currentStageId, targetId, stageInfo) {
  return String(currentStageId || '') === DSS_STAGE_CLINIC_BOOKED &&
    Boolean(targetId) && Boolean(stageInfo) && targetId === stageInfo.bookedId;
}

// Эффективные типы сделки: при нескольких типах консультация C не учитывается.
function DSS_effectiveDealCodes_(codes) {
  const effective = new Set(codes);
  if (effective.size > 1) effective.delete(DSS_CONFIG.consultationCode);
  return effective;
}

// Сопоставление заявок пациента со сделкой по общим правилам DSS:
// учитываются агрегированные заявки не раньше нижней границы,
// совпадение — по эффективным типам назначений сделки.
function DSS_matchRequestsToDeal_(requestRows, startDate, effective) {
  const planned = new Set(), done = new Set(), plannedDates = [];
  (requestRows || []).forEach(r => {
    const rd = DSS_date_(r['Дата']);
    if (!rd || rd < startDate) return;
    let matched = false;
    DSS_codeSet_(r['Запланированы']).forEach(c => { if (effective.has(c)) { planned.add(c); matched = true; } });
    DSS_codeSet_(r['Выполнены']).forEach(c => { if (effective.has(c)) done.add(c); });
    if (matched) plannedDates.push(rd);
  });
  return { planned, done, plannedDates };
}

// Дата записи: ближайшая подходящая заявка не раньше сегодняшнего дня.
// Если все совпавшие плановые заявки уже в прошлом, берётся самая поздняя из них.
function DSS_pickBookedAppointmentDate_(plannedDates, today) {
  const dates = (plannedDates || []).filter(Boolean).slice().sort((a, b) => a - b);
  if (!dates.length) return null;
  const future = dates.filter(d => d >= today);
  return future.length ? future[0] : dates[dates.length - 1];
}

// Сделку обрабатывает шаг «Дошёл»: контроль пропуска записи её не трогает.
function DSS_isAttendedByExistingRules_(effective, planned, done) {
  const onlyC = effective.size === 1 && effective.has(DSS_CONFIG.consultationCode);
  if (onlyC) return planned.has(DSS_CONFIG.consultationCode) || done.has(DSS_CONFIG.consultationCode);
  return done.size > 0;
}

// Типы, удерживающие сделку в записи. Консультация совпадением не считается:
// плановая консультация не удерживает сделку в «Записался».
function DSS_bookingMatchCodes_(effective) {
  const codes = new Set(effective);
  codes.delete(DSS_CONFIG.consultationCode);
  return codes;
}

// Заявка на сегодняшний день считается действующей записью: шаг запускается
// вечером, но перенос на сегодня безопаснее ошибочного «Пропустил запись» —
// на следующем запуске такая дата снова попадёт в проверку.
function DSS_findFutureBookingRequestDate_(requestRows, startDate, today, effective) {
  const matchCodes = DSS_bookingMatchCodes_(effective);
  if (!matchCodes.size) return null;
  let nearest = null;
  (requestRows || []).forEach(r => {
    const rd = DSS_date_(r['Дата']);
    if (!rd || rd < startDate || rd < today) return;
    let matched = false;
    DSS_codeSet_(r['Запланированы']).forEach(c => { if (matchCodes.has(c)) matched = true; });
    if (matched && (!nearest || rd < nearest)) nearest = rd;
  });
  return nearest;
}

// Сделка попадает в контроль пропуска записи, если стоит в рабочей стадии
// записи и дата «Записан на дату» уже прошла.
function DSS_isMissedAppointmentCandidate_(stageId, bookedDate, today) {
  if (DSS_MISSED_APPOINTMENT_STAGE_IDS.indexOf(String(stageId || '')) === -1) return false;
  const date = DSS_date_(bookedDate);
  return Boolean(date) && Boolean(today) && date < today;
}

/* Шаг 4: контроль пропуска записи.
 * Запускается вечером по свежей выгрузке заявок, когда заявки дня уже закрыты.
 * Отменённые заявки в агрегированный лист не попадают, поэтому слетевший
 * с записи пациент виден по отсутствию подходящих заявок.
 * Предложения уходят на тот же лист «Актуализация сделок» и отправляются
 * общим шагом подтверждения и батч-отправки. */
function DSS_actualizeMissedAppointments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const dealSheet = ss.getSheetByName(DSS_CONFIG.sheets.deals); const requestSheet = ss.getSheetByName(DSS_CONFIG.sheets.aggregated);
  if (!dealSheet || dealSheet.getLastRow() < 2) throw new Error('Сначала выполните пункт «2. Загрузить сделки из Bitrix».');
  if (!requestSheet || requestSheet.getLastRow() < 2) throw new Error('Сначала выполните пункт «1. Обработать заявки».');
  const deals = DSS_readObjects_(dealSheet); const requests = DSS_readObjects_(requestSheet); const dealTime = DSS_latestDate_(deals, 'Дата загрузки'); const requestTime = DSS_latestDate_(requests, 'Дата обработки');
  if (!DSS_isToday_(dealTime) || !DSS_isToday_(requestTime)) { const ui = SpreadsheetApp.getUi(); if (ui.alert('Предупреждение', 'Данные были подготовлены не сегодня. Контроль пропуска записи выполняется по свежей выгрузке заявок.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return; }
  const index = new Map(); requests.forEach(r => { const code = DSS_normalizePatientCode_(r['КлиентКод']); if (!code) return; if (!index.has(code)) index.set(code, []); index.get(code).push(r); });
  const stageInfo = DSS_loadStageDirectory_(); const now = new Date(); const today = DSS_today_();
  let transferred = 0, missed = 0, attended = 0, errors = 0;
  const rows = [];
  deals.forEach(d => {
    const stageId = String(d['Текущая стадия ID'] || '');
    const currentBookedDate = DSS_date_(d['Записан на дату']);
    if (!DSS_isMissedAppointmentCandidate_(stageId, currentBookedDate, today)) return;

    const id = String(d['ID сделки'] || ''); const patient = DSS_normalizePatientCode_(d['Код пациента']);
    const appointmentDate = DSS_date_(d['Дата назначения']); const firstTreatment = DSS_date_(d['Первый день лечения']); const codes = DSS_codeSet_(d['Типы назначений']);
    const startDate = DSS_getRequestMatchingStartDate_(appointmentDate, firstTreatment);
    let planned = new Set(), done = new Set(), bookedDate = '', targetId = '', targetName = '', result = 'Без изменений', reason = '';

    if (!patient) { result = 'Не найден код пациента'; reason = 'В сделке отсутствует код пациента UF_CRM_1783751141.'; errors += 1; }
    else if (!startDate) { result = 'Недостаточно данных'; reason = 'Невозможно проверить заявки: отсутствует дата назначения.'; errors += 1; }
    else if (!codes.size) { result = d['Ошибка данных'] ? 'Неизвестная номенклатура' : 'Недостаточно данных'; reason = String(d['Ошибка данных'] || 'Не указаны коды назначения.'); errors += 1; }
    else {
      const effective = DSS_effectiveDealCodes_(codes);
      const match = DSS_matchRequestsToDeal_(index.get(patient) || [], startDate, effective);
      planned = match.planned; done = match.done;
      if (DSS_isAttendedByExistingRules_(effective, planned, done)) {
        result = 'Без изменений'; reason = 'Есть начатая или выполненная заявка — сделку обрабатывает шаг «Дошёл».'; attended += 1;
      } else {
        const nextDate = DSS_findFutureBookingRequestDate_(index.get(patient) || [], startDate, today, effective);
        if (nextDate) {
          bookedDate = nextDate; result = 'Перенос записи';
          reason = 'Найдена плановая заявка на ' + DSS_iso_(nextDate) + ' с совпадающими типами записи: стадия не меняется, обновляется «Записан на дату».';
          transferred += 1;
        } else {
          targetId = DSS_STAGE_MISSED_APPOINTMENT; result = 'Пропустил запись';
          reason = 'Заявок с совпадающими типами записи нет: плановая консультация C записью не считается.';
          missed += 1;
        }
      }
    }

    // Отбираются только рабочие стадии записи, поэтому целевая стадия
    // «Пропустил запись» здесь всегда отличается от текущей.
    if (targetId) {
      const si = stageInfo.get(Number(d['CATEGORY_ID'] || 0));
      targetName = (si && si.byId.get(targetId)) || result;
    }

    rows.push([Boolean(targetId || bookedDate), id, d['Название'], patient, appointmentDate || '', firstTreatment || '', DSS_codes_(codes), DSS_codes_(planned), DSS_codes_(done), stageId, d['Текущая стадия'], targetId, targetName, bookedDate, result, reason, d['Дата загрузки'], requestTime || '', now, '', '']);
  });
  DSS_writeActualization_(ss, rows); DSS_log_(ss, 'Контроль пропуска записи', now);
  DSS_alert_('Контроль пропуска записи завершён.', 'Сделок с прошедшей датой записи: ' + rows.length + '.\nПредлагается перенос записи: ' + transferred + '.\nПредлагается «Пропустил запись»: ' + missed + '.\nОбрабатывается шагом «Дошёл»: ' + attended + '.\nСтрок с ошибками данных: ' + errors + '.\n\nПроверьте лист «' + DSS_CONFIG.sheets.actualization + '» и выполните пункт «5. Отправить изменения в Bitrix».');
}

function DSS_sendChangesToBitrixWithConfirmation() {
  const ui = SpreadsheetApp.getUi(); if (ui.alert('Отправка изменений в Bitrix', 'Будут обновлены стадии сделок и даты записи для строк, отмеченных флажком «Отправить» на листе «Актуализация сделок». Продолжить?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const sheet = ss.getSheetByName(DSS_CONFIG.sheets.actualization); if (!sheet || sheet.getLastRow() < 2) throw new Error('Нет подготовленных изменений для отправки.');
  const rows = DSS_readObjects_(sheet); const actualized = DSS_latestDate_(rows, 'Дата актуализации'); const deals = DSS_readObjects_(DSS_requiredSheet_(ss, DSS_CONFIG.sheets.deals)); const requests = DSS_readObjects_(DSS_requiredSheet_(ss, DSS_CONFIG.sheets.aggregated));
  if (DSS_latestDate_(deals, 'Дата загрузки') > actualized || DSS_latestDate_(requests, 'Дата обработки') > actualized) throw new Error('После актуализации исходные данные изменились. Повторно выполните пункт «3. Актуализировать сделки по заявкам» или «4. Проверить пропуск записи».');
  const candidates = rows.map((r, i) => ({ r, row: i + 2 })).filter(x => x.r['Отправить'] === true && x.r['ID сделки'] && DSS_hasActualizationChange_(x.r) && x.r['Статус отправки'] !== 'Отправлено');
  if (!candidates.length) { DSS_alert_('Отправка изменений в Bitrix', 'Нет подготовленных изменений для отправки.'); return; }
  const base = DSS_webhook_(); let success = 0, failed = 0, skipped = 0; const verified = [];
  candidates.forEach(item => { try { const current = DSS_call_(base, 'crm.deal.get', { id: item.r['ID сделки'] }).result || {}; if (String(current.STAGE_ID || '') !== String(item.r['Текущая стадия ID'])) { DSS_sendStatus_(sheet, item.row, 'Пропущено: стадия изменилась в Bitrix.', ''); skipped += 1; } else verified.push(item); } catch (e) { DSS_sendStatus_(sheet, item.row, 'Ошибка', DSS_safeError_(e)); failed += 1; } });
  for (let offset = 0; offset < verified.length; offset += DSS_CONFIG.batchSize) { const result = DSS_sendBitrixBatch_(base, verified.slice(offset, offset + DSS_CONFIG.batchSize)); result.forEach(x => { if (x.ok) { DSS_sendStatus_(sheet, x.item.row, 'Отправлено ' + DSS_datetime_(new Date()), ''); success += 1; } else { DSS_sendStatus_(sheet, x.item.row, 'Ошибка', x.error); failed += 1; } }); }
  DSS_log_(ss, 'Отправка изменений в Bitrix', new Date()); DSS_alert_('Отправка изменений в Bitrix завершена.', 'Отправлено успешно: ' + success + '.\nОшибок: ' + failed + '.\nПропущено: ' + skipped + '.');
}

// Отправляется либо перевод стадии, либо только новая дата записи:
// при переносе записи стадия сделки не меняется.
function DSS_hasActualizationChange_(row) {
  const targetId = String(row['Предлагаемая стадия ID'] || '');
  if (targetId && targetId !== String(row['Текущая стадия ID'] || '')) return true;
  return Boolean(DSS_date_(row['Записан на дату']));
}

/* Ежедневный отчёт в чат Bitrix */
function sendDailySalesReport(event) {
  // Триггерный запуск отличается от ручного наличием triggerUid в событии.
  const manual = !(event && event.triggerUid);
  const reportWindow = DSS_dailyReportWindow_(new Date());
  let message;

  try {
    message = DSS_formatDailyReportMessage_(DSS_collectDailyReport_(reportWindow));
  } catch (error) {
    DSS_reportDailyReportFailure_(reportWindow, DSS_safeError_(error), manual, true);
    return;
  }

  try {
    DSS_call_(DSS_webhook_(), 'im.message.add', { DIALOG_ID: DAILY_REPORT_CHAT_ID, MESSAGE: message });
  } catch (error) {
    // Отправка в чат недоступна (например, пользователь вебхука не состоит в чате),
    // поэтому повторное сообщение в тот же чат не отправляем.
    DSS_reportDailyReportFailure_(reportWindow, DSS_safeError_(error), manual, false);
    return;
  }

  if (manual) DSS_alert_('Итог дня отправлен', 'Отчёт за ' + reportWindow.label + ' отправлен в чат ' + DAILY_REPORT_CHAT_ID + '.');
}

function DSS_installDailyReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === DSS_DAILY_REPORT_FUNCTION) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(DSS_DAILY_REPORT_FUNCTION).timeBased()
    .atHour(DSS_DAILY_REPORT_TRIGGER_HOUR).nearMinute(0).everyDays(1)
    .inTimezone(DSS_CONFIG.timezone).create();
  DSS_alert_('Ежедневный отчёт', 'Триггер установлен: ежедневно в ' + DSS_DAILY_REPORT_TRIGGER_HOUR + ':00 (' + DSS_CONFIG.timezone + '), включая выходные.');
}

function DSS_reportDailyReportFailure_(reportWindow, message, manual, notifyChat) {
  const text = 'Отчёт за ' + reportWindow.label + ' не собран: ' + message;
  Logger.log(text);
  if (manual) { DSS_alert_('Итог дня не отправлен', text); return; }
  if (!notifyChat) return;
  try { DSS_call_(DSS_webhook_(), 'im.message.add', { DIALOG_ID: DAILY_REPORT_CHAT_ID, MESSAGE: text }); }
  catch (error) { Logger.log('Не удалось отправить сообщение об ошибке в чат: ' + DSS_safeError_(error)); }
}

// Границы отчётных суток: всё до 06:00 относится к предыдущему дню.
function DSS_dailyReportWindow_(now) {
  const shifted = new Date(now.getTime() - DSS_DAILY_REPORT_DAY_START_HOUR * 60 * 60 * 1000);
  const reportDay = Utilities.formatDate(shifted, DSS_CONFIG.timezone, 'yyyy-MM-dd');
  const parts = reportDay.split('-').map(Number);
  const startUtc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const nextUtc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
  const boundary = ' ' + ('0' + DSS_DAILY_REPORT_DAY_START_HOUR).slice(-2) + ':00:00';
  return {
    reportDay: reportDay,
    label: Utilities.formatDate(startUtc, 'UTC', 'dd.MM'),
    from: reportDay + boundary,
    to: Utilities.formatDate(nextUtc, 'UTC', 'yyyy-MM-dd') + boundary
  };
}

// Источник правды — только Bitrix: операторы меняют сделки вручную,
// поэтому листы таблицы в отчёте не используются.
function DSS_collectDailyReport_(reportWindow) {
  const base = DSS_webhook_();
  const report = {
    label: reportWindow.label,
    newDeals: {
      total: DSS_reportTotal_(), contact: DSS_reportTotal_(),
      waiting: DSS_reportTotal_(), intersection: DSS_reportTotal_(),
      clinicBooked: DSS_reportTotal_(), clinicStarted: DSS_reportTotal_()
    },
    booked: DSS_reportTotal_(), missed: DSS_reportTotal_(), won: DSS_reportTotal_(),
    lost: DSS_reportTotal_(), lostRefusal: DSS_reportTotal_(), lostNoContact: DSS_reportTotal_(),
    activities: { created: 0, completed: 0 }
  };

  const history = DSS_collectDailyReportStageHistory_(base, reportWindow);
  const creationStages = DSS_firstStageByDeal_(history);

  const created = DSS_list_(base, 'crm.deal.list', {
    order: { ID: 'ASC' },
    filter: { CATEGORY_ID: DSS_CONFIG.categoryId, '>=DATE_CREATE': reportWindow.from, '<DATE_CREATE': reportWindow.to },
    select: ['ID', 'STAGE_ID', 'OPPORTUNITY']
  });
  created.forEach(deal => {
    const amount = DSS_reportAmount_(deal.OPPORTUNITY);
    // Группировка по стадии создания, а не по текущей: «Начал в клинике»
    // робот мгновенно переводит в «Дошёл». Без истории берётся текущая стадия.
    const stageId = creationStages.get(String(deal.ID || '')) || String(deal.STAGE_ID || '');
    DSS_reportAdd_(report.newDeals.total, amount);
    // Прочие стадии учитываются только в общем счётчике новых сделок.
    if (stageId === DSS_REPORT_STAGE_CONTACT) DSS_reportAdd_(report.newDeals.contact, amount);
    else if (stageId === DSS_REPORT_STAGE_WAITING) DSS_reportAdd_(report.newDeals.waiting, amount);
    else if (stageId === DSS_REPORT_STAGE_INTERSECTION) DSS_reportAdd_(report.newDeals.intersection, amount);
    else if (stageId === DSS_STAGE_CLINIC_BOOKED) DSS_reportAdd_(report.newDeals.clinicBooked, amount);
    else if (stageId === DSS_STAGE_CLINIC_STARTED) DSS_reportAdd_(report.newDeals.clinicStarted, amount);
  });

  // «Дошёл» считается по всем переходам суток: сделки, созданные сегодня
  // в «Начал в клинике», сознательно попадают и в «Новые сделки», и в «Дошёл».
  const transitions = DSS_classifyStageTransitions_(history);
  const ids = new Set();
  Object.keys(transitions).forEach(key => transitions[key].forEach(id => ids.add(id)));
  const opportunities = DSS_fetchDealOpportunities_(base, Array.from(ids));
  const fill = (target, dealIds) => dealIds.forEach(id => DSS_reportAdd_(target, opportunities.get(id) || 0));
  fill(report.booked, transitions.booked);
  fill(report.missed, transitions.missed);
  fill(report.won, transitions.won);
  fill(report.lost, transitions.lost);
  fill(report.lostRefusal, transitions.lostRefusal);
  fill(report.lostNoContact, transitions.lostNoContact);

  report.activities = DSS_collectDailyReportActivities_(base, reportWindow);
  return report;
}

// История стадий за сутки: учитываются изменения и скриптом, и операторами.
// Из неё считаются и стадии создания новых сделок, и переходы за сутки.
function DSS_collectDailyReportStageHistory_(base, reportWindow) {
  return DSS_listStageHistory_(base, {
    entityTypeId: 2,
    order: { ID: 'ASC' },
    filter: { CATEGORY_ID: DSS_CONFIG.categoryId, '>=CREATED_TIME': reportWindow.from, '<CREATED_TIME': reportWindow.to },
    select: ['ID', 'OWNER_ID', 'CREATED_TIME', 'CATEGORY_ID', 'STAGE_ID']
  });
}

// Стадия создания сделки — первая запись crm.stagehistory.list по сделке.
// История приходит в порядке возрастания ID, поэтому берётся первое вхождение.
function DSS_firstStageByDeal_(history) {
  const out = new Map();
  history.forEach(item => {
    const dealId = String(item.OWNER_ID || '');
    if (!dealId || out.has(dealId)) return;
    out.set(dealId, String(item.STAGE_ID || ''));
  });
  return out;
}

// history — записи истории стадий за сутки в порядке возрастания ID.
function DSS_classifyStageTransitions_(history) {
  const byDeal = new Map();
  history.forEach(item => {
    const dealId = String(item.OWNER_ID || '');
    if (!dealId) return;
    if (!byDeal.has(dealId)) byDeal.set(dealId, []);
    byDeal.get(dealId).push(String(item.STAGE_ID || ''));
  });

  const result = { booked: new Set(), missed: new Set(), won: new Set(), lost: new Set(), lostRefusal: new Set(), lostNoContact: new Set() };
  byDeal.forEach((stages, dealId) => {
    stages.forEach((stageId, index) => {
      if (stageId === DSS_REPORT_STAGE_BOOKED) result.booked.add(dealId);
      else if (stageId === DSS_REPORT_STAGE_MISSED) result.missed.add(dealId);
      else if (stageId === DSS_REPORT_STAGE_WON) result.won.add(dealId);
      else if (stageId === DSS_REPORT_STAGE_LOSE && !result.lost.has(dealId)) {
        result.lost.add(dealId);
        // Разбивка по предыдущей стадии той же сделки: транзитные «Отказ»
        // и «Не вышел на связь» робот сразу переводит в «Провал».
        const previous = index > 0 ? stages[index - 1] : '';
        if (previous === DSS_REPORT_STAGE_REFUSAL) result.lostRefusal.add(dealId);
        else if (previous === DSS_REPORT_STAGE_NO_CONTACT) result.lostNoContact.add(dealId);
      }
    });
  });
  return result;
}

// crm.activity.list не фильтрует по воронке, поэтому дела сначала
// отбираются по OWNER_TYPE_ID = 2, а затем по принадлежности сделке воронки 114.
function DSS_collectDailyReportActivities_(base, reportWindow) {
  const created = DSS_list_(base, 'crm.activity.list', {
    order: { ID: 'ASC' },
    filter: { OWNER_TYPE_ID: 2, '>=CREATED': reportWindow.from, '<CREATED': reportWindow.to },
    select: ['ID', 'OWNER_ID', 'CREATED']
  });
  const completed = DSS_list_(base, 'crm.activity.list', {
    order: { ID: 'ASC' },
    filter: { OWNER_TYPE_ID: 2, COMPLETED: 'Y', '>=LAST_UPDATED': reportWindow.from, '<LAST_UPDATED': reportWindow.to },
    select: ['ID', 'OWNER_ID', 'LAST_UPDATED']
  });
  const ownerIds = new Set();
  created.concat(completed).forEach(item => { const id = String(item.OWNER_ID || ''); if (id) ownerIds.add(id); });
  const inCategory = DSS_filterDealIdsByCategory_(base, Array.from(ownerIds));
  const count = items => items.filter(item => inCategory.has(String(item.OWNER_ID || ''))).length;
  return { created: count(created), completed: count(completed) };
}

// crm.stagehistory.list возвращает result.items, поэтому DSS_list_,
// ожидающий массив в result, здесь неприменим.
function DSS_listStageHistory_(base, params) {
  let start = 0, guard = 0, items = [];
  while (guard++ < 10000) {
    let out;
    try { out = DSS_call_(base, 'crm.stagehistory.list', Object.assign({}, params, { start })); }
    catch (error) { throw new Error('Ошибка при выполнении crm.stagehistory.list, start=' + start + ', уже загружено=' + items.length + '. ' + DSS_safeError_(error)); }
    const page = out.result && Array.isArray(out.result.items) ? out.result.items : [];
    items = items.concat(page);
    if (out.next === undefined || out.next === null || out.next === '') break;
    const next = Number(out.next);
    if (!Number.isFinite(next) || next <= start) throw new Error('Bitrix вернул некорректное значение next для crm.stagehistory.list: ' + String(out.next));
    start = next;
  }
  return items;
}

function DSS_fetchDealOpportunities_(base, ids) {
  const result = new Map();
  for (let offset = 0; offset < ids.length; offset += DSS_CONFIG.batchSize) {
    DSS_list_(base, 'crm.deal.list', {
      order: { ID: 'ASC' },
      filter: { '@ID': ids.slice(offset, offset + DSS_CONFIG.batchSize) },
      select: ['ID', 'OPPORTUNITY']
    }).forEach(deal => result.set(String(deal.ID), DSS_reportAmount_(deal.OPPORTUNITY)));
  }
  return result;
}

function DSS_filterDealIdsByCategory_(base, ids) {
  const found = new Set();
  for (let offset = 0; offset < ids.length; offset += DSS_CONFIG.batchSize) {
    DSS_list_(base, 'crm.deal.list', {
      order: { ID: 'ASC' },
      filter: { CATEGORY_ID: DSS_CONFIG.categoryId, '@ID': ids.slice(offset, offset + DSS_CONFIG.batchSize) },
      select: ['ID']
    }).forEach(deal => found.add(String(deal.ID)));
  }
  return found;
}

function DSS_reportTotal_() { return { count: 0, amount: 0 }; }
function DSS_reportAmount_(value) { return value === undefined || value === null || value === '' ? 0 : Number(value) || 0; }
function DSS_reportAdd_(target, amount) { target.count += 1; target.amount += amount; }
function DSS_reportMoney_(value) { return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
function DSS_reportValue_(total) { return (total ? total.count : 0) + ' на ' + DSS_reportMoney_(total ? total.amount : 0); }

// Формат согласован с заказчиком: нулевые строки выводятся,
// «Повторные касания. Не дозвоны» в отчёт не включаются.
function DSS_formatDailyReportMessage_(report) {
  return [
    '📊 Итоги дня ' + report.label,
    '',
    'Новые сделки: ' + DSS_reportValue_(report.newDeals.total),
    '• Связаться: ' + DSS_reportValue_(report.newDeals.contact),
    '• Ожидание: ' + DSS_reportValue_(report.newDeals.waiting),
    '• Пересечения: ' + DSS_reportValue_(report.newDeals.intersection),
    '• Записался в клинике: ' + DSS_reportValue_(report.newDeals.clinicBooked),
    '• Начал в клинике: ' + DSS_reportValue_(report.newDeals.clinicStarted),
    '',
    'Движение по стадиям:',
    '• Записался: ' + DSS_reportValue_(report.booked),
    '• Пропустил запись: ' + DSS_reportValue_(report.missed),
    '',
    'Финализировано:',
    '• Дошёл: ' + DSS_reportValue_(report.won),
    '• Провалено: ' + DSS_reportValue_(report.lost),
    '  — отказ: ' + DSS_reportValue_(report.lostRefusal),
    '  — не вышел на связь: ' + DSS_reportValue_(report.lostNoContact),
    '',
    'Дела: создано ' + report.activities.created + ', завершено ' + report.activities.completed
  ].join('\n');
}

function DSS_testDailyReportWindow_() {
  const assertEqual = (actual, expected, message) => { if (actual !== expected) throw new Error(message + ' Ожидалось: ' + expected + ', получено: ' + actual + '.'); };
  // Время задаётся в UTC: Europe/Moscow = UTC+3 круглый год.
  const msk = (year, month, day, hour, minute) => new Date(Date.UTC(year, month - 1, day, hour - 3, minute || 0));

  const evening = DSS_dailyReportWindow_(msk(2026, 7, 31, 20, 0));
  assertEqual(evening.reportDay, '2026-07-31', 'Запуск 31.07 в 20:00 должен давать отчёт за 31.07.');
  assertEqual(evening.from, '2026-07-31 06:00:00', 'Начало окна — 31.07 06:00.');
  assertEqual(evening.to, '2026-08-01 06:00:00', 'Конец окна — 01.08 06:00.');
  assertEqual(evening.label, '31.07', 'Заголовок отчёта — дата отчётных суток.');

  const night = DSS_dailyReportWindow_(msk(2026, 8, 1, 2, 0));
  assertEqual(night.reportDay, '2026-07-31', 'Запуск 01.08 в 02:00 должен давать отчёт за 31.07.');
  assertEqual(night.from, '2026-07-31 06:00:00', 'Ночной запуск использует то же окно.');
  assertEqual(night.to, '2026-08-01 06:00:00', 'Ночной запуск использует то же окно.');
  assertEqual(night.label, '31.07', 'Ночной запуск сохраняет дату предыдущего дня.');

  assertEqual(DSS_dailyReportWindow_(msk(2026, 8, 1, 5, 59)).reportDay, '2026-07-31', 'В 05:59 сутки ещё предыдущие.');
  assertEqual(DSS_dailyReportWindow_(msk(2026, 8, 1, 6, 0)).reportDay, '2026-08-01', 'В 06:00 начинаются новые сутки.');
  assertEqual(DSS_dailyReportWindow_(msk(2026, 8, 1, 23, 30)).label, '01.08', 'Запуск 01.08 в 23:30 — отчёт за 01.08.');

  return 'DSS_testDailyReportWindow_: OK';
}

function DSS_testDailyReportTransitions_() {
  const entry = (dealId, stageId) => ({ OWNER_ID: dealId, STAGE_ID: stageId });
  const list = set => Array.from(set).sort().join(',');
  const result = DSS_classifyStageTransitions_([
    // Сделка 1: «Отказ → Провал» — только в «Провалено», подстрока «отказ».
    entry('1', DSS_REPORT_STAGE_REFUSAL), entry('1', DSS_REPORT_STAGE_LOSE),
    // Сделка 2: «Не вышел на связь → Провал».
    entry('2', DSS_REPORT_STAGE_NO_CONTACT), entry('2', DSS_REPORT_STAGE_LOSE),
    // Сделка 3: провал без транзитной стадии — только в общей сумме.
    entry('3', DSS_REPORT_STAGE_CONTACT), entry('3', DSS_REPORT_STAGE_LOSE),
    // Сделка 4: дважды «Записался» за сутки — считается один раз.
    entry('4', DSS_REPORT_STAGE_BOOKED), entry('4', DSS_REPORT_STAGE_WAITING), entry('4', DSS_REPORT_STAGE_BOOKED),
    // Сделка 5: «Записался → Дошёл».
    entry('5', DSS_REPORT_STAGE_BOOKED), entry('5', DSS_REPORT_STAGE_WON),
    // Сделка 6: создана в «Начал в клинике», робот сразу перевёл её в «Дошёл».
    entry('6', DSS_STAGE_CLINIC_STARTED), entry('6', DSS_REPORT_STAGE_WON),
    // Сделка 7: создана в «Записался в клинике» и за сутки не двигалась.
    entry('7', DSS_STAGE_CLINIC_BOOKED),
    // Сделка 8: слетела с записи — «Записался → Пропустил запись».
    entry('8', DSS_REPORT_STAGE_BOOKED), entry('8', DSS_REPORT_STAGE_MISSED)
  ]);

  const checks = [
    ['booked', '4,5,8'], ['missed', '8'], ['won', '5,6'], ['lost', '1,2,3'], ['lostRefusal', '1'], ['lostNoContact', '2']
  ];
  checks.forEach(check => {
    if (list(result[check[0]]) !== check[1]) {
      throw new Error('Неверный состав категории ' + check[0] + '. Ожидалось: ' + check[1] + ', получено: ' + list(result[check[0]]) + '.');
    }
  });
  if (result.booked.has('1')) throw new Error('Сделка «Отказ → Провал» не должна попадать в движение по стадиям.');
  if (result.booked.has('6') || result.booked.has('7')) throw new Error('Стадии «в клинике» не попадают в «Записался» блока «Движение».');

  return 'DSS_testDailyReportTransitions_: OK';
}

// Группировка новых сделок ведётся по стадии создания: «Начал в клинике»
// робот мгновенно переводит в «Дошёл», по текущей стадии её не посчитать.
function DSS_testDailyReportCreationStages_() {
  const entry = (dealId, stageId) => ({ OWNER_ID: dealId, STAGE_ID: stageId });
  const stages = DSS_firstStageByDeal_([
    entry('6', DSS_STAGE_CLINIC_STARTED), entry('6', DSS_REPORT_STAGE_WON),
    entry('7', DSS_STAGE_CLINIC_BOOKED),
    entry('8', DSS_REPORT_STAGE_CONTACT), entry('8', DSS_REPORT_STAGE_BOOKED)
  ]);

  const checks = [
    ['6', DSS_STAGE_CLINIC_STARTED, 'Сделка «Начал в клинике → Дошёл» считается по стадии создания.'],
    ['7', DSS_STAGE_CLINIC_BOOKED, 'Сделка без переходов считается по своей стадии создания.'],
    ['8', DSS_REPORT_STAGE_CONTACT, 'Стадия создания не подменяется более поздним переходом.']
  ];
  checks.forEach(check => {
    if (stages.get(check[0]) !== check[1]) {
      throw new Error(check[2] + ' Ожидалось: ' + check[1] + ', получено: ' + stages.get(check[0]) + '.');
    }
  });
  if (stages.has('9')) throw new Error('Для сделки без записей истории стадия создания не определяется — берётся текущая.');

  return 'DSS_testDailyReportCreationStages_: OK';
}

// «Записался в клинике» → «Дошёл» рассчитывается, → «Записался» — нет.
function DSS_testClinicBookedTransitions_() {
  const stageInfo = { bookedId: DSS_REPORT_STAGE_BOOKED, attendedId: DSS_REPORT_STAGE_WON };

  if (!DSS_isClinicBookedToBookedTransition_(DSS_STAGE_CLINIC_BOOKED, DSS_REPORT_STAGE_BOOKED, stageInfo)) {
    throw new Error('Переход «Записался в клинике» → «Записался» выполняться не должен.');
  }
  if (DSS_isClinicBookedToBookedTransition_(DSS_STAGE_CLINIC_BOOKED, DSS_REPORT_STAGE_WON, stageInfo)) {
    throw new Error('Переход «Записался в клинике» → «Дошёл» должен рассчитываться.');
  }
  if (DSS_isClinicBookedToBookedTransition_(DSS_REPORT_STAGE_CONTACT, DSS_REPORT_STAGE_BOOKED, stageInfo)) {
    throw new Error('Из обычных стадий перевод в «Записался» должен рассчитываться.');
  }
  if (DSS_isClinicBookedToBookedTransition_(DSS_STAGE_CLINIC_BOOKED, '', stageInfo)) {
    throw new Error('Без целевой стадии проверка не применяется.');
  }
  if (DSS_ACTUALIZATION_STAGE_IDS.indexOf(DSS_STAGE_CLINIC_BOOKED) === -1) {
    throw new Error('«Записался в клинике» должна попадать в актуализацию.');
  }
  if (DSS_ACTUALIZATION_STAGE_IDS.indexOf(DSS_STAGE_CLINIC_STARTED) !== -1) {
    throw new Error('«Начал в клинике» — транзитная стадия, в актуализацию не попадает.');
  }

  return 'DSS_testClinicBookedTransitions_: OK';
}

// Контроль пропуска записи: отбор кандидатов, совпадение типов без C,
// ветвление «перенос записи» / «Пропустил запись».
function DSS_testMissedAppointmentActualization_() {
  const assertEqual = (actual, expected, message) => { if (actual !== expected) throw new Error(message + ' Ожидалось: ' + expected + ', получено: ' + actual + '.'); };
  const assertTrue = (actual, message) => { if (!actual) throw new Error(message); };
  const d = (year, month, day) => new Date(year, month - 1, day);
  const request = (date, planned, done) => ({ 'Дата': date, 'Запланированы': planned || '', 'Выполнены': done || '' });
  const today = d(2026, 8, 2);

  // Отбор кандидатов: рабочая стадия записи и прошедшая дата записи.
  assertTrue(DSS_isMissedAppointmentCandidate_('C114:EXECUTING', d(2026, 8, 1), today), 'Сделка «Записался» с прошедшей датой записи проверяется.');
  assertTrue(DSS_isMissedAppointmentCandidate_(DSS_STAGE_CLINIC_BOOKED, d(2026, 7, 20), today), 'Сделка «Записался в клинике» с прошедшей датой записи проверяется.');
  assertTrue(DSS_isMissedAppointmentCandidate_('C114:UC_G5EXVL', d(2026, 8, 1), today), 'Сделка «Запись по горящей акции» с прошедшей датой записи проверяется.');
  assertTrue(!DSS_isMissedAppointmentCandidate_('C114:EXECUTING', d(2026, 8, 2), today), 'Дата записи «сегодня» ещё не считается пропущенной.');
  assertTrue(!DSS_isMissedAppointmentCandidate_('C114:EXECUTING', d(2026, 8, 5), today), 'Будущая дата записи шагом не затрагивается.');
  assertTrue(!DSS_isMissedAppointmentCandidate_('C114:EXECUTING', '', today), 'Без даты записи сделка не проверяется.');
  assertTrue(!DSS_isMissedAppointmentCandidate_('C114:NEW', d(2026, 8, 1), today), 'Стадии вне записи шагом не затрагиваются.');
  assertTrue(!DSS_isMissedAppointmentCandidate_(DSS_STAGE_MISSED_APPOINTMENT, d(2026, 8, 1), today), 'Сделка уже в «Пропустил запись» повторно не переводится.');

  // Выполненная заявка — сделку обрабатывает шаг «Дошёл».
  assertTrue(DSS_isAttendedByExistingRules_(new Set(['L']), new Set(), new Set(['L'])), 'Выполненная заявка отдаётся шагу «Дошёл».');
  assertTrue(DSS_isAttendedByExistingRules_(new Set(['C']), new Set(['C']), new Set()), 'Сделка только с консультацией отдаётся шагу «Дошёл» по плановой C.');
  assertTrue(!DSS_isAttendedByExistingRules_(new Set(['L', 'M']), new Set(['L']), new Set()), 'Только плановая заявка шагу «Дошёл» не отдаётся.');

  // Совпадение — только по типам записи, консультация C не считается.
  assertEqual(DSS_codes_(DSS_bookingMatchCodes_(new Set(['L', 'C']))), 'L', 'Консультация исключается из типов записи.');
  assertEqual(DSS_codes_(DSS_bookingMatchCodes_(new Set(['C']))), '', 'Для сделки только с консультацией типов записи нет.');

  const start = d(2026, 7, 1);
  const found = DSS_findFutureBookingRequestDate_([
    request(d(2026, 8, 5), 'L'), request(d(2026, 8, 3), 'L'), request(d(2026, 7, 25), 'L')
  ], start, today, new Set(['L']));
  assertTrue(found && found.getTime() === d(2026, 8, 3).getTime(), 'Берётся ближайшая подходящая будущая заявка.');
  assertTrue(!DSS_findFutureBookingRequestDate_([request(d(2026, 8, 3), 'C')], start, today, new Set(['L', 'C'])), 'Плановая консультация не удерживает сделку в записи.');
  assertTrue(!DSS_findFutureBookingRequestDate_([request(d(2026, 8, 3), 'M')], start, today, new Set(['L'])), 'Заявка с несовпадающими типами переносом не является.');
  assertTrue(!DSS_findFutureBookingRequestDate_([request(d(2026, 7, 25), 'L')], start, today, new Set(['L'])), 'Прошедшая заявка переносом не является.');
  assertTrue(!DSS_findFutureBookingRequestDate_([request(d(2026, 8, 3), 'L')], start, today, new Set(['C'])), 'Для сделки только с консультацией совпадений не бывает.');
  assertTrue(!DSS_findFutureBookingRequestDate_([request(d(2026, 8, 3), '', 'L')], start, today, new Set(['L'])), 'Выполненная заявка переносом не является.');

  // Дата записи при переводе в «Записался»: ближайшая будущая заявка.
  const picked = DSS_pickBookedAppointmentDate_([d(2026, 8, 10), d(2026, 8, 4), d(2026, 7, 20)], today);
  assertTrue(picked && picked.getTime() === d(2026, 8, 4).getTime(), 'В «Записан на дату» уходит ближайшая будущая заявка.');
  const onlyPast = DSS_pickBookedAppointmentDate_([d(2026, 7, 20), d(2026, 7, 28)], today);
  assertTrue(onlyPast && onlyPast.getTime() === d(2026, 7, 28).getTime(), 'Если будущих заявок нет, берётся самая поздняя из прошедших.');
  assertTrue(DSS_pickBookedAppointmentDate_([], today) === null, 'Без совпавших заявок дата записи не определяется.');

  // Отправка: перенос идёт без смены стадии, перевод — со стадией.
  const transfer = { 'ID сделки': '10', 'Текущая стадия ID': 'C114:EXECUTING', 'Предлагаемая стадия ID': '', 'Записан на дату': d(2026, 8, 3) };
  const missed = { 'ID сделки': '11', 'Текущая стадия ID': 'C114:EXECUTING', 'Предлагаемая стадия ID': DSS_STAGE_MISSED_APPOINTMENT, 'Записан на дату': '' };
  assertTrue(DSS_hasActualizationChange_(transfer), 'Перенос записи без смены стадии должен отправляться.');
  assertTrue(DSS_hasActualizationChange_(missed), 'Перевод в «Пропустил запись» должен отправляться.');
  assertTrue(!DSS_hasActualizationChange_({ 'ID сделки': '12', 'Текущая стадия ID': 'C114:EXECUTING', 'Предлагаемая стадия ID': '', 'Записан на дату': '' }), 'Строка без изменений не отправляется.');
  assertTrue(!DSS_hasActualizationChange_({ 'ID сделки': '13', 'Текущая стадия ID': 'C114:EXECUTING', 'Предлагаемая стадия ID': 'C114:EXECUTING', 'Записан на дату': '' }), 'Совпадающая стадия изменением не является.');

  assertEqual(DSS_buildDealUpdateCommand_(transfer), 'crm.deal.update?id=10&fields[' + DSS_DEAL_BOOKED_DATE_FIELD + ']=2026-08-03', 'Перенос обновляет только «Записан на дату».');
  assertEqual(DSS_buildDealUpdateCommand_(missed), 'crm.deal.update?id=11&fields[STAGE_ID]=' + encodeURIComponent(DSS_STAGE_MISSED_APPOINTMENT), 'Пропуск записи обновляет только стадию.');

  if (DSS_ACTUALIZATION_STAGE_IDS.indexOf(DSS_STAGE_MISSED_APPOINTMENT) === -1) {
    throw new Error('«Пропустил запись» должна попадать в актуализацию: вернувшийся пациент обрабатывается штатно.');
  }
  if (DSS_MISSED_APPOINTMENT_STAGE_IDS.indexOf(DSS_STAGE_MISSED_APPOINTMENT) !== -1) {
    throw new Error('Из «Пропустил запись» повторный пропуск записи не рассчитывается.');
  }
  if (DSS_ACTUALIZATION_HEADERS.indexOf('Записан на дату') === -1 || DSS_DEAL_HEADERS.indexOf('Записан на дату') === -1) {
    throw new Error('Колонка «Записан на дату» должна быть на листах сделок и актуализации.');
  }

  return 'DSS_testMissedAppointmentActualization_: OK';
}

function DSS_testDailyReportMessage_() {
  const total = (count, amount) => ({ count, amount });
  const message = DSS_formatDailyReportMessage_({
    label: '31.07',
    newDeals: {
      total: total(20, 640000), contact: total(8, 290000), waiting: total(4, 122000), intersection: total(2, 74000),
      clinicBooked: total(3, 82000), clinicStarted: total(3, 72000)
    },
    booked: total(9, 312000), missed: total(2, 51000), won: total(6, 214000), lost: total(9, 254000),
    lostRefusal: total(4, 96000), lostNoContact: total(5, 158000),
    activities: { created: 37, completed: 29 }
  });
  const expected = [
    '📊 Итоги дня 31.07', '',
    'Новые сделки: 20 на 640 000 ₽',
    '• Связаться: 8 на 290 000 ₽',
    '• Ожидание: 4 на 122 000 ₽',
    '• Пересечения: 2 на 74 000 ₽',
    '• Записался в клинике: 3 на 82 000 ₽',
    '• Начал в клинике: 3 на 72 000 ₽', '',
    'Движение по стадиям:',
    '• Записался: 9 на 312 000 ₽',
    '• Пропустил запись: 2 на 51 000 ₽', '',
    'Финализировано:',
    '• Дошёл: 6 на 214 000 ₽',
    '• Провалено: 9 на 254 000 ₽',
    '  — отказ: 4 на 96 000 ₽',
    '  — не вышел на связь: 5 на 158 000 ₽', '',
    'Дела: создано 37, завершено 29'
  ].join('\n');
  if (message !== expected) throw new Error('Формат отчёта не совпадает с согласованным образцом:\n' + message);

  const zero = DSS_formatDailyReportMessage_({
    label: '01.08',
    newDeals: {
      total: DSS_reportTotal_(), contact: DSS_reportTotal_(), waiting: DSS_reportTotal_(),
      intersection: DSS_reportTotal_(), clinicBooked: DSS_reportTotal_(), clinicStarted: DSS_reportTotal_()
    },
    booked: DSS_reportTotal_(), missed: DSS_reportTotal_(), won: DSS_reportTotal_(),
    lost: DSS_reportTotal_(), lostRefusal: DSS_reportTotal_(), lostNoContact: DSS_reportTotal_(),
    activities: { created: 0, completed: 0 }
  });
  if (zero.indexOf('• Записался: 0 на 0 ₽') === -1) throw new Error('Нулевые строки должны выводиться.');
  if (zero.indexOf('• Пропустил запись: 0 на 0 ₽') === -1) throw new Error('Нулевая строка «Пропустил запись» должна выводиться.');
  if (DSS_reportMoney_(1234567) !== '1 234 567 ₽') throw new Error('Разделитель тысяч — пробел, без копеек.');

  return 'DSS_testDailyReportMessage_: OK';
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
function DSS_writeActualization_(ss, rows) { DSS_writeSheet_(ss, DSS_CONFIG.sheets.actualization, DSS_ACTUALIZATION_HEADERS, rows, { dates: [5,6,14], dateTimes: [17,18,19] }); const s = ss.getSheetByName(DSS_CONFIG.sheets.actualization); s.getRange(2,1,Math.max(rows.length,1),1).insertCheckboxes(); }
function DSS_prepareSheet_(ss, name, headers) { let s = ss.getSheetByName(name); if(!s) s = ss.insertSheet(name); if (s.getFilter()) s.getFilter().remove(); s.clear(); s.getRange(1,1,1,headers.length).setValues([headers]); return s; }
function DSS_requiredSheet_(ss, name) { const s = ss.getSheetByName(name); if(!s) throw new Error('Не найден обязательный лист "' + name + '".'); return s; }
function DSS_readObjects_(sheet) { const values = sheet.getDataRange().getValues(), display = sheet.getDataRange().getDisplayValues(); if(!values.length) return []; const h = display[0].map(x => String(x || '').trim()); return values.slice(1).map((row,i) => { const x = {}; h.forEach((k,j) => x[k] = row[j]); return x; }); }
// Колонки статуса отправки берутся из заголовков: их номера сдвигаются
// при добавлении колонок на лист актуализации.
function DSS_sendStatus_(sheet, row, status, error) { sheet.getRange(row, DSS_ACTUALIZATION_HEADERS.indexOf('Статус отправки') + 1, 1, 2).setValues([[status,error]]); }
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

function DSS_testBotulinumTypeCode_() {
  const assertEqual = (actual, expected, message) => {
    if (actual !== expected) throw new Error(message + ' Ожидалось: ' + expected + ', получено: ' + actual + '.');
  };
  const assertTrue = (actual, message) => { if (!actual) throw new Error(message); };
  const resolveResult = (dealCodes, requests) => {
    const effective = DSS_codeSet_(dealCodes);
    if (effective.size > 1) effective.delete(DSS_CONFIG.consultationCode);
    const planned = new Set(), done = new Set();
    requests.forEach(r => {
      DSS_codeSet_(r.planned).forEach(c => { if (effective.has(c)) planned.add(c); });
      DSS_codeSet_(r.done).forEach(c => { if (effective.has(c)) done.add(c); });
    });
    if (done.size) return 'Дошёл';
    if (planned.size) return 'Записался';
    return 'Подходящие заявки не найдены';
  };

  assertEqual(DSS_serviceCode_('B'), 'B', 'B должен быть допустимым кодом.');
  assertEqual(DSS_normalizeDealTypeCodes_('LB'), 'LB', 'Нормализация LB должна сохранять B.');
  assertTrue(DSS_codeSet_('B').has('B'), 'Набор кодов должен содержать B.');
  assertEqual(DSS_codes_(new Set(['B', 'L'])), 'LB', 'Сортировка B, L должна давать LB.');
  assertEqual(resolveResult('B', [{ planned: 'B', done: '' }]), 'Записался', 'Плановая заявка B должна давать Записался.');
  assertEqual(resolveResult('B', [{ planned: '', done: 'B' }]), 'Дошёл', 'Выполненная заявка B должна давать Дошёл.');
  assertEqual(resolveResult('B', [{ planned: 'L', done: '' }]), 'Подходящие заявки не найдены', 'Заявка L не должна подходить к сделке B.');
  assertEqual(resolveResult('B', [{ planned: 'B', done: '', branch: 'Другой филиал' }]), 'Записался', 'Филиал не должен препятствовать сопоставлению B.');

  return 'DSS_testBotulinumTypeCode_: OK';
}

function DSS_scriptTimeZone_() { return Session.getScriptTimeZone(); }
function DSS_today_() { return DSS_date_(Utilities.formatDate(new Date(), DSS_scriptTimeZone_(), 'yyyy-MM-dd')); }
function DSS_iso_(d) { return Utilities.formatDate(d, DSS_scriptTimeZone_(), 'yyyy-MM-dd'); }
function DSS_datetime_(d) { return Utilities.formatDate(d, DSS_scriptTimeZone_(), 'dd.MM.yyyy HH:mm:ss'); }
function DSS_addDays_(d,n) { const x = new Date(d.getFullYear(),d.getMonth(),d.getDate()); x.setDate(x.getDate()+n); return x; }
function DSS_latestDate_(rows, field) { return rows.reduce((max,r) => { const d = r[field] instanceof Date ? r[field] : new Date(r[field]); return !isNaN(d) && (!max || d > max) ? d : max; }, null); }
function DSS_isToday_(d) { return d && DSS_iso_(d) === DSS_iso_(DSS_today_()); }
function DSS_safeError_(e) { return String(e && e.message || e || 'Неизвестная ошибка').replace(/https?:\/\/[^\s]+/g, '[скрыто]').slice(0,500); }
// Команда batch для одной строки актуализации: стадия и/или «Записан на дату».
// При переносе записи стадия не передаётся — сделка остаётся в своей стадии.
function DSS_buildDealUpdateCommand_(row) {
  const parts = ['crm.deal.update?id=' + encodeURIComponent(row['ID сделки'])];
  const targetId = String(row['Предлагаемая стадия ID'] || '');
  if (targetId && targetId !== String(row['Текущая стадия ID'] || '')) {
    parts.push('fields[STAGE_ID]=' + encodeURIComponent(targetId));
  }
  const bookedDate = DSS_date_(row['Записан на дату']);
  if (bookedDate) {
    parts.push('fields[' + DSS_DEAL_BOOKED_DATE_FIELD + ']=' + encodeURIComponent(DSS_iso_(bookedDate)));
  }
  return parts.join('&');
}

function DSS_saveStageDirectory_(directory) { const data = {}; directory.forEach((x, category) => { data[category] = { stages: Array.from(x.byId.entries()), bookedId: x.bookedId || '', attendedId: x.attendedId || '' }; }); PropertiesService.getDocumentProperties().setProperty('DSS_STAGE_DIRECTORY', JSON.stringify(data)); }
function DSS_loadStageDirectory_() { const raw = PropertiesService.getDocumentProperties().getProperty('DSS_STAGE_DIRECTORY'); const result = new Map(); if (!raw) return result; try { const data = JSON.parse(raw); Object.keys(data).forEach(category => { const x = data[category]; result.set(Number(category), { byId: new Map(x.stages || []), bookedId: x.bookedId || '', attendedId: x.attendedId || '' }); }); } catch (e) { return new Map(); } return result; }
function DSS_sendBitrixBatch_(base, items) { const cmd = {}; items.forEach((item, i) => { cmd['d' + i] = DSS_buildDealUpdateCommand_(item.r); }); try { const out = DSS_call_(base, 'batch', { halt: 0, cmd }).result || {}; const success = out.result || {}, errors = out.result_error || {}; return items.map((item, i) => ({ item, ok: success['d' + i] === true, error: DSS_safeError_(errors['d' + i] || 'Bitrix не подтвердил обновление.') })); } catch (e) { return items.map(item => ({ item, ok: false, error: DSS_safeError_(e) })); } }

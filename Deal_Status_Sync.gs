/****************************************************
 * TEMED — пошаговая сверка сделок Bitrix с заявками.
 * Каждый публичный этап запускается только вручную из меню.
 ****************************************************/

const DSS_CONFIG = Object.freeze({
  timezone: 'Europe/Moscow',
  sheets: {
    requests: 'Заявки',
    registry: 'Реестр отправки Bitrix',
    nomenclature: 'Коды номенклатуры',
    aggregated: 'Заявки агрегированные',
    deals: 'Сделки Bitrix',
    actualization: 'Актуализация сделок',
    log: 'Журнал статусов Bitrix',
    stages: 'Стадии Bitrix'
  },
  categoryId: 114,
  requestColumns: { patientCode: 'КлиентКод', patientName: 'Клиент', startDate: 'ДатаНачала', state: 'Состояние', nomenclature: 'НоменклатураНаименование' },
  fieldOverrides: { patientCode: '', firstPlanDate: 'UF_CRM_1783751996', composition: 'UF_CRM_1783752197' },
  fieldAliases: {
    patientCode: ['Пациент.Код', 'Код пациента', 'TEMED_PATIENT_CODE', 'PATIENT_CODE'],
    firstPlanDate: ['Первый плановый день', 'Первый день лечения', 'Дата начала лечения', 'TEMED_FIRST_PLAN_DATE']
  },
  dealCheckDaysAfterTreatmentStart: 30,
  requestMatchWindowDays: 30,
  stageNames: { booked: 'Записался', attended: 'Дошёл' },
  ignoredCode: '-', consultationCode: 'C', serviceCodeOrder: 'CLFMSUIPDABEGHJKNOQRTVWXYZ', batchSize: 50,
  doneStates: ['Начато', 'Выполнена', 'Выполнено', 'Завершена', 'Завершено', 'Оказана', 'Оказано', 'Прием состоялся', 'Приём состоялся', 'Состоялась', 'Состоялся'],
  plannedStates: ['Запланирована', 'Запланировано', 'Подтвердил запись', 'Подтверждена', 'Подтверждено', 'Записан', 'Записана', 'Недозвон. Отправить смс'],
  cancelledMarkers: ['отменена', 'отменено', 'отменен', 'отменён', 'отказ', 'не состоялась', 'не состоялся', 'неявка', 'не явился', 'не явилась', 'удалена', 'удалено']
});

const DSS_MAP_HEADERS = ['Номенклатура', 'Код', 'Источник', 'Количество строк', 'Последнее появление', 'Комментарий'];
const DSS_REQUEST_HEADERS = ['КлиентКод', 'Пациент', 'Дата', 'Запланированы', 'Выполнены', 'Дата обработки'];
const DSS_DEAL_HEADERS = ['ID сделки', 'Название', 'CATEGORY_ID', 'Текущая стадия ID', 'Текущая стадия', 'Код пациента', 'Первый день лечения', 'Состав назначения', 'Коды назначения', 'Дата загрузки', 'Ошибка данных'];
const DSS_ACTUALIZATION_HEADERS = ['Отправить', 'ID сделки', 'Название сделки', 'Код пациента', 'Первый день лечения', 'Коды назначения', 'Найденные запланированные коды', 'Найденные выполненные коды', 'Текущая стадия ID', 'Текущая стадия', 'Предлагаемая стадия ID', 'Предлагаемая стадия', 'Результат проверки', 'Причина', 'Дата загрузки сделок', 'Дата обработки заявок', 'Дата актуализации', 'Статус отправки', 'Ошибка отправки'];
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
  DSS_ensureMapSheet_(ss);
  DSS_prepareSheet_(ss, DSS_CONFIG.sheets.aggregated, DSS_REQUEST_HEADERS);
  DSS_prepareSheet_(ss, DSS_CONFIG.sheets.deals, DSS_DEAL_HEADERS);
  DSS_prepareSheet_(ss, DSS_CONFIG.sheets.actualization, DSS_ACTUALIZATION_HEADERS);
  DSS_ensureLogSheet_(ss);
  SpreadsheetApp.getActive().toast('Служебные листы созданы.', 'Сверка сделок Bitrix', 5);
}

function DSS_processRequests() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const requests = DSS_readObjects_(DSS_requiredSheet_(ss, DSS_CONFIG.sheets.requests));
  const map = DSS_loadMap_(ss); const now = new Date(); const groups = new Map();
  let excluded = 0; let unknown = 0;
  requests.forEach(row => {
    const code = DSS_patientCode_(row[DSS_CONFIG.requestColumns.patientCode]);
    const date = DSS_date_(row[DSS_CONFIG.requestColumns.startDate]);
    const name = DSS_cleanName_(row[DSS_CONFIG.requestColumns.nomenclature]);
    const state = DSS_requestState_(row[DSS_CONFIG.requestColumns.state]);
    if (state === 'CANCEL') { excluded += 1; return; }
    if (!code || !date || !name || !state) return;
    const lookup = DSS_mapCode_(map, name, 'Заявки');
    if (lookup.created) unknown += 1;
    if (!lookup.code || lookup.code === DSS_CONFIG.ignoredCode) return;
    const key = code + '|' + DSS_iso_(date);
    if (!groups.has(key)) groups.set(key, { code, patient: String(row[DSS_CONFIG.requestColumns.patientName] || '').trim(), date, planned: new Set(), done: new Set() });
    groups.get(key)[state === 'DONE' ? 'done' : 'planned'].add(lookup.code);
  });
  const rows = Array.from(groups.values()).sort((a,b) => a.code.localeCompare(b.code) || a.date - b.date).map(x => [x.code, x.patient, x.date, DSS_codes_(x.planned), DSS_codes_(x.done), now]);
  DSS_saveMap_(ss, map); DSS_writeSheet_(ss, DSS_CONFIG.sheets.aggregated, DSS_REQUEST_HEADERS, rows, { dates: [3], dateTimes: [6] });
  DSS_log_(ss, 'Обработка заявок', now);
  DSS_alert_('Обработка заявок завершена.', ['Строк исходного листа обработано: ' + requests.length + '.', 'Агрегированных строк создано: ' + rows.length + '.', 'Отменённых строк исключено: ' + excluded + '.', 'Неизвестных номенклатур обнаружено: ' + unknown + '.'].join('\n'));
}

function DSS_loadDealsFromBitrix() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const now = new Date(); const base = DSS_webhook_();
  const fields = DSS_fields_(base); const threshold = DSS_addDays_(DSS_today_(), -DSS_CONFIG.dealCheckDaysAfterTreatmentStart);
  const raw = DSS_list_(base, 'crm.deal.list', { order: { ID: 'ASC' }, filter: { ['>=' + fields.firstPlanDate]: DSS_iso_(threshold) }, select: ['ID','TITLE','CATEGORY_ID','STAGE_ID',fields.firstPlanDate,fields.composition].concat(fields.patientCode ? [fields.patientCode] : []) });
  const registry = DSS_registryCodes_(ss); const map = DSS_loadMap_(ss); const stages = DSS_stageDirectory_(base, raw);
  let noPatient = 0; let incomplete = 0;
  const rows = raw.map(item => {
    const id = String(item.ID || ''); const date = DSS_date_(item[fields.firstPlanDate]);
    let patient = fields.patientCode ? DSS_patientCode_(item[fields.patientCode]) : ''; patient = patient || registry.get(id) || '';
    const names = DSS_compositionNames_(item[fields.composition]); const codes = new Set(); const unknown = [];
    names.forEach(name => { const m = DSS_mapCode_(map, name, 'Сделки Bitrix'); if (!m.code) unknown.push(name); else if (m.code !== DSS_CONFIG.ignoredCode) codes.add(m.code); });
    const errors = []; if (!patient) { noPatient += 1; errors.push('Не найден код пациента.'); } if (unknown.length) { incomplete += 1; errors.push('Неизвестная номенклатура: ' + unknown.join(', ') + '.'); }
    const category = Number(item.CATEGORY_ID || 0); const stageId = String(item.STAGE_ID || ''); const stage = (stages.get(category) || { byId: new Map() }).byId.get(stageId) || stageId;
    return [id, String(item.TITLE || ''), category, stageId, stage, patient, date || '', String(item[fields.composition] || ''), DSS_codes_(codes), now, errors.join(' ')];
  }).filter(row => row[0] && row[6]);
  DSS_saveMap_(ss, map); DSS_saveStageDirectory_(stages); DSS_writeSheet_(ss, DSS_CONFIG.sheets.deals, DSS_DEAL_HEADERS, rows, { dates: [7], dateTimes: [10] }); DSS_log_(ss, 'Загрузка сделок Bitrix', now);
  DSS_alert_('Загрузка сделок из Bitrix завершена.', 'Сделок получено: ' + raw.length + '.\nСделок записано на лист: ' + rows.length + '.\nБез кода пациента: ' + noPatient + '.\nС неполными кодами назначений: ' + incomplete + '.');
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
  const index = new Map(); requests.forEach(r => { const code = DSS_patientCode_(r['КлиентКод']); if (!index.has(code)) index.set(code, []); index.get(code).push(r); });
  const stageInfo = DSS_loadStageDirectory_(); const now = new Date(); let booked = 0, attended = 0, unchanged = 0, errors = 0;
  const rows = deals.map(d => {
    const id = String(d['ID сделки'] || ''); const patient = DSS_patientCode_(d['Код пациента']); const date = DSS_date_(d['Первый день лечения']); const codes = DSS_codeSet_(d['Коды назначения']);
    let planned = new Set(), done = new Set(), targetId = '', targetName = '', result = 'Без изменений', reason = '';
    if (!patient) { result = 'Не найден код пациента'; reason = 'В сделке отсутствует код пациента.'; errors += 1; }
    else if (!date || !codes.size) { result = d['Ошибка данных'] ? 'Неизвестная номенклатура' : 'Недостаточно данных'; reason = String(d['Ошибка данных'] || 'Не указан первый день лечения или коды назначения.'); errors += 1; }
    else {
      const effective = new Set(codes); if (effective.size > 1) effective.delete(DSS_CONFIG.consultationCode);
      (index.get(patient) || []).forEach(r => { const rd = DSS_date_(r['Дата']); if (!rd || rd < date || rd > DSS_addDays_(date, DSS_CONFIG.requestMatchWindowDays)) return; DSS_codeSet_(r['Запланированы']).forEach(c => { if (effective.has(c)) planned.add(c); }); DSS_codeSet_(r['Выполнены']).forEach(c => { if (effective.has(c)) done.add(c); }); });
      const cat = Number(d['CATEGORY_ID'] || 0); const si = stageInfo.get(cat); const onlyC = effective.size === 1 && effective.has('C');
      if (si && onlyC && (planned.has('C') || done.has('C'))) { targetId = si.attendedId; result = 'Дошёл'; reason = 'Назначена только консультация C.'; }
      else if (si && done.size) { targetId = si.attendedId; result = 'Дошёл'; reason = 'Найдена выполненная заявка.'; }
      else if (si && planned.size) { targetId = si.bookedId; result = 'Записался'; reason = 'Найдена действующая запланированная заявка.'; }
      else { result = 'Подходящие заявки не найдены'; reason = 'В заданном временном диапазоне совпадений нет.'; }
      if (!si) { result = 'Недостаточно данных'; reason = 'Не найдены стадии воронки.'; errors += 1; targetId = ''; }
      if (targetId === String(d['Текущая стадия ID'] || '') || String(d['Текущая стадия'] || '') === DSS_CONFIG.stageNames.attended) { targetId = ''; targetName = ''; result = 'Без изменений'; reason = 'Обратный переход не рассчитывается или стадия уже целевая.'; }
      if (targetId) targetName = si.byId.get(targetId) || result;
    }
    if (result === 'Записался' && targetId) booked += 1; else if (result === 'Дошёл' && targetId) attended += 1; else unchanged += 1;
    return [Boolean(targetId), id, d['Название'], patient, date || '', DSS_codes_(codes), DSS_codes_(planned), DSS_codes_(done), d['Текущая стадия ID'], d['Текущая стадия'], targetId, targetName, result, reason, d['Дата загрузки'], requestTime || '', now, '', ''];
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
function DSS_fields_(base) { const f = (DSS_call_(base, 'crm.deal.fields', {}).result || {}); return { patientCode: DSS_field_(f, DSS_CONFIG.fieldOverrides.patientCode, DSS_CONFIG.fieldAliases.patientCode, false), firstPlanDate: DSS_field_(f, DSS_CONFIG.fieldOverrides.firstPlanDate, DSS_CONFIG.fieldAliases.firstPlanDate, true), composition: DSS_field_(f, DSS_CONFIG.fieldOverrides.composition, ['Состав назначений', 'TEMED_APPOINTMENT_COMPOSITION'], true) }; }
function DSS_field_(fields, override, aliases, required) { if (override) { if (!fields[override]) throw new Error('В crm.deal.fields отсутствует указанное поле ' + override + '.'); return override; } const found = Object.keys(fields).find(id => [id, fields[id].title, fields[id].formLabel, fields[id].listLabel].some(v => (aliases || []).some(a => DSS_text_(v) === DSS_text_(a) || DSS_text_(v).indexOf(DSS_text_(a)) !== -1))); if (!found && required) throw new Error('Не удалось найти обязательное поле Bitrix.'); return found || ''; }
function DSS_call_(base, method, payload) { const response = UrlFetchApp.fetch(base + method + '.json', { method: 'post', contentType: 'application/json; charset=utf-8', payload: JSON.stringify(payload || {}), muteHttpExceptions: true }); const body = response.getContentText() || ''; let parsed; try { parsed = body ? JSON.parse(body) : {}; } catch (e) { throw new Error('Bitrix вернул некорректный ответ. HTTP ' + response.getResponseCode() + '.'); } if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || parsed.error) throw new Error('Ошибка Bitrix: ' + String(parsed.error_description || parsed.error || 'HTTP ' + response.getResponseCode()).slice(0, 500)); return parsed; }
function DSS_list_(base, method, params) { let start = 0, guard = 0, result = []; while (guard++ < 10000) { const out = DSS_call_(base, method, Object.assign({}, params, { start })); result = result.concat(Array.isArray(out.result) ? out.result : []); if (out.next === undefined || out.next === null || out.next === '') break; start = Number(out.next); } return result; }
function DSS_stageDirectory_(base, deals) { const categories = Array.from(new Set(deals.map(d => Number(d.CATEGORY_ID || 0)))); const out = new Map(); categories.forEach(c => { const statuses = DSS_list_(base, 'crm.status.list', { order: { SORT: 'ASC' }, filter: { ENTITY_ID: c ? 'DEAL_STAGE_' + c : 'DEAL_STAGE' } }); const byId = new Map(), byName = new Map(); statuses.forEach(s => { byId.set(String(s.STATUS_ID), String(s.NAME)); byName.set(DSS_text_(s.NAME), String(s.STATUS_ID)); }); out.set(c, { byId, bookedId: byName.get(DSS_text_(DSS_CONFIG.stageNames.booked)), attendedId: byName.get(DSS_text_(DSS_CONFIG.stageNames.attended)) }); }); return out; }
function DSS_stageDirectoryFromDeals_(deals) { const out = new Map(); deals.forEach(d => { const c = Number(d.CATEGORY_ID || 0); if (!out.has(c)) out.set(c, { byId: new Map(), bookedId: '', attendedId: '' }); const x = out.get(c), id = String(d['Текущая стадия ID'] || ''), name = String(d['Текущая стадия'] || ''); if (id) x.byId.set(id, name); if (DSS_text_(name) === DSS_text_(DSS_CONFIG.stageNames.booked)) x.bookedId = id; if (DSS_text_(name) === DSS_text_(DSS_CONFIG.stageNames.attended)) x.attendedId = id; }); return out; }
function DSS_registryCodes_(ss) { const sheet = ss.getSheetByName(DSS_CONFIG.sheets.registry), out = new Map(); if (!sheet || sheet.getLastRow() < 2) return out; DSS_readObjects_(sheet).forEach(r => { const id = String(r['Bitrix Deal ID'] || r['ID сделки'] || '').trim(), code = DSS_patientCode_(r['Пациент.Код'] || r['Код пациента']); if (id && code && !out.has(id)) out.set(id, code); }); return out; }
function DSS_compositionNames_(value) { return String(value || '').split(/[\r\n;,]+/).map(x => DSS_cleanName_(x.replace(/^[-•*\d.)\s]+/, '').replace(/\s+[xх]\s*\d+(?:[.,]\d+)?\s*$/i, ''))).filter(Boolean); }
function DSS_loadMap_(ss) { const sheet = DSS_ensureMapSheet_(ss), rows = DSS_readObjects_(sheet), entries = new Map(); rows.forEach(r => { const name = DSS_cleanName_(r['Номенклатура']); if (name) entries.set(DSS_text_(name), { name, code: DSS_serviceCode_(r['Код']), existed: true, sources: new Set(), count: 0, last: r['Последнее появление'], comment: String(r['Комментарий'] || '') }); }); return { entries }; }
function DSS_mapCode_(map, name, source) { const key = DSS_text_(name); let entry = map.entries.get(key), created = false; if (!entry) { created = true; entry = { name, code: '', existed: false, sources: new Set(), count: 0, last: '', comment: '' }; map.entries.set(key, entry); } entry.sources.add(source); entry.count += 1; entry.last = new Date(); return { code: entry.code, created }; }
function DSS_saveMap_(ss, map) { const sheet = DSS_ensureMapSheet_(ss); const old = DSS_readObjects_(sheet); const oldByName = new Map(old.map(r => [DSS_text_(r['Номенклатура']), r])); const rows = Array.from(map.entries.values()).sort((a,b) => a.name.localeCompare(b.name, 'ru')).map(e => { const p = oldByName.get(DSS_text_(e.name)) || {}; return [e.name, e.code, Array.from(e.sources).join(', '), e.count, e.last || p['Последнее появление'] || '', e.comment || p['Комментарий'] || '']; }); sheet.clearContents(); sheet.getRange(1,1,1,DSS_MAP_HEADERS.length).setValues([DSS_MAP_HEADERS]); if(rows.length) sheet.getRange(2,1,rows.length,DSS_MAP_HEADERS.length).setValues(rows); sheet.setFrozenRows(1); sheet.getRange(1,1,1,DSS_MAP_HEADERS.length).setFontWeight('bold'); }
function DSS_ensureMapSheet_(ss) { let s = ss.getSheetByName(DSS_CONFIG.sheets.nomenclature); if (!s) s = ss.insertSheet(DSS_CONFIG.sheets.nomenclature); if (!s.getLastRow()) s.getRange(1,1,1,DSS_MAP_HEADERS.length).setValues([DSS_MAP_HEADERS]); return s; }
function DSS_requestState_(v) { const t = DSS_text_(v); if (DSS_CONFIG.cancelledMarkers.some(x => t.indexOf(DSS_text_(x)) !== -1)) return 'CANCEL'; if (DSS_CONFIG.doneStates.some(x => t === DSS_text_(x))) return 'DONE'; if (DSS_CONFIG.plannedStates.some(x => t === DSS_text_(x))) return 'PLAN'; return ''; }
function DSS_writeSheet_(ss, name, headers, rows, formats) { const s = DSS_prepareSheet_(ss, name, headers); if(rows.length) s.getRange(2,1,rows.length,headers.length).setValues(rows); s.setFrozenRows(1); s.getRange(1,1,1,headers.length).setFontWeight('bold'); (formats && formats.dates || []).forEach(c => s.getRange(2,c,Math.max(rows.length,1),1).setNumberFormat('dd.MM.yyyy')); (formats && formats.dateTimes || []).forEach(c => s.getRange(2,c,Math.max(rows.length,1),1).setNumberFormat('dd.MM.yyyy HH:mm')); }
function DSS_writeActualization_(ss, rows) { DSS_writeSheet_(ss, DSS_CONFIG.sheets.actualization, DSS_ACTUALIZATION_HEADERS, rows, { dates: [5], dateTimes: [15,16,17] }); const s = ss.getSheetByName(DSS_CONFIG.sheets.actualization); s.getRange(2,1,Math.max(rows.length,1),1).insertCheckboxes(); }
function DSS_prepareSheet_(ss, name, headers) { let s = ss.getSheetByName(name); if(!s) s = ss.insertSheet(name); s.clear(); s.getRange(1,1,1,headers.length).setValues([headers]); return s; }
function DSS_requiredSheet_(ss, name) { const s = ss.getSheetByName(name); if(!s) throw new Error('Не найден обязательный лист "' + name + '".'); return s; }
function DSS_readObjects_(sheet) { const values = sheet.getDataRange().getValues(), display = sheet.getDataRange().getDisplayValues(); if(!values.length) return []; const h = display[0].map(x => String(x || '').trim()); return values.slice(1).map((row,i) => { const x = {}; h.forEach((k,j) => x[k] = row[j]); return x; }); }
function DSS_sendStatus_(sheet, row, status, error) { sheet.getRange(row,18,1,2).setValues([[status,error]]); }
function DSS_ensureLogSheet_(ss) { let s = ss.getSheetByName(DSS_CONFIG.sheets.log); if(!s) s = ss.insertSheet(DSS_CONFIG.sheets.log); if(!s.getLastRow()) s.appendRow(['Дата и время','Этап']); return s; }
function DSS_log_(ss, stage, date) { DSS_ensureLogSheet_(ss).appendRow([date, stage]); }
function DSS_alert_(title, text) { SpreadsheetApp.getUi().alert(title, text, SpreadsheetApp.getUi().ButtonSet.OK); }
function DSS_cleanName_(v) { return String(v || '').replace(/\s*\|.*$/,'').replace(/\s+/g,' ').trim(); }
function DSS_text_(v) { return String(v || '').toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function DSS_patientCode_(v) { const x = String(v == null ? '' : v).replace(/\D/g,''); return x ? (x.replace(/^0+/,'') || '0') : ''; }
function DSS_serviceCode_(v) { const x = String(v || '').trim().toUpperCase(); if(x === '-') return x; const m = x.match(/[A-ZА-Я]/); return m ? m[0] : ''; }
function DSS_codeSet_(v) { return new Set(String(v || '').split('').map(DSS_serviceCode_).filter(Boolean)); }
function DSS_codes_(set) { return Array.from(set || []).filter(x => x && x !== '-').sort((a,b) => DSS_CONFIG.serviceCodeOrder.indexOf(a) - DSS_CONFIG.serviceCodeOrder.indexOf(b)).join(''); }
function DSS_date_(v) { if(v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(),v.getMonth(),v.getDate()); const t = String(v || '').trim(), m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/); if(m) return m[1].length === 4 ? new Date(+m[1],+m[2]-1,+m[3]) : new Date(+m[3],+m[2]-1,+m[1]); const d = new Date(t); return isNaN(d) ? null : new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
function DSS_today_() { return DSS_date_(Utilities.formatDate(new Date(), DSS_CONFIG.timezone, 'yyyy-MM-dd')); }
function DSS_iso_(d) { return Utilities.formatDate(d, DSS_CONFIG.timezone, 'yyyy-MM-dd'); }
function DSS_datetime_(d) { return Utilities.formatDate(d, DSS_CONFIG.timezone, 'dd.MM.yyyy HH:mm:ss'); }
function DSS_addDays_(d,n) { const x = new Date(d.getFullYear(),d.getMonth(),d.getDate()); x.setDate(x.getDate()+n); return x; }
function DSS_latestDate_(rows, field) { return rows.reduce((max,r) => { const d = r[field] instanceof Date ? r[field] : new Date(r[field]); return !isNaN(d) && (!max || d > max) ? d : max; }, null); }
function DSS_isToday_(d) { return d && DSS_iso_(d) === DSS_iso_(DSS_today_()); }
function DSS_safeError_(e) { return String(e && e.message || e || 'Неизвестная ошибка').replace(/https?:\/\/[^\s]+/g, '[скрыто]').slice(0,500); }
function DSS_saveStageDirectory_(directory) { const data = {}; directory.forEach((x, category) => { data[category] = { stages: Array.from(x.byId.entries()), bookedId: x.bookedId || '', attendedId: x.attendedId || '' }; }); PropertiesService.getDocumentProperties().setProperty('DSS_STAGE_DIRECTORY', JSON.stringify(data)); }
function DSS_loadStageDirectory_() { const raw = PropertiesService.getDocumentProperties().getProperty('DSS_STAGE_DIRECTORY'); const result = new Map(); if (!raw) return result; try { const data = JSON.parse(raw); Object.keys(data).forEach(category => { const x = data[category]; result.set(Number(category), { byId: new Map(x.stages || []), bookedId: x.bookedId || '', attendedId: x.attendedId || '' }); }); } catch (e) { return new Map(); } return result; }
function DSS_sendBitrixBatch_(base, items) { const cmd = {}; items.forEach((item, i) => { cmd['d' + i] = 'crm.deal.update?id=' + encodeURIComponent(item.r['ID сделки']) + '&fields[STAGE_ID]=' + encodeURIComponent(item.r['Предлагаемая стадия ID']); }); try { const out = DSS_call_(base, 'batch', { halt: 0, cmd }).result || {}; const success = out.result || {}, errors = out.result_error || {}; return items.map((item, i) => ({ item, ok: success['d' + i] === true, error: DSS_safeError_(errors['d' + i] || 'Bitrix не подтвердил обновление.') })); } catch (e) { return items.map(item => ({ item, ok: false, error: DSS_safeError_(e) })); } }

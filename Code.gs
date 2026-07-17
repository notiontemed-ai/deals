/****************************************************
 * TEMED — сделки по назначениям для отдела продаж
 *
 * Входные листы:
 * 1) "Назначения"
 * 2) "Заявки"
 *
 * Выходной лист:
 * "Сделки"
 *
 * Одна строка на листе "Сделки" = один УИД назначения.
 *
 * УИД НЕ требует сделки, если:
 * - есть заявка "Начато" / "Выполнена" в день назначения;
 * - или есть плановая заявка на эту услугу на любую будущую дату
 *   начиная с даты назначения.
 *
 * Сопоставление:
 * - Пациент.Код = КлиентКод
 * - Филиал = Филиал
 * - Номенклатура = НоменклатураНаименование
 *   ИЛИ резерв:
 *     кабинет содержит "ФТЛ"    → MLS / лазеротерапия
 *     кабинет содержит "Магнит" → SIS / магнитотерапия
 *
 * Состав назначений:
 * - однотипные назначения объединяются;
 * - всё начиная с "|" удаляется;
 * - анализы объединяются в одну строку "Анализы".
 ****************************************************/

const MIN_BITRIX_DEAL_AMOUNT = 20000;
const AI_PROCESSING_TIMEOUT_SECONDS = 180;
const APPOINTMENT_TYPE_CODE_ORDER = ['L', 'M', 'S', 'F', 'C', 'D', 'U', 'P'];
const APPOINTMENT_TYPE_CODE_SET = new Set(APPOINTMENT_TYPE_CODE_ORDER.concat('-'));

const DEALS_CONFIG = {
  appointmentsSheetName: 'Назначения',
  requestsSheetName: 'Заявки',
  outputSheetName: 'Сделки',
  typeCodesSheetName: 'Коды типов назначений',
  bitrixDealsSheetName: 'Сделки в Битрикс',
  bitrixRegistrySheetName: 'Реестр отправки Bitrix',
  bitrixDealSource: 'google_sheets_appointments',
  // Production URL from the activated n8n workflow deal-patient-context-v3-batch.
  aiWebhookUrl: 'https://n8n-x3.tech.temed.ru/webhook/deal-patient-context-v3-batch',
  minBitrixDealAmount: MIN_BITRIX_DEAL_AMOUNT,

  appointmentColumns: {
    branch: 'Филиал',
    patient: 'Пациент',
    patientCode: 'Пациент.Код',
    doctor: 'Врач',
    standard: 'Стандарт лечения',
    standardCode: 'Стандарт лечения.Код',
    uid: 'УИД',
    appointmentDate: 'Дата',
    treatmentDate: 'Дата лечения',
    nomenclature: 'Номенклатура',
    price: 'Цена'
  },

  typeCodeColumns: {
    nomenclature: 'Номенклатура',
    type: 'Тип'
  },

  requestColumns: {
    branch: 'Филиал',
    client: 'Клиент',
    clientCode: 'КлиентКод',
    state: 'Состояние',
    startDate: 'ДатаНачала',
    endDate: 'ДатаОкончания',
    number: 'Номер',
    nomenclature: 'НоменклатураНаименование',
    cabinet: 'Кабинет'
  },

  plannedRequestStates: [
    'Запланирована',
    'Запланировано',
    'Подтвердил запись',
    'Недозвон. Отправить смс'
  ],

  startedRequestStates: [
    'Начато'
  ],

  completedRequestStates: [
    'Выполнена',
    'Выполнено',
    'Завершена',
    'Завершено',
    'Оказана',
    'Оказано'
  ],

  cancelledRequestStateMarkers: [
    'отменена',
    'отменено',
    'отменен',
    'отменён',
    'отказ',
    'не состоялась',
    'не состоялся'
  ],

  resultStatuses: {
    createDeal: 'Создать сделку',
    planned: 'Запланировано',
    started: 'Начато'
  },

  nearestRequestsLimit: 7
};


/****************************************************
 * Главная функция запуска
 ****************************************************/

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('TEMED сделки')
    .addItem('Сформировать лист "Сделки"', 'buildDealsSheet')
    .addSeparator()
    .addItem('Сделки в Битрикс', 'buildBitrixDealsSheet')
    .addItem('Запросить AI справки для Bitrix', 'requestAiSummariesForBitrixDeals')
    .addItem('Собрать описания для Bitrix', 'buildFinalBitrixDescriptions')
    .addSeparator()
    .addItem('Обновить справочник сотрудников Bitrix', 'updateBitrixEmployeesDirectory')
    .addItem('Отправить сделки в Bitrix', 'uploadBitrixDeals')
    .addItem('Заполнить типы, коды пациентов и даты назначений в существующих сделках Bitrix', 'backfillBitrixDealAppointmentTypes')
    .addItem('Проверить поля Bitrix', 'debugBitrixDealFields')
    .addItem('Проверить дубли отправки Bitrix', 'checkBitrixDuplicateRegistry')
    .addToUi();
}


/****************************************************
 * Справочник буквенных типов назначений
 ****************************************************/

function validateAppointmentTypeCodes_(sheet, appointments, requests) {
  const dictionary = readAppointmentTypeCodeMap_(sheet);

  if (dictionary.conflictingNomenclature) {
    return {
      isValid: false,
      message: 'На листе «' + DEALS_CONFIG.typeCodesSheetName +
        '» одна номенклатура имеет разные типы: ' +
        dictionary.conflictingNomenclature + '.'
    };
  }

  const nomenclatures = collectNomenclaturesForTypeValidation_(appointments, requests);
  const missing = [];
  let emptyCount = 0;
  let invalidCount = 0;

  nomenclatures.forEach(item => {
    const entry = dictionary.map.get(item.normalized);
    if (!entry) {
      missing.push(item);
      return;
    }

    if (!entry.typeCode) {
      emptyCount += 1;
    } else if (!APPOINTMENT_TYPE_CODE_SET.has(entry.typeCode)) {
      invalidCount += 1;
    }
  });

  appendMissingNomenclatures_(sheet, missing);

  if (missing.length || emptyCount || invalidCount) {
    return {
      isValid: false,
      message: [
        'Не для всей номенклатуры указаны типы.',
        '',
        'Добавлено новых позиций: ' + missing.length + '.',
        'Позиций с пустым типом: ' + emptyCount + '.',
        'Позиций с ошибочным типом: ' + invalidCount + '.',
        '',
        'Заполните колонку «' + DEALS_CONFIG.typeCodeColumns.type +
          '» на листе «' + DEALS_CONFIG.typeCodesSheetName +
          '» и повторно запустите «Сформировать лист "Сделки"».'
      ].join('\n')
    };
  }

  return { isValid: true, typeCodeMap: dictionary.map };
}


function readAppointmentTypeCodeMap_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values.length ? values[0].map(value => String(value || '').trim()) : [];
  const nomenclatureColumn = headers.indexOf(DEALS_CONFIG.typeCodeColumns.nomenclature);
  const typeColumn = headers.indexOf(DEALS_CONFIG.typeCodeColumns.type);

  if (nomenclatureColumn === -1 || typeColumn === -1) {
    throw new Error(
      'На листе «' + DEALS_CONFIG.typeCodesSheetName + '» должны быть колонки «' +
      DEALS_CONFIG.typeCodeColumns.nomenclature + '» и «' + DEALS_CONFIG.typeCodeColumns.type + '».'
    );
  }

  const map = new Map();
  let conflictingNomenclature = '';

  values.slice(1).forEach(row => {
    const nomenclature = String(row[nomenclatureColumn] || '').trim();
    const normalized = normalizeTypeNomenclature_(nomenclature);
    if (!normalized) return;

    const typeCode = String(row[typeColumn] || '').trim().toUpperCase();
    const existing = map.get(normalized);

    // Пустой дубль не является вторым назначенным типом, но останется
    // причиной остановки при проверке незаполненных строк справочника.
    if (existing && existing.typeCode && typeCode && existing.typeCode !== typeCode) {
      conflictingNomenclature = existing.nomenclature;
      return;
    }

    if (!existing || (!existing.typeCode && typeCode)) {
      map.set(normalized, { nomenclature, typeCode });
    }
  });

  return { map, conflictingNomenclature };
}


function collectNomenclaturesForTypeValidation_(appointments, requests) {
  const found = new Map();
  const appointmentColumn = DEALS_CONFIG.appointmentColumns.nomenclature;
  const requestColumn = DEALS_CONFIG.requestColumns.nomenclature;

  appointments.concat(requests).forEach(row => {
    const sourceColumn = Object.prototype.hasOwnProperty.call(row, appointmentColumn)
      ? appointmentColumn
      : requestColumn;
    const nomenclature = String(row[sourceColumn] || '').trim();
    const normalized = normalizeTypeNomenclature_(nomenclature);

    if (normalized && !found.has(normalized)) {
      found.set(normalized, { nomenclature, normalized });
    }
  });

  return Array.from(found.values());
}


function appendMissingNomenclatures_(sheet, missing) {
  if (!missing.length) return;

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, missing.length, 2)
    .setValues(missing.map(item => [item.nomenclature, '']));
}


function assignAppointmentTypeCodes_(appointments, requests, typeCodeMap) {
  const appointmentColumn = DEALS_CONFIG.appointmentColumns.nomenclature;
  const requestColumn = DEALS_CONFIG.requestColumns.nomenclature;

  appointments.forEach(row => {
    row.typeCode = getAppointmentTypeCode_(row[appointmentColumn], typeCodeMap);
  });
  requests.forEach(row => {
    row.typeCode = getAppointmentTypeCode_(row[requestColumn], typeCodeMap);
  });
}


function getAppointmentTypeCode_(nomenclature, typeCodeMap) {
  const entry = typeCodeMap.get(normalizeTypeNomenclature_(nomenclature));
  return entry ? entry.typeCode : '';
}


function normalizeTypeNomenclature_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}


function buildAppointmentTypeCodes_(items) {
  const found = new Set();
  (items || []).forEach(item => {
    const typeCode = String(item.typeCode || '').trim().toUpperCase();
    if (APPOINTMENT_TYPE_CODE_SET.has(typeCode) && typeCode !== '-') found.add(typeCode);
  });
  return APPOINTMENT_TYPE_CODE_ORDER.filter(code => found.has(code)).join('');
}


function mergeAppointmentTypeCodes_(values) {
  const found = new Set();
  (values || []).forEach(value => {
    String(value || '').toUpperCase().split('').forEach(code => {
      if (APPOINTMENT_TYPE_CODE_ORDER.indexOf(code) !== -1) found.add(code);
    });
  });
  return APPOINTMENT_TYPE_CODE_ORDER.filter(code => found.has(code)).join('');
}


function buildDealsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const appointmentsSheet = getRequiredSheet_(ss, DEALS_CONFIG.appointmentsSheetName);
  const requestsSheet = getRequiredSheet_(ss, DEALS_CONFIG.requestsSheetName);

  const appointments = readSheetAsObjects_(appointmentsSheet);
  const requests = readSheetAsObjects_(requestsSheet);

  // Проверяем справочник до любых расчётов и до очистки листа "Сделки".
  const typeCodesSheet = getRequiredSheet_(ss, DEALS_CONFIG.typeCodesSheetName);
  const typeValidation = validateAppointmentTypeCodes_(typeCodesSheet, appointments, requests);
  if (!typeValidation.isValid) {
    typeCodesSheet.activate();
    SpreadsheetApp.getUi().alert(typeValidation.message);
    return;
  }

  assignAppointmentTypeCodes_(appointments, requests, typeValidation.typeCodeMap);

  const requestIndexes = buildRequestIndexes_(requests);
  const nearestRequestsByClient = buildNearestRequestsByClientIndex_(requests);
  const uidGroups = groupAppointmentsByUid_(appointments);

  const outputRows = Object.values(uidGroups)
    .map(uidGroup => buildUidDealRow_(uidGroup, requestIndexes, nearestRequestsByClient))
    .sort((a, b) => {
      const statusOrder = {
        [DEALS_CONFIG.resultStatuses.createDeal]: 1,
        [DEALS_CONFIG.resultStatuses.started]: 2,
        [DEALS_CONFIG.resultStatuses.planned]: 3
      };

      const statusDiff = (statusOrder[a.status] || 99) - (statusOrder[b.status] || 99);
      if (statusDiff !== 0) return statusDiff;

      const dateDiff = a.sortDate - b.sortDate;
      if (dateDiff !== 0) return dateDiff;

      const patientDiff = String(a.patient).localeCompare(String(b.patient), 'ru');
      if (patientDiff !== 0) return patientDiff;

      return String(a.uid).localeCompare(String(b.uid), 'ru');
    })
    .map(item => item.row);

  writeDealsOutput_(ss, outputRows);
}



/****************************************************
 * Сделки в Битрикс: 1 пациент + 1 филиал = 1 сделка
 ****************************************************/

const BITRIX_DEALS_HEADERS = [
  'DealKey',
  'Статус отправки',
  'AI статус',
  'Пациент.Код',
  'ФИО',
  'Филиал',
  'Сумма сделки',
  'Дата назначения',
  'Первый плановый день',
  'Врач',
  'УИДы',
  'Deal Hash',
  'TEMED_UIDS',
  'TEMED_DEAL_HASH',
  'TEMED_DEAL_SOURCE',
  'Кол-во назначений',
  'Состав назначений',
  'Типы назначений',
  'Ближайшие заявки пациента',
  'Телефон клиента',
  'Комментарий администратора',
  'Описание назначений',
  'Plan Items JSON',
  'AI справка',
  'Описание для Bitrix',
  'Bitrix Deal ID',
  'Bitrix sent_at',
  'Ошибка',
  'AI request_id',
  'AI updated_at'
];


function buildBitrixDealsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dealsSheet = getRequiredSheet_(ss, DEALS_CONFIG.outputSheetName);
  const deals = readSheetAsObjects_(dealsSheet);
  const registry = readBitrixSentUidRegistry_(ss);
  const sentUidSet = registry.sentUidSet;
  const groups = new Map();

  deals.forEach(row => {
    if (String(row['Статус'] || '').trim() !== DEALS_CONFIG.resultStatuses.createDeal) {
      return;
    }

    const uid = String(row['УИД'] || '').trim();

    if (!uid || sentUidSet.has(uid)) {
      return;
    }

    const patientCode = String(row['Пациент.Код'] || '').trim();
    const branch = String(row['Филиал'] || '').trim();

    if (!patientCode || !branch) {
      return;
    }

    const dealKey = buildBitrixDealKey_(patientCode, branch);

    if (!groups.has(dealKey)) {
      groups.set(dealKey, {
        dealKey,
        patientCode,
        patientName: String(row['ФИО'] || '').trim(),
        branch,
        amount: 0,
        firstPlanDate: null,
        appointmentDate: null,
        doctors: [],
        uids: [],
        compositions: [],
        typeCodes: new Set(),
        nearestRequests: [],
        uidRows: []
      });
    }

    const group = groups.get(dealKey);
    const planDate = parseBitrixDealPlanDate_(row);
    const appointmentDate = parseDateOnly_(row['Дата назначения']);

    group.amount += parseNumber_(row['Сумма к продаже']);

    if (appointmentDate && (!group.appointmentDate || appointmentDate > group.appointmentDate)) group.appointmentDate = appointmentDate;

    if (planDate && (!group.firstPlanDate || planDate < group.firstPlanDate)) {
      group.firstPlanDate = planDate;
    }

    addUniqueText_(group.doctors, row['Врач']);
    addUniqueText_(group.uids, uid);

    if (row['Состав назначений']) {
      group.compositions.push(String(row['Состав назначений']));
    }

    String(row['Типы назначений'] || '').toUpperCase().split('').forEach(code => {
      if (APPOINTMENT_TYPE_CODE_ORDER.indexOf(code) !== -1) group.typeCodes.add(code);
    });

    splitLines_(row['Ближайшие заявки пациента']).forEach(line => addUniqueText_(group.nearestRequests, line));

    group.uidRows.push({
      uid,
      appointmentDate: appointmentDate || '',
      firstPlanDate: planDate,
      doctor: String(row['Врач'] || '').trim(),
      composition: String(row['Состав назначений'] || '').trim(),
      amount: parseNumber_(row['Сумма к продаже']),
      sourceComposition: String(row['Состав назначений'] || '').trim(),
      patientCode: String(row['Пациент.Код'] || '').trim(),
      branch: String(row['Филиал'] || '').trim(),
      uidPlanItemsJson: String(row['UID Plan Items JSON'] || '').trim()
    });
  });

  const outputRows = Array.from(groups.values())
    .sort((a, b) => {
      const dateDiff = (a.firstPlanDate ? a.firstPlanDate.getTime() : 0) - (b.firstPlanDate ? b.firstPlanDate.getTime() : 0);
      if (dateDiff !== 0) return dateDiff;

      const patientDiff = a.patientName.localeCompare(b.patientName, 'ru');
      if (patientDiff !== 0) return patientDiff;

      return a.branch.localeCompare(b.branch, 'ru');
    })
    .map(group => {
      const uidsText = group.uids.join(', ');
      const dealHash = buildDealHashFromUids_(group.uids);

      return [
        group.dealKey,
        'Новая',
        'Не запрошено',
        group.patientCode,
        group.patientName,
        group.branch,
        group.amount,
        group.appointmentDate || '',
        group.firstPlanDate || '',
        group.doctors.join(', '),
        uidsText,
        dealHash,
        uidsText,
        dealHash,
        DEALS_CONFIG.bitrixDealSource,
        group.uids.length,
        aggregateAppointmentCompositionText_(group.compositions),
        mergeAppointmentTypeCodes_(Array.from(group.typeCodes)),
        group.nearestRequests.join('\n'),
        '', // Телефон клиента — заполнит n8n
        '', // Комментарий администратора — заполнит n8n
        buildBitrixDealAppointmentsDescription_(group),
        buildPlanItemsJson_(group, dealHash),
        '',
        '',
        '',
        '',
        '',
        '',
        ''
      ];
    });

  writeBitrixDealsOutput_(ss, outputRows);
}


function requestAiSummariesForBitrixDeals() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getRequiredSheet_(ss, DEALS_CONFIG.bitrixDealsSheetName);
  const data = readSheetWithHeaders_(sheet);
  const items = [];
  const addedDealKeys = new Set();
  const addedRowNumbers = new Set();

  data.rows.forEach((row, i) => {
    const sendStatus = String(row['Статус отправки'] || '').trim();
    const aiStatus = String(row['AI статус'] || '').trim();
    const aiUpdatedAt = row['AI updated_at'];
    const canRequestAi =
      aiStatus === 'Не запрошено' ||
      aiStatus === 'error' ||
      isAiProcessingExpired_(aiStatus, aiUpdatedAt);

    if (sendStatus !== 'Новая' || !canRequestAi) {
      return;
    }

    // Preserve the physical Sheets row before filtering any candidate deals.
    const rowNumber = i + 2;
    const dealKey = String(row['DealKey'] || '').trim();

    if (addedDealKeys.has(dealKey) || addedRowNumbers.has(rowNumber)) {
      return;
    }

    items.push({
      row_number: rowNumber,
      deal_key: dealKey,
      patient_code: row['Пациент.Код'] || '',
      patient_name: row['ФИО'] || '',
      branch: row['Филиал'] || '',
      deal_amount: parseNumber_(row['Сумма сделки']),
      first_plan_date: formatDateTimeForText_(row['Первый плановый день']),
      doctor: row['Врач'] || '',
      uids: row['УИДы'] || '',
      appointment_composition: row['Состав назначений'] || '',
      nearest_requests: row['Ближайшие заявки пациента'] || '',
      deal_description: row['Описание назначений'] || '',
      booking_execution_context: 'По данным текущей выгрузки по связанным назначениям требуется создание сделки.'
    });
    addedDealKeys.add(dealKey);
    addedRowNumbers.add(rowNumber);
  });

  const batches = chunkArray_(items, 10);

  batches.forEach((batch, batchIndex) => {
    const result = sendAiContextBatchWithRetry_(DEALS_CONFIG.aiWebhookUrl, ss.getId(), sheet.getName(), batch);
    logAiContextBatch_(batchIndex + 1, batch, result);

    if (result.exhausted) {
      writeAiBatchSendError_(sheet, data.headerMap, batch, result.errorText);
    }

    if (batchIndex < batches.length - 1) {
      Utilities.sleep(1000 + Math.floor(Math.random() * 501));
    }
  });
}


function chunkArray_(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}


function sendAiContextBatch_(webhookUrl, spreadsheetId, sheetName, items) {
  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ spreadsheet_id: spreadsheetId, sheet_name: sheetName, items: items }),
    muteHttpExceptions: true
  });
  const responseText = response.getContentText() || '';

  return {
    statusCode: response.getResponseCode(),
    responseText: responseText,
    responseJson: parseJsonSafely_(responseText)
  };
}


function sendAiContextBatchWithRetry_(webhookUrl, spreadsheetId, sheetName, items) {
  const retryDelays = [2000, 4000, 8000, 16000];
  let retries = 0;
  let lastResult = null;

  // Retry only transient HTTP failures and fetch exceptions with the same batch.
  while (true) {
    try {
      lastResult = sendAiContextBatch_(webhookUrl, spreadsheetId, sheetName, items);
      if (lastResult.statusCode === 202 && lastResult.responseJson && lastResult.responseJson.ok === true) {
        return Object.assign(lastResult, { retries: retries, exhausted: false, errorText: '' });
      }

      if ([429, 500, 502, 503, 504].indexOf(lastResult.statusCode) === -1) {
        return Object.assign(lastResult, { retries: retries, exhausted: false, errorText: formatAiBatchError_(lastResult.responseJson, lastResult.responseText, lastResult.statusCode) });
      }
    } catch (err) {
      lastResult = { statusCode: null, responseText: '', responseJson: null, errorText: err && err.message ? err.message : String(err) };
    }

    if (retries === retryDelays.length) {
      return Object.assign(lastResult, { retries: retries, exhausted: true, errorText: lastResult.errorText || formatAiBatchError_(lastResult.responseJson, lastResult.responseText, lastResult.statusCode) });
    }

    Utilities.sleep(retryDelays[retries] + Math.floor(Math.random() * 1001));
    retries += 1;
  }
}


function formatAiBatchError_(responseJson, responseText, statusCode) {
  if (!responseJson) {
    return extractErrorText_(responseJson, responseText, statusCode);
  }

  const parts = [];
  if (responseJson.error_code) parts.push('error_code=' + responseJson.error_code);
  if (responseJson.message) parts.push('message=' + responseJson.message);
  if (responseJson.details) parts.push('details=' + JSON.stringify(responseJson.details));
  if (responseJson.missing_columns) parts.push('missing_columns=' + JSON.stringify(responseJson.missing_columns));

  return parts.join('; ') || extractErrorText_(responseJson, responseText, statusCode);
}


function writeAiBatchSendError_(sheet, headerMap, items, errorText) {
  const requiredHeaders = ['AI статус', 'Ошибка', 'AI updated_at'];
  requiredHeaders.forEach(header => {
    if (!headerMap[header]) throw new Error('Не найдена колонка "' + header + '" на листе "' + sheet.getName() + '".');
  });
  const rowNumbers = items.map(item => item.row_number).sort((a, b) => a - b);
  const firstRow = rowNumbers[0];
  const lastRow = rowNumbers[rowNumbers.length - 1];
  const firstColumn = Math.min(headerMap['AI статус'], headerMap['Ошибка'], headerMap['AI updated_at']);
  const lastColumn = Math.max(headerMap['AI статус'], headerMap['Ошибка'], headerMap['AI updated_at']);
  const existingValues = sheet.getRange(firstRow, firstColumn, lastRow - firstRow + 1, lastColumn - firstColumn + 1).getValues();
  const selectedRows = new Set(rowNumbers);
  const now = new Date();

  // A single setValues call updates this batch while preserving skipped rows between it.
  existingValues.forEach((values, index) => {
    if (!selectedRows.has(firstRow + index)) return;
    values[headerMap['AI статус'] - firstColumn] = 'error';
    values[headerMap['Ошибка'] - firstColumn] = String(errorText || 'Ошибка отправки пакета в n8n').slice(0, 500);
    values[headerMap['AI updated_at'] - firstColumn] = now;
  });
  sheet.getRange(firstRow, firstColumn, existingValues.length, existingValues[0].length).setValues(existingValues);
}


function logAiContextBatch_(batchNumber, items, result) {
  const rowNumbers = items.map(item => item.row_number).join(',');
  const dealKeys = items.map(item => item.deal_key).join(',');
  const batchId = result.responseJson && result.responseJson.batch_id ? result.responseJson.batch_id : '';
  const errorText = result.errorText ? ' error=' + result.errorText : '';
  Logger.log('AI context batch=' + batchNumber + ' count=' + items.length + ' rows=' + rowNumbers + ' deal_keys=' + dealKeys + ' http=' + (result.statusCode || 'fetch_exception') + ' batch_id=' + batchId + ' retries=' + result.retries + errorText);
}


function isAiProcessingExpired_(aiStatus, aiUpdatedAt) {
  if (String(aiStatus || '').trim() !== 'processing') {
    return false;
  }

  const updatedAt = parseDateTime_(aiUpdatedAt);

  if (!updatedAt) {
    return true;
  }

  const ageSeconds = (new Date().getTime() - updatedAt.getTime()) / 1000;

  return ageSeconds > AI_PROCESSING_TIMEOUT_SECONDS;
}


function parseDateTime_(value) {
  if (!value) {
    return null;
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return value;
  }

  if (typeof value === 'number') {
    const parsedNumberDate = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isNaN(parsedNumberDate) ? null : parsedNumberDate;
  }

  const text = String(value).trim();
  const matchRu = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);

  if (matchRu) {
    return new Date(
      Number(matchRu[3]),
      Number(matchRu[2]) - 1,
      Number(matchRu[1]),
      Number(matchRu[4] || 0),
      Number(matchRu[5] || 0),
      Number(matchRu[6] || 0)
    );
  }

  const parsed = new Date(text);

  return isNaN(parsed) ? null : parsed;
}


function buildFinalBitrixDescriptions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getRequiredSheet_(ss, DEALS_CONFIG.bitrixDealsSheetName);
  const data = readSheetWithHeaders_(sheet);

  data.rows.forEach((row, i) => {
    const aiStatus = String(row['AI статус'] || '').trim();
    const currentDescription = String(row['Описание для Bitrix'] || '').trim();

    if (aiStatus !== 'done' || currentDescription) {
      return;
    }

    const aiSummary = String(row['AI справка'] || '').trim();
    const appointmentsDescription = String(row['Описание назначений'] || '').trim();
    const finalDescription = aiSummary
      ? aiSummary + '\n\n---\n\nНАЗНАЧЕНИЯ:\n\n' + appointmentsDescription
      : appointmentsDescription;
    const rowNumber = i + 2;

    setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Описание для Bitrix', finalDescription);
    setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Статус отправки', 'Готова к отправке');
  });
}




function normalizeMultilineTextForBitrix_(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatAiSummaryForBitrix_(value) {
  let text = normalizeMultilineTextForBitrix_(value);

  if (text.indexOf('\n') !== -1) {
    return text;
  }

  text = text
    .replace(/\s*История взаимодействия:\s*/g, '\n\nИстория взаимодействия:\n')
    .replace(/\s*Последний прием:\s*/g, '\n\nПоследний прием:\n')
    .replace(/\s*Запись\/исполнение:\s*/g, '\n\nЗапись/исполнение:\n')
    .replace(/\s*Комментарий администратора:\s*/g, '\n\nКомментарий администратора:\n')
    .replace(/\s*Особенности коммуникации:\s*/g, '\n\nОсобенности коммуникации:\n')
    .replace(/\s*КРАТКАЯ СПРАВКА ДЛЯ СДЕЛКИ\s*/g, 'КРАТКАЯ СПРАВКА ДЛЯ СДЕЛКИ\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function buildBitrixDealKey_(patientCode, branch) {
  return String(patientCode || '').trim() + '|' + String(branch || '').trim();
}


const BITRIX_REGISTRY_HEADERS = [
  'УИД',
  'DealKey',
  'Пациент.Код',
  'ФИО',
  'Филиал',
  'Врач',
  'Состав назначения',
  'Сумма',
  'Дата лечения',
  'Дата назначения',
  'Bitrix Deal ID',
  'Дата отправки',
  'Статус',
  'Источник',
  'Комментарий'
];

const BITRIX_REGISTRY_BLOCKING_STATUSES = ['sent_to_bitrix', 'manual_skip'];

function readBitrixSentUidRegistry_(ss) {
  const sheet = getOrCreateBitrixRegistrySheet_(ss);
  const data = readSheetWithHeaders_(sheet);
  const sentUidSet = new Set();
  const rowsByUid = new Map();
  const rowsByDealId = new Map();

  data.rows.forEach((row, i) => {
    const uid = String(row['УИД'] || '').trim();
    const status = String(row['Статус'] || '').trim();

    const dealId = String(row['Bitrix Deal ID'] || '').trim();
    const enrichedRow = Object.assign({ rowNumber: i + 2 }, row);

    if (uid) {
      if (!rowsByUid.has(uid)) rowsByUid.set(uid, []);
      rowsByUid.get(uid).push(enrichedRow);
    }
    if (dealId) {
      if (!rowsByDealId.has(dealId)) rowsByDealId.set(dealId, []);
      rowsByDealId.get(dealId).push(enrichedRow);
    }

    if (BITRIX_REGISTRY_BLOCKING_STATUSES.indexOf(status) !== -1) {
      sentUidSet.add(uid);
    }
  });

  return { sentUidSet, rowsByUid, rowsByDealId };
}

function getOrCreateBitrixRegistrySheet_(ss) {
  let sheet = ss.getSheetByName(DEALS_CONFIG.bitrixRegistrySheetName);

  if (!sheet) {
    sheet = ss.insertSheet(DEALS_CONFIG.bitrixRegistrySheetName);
  }

  ensureBitrixRegistryHeaders_(sheet);
  return sheet;
}

function ensureBitrixRegistryHeaders_(sheet) {
  const lastColumn = sheet.getLastColumn();
  const existingHeaders = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(header => String(header || '').trim())
    : [];

  if (existingHeaders.length === 0 || existingHeaders.every(header => !header)) {
    sheet.getRange(1, 1, 1, BITRIX_REGISTRY_HEADERS.length).setValues([BITRIX_REGISTRY_HEADERS]);
  } else {
    // Insert this date before Bitrix Deal ID so legacy registry values remain aligned.
    if (existingHeaders.indexOf('Дата назначения') === -1) {
      const beforeDealId = existingHeaders.indexOf('Bitrix Deal ID');
      if (beforeDealId !== -1) sheet.insertColumnBefore(beforeDealId + 1);
      sheet.getRange(1, beforeDealId === -1 ? existingHeaders.length + 1 : beforeDealId + 1).setValue('Дата назначения');
      existingHeaders.splice(beforeDealId === -1 ? existingHeaders.length : beforeDealId, 0, 'Дата назначения');
    }
    const missingHeaders = BITRIX_REGISTRY_HEADERS.filter(header => existingHeaders.indexOf(header) === -1);
    if (missingHeaders.length > 0) sheet.getRange(1, existingHeaders.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn())
    .setFontWeight('bold')
    .setBackground('#ead1dc')
    .setHorizontalAlignment('center');
}

function buildDealHashFromUids_(uids) {
  const normalized = (uids || [])
    .map(uid => String(uid || '').trim())
    .filter(Boolean)
    .sort();

  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    normalized.join('|')
  )
    .map(byte => {
      const value = (byte < 0 ? byte + 256 : byte).toString(16);
      return value.padStart(2, '0');
    })
    .join('');
}

function appendSentUidsToBitrixRegistry_(ss, dealRow, bitrixDealId, status, comment) {
  return appendUidsToBitrixRegistry_(ss, dealRow, bitrixDealId, status || 'sent_to_bitrix', comment || '');
}

function appendBitrixRegistryError_(ss, dealRow, errorText) {
  return appendUidsToBitrixRegistry_(ss, dealRow, '', 'error', errorText);
}

function appendUidsToBitrixRegistry_(ss, dealRow, bitrixDealId, status, comment) {
  const sheet = getOrCreateBitrixRegistrySheet_(ss);
  const uids = splitUids_(dealRow['УИДы'] || dealRow['TEMED_UIDS']);
  const now = new Date();

  if (!uids.length) {
    return;
  }

  const rows = uids.map(uid => [
    uid,
    dealRow['DealKey'] || '',
    dealRow['Пациент.Код'] || '',
    dealRow['ФИО'] || '',
    dealRow['Филиал'] || '',
    dealRow['Врач'] || '',
    dealRow['Состав назначений'] || '',
    dealRow['Сумма сделки'] || '',
    dealRow['Первый плановый день'] || '',
    dealRow['Дата назначения'] || '',
    bitrixDealId || '',
    now,
    status,
    DEALS_CONFIG.bitrixDealSource,
    comment || ''
  ]);

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, BITRIX_REGISTRY_HEADERS.length).setValues(rows);
}

function checkBitrixDuplicateRegistry() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const registry = readBitrixSentUidRegistry_(ss);
  let duplicateCount = 0;
  let sentWithoutDealIdCount = 0;

  registry.rowsByUid.forEach(rows => {
    if (rows.length > 1) {
      duplicateCount += rows.length - 1;
    }

    rows.forEach(row => {
      const status = String(row['Статус'] || '').trim();
      const bitrixDealId = String(row['Bitrix Deal ID'] || '').trim();

      if (status === 'sent_to_bitrix' && !bitrixDealId) {
        sentWithoutDealIdCount += 1;
      }
    });
  });

  SpreadsheetApp.getUi().alert(
    'Проверка завершена. Найдено дублей: ' + duplicateCount +
    '. sent_to_bitrix без Bitrix Deal ID: ' + sentWithoutDealIdCount + '.'
  );
}


function aggregateAppointmentCompositionText_(compositionTexts) {
  const counts = new Map();

  (compositionTexts || []).forEach(text => {
    splitLines_(text).forEach(line => {
      const parsed = parseCompositionLine_(line);
      if (!parsed.name) return;
      counts.set(parsed.name, (counts.get(parsed.name) || 0) + parsed.count);
    });
  });

  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
    .map(([name, count]) => count > 1 ? name + ' х ' + count : name)
    .join('\n');
}


function parseCompositionLine_(line) {
  const text = String(line || '').trim();
  const match = text.match(/^(.*?)\s+[xх]\s*(\d+(?:[.,]\d+)?)$/i);

  if (!match) {
    return { name: text, count: text ? 1 : 0 };
  }

  return {
    name: match[1].trim(),
    count: parseNumber_(match[2]) || 1
  };
}


function buildBitrixDealAppointmentsDescription_(group) {
  const lines = ['Назначения:', ''];

  const firstPlanDate = getFirstDateFromUidRows_(group.uidRows) || group.firstPlanDate || null;
  const doctorGroups = groupUidRowsByDoctor_(group.uidRows);

  lines.push('Первый плановый день: ' + formatDateRu_(firstPlanDate));
  lines.push('Общая сумма: ' + formatMoneyForText_(group.amount));
  lines.push('');

  doctorGroups.forEach((doctorGroup, i) => {
    if (i > 0) {
      lines.push('');
    }

    lines.push('Врач: ' + (doctorGroup.doctor || 'Не указан'));
    lines.push('Состав назначений:');

    const composition = aggregateAppointmentCompositionText_(
      doctorGroup.rows.map(row => row.composition).filter(Boolean)
    );

    if (composition) {
      splitLines_(composition).forEach(line => lines.push('- ' + line));
    }

    const amount = doctorGroup.rows.reduce((sum, row) => {
      return sum + (Number(row.amount) || 0);
    }, 0);

    lines.push('Сумма: ' + formatMoneyForText_(amount));
  });

  return lines.join('\n');
}


function getFirstDateFromUidRows_(uidRows) {
  const dates = (uidRows || [])
    .map(row => row.firstPlanDate)
    .filter(date => Object.prototype.toString.call(date) === '[object Date]' && !isNaN(date));

  if (!dates.length) {
    return null;
  }

  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates[0];
}


function groupUidRowsByDoctor_(uidRows) {
  const groups = new Map();

  (uidRows || []).forEach(row => {
    const doctor = String(row.doctor || '').trim() || 'Не указан';

    if (!groups.has(doctor)) {
      groups.set(doctor, {
        doctor,
        rows: []
      });
    }

    groups.get(doctor).rows.push(row);
  });

  return Array.from(groups.values());
}


function parseBitrixDealPlanDate_(row) {
  return (
    parseDateOnly_(row['Первый плановый день']) ||
    parseDateOnly_(row['Дата лечения']) ||
    parseDateOnly_(row['ДатаЛечения']) ||
    parseDateOnly_(row['Дата']) ||
    null
  );
}


function writeBitrixDealsOutput_(ss, outputRows) {
  let sheet = ss.getSheetByName(DEALS_CONFIG.bitrixDealsSheetName);

  if (!sheet) {
    sheet = ss.insertSheet(DEALS_CONFIG.bitrixDealsSheetName);
  }

  sheet.clear();
  sheet.getRange(1, 1, 1, BITRIX_DEALS_HEADERS.length).setValues([BITRIX_DEALS_HEADERS]);

  if (outputRows.length > 0) {
    sheet.getRange(2, 1, outputRows.length, BITRIX_DEALS_HEADERS.length).setValues(outputRows);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, BITRIX_DEALS_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#cfe2f3')
    .setHorizontalAlignment('center');

  const totalRows = Math.max(outputRows.length, 1);
  sheet.getRange(2, 7, totalRows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 8, totalRows, 2).setNumberFormat('dd.MM.yyyy');
  const aiUpdatedAtColumn = BITRIX_DEALS_HEADERS.indexOf('AI updated_at') + 1;
  sheet.getRange(2, aiUpdatedAtColumn, totalRows, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');

  if (outputRows.length > 0) {
    sheet.getRange(2, 12, outputRows.length, 11).setWrap(true);
  }

  sheet.autoResizeColumns(1, BITRIX_DEALS_HEADERS.length);
  sheet.setColumnWidth(12, 450);
  sheet.setColumnWidth(13, 500);
  sheet.setColumnWidth(14, 180);
  sheet.setColumnWidth(15, 450);
  sheet.setColumnWidth(16, 800);
  sheet.setColumnWidth(17, 120);
  sheet.setColumnWidth(18, 600);
  sheet.setColumnWidth(19, 800);
  sheet.setColumnWidth(21, 800);
  sheet.setColumnWidth(22, 800);

  if (sheet.getFilter()) {
    sheet.getFilter().remove();
  }

  sheet.getRange(1, 1, Math.max(outputRows.length + 1, 1), BITRIX_DEALS_HEADERS.length).createFilter();
}


function readSheetWithHeaders_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values.length ? values[0].map(h => String(h || '').trim()) : [];
  const headerMap = {};

  headers.forEach((header, i) => {
    headerMap[header] = i + 1;
  });

  const rows = values.slice(1).map(row => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = row[i];
    });
    return obj;
  });

  return { headers, headerMap, rows };
}


function setSheetValueByHeader_(sheet, headerMap, rowNumber, header, value) {
  const colNumber = headerMap[header];

  if (!colNumber) {
    throw new Error('Не найдена колонка "' + header + '" на листе "' + sheet.getName() + '".');
  }

  sheet.getRange(rowNumber, colNumber).setValue(value);
}


function addUniqueText_(items, value) {
  const text = String(value || '').trim();

  if (text && items.indexOf(text) === -1) {
    items.push(text);
  }
}


function splitLines_(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}


function parseJsonSafely_(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (err) {
    return null;
  }
}


function buildUidPlanItemsJson_(uidGroup) {
  const itemsMap = new Map();

  (uidGroup.items || []).forEach(item => {
    const sourceName = String(item.nomenclature || '').trim();
    const displayName = normalizePlanItemDisplayName_(sourceName);
    const doctor = String(uidGroup.doctor || '').trim();
    const unitPrice = Number(item.price) || 0;
    const firstPlanDate = uidGroup.firstTreatmentDate
      ? formatDateKey_(uidGroup.firstTreatmentDate)
      : '';

    const key = [
      uidGroup.uid,
      sourceName,
      doctor,
      unitPrice
    ].join('|');

    if (!itemsMap.has(key)) {
      itemsMap.set(key, {
        uid: String(uidGroup.uid || '').trim(),
        source_name: sourceName,
        display_name: displayName,
        service_class: detectPlanServiceClass_(sourceName),
        doctor: doctor,
        first_plan_date: firstPlanDate,
        qty: 0,
        unit_price: unitPrice,
        sum: 0
      });
    }

    const row = itemsMap.get(key);
    row.qty += 1;
    row.sum += unitPrice;
  });

  return JSON.stringify({
    version: 1,
    uid: String(uidGroup.uid || '').trim(),
    patient_code: String(uidGroup.patientCode || '').trim(),
    branch: String(uidGroup.branch || '').trim(),
    items: Array.from(itemsMap.values())
  });
}


function normalizePlanItemDisplayName_(nomenclature) {
  const source = String(nomenclature || '').trim();

  if (!source) {
    return '';
  }

  return source
    .replace(/\s*\|.*$/g, '')
    .trim();
}


function detectPlanServiceClass_(name) {
  const text = normalizeText_(name);

  if (
    text.indexOf('mls') !== -1 ||
    text.indexOf('лазер') !== -1 ||
    text.indexOf('лазеротерап') !== -1
  ) {
    return 'ЛАЗЕР';
  }

  if (
    text.indexOf('sis') !== -1 ||
    text.indexOf('магнит') !== -1 ||
    text.indexOf('магнитотерап') !== -1
  ) {
    return 'МАГНИТ';
  }

  if (text.indexOf('массаж') !== -1) {
    return 'МАССАЖ';
  }

  if (
    text.indexOf('prp') !== -1 ||
    text.indexOf('плазм') !== -1 ||
    text.indexOf('плазма') !== -1 ||
    text.indexOf('тромбоцит') !== -1
  ) {
    return 'ПЛАЗМА';
  }

  if (
    text.indexOf('лфк') !== -1 ||
    text.indexOf('физическ') !== -1 ||
    text.indexOf('физический терапевт') !== -1 ||
    text.indexOf('кинези') !== -1
  ) {
    return 'ЛФК';
  }

  if (
    text.indexOf('анализ') !== -1 ||
    text.indexOf('кров') !== -1 ||
    text.indexOf('моч') !== -1 ||
    text.indexOf('соэ') !== -1 ||
    text.indexOf('с-реактив') !== -1 ||
    text.indexOf('с реактив') !== -1 ||
    text.indexOf('срб') !== -1 ||
    text.indexOf('ревматоид') !== -1 ||
    text.indexOf('биохим') !== -1 ||
    text.indexOf('глюкоз') !== -1 ||
    text.indexOf('креатинин') !== -1 ||
    text.indexOf('алт') !== -1 ||
    text.indexOf('аст') !== -1 ||
    text.indexOf('ферритин') !== -1 ||
    text.indexOf('витамин') !== -1
  ) {
    return 'АНАЛИЗЫ';
  }

  return 'ПРОЧЕЕ';
}


function buildPlanItemsJson_(group, dealHash) {
  const items = [];

  (group.uidRows || []).forEach(row => {
    const raw = String(row.uidPlanItemsJson || row['UID Plan Items JSON'] || '').trim();

    if (!raw) {
      return;
    }

    const parsed = parseJsonSafely_(raw);

    if (!parsed || !Array.isArray(parsed.items)) {
      return;
    }

    parsed.items.forEach(item => {
      items.push(item);
    });
  });

  return JSON.stringify({
    version: 1,
    deal_key: String(group.dealKey || '').trim(),
    deal_hash: String(dealHash || '').trim(),
    patient_code: String(group.patientCode || '').trim(),
    branch: String(group.branch || '').trim(),
    first_plan_date: group.firstPlanDate ? formatDateKey_(group.firstPlanDate) : '',
    items: items
  });
}


function getAiRequestId_(parsed) {
  if (!parsed) {
    return '';
  }

  return parsed.request_id || parsed.requestId || parsed.id || '';
}


function extractErrorText_(parsed, body, code) {
  if (parsed && (parsed.error || parsed.message)) {
    return parsed.error || parsed.message;
  }

  return body || ('HTTP ' + code);
}

/****************************************************
 * Построение строки по одному УИД
 ****************************************************/

function buildUidDealRow_(uidGroup, requestIndexes, nearestRequestsByClient) {
  const matchedRequests = [];
  const matchedRequestNumbers = new Set();
  const matchExplanations = [];

  let amountTotal = 0;

  uidGroup.items.forEach(item => {
    amountTotal += item.price;

    const candidateRequests = findCandidateRequestsForAppointmentItem_(
      uidGroup,
      item,
      requestIndexes
    );

    candidateRequests.forEach(match => {
      const req = match.request;
      matchedRequests.push(req);

      if (req.number) {
        matchedRequestNumbers.add(req.number);
      }

      matchExplanations.push(
        formatDateRu_(item.treatmentDate) +
        ' — ' +
        match.reason +
        ': ' +
        item.nomenclature +
        ' → заявка ' +
        formatRequestShort_(req)
      );
    });
  });

  let resultStatus = DEALS_CONFIG.resultStatuses.createDeal;

  // Статус определяется на уровне всего УИД: достаточно любого совпадения
  // по любой услуге из состава УИД, с приоритетом "Начато" выше "Запланировано".
  if (matchedRequests.some(req => isStartedOrCompletedRequestState_(req.state))) {
    resultStatus = DEALS_CONFIG.resultStatuses.started;
  } else if (matchedRequests.some(req => isPlannedRequestState_(req.state))) {
    resultStatus = DEALS_CONFIG.resultStatuses.planned;
  }

  const amountToSell = resultStatus === DEALS_CONFIG.resultStatuses.createDeal
    ? amountTotal
    : 0;

  const appointmentComposition = buildAppointmentCompositionText_(uidGroup.items);
  const appointmentTypeCodes = buildAppointmentTypeCodes_(uidGroup.items);

  const nearestRequests = nearestRequestsByClient.get(normalizeCode_(uidGroup.patientCode)) || [];
  const nearestRequestsText = nearestRequests
    .slice(0, DEALS_CONFIG.nearestRequestsLimit)
    .map(req => {
      return [
        formatDateTimeForText_(req.startDateRaw),
        normalizeOutputState_(req.state),
        req.nomenclature || req.cabinet || '',
        req.number ? '№' + req.number : ''
      ].filter(Boolean).join(' — ');
    })
    .join('\n');

  const description = buildUidDescription_(uidGroup, {
    resultStatus,
    amountTotal,
    amountToSell,
    matchedRequests,
    matchedRequestNumbers: Array.from(matchedRequestNumbers),
    matchExplanations,
    nearestRequestsText,
    appointmentComposition
  });

  return {
    uid: uidGroup.uid,
    patient: uidGroup.patient,
    status: resultStatus,
    sortDate: uidGroup.firstTreatmentDate ? uidGroup.firstTreatmentDate.getTime() : 0,
    row: [
      resultStatus,
      uidGroup.patient,
      uidGroup.patientCode,
      uidGroup.branch,
      uidGroup.uid,
      uidGroup.items.length,
      amountTotal,
      amountToSell,
      uidGroup.appointmentDate || '',
      uidGroup.firstTreatmentDate,
      uidGroup.doctor,
      uidGroup.standard,
      appointmentComposition,
      appointmentTypeCodes,
      Array.from(matchedRequestNumbers).join(', '),
      nearestRequestsText,
      description,
      buildUidPlanItemsJson_(uidGroup)
    ]
  };
}


function testBuildUidDealRowStatusPriority_() {
  const baseDate = new Date(2026, 0, 10);
  const uidGroup = {
    uid: 'TEST-UID-STATUS',
    branch: 'Тестовый филиал',
    patient: 'Тестовый пациент',
    patientCode: 'P-001',
    doctor: 'Тестовый врач',
    standard: 'Тестовый стандарт',
    firstTreatmentDate: baseDate,
    items: [
      { treatmentDate: baseDate, nomenclature: 'Услуга 1', price: 1000, typeCode: 'L' },
      { treatmentDate: baseDate, nomenclature: 'Услуга 2', price: 1000, typeCode: 'M' },
      { treatmentDate: baseDate, nomenclature: 'Услуга 3', price: 1000, typeCode: 'S' },
      { treatmentDate: baseDate, nomenclature: 'Услуга 4', price: 1000, typeCode: 'F' },
      { treatmentDate: baseDate, nomenclature: 'Услуга 5', price: 1000, typeCode: 'C' }
    ]
  };

  const checks = [
    {
      name: 'плановая заявка только на одну услугу',
      requests: [
        buildUidStatusPriorityTestRequest_('Услуга 3', 'Запланирована', new Date(2026, 0, 12), 'P-001')
      ],
      expectedStatus: DEALS_CONFIG.resultStatuses.planned
    },
    {
      name: 'начатая заявка только на одну услугу',
      requests: [
        buildUidStatusPriorityTestRequest_('Услуга 4', 'Начато', baseDate, 'P-001')
      ],
      expectedStatus: DEALS_CONFIG.resultStatuses.started
    },
    {
      name: 'плановая и начатая заявки на разные услуги',
      requests: [
        buildUidStatusPriorityTestRequest_('Услуга 1', 'Запланирована', new Date(2026, 0, 12), 'P-001'),
        buildUidStatusPriorityTestRequest_('Услуга 5', 'Начато', baseDate, 'P-001')
      ],
      expectedStatus: DEALS_CONFIG.resultStatuses.started
    },
    {
      name: 'нет подходящих заявок',
      requests: [
        buildUidStatusPriorityTestRequest_('Другая услуга', 'Запланирована', new Date(2026, 0, 12), 'P-001')
      ],
      expectedStatus: DEALS_CONFIG.resultStatuses.createDeal
    }
  ];

  checks.forEach(check => {
    const row = buildUidDealRow_(
      uidGroup,
      buildRequestIndexes_(check.requests),
      new Map()
    );

    if (row.status !== check.expectedStatus) {
      throw new Error(
        'Проверка статуса УИД не пройдена: ' +
        check.name +
        '. Ожидалось "' +
        check.expectedStatus +
        '", получено "' +
        row.status +
        '".'
      );
    }
  });

  return 'Проверки статуса УИД пройдены: ' + checks.length;
}


function buildUidStatusPriorityTestRequest_(nomenclature, state, startDate, clientCode) {
  const c = DEALS_CONFIG.requestColumns;
  const row = {};

  row[c.branch] = 'Тестовый филиал';
  row[c.client] = 'Тестовый пациент';
  row[c.clientCode] = clientCode;
  row[c.state] = state;
  row[c.startDate] = startDate;
  row[c.endDate] = '';
  row[c.number] = 'TEST-' + nomenclature;
  row[c.nomenclature] = nomenclature;
  row[c.cabinet] = '';
  row.typeCode = nomenclature === 'Другая услуга' ? 'D' : {
    'Услуга 1': 'L',
    'Услуга 2': 'M',
    'Услуга 3': 'S',
    'Услуга 4': 'F',
    'Услуга 5': 'C'
  }[nomenclature] || '';

  return row;
}


function findCandidateRequestsForAppointmentItem_(uidGroup, item, requestIndexes) {
  const out = [];
  const typeCode = String(item.typeCode || '').trim().toUpperCase();

  if (!typeCode || typeCode === '-') {
    return out;
  }

  const typeKey = buildTypeServiceMatchKeyWithoutDate_(
    uidGroup.patientCode,
    uidGroup.branch,
    typeCode
  );

  const typeRequests = requestIndexes.type.get(typeKey) || [];

  typeRequests.forEach(req => {
    if (isRequestSuitableByDateAndStatus_(req, item.treatmentDate)) {
      out.push({
        request: req,
        reason: 'совпадение по типу ' + typeCode
      });
    }
  });

  // Если точные совпадения уже есть, резерв по кабинету не нужен.
  if (out.length > 0) {
    return out;
  }

  // Резерв по кабинету допустим только для заявок без номенклатуры.
  const fallbackRequests = requestIndexes.emptyNomenclatureByClientBranch.get(
    buildClientBranchMatchKeyWithoutDate_(uidGroup.patientCode, uidGroup.branch)
  ) || [];

  fallbackRequests.forEach(req => {
    if (
      isEmptyNomenclatureRequestSuitableForType_(req, typeCode) &&
      isRequestSuitableByDateAndStatus_(req, item.treatmentDate)
    ) {
      out.push({
        request: req,
        reason: 'совпадение по кабинету ' + req.cabinet
      });
    }
  });

  return out;
}


function isEmptyNomenclatureRequestSuitableForType_(request, typeCode) {
  const cabinetCategory = detectRequestServiceCategoryByCabinet_(request.cabinet);
  return (
    (typeCode === 'L' && cabinetCategory === 'LASER') ||
    (typeCode === 'S' && cabinetCategory === 'SIS')
  );
}


function isRequestSuitableByDateAndStatus_(req, treatmentDate) {
  if (!req || !req.startDate || !treatmentDate) {
    return false;
  }

  const requestDayKey = formatDateKey_(req.startDate);
  const treatmentDayKey = formatDateKey_(treatmentDate);

  // Если заявка начата или выполнена именно в день назначения —
  // считаем, что назначение уже исполняется.
  if (
    isStartedOrCompletedRequestState_(req.state) &&
    requestDayKey === treatmentDayKey
  ) {
    return true;
  }

  // Если есть плановая заявка на любую будущую дату,
  // начиная с даты назначения, считаем, что пациент записан.
  if (
    isPlannedRequestState_(req.state) &&
    requestDayKey >= treatmentDayKey
  ) {
    return true;
  }

  return false;
}


/****************************************************
 * Описание УИД
 ****************************************************/

function buildUidDescription_(uidGroup, data) {
  const lines = [];

  lines.push('Пациент: ' + uidGroup.patient);
  lines.push('Код пациента: ' + uidGroup.patientCode);
  lines.push('Филиал: ' + uidGroup.branch);
  lines.push('УИД назначения: ' + uidGroup.uid);

  if (uidGroup.doctor) {
    lines.push('Врач: ' + uidGroup.doctor);
  }

  lines.push('Первый плановый день: ' + formatDateRu_(uidGroup.firstTreatmentDate));
  lines.push('Сумма назначений всего: ' + formatMoneyForText_(data.amountTotal));

  if (data.appointmentComposition) {
    lines.push('Состав назначений: ' + data.appointmentComposition.replace(/\n/g, '; '));
  }

  if (data.matchedRequestNumbers.length) {
    lines.push('Найденные заявки: ' + data.matchedRequestNumbers.join(', '));
  }

  lines.push('');
  lines.push('Состав назначений:');

  if (data.appointmentComposition) {
    data.appointmentComposition.split('\n').forEach(line => {
      lines.push('- ' + line);
    });
  }


  if (data.matchExplanations.length) {
    lines.push('');
    lines.push('Почему УИД считается записанным/исполняемым:');
    data.matchExplanations.forEach(line => {
      lines.push('- ' + line);
    });
  } else {
    lines.push('');
    lines.push('По этому УИД не найдено ни одной подходящей заявки:');
    lines.push('- нет плановой заявки на будущую дату по номенклатуре или кабинету;');
    lines.push('- нет начатой/выполненной заявки в день назначения.');
  }

  if (data.nearestRequestsText) {
    lines.push('');
    lines.push('Ближайшие заявки пациента:');
    data.nearestRequestsText.split('\n').forEach(line => {
      lines.push('- ' + line);
    });
  }

  return lines.join('\n');
}


/****************************************************
 * Состав назначений
 ****************************************************/

function buildAppointmentCompositionText_(items) {
  const counts = new Map();

  (items || []).forEach(item => {
    const normalizedName = normalizeAppointmentCompositionName_(item.nomenclature);

    if (!normalizedName) {
      return;
    }

    counts.set(normalizedName, (counts.get(normalizedName) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
    .map(([name, count]) => {
      return count > 1 ? name + ' х ' + count : name;
    })
    .join('\n');
}


function normalizeAppointmentCompositionName_(nomenclature) {
  let name = String(nomenclature || '').trim();

  if (!name) {
    return '';
  }

  // Удаляем всё начиная с |, включая пробел перед ним.
  name = name.replace(/\s*\|.*$/g, '').trim();

  if (isAnalysisService_(name)) {
    return 'Анализы';
  }

  return name;
}


function isAnalysisService_(name) {
  const text = normalizeText_(name);

  return (
    text.indexOf('анализ') !== -1 ||
    text.indexOf('кров') !== -1 ||
    text.indexOf('моч') !== -1 ||
    text.indexOf('биохим') !== -1 ||
    text.indexOf('соэ') !== -1 ||
    text.indexOf('с-реактив') !== -1 ||
    text.indexOf('с реактив') !== -1 ||
    text.indexOf('срб') !== -1 ||
    text.indexOf('ревматоид') !== -1 ||
    text.indexOf('мочевин') !== -1 ||
    text.indexOf('креатинин') !== -1 ||
    text.indexOf('алт') !== -1 ||
    text.indexOf('аст') !== -1 ||
    text.indexOf('глюкоз') !== -1 ||
    text.indexOf('холестерин') !== -1 ||
    text.indexOf('билирубин') !== -1 ||
    text.indexOf('ферритин') !== -1 ||
    text.indexOf('витамин') !== -1 ||
    text.indexOf('лаборатор') !== -1
  );
}


/****************************************************
 * Индексы заявок
 ****************************************************/

function buildRequestIndexes_(requests) {
  const c = DEALS_CONFIG.requestColumns;

  const type = new Map();
  const emptyNomenclatureByClientBranch = new Map();

  requests.forEach(row => {
    const clientCode = row[c.clientCode];
    const branch = row[c.branch];
    const startDate = parseDateOnly_(row[c.startDate]);
    const nomenclature = row[c.nomenclature];
    const cabinet = row[c.cabinet];
    const state = String(row[c.state] || '').trim();

    if (!clientCode || !branch || !startDate) {
      return;
    }

    const req = {
      number: String(row[c.number] || '').trim(),
      client: String(row[c.client] || '').trim(),
      clientCode: String(clientCode || '').trim(),
      branch: String(branch || '').trim(),
      state,
      nomenclature: String(nomenclature || '').trim(),
      cabinet: String(cabinet || '').trim(),
      startDate,
      startDateRaw: row[c.startDate],
      endDateRaw: row[c.endDate]
    };

    const typeCode = String(row.typeCode || '').trim().toUpperCase();
    req.typeCode = typeCode;

    if (nomenclature && typeCode && typeCode !== '-') {
      const typeKey = buildTypeServiceMatchKeyWithoutDate_(
        clientCode,
        branch,
        typeCode
      );

      if (!type.has(typeKey)) {
        type.set(typeKey, []);
      }

      type.get(typeKey).push(req);
    }

    if (!String(nomenclature || '').trim()) {
      const fallbackKey = buildClientBranchMatchKeyWithoutDate_(clientCode, branch);
      if (!emptyNomenclatureByClientBranch.has(fallbackKey)) {
        emptyNomenclatureByClientBranch.set(fallbackKey, []);
      }
      emptyNomenclatureByClientBranch.get(fallbackKey).push(req);
    }
  });

  return { type, emptyNomenclatureByClientBranch };
}


function buildNearestRequestsByClientIndex_(requests) {
  const c = DEALS_CONFIG.requestColumns;
  const index = new Map();

  requests.forEach(row => {
    const clientCode = normalizeCode_(row[c.clientCode]);
    const startDate = parseDateOnly_(row[c.startDate]);
    const state = String(row[c.state] || '').trim();

    if (!clientCode || !startDate || isCancelledRequestState_(state)) {
      return;
    }

    if (!index.has(clientCode)) {
      index.set(clientCode, []);
    }

    index.get(clientCode).push({
      number: String(row[c.number] || '').trim(),
      client: String(row[c.client] || '').trim(),
      clientCode,
      branch: String(row[c.branch] || '').trim(),
      state,
      nomenclature: String(row[c.nomenclature] || '').trim(),
      cabinet: String(row[c.cabinet] || '').trim(),
      startDate,
      startDateRaw: row[c.startDate],
      endDateRaw: row[c.endDate]
    });
  });

  index.forEach(items => {
    items.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  });

  return index;
}


/****************************************************
 * Группировка назначений по УИД
 ****************************************************/

function groupAppointmentsByUid_(appointments) {
  const c = DEALS_CONFIG.appointmentColumns;
  const groups = {};

  appointments.forEach(row => {
    const uid = String(row[c.uid] || '').trim();
    const branch = String(row[c.branch] || '').trim();
    const patient = String(row[c.patient] || '').trim();
    const patientCode = String(row[c.patientCode] || '').trim();
    const doctor = String(row[c.doctor] || '').trim();
    const standard = String(row[c.standard] || '').trim();
    const treatmentDate = parseDateOnly_(row[c.treatmentDate]);
    const appointmentDate = parseDateOnly_(row[c.appointmentDate]);
    const nomenclature = String(row[c.nomenclature] || '').trim();
    const price = parseNumber_(row[c.price]);
    const typeCode = String(row.typeCode || '').trim().toUpperCase();

    if (!uid || !branch || !patientCode || !patient || !treatmentDate || !nomenclature) {
      return;
    }

    if (!groups[uid]) {
      groups[uid] = {
        uid,
        branch,
        patient,
        patientCode,
        doctor,
        standard,
        firstTreatmentDate: treatmentDate,
        appointmentDates: [],
        appointmentDate: null,
        items: []
      };
    }

    if (appointmentDate) {
      groups[uid].appointmentDates.push(appointmentDate);
      if (!groups[uid].appointmentDate || appointmentDate > groups[uid].appointmentDate) groups[uid].appointmentDate = appointmentDate;
    }

    if (treatmentDate < groups[uid].firstTreatmentDate) {
      groups[uid].firstTreatmentDate = treatmentDate;
    }

    if (!groups[uid].doctor && doctor) {
      groups[uid].doctor = doctor;
    }

    if (!groups[uid].standard && standard) {
      groups[uid].standard = standard;
    }

    groups[uid].items.push({
      treatmentDate,
      nomenclature,
      price,
      typeCode
    });
  });

  Object.keys(groups).forEach(uid => {
    const dates = Array.from(new Set(groups[uid].appointmentDates.map(formatDateForBitrix_)));
    if (dates.length > 1) Logger.log('УИД ' + uid + ': обнаружено несколько дат назначения: ' + dates.join(', ') + '. Использована самая поздняя дата.');
  });
  return groups;
}


/****************************************************
 * Вывод листа "Сделки"
 ****************************************************/

function writeDealsOutput_(ss, outputRows) {
  let sheet = ss.getSheetByName(DEALS_CONFIG.outputSheetName);

  if (!sheet) {
    sheet = ss.insertSheet(DEALS_CONFIG.outputSheetName);
  }

  sheet.clear();

  const headers = [
    'Статус',
    'ФИО',
    'Пациент.Код',
    'Филиал',
    'УИД',
    'Кол-во услуг',
    'Сумма назначений',
    'Сумма к продаже',
    'Дата назначения',
    'Первый плановый день',
    'Врач',
    'Стандарт лечения',
    'Состав назначений',
    'Типы назначений',
    'Номера найденных заявок',
    'Ближайшие заявки пациента',
    'Описание сделки',
    'UID Plan Items JSON'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (outputRows.length > 0) {
    sheet.getRange(2, 1, outputRows.length, headers.length).setValues(outputRows);
  }

  sheet.setFrozenRows(1);

  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#d9ead3')
    .setHorizontalAlignment('center');

  const totalRows = Math.max(outputRows.length, 1);

  sheet.getRange(2, 6, totalRows, 1).setNumberFormat('0');
  sheet.getRange(2, 7, totalRows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 8, totalRows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 9, totalRows, 2).setNumberFormat('dd.MM.yyyy');

  if (outputRows.length > 0) {
    sheet.getRange(2, 12, outputRows.length, 6).setWrap(true);

    const statusValues = sheet.getRange(2, 1, outputRows.length, 1).getValues();

    statusValues.forEach((row, i) => {
      const status = String(row[0] || '');
      const range = sheet.getRange(i + 2, 1, 1, headers.length);

      if (status === DEALS_CONFIG.resultStatuses.createDeal) {
        range.setBackground('#fff2cc');
      }

      if (status === DEALS_CONFIG.resultStatuses.planned) {
        range.setBackground('#d9ead3');
      }

      if (status === DEALS_CONFIG.resultStatuses.started) {
        range.setBackground('#cfe2f3');
      }
    });
  }

  sheet.autoResizeColumns(1, headers.length);

  sheet.setColumnWidth(12, 450);
  sheet.setColumnWidth(14, 500);
  sheet.setColumnWidth(15, 800);
  sheet.setColumnWidth(16, 800);
  sheet.setColumnWidth(17, 800);

  if (sheet.getFilter()) {
    sheet.getFilter().remove();
  }

  sheet.getRange(1, 1, Math.max(outputRows.length + 1, 1), headers.length).createFilter();
}


/****************************************************
 * Статусы заявок
 ****************************************************/

function isRelevantRequestState_(state) {
  return isPlannedRequestState_(state) || isStartedOrCompletedRequestState_(state);
}


function isCancelledRequestState_(state) {
  const normalized = normalizeText_(state);

  if (!normalized) {
    return false;
  }

  return DEALS_CONFIG.cancelledRequestStateMarkers.some(marker => {
    return normalized.indexOf(normalizeText_(marker)) !== -1;
  });
}


function isPlannedRequestState_(state) {
  const normalized = normalizeText_(state);

  return DEALS_CONFIG.plannedRequestStates.some(allowedState => {
    return normalized === normalizeText_(allowedState);
  });
}


function isStartedRequestState_(state) {
  const normalized = normalizeText_(state);

  return DEALS_CONFIG.startedRequestStates.some(startedState => {
    return normalized === normalizeText_(startedState);
  });
}


function isCompletedRequestState_(state) {
  const normalized = normalizeText_(state);

  return DEALS_CONFIG.completedRequestStates.some(completedState => {
    return normalized === normalizeText_(completedState);
  });
}


function isStartedOrCompletedRequestState_(state) {
  return isStartedRequestState_(state) || isCompletedRequestState_(state);
}


function normalizeOutputState_(state) {
  if (isStartedOrCompletedRequestState_(state)) {
    return DEALS_CONFIG.resultStatuses.started;
  }

  if (isPlannedRequestState_(state)) {
    return DEALS_CONFIG.resultStatuses.planned;
  }

  return String(state || '').trim();
}


/****************************************************
 * Ключи сопоставления без даты
 ****************************************************/

function buildExactServiceMatchKeyWithoutDate_(clientCode, branch, nomenclature) {
  return [
    normalizeCode_(clientCode),
    normalizeText_(branch),
    normalizeNomenclature_(nomenclature)
  ].join('|');
}


function buildCategoryServiceMatchKeyWithoutDate_(clientCode, branch, category) {
  return [
    normalizeCode_(clientCode),
    normalizeText_(branch),
    String(category || '').trim()
  ].join('|');
}


function buildTypeServiceMatchKeyWithoutDate_(clientCode, branch, typeCode) {
  return [
    normalizeCode_(clientCode),
    normalizeText_(branch),
    String(typeCode || '').trim().toUpperCase()
  ].join('|');
}


function buildClientBranchMatchKeyWithoutDate_(clientCode, branch) {
  return [normalizeCode_(clientCode), normalizeText_(branch)].join('|');
}


function normalizeCode_(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .trim();
}


function normalizeNomenclature_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}


/****************************************************
 * Логика кабинетов и типов услуг
 ****************************************************/

function detectRequestServiceCategoryByCabinet_(cabinet) {
  const text = normalizeText_(cabinet);

  if (text.indexOf('фтл') !== -1) {
    return 'LASER';
  }

  if (text.indexOf('магнит') !== -1) {
    return 'SIS';
  }

  return '';
}


function detectAppointmentServiceCategory_(nomenclature) {
  const text = normalizeText_(nomenclature);

  if (
    text.indexOf('mls') !== -1 ||
    text.indexOf('лазер') !== -1 ||
    text.indexOf('лазеротерап') !== -1
  ) {
    return 'LASER';
  }

  if (
    text.indexOf('sis') !== -1 ||
    text.indexOf('магнит') !== -1 ||
    text.indexOf('магнитотерап') !== -1
  ) {
    return 'SIS';
  }

  return '';
}


/****************************************************
 * Форматирование
 ****************************************************/

function formatRequestShort_(req) {
  return [
    req.number ? '№' + req.number : 'без номера',
    normalizeOutputState_(req.state),
    formatDateTimeForText_(req.startDateRaw),
    req.nomenclature || req.cabinet || ''
  ].filter(Boolean).join(' / ');
}


function formatDateRu_(dateObj) {
  if (!dateObj) {
    return '';
  }

  const d = String(dateObj.getDate()).padStart(2, '0');
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const y = dateObj.getFullYear();

  return d + '.' + m + '.' + y;
}


function formatDateTimeForText_(value) {
  if (!value) {
    return '';
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    const d = String(value.getDate()).padStart(2, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const y = value.getFullYear();
    const hh = String(value.getHours()).padStart(2, '0');
    const mm = String(value.getMinutes()).padStart(2, '0');

    if (hh === '00' && mm === '00') {
      return d + '.' + m + '.' + y;
    }

    return d + '.' + m + '.' + y + ' ' + hh + ':' + mm;
  }

  return String(value || '').trim();
}


function formatMoneyForText_(value) {
  const num = Number(value) || 0;

  return num
    .toLocaleString('ru-RU', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }) + ' ₽';
}


/****************************************************
 * Общие helpers
 ****************************************************/

function readSheetAsObjects_(sheet) {
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(h => String(h || '').trim());

  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = row[i];
    });
    return obj;
  });
}


function getRequiredSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);

  if (!sheet) {
    throw new Error('Не найден лист "' + name + '". Проверь название листа в DEALS_CONFIG.');
  }

  return sheet;
}


function normalizeText_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}


function parseDateOnly_(value) {
  if (!value) {
    return null;
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === 'number') {
    const parsedNumberDate = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (!isNaN(parsedNumberDate)) {
      return new Date(
        parsedNumberDate.getFullYear(),
        parsedNumberDate.getMonth(),
        parsedNumberDate.getDate()
      );
    }
  }

  const text = String(value).trim();

  const matchRu = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (matchRu) {
    return new Date(
      Number(matchRu[3]),
      Number(matchRu[2]) - 1,
      Number(matchRu[1])
    );
  }

  const matchIso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (matchIso) {
    return new Date(
      Number(matchIso[1]),
      Number(matchIso[2]) - 1,
      Number(matchIso[3])
    );
  }

  const parsed = new Date(text);
  if (!isNaN(parsed)) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  return null;
}


function formatDateKey_(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');

  return y + '-' + m + '-' + d;
}


function parseNumber_(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const text = String(value)
    .replace(/\s+/g, '')
    .replace(',', '.');

  const num = Number(text);

  return isNaN(num) ? 0 : num;
}


function getOrCreateSheet_(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  return sheet;
}

/****************************************************
 * Интеграция Bitrix24: отправка сделок и сотрудники
 ****************************************************/

const BITRIX_DEAL_CATEGORY_ID = 114;
const BITRIX_DEAL_TYPES_FIELD = 'UF_CRM_1784225678';
const BITRIX_DEAL_PATIENT_CODE_FIELD = 'UF_CRM_1783751141';
const BITRIX_DEAL_APPOINTMENT_DATE_FIELD = 'UF_CRM_1784267448';
const BITRIX_DEAL_STAGE_CONTACT = 'C114:NEW';
const BITRIX_DEAL_STAGE_WAITING = 'C114:UC_2ITBVA';
const BITRIX_DEAL_CONTACT_WINDOW_DAYS = 5;
const BITRIX_DEAL_ASSIGNED_BY_ID = 22718;
const BITRIX_DEAL_SMALL_AMOUNT_ASSIGNED_BY_ID = 6108;
const BITRIX_DEAL_SMALL_AMOUNT_LIMIT = 20000;
const BITRIX_EMPLOYEES_SHEET_NAME = 'Справочник сотрудников';
const BITRIX_DEAL_SUCCESS_STATUSES = ['Отправлено', 'sent_to_bitrix', 'Уже существует в Bitrix'];

function getTodayDateOnly_() {
  const timeZone = Session.getScriptTimeZone();
  const todayText = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  return parseDateOnly_(todayText);
}

function getInitialBitrixDealStageId_(firstPlanDateValue) {
  const firstPlanDate = parseDateOnly_(firstPlanDateValue);
  const today = getTodayDateOnly_();

  if (!firstPlanDate || !today) {
    return BITRIX_DEAL_STAGE_CONTACT;
  }

  const differenceInCalendarDays = Math.round(
    (firstPlanDate.getTime() - today.getTime()) /
    (24 * 60 * 60 * 1000)
  );

  return differenceInCalendarDays > BITRIX_DEAL_CONTACT_WINDOW_DAYS
    ? BITRIX_DEAL_STAGE_WAITING
    : BITRIX_DEAL_STAGE_CONTACT;
}

function testInitialBitrixDealStageId_() {
  const today = getTodayDateOnly_();
  const dateInDays = function(days) {
    const date = new Date(today.getTime());
    date.setDate(date.getDate() + days);
    return date;
  };
  const checks = [
    { name: 'дата через 6 дней', value: dateInDays(6), expected: BITRIX_DEAL_STAGE_WAITING },
    { name: 'дата через 5 дней', value: dateInDays(5), expected: BITRIX_DEAL_STAGE_CONTACT },
    { name: 'дата через 4 дня', value: dateInDays(4), expected: BITRIX_DEAL_STAGE_CONTACT },
    { name: 'сегодня', value: dateInDays(0), expected: BITRIX_DEAL_STAGE_CONTACT },
    { name: 'дата в прошлом', value: dateInDays(-1), expected: BITRIX_DEAL_STAGE_CONTACT },
    { name: 'пустая дата', value: '', expected: BITRIX_DEAL_STAGE_CONTACT }
  ];

  checks.forEach(check => {
    const actual = getInitialBitrixDealStageId_(check.value);
    if (actual !== check.expected) {
      throw new Error(
        'Ошибка проверки начальной стадии Bitrix для «' + check.name +
        '»: ожидалось ' + check.expected + ', получено ' + actual + '.'
      );
    }
  });

  return 'Проверка определения начальной стадии Bitrix пройдена.';
}

function getBitrixDealAssignedById_(amount) {
  const value = Number(amount) || 0;

  if (value < BITRIX_DEAL_SMALL_AMOUNT_LIMIT) {
    return BITRIX_DEAL_SMALL_AMOUNT_ASSIGNED_BY_ID;
  }

  return BITRIX_DEAL_ASSIGNED_BY_ID;
}


function addBitrixDealComment_(dealId, text) {
  if (!dealId || !text) {
    return null;
  }

  return bitrixCall_('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: text
    }
  });
}

function buildBitrixDealTimelineComment_(row) {
  const aiSummary = formatAiSummaryForBitrix_(row['AI справка'] || '');

  const appointmentsTextRaw = row['Описание назначений'] || row['Назначения'] || '';
  let appointmentsText = normalizeMultilineTextForBitrix_(appointmentsTextRaw);

  appointmentsText = appointmentsText
    .replace(/^Назначения:\s*/i, '')
    .trim();

  const parts = [];

  if (aiSummary) {
    parts.push(aiSummary);
  }

  if (appointmentsText) {
    parts.push('НАЗНАЧЕНИЯ\n\n' + appointmentsText);
  }

  return parts
    .filter(Boolean)
    .join('\n\n---\n\n')
    .trim();
}

function bitrixCall_(method, payload) {
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

  return data.result;
}

function updateBitrixEmployeesDirectory() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, BITRIX_EMPLOYEES_SHEET_NAME);
  const employees = fetchAllBitrixUsers_();
  const headers = [
    'Bitrix User ID',
    'ФИО',
    'Имя',
    'Фамилия',
    'Отчество',
    'Email',
    'Активен',
    'Должность',
    'Подразделение',
    'Дата обновления'
  ];
  const now = new Date();
  const rows = employees.map(user => {
    const lastName = String(user.LAST_NAME || '').trim();
    const name = String(user.NAME || '').trim();
    const secondName = String(user.SECOND_NAME || '').trim();
    const fullName = [lastName, name, secondName].filter(Boolean).join(' ').trim();
    const departments = Array.isArray(user.UF_DEPARTMENT)
      ? user.UF_DEPARTMENT.join(', ')
      : String(user.UF_DEPARTMENT || '');

    return [
      user.ID || '',
      fullName,
      name,
      lastName,
      secondName,
      user.EMAIL || '',
      user.ACTIVE || '',
      user.WORK_POSITION || '',
      departments,
      now
    ];
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
  SpreadsheetApp.getUi().alert('Справочник сотрудников обновлен. Загружено сотрудников: ' + rows.length);
}

function fetchAllBitrixUsers_() {
  const result = [];
  let start = 0;

  while (true) {
    const response = bitrixCall_('user.get', {
      FILTER: { ACTIVE: true },
      start: start
    });
    const users = Array.isArray(response) ? response : [];
    result.push.apply(result, users);

    if (users.length < 50) {
      break;
    }

    start += 50;
  }

  return result;
}

function readBitrixEmployeesMap_(ss) {
  const sheet = ss.getSheetByName(BITRIX_EMPLOYEES_SHEET_NAME);

  if (!sheet) {
    return new Map();
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return new Map();
  }

  const headers = values[0].map(String);
  const idIndex = headers.indexOf('Bitrix User ID');
  const fioIndex = headers.indexOf('ФИО');
  const activeIndex = headers.indexOf('Активен');
  const map = new Map();

  if (idIndex === -1 || fioIndex === -1) {
    return map;
  }

  values.slice(1).forEach(row => {
    const id = String(row[idIndex] || '').trim();
    const fio = String(row[fioIndex] || '').trim();
    const active = activeIndex === -1 ? 'true' : String(row[activeIndex] || '').trim();

    if (!id || !fio) {
      return;
    }

    if (active && active.toLowerCase() !== 'true' && active.toLowerCase() !== 'y' && active.toLowerCase() !== 'да' && active !== '1') {
      return;
    }

    map.set(normalizeDoctorName_(fio), id);
  });

  return map;
}

function normalizeDoctorName_(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function uploadBitrixDeals() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getRequiredSheet_(ss, DEALS_CONFIG.bitrixDealsSheetName);
  ensureBitrixDealsUploadColumns_(sheet);
  const data = readSheetWithHeaders_(sheet);
  const registry = readBitrixSentUidRegistry_(ss);
  const doctorUserMap = readBitrixEmployeesMap_(ss);
  const now = new Date();
  let sentCount = 0;
  let existingCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  data.rows.forEach((row, i) => {
    const rowNumber = i + 2;
    const uids = splitUids_(row['УИДы'] || row['TEMED_UIDS']);
    const status = String(row['Статус отправки'] || '').trim();
    const bitrixDealId = String(row['Bitrix Deal ID'] || '').trim();

    if (isEmptyBitrixDealRow_(row)) {
      skippedCount += 1;
      return;
    }

    if (bitrixDealId || BITRIX_DEAL_SUCCESS_STATUSES.indexOf(status) !== -1) {
      skippedCount += 1;
      return;
    }

    const alreadySent = uids.filter(uid => registry.sentUidSet.has(uid));

    if (uids.length && alreadySent.length === uids.length) {
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Ошибка', 'Все УИДы уже есть в реестре отправки Bitrix: ' + alreadySent.join(', '));
      skippedCount += 1;
      return;
    }

    if (alreadySent.length) {
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Статус отправки', 'Ошибка');
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Ошибка', 'Часть УИДов уже есть в реестре отправки Bitrix. Пересоберите лист, чтобы отправить только новые УИДы: ' + alreadySent.join(', '));
      skippedCount += 1;
      return;
    }

    try {
      const dealHash = String(row['Deal Hash'] || row['TEMED_DEAL_HASH'] || '').trim() || buildDealHashFromUids_(uids);
      const existingDeal = findBitrixDealByHash_(dealHash);

      if (existingDeal) {
        const comment = String(row['Ошибка'] || '').trim();
        setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Bitrix Deal ID', existingDeal.ID || '');
        setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Статус отправки', 'Уже существует в Bitrix');
        setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Bitrix sent_at', now);
        appendSentUidsToBitrixRegistry_(ss, row, existingDeal.ID || '', 'sent_to_bitrix', comment);
        existingCount += 1;
        return;
      }

      const created = createBitrixDealFromRow_(row, doctorUserMap);
      const warnings = created.warnings.slice();

      try {
        const timelineComment = buildBitrixDealTimelineComment_(row);

        if (timelineComment) {
          addBitrixDealComment_(created.dealId, timelineComment);
        }
      } catch (commentErr) {
        const commentErrorText = commentErr && commentErr.message
          ? commentErr.message
          : String(commentErr);

        warnings.push('Сделка создана, но комментарий в таймлайн не добавлен: ' + commentErrorText);
      }

      const warningText = warnings.join('\n');

      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Bitrix Deal ID', created.dealId);
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Статус отправки', 'Отправлено');
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Ошибка', warningText);
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Bitrix sent_at', now);

      appendSentUidsToBitrixRegistry_(ss, row, created.dealId, 'sent_to_bitrix', warningText);
      created.uids.forEach(uid => registry.sentUidSet.add(uid));

      sentCount += 1;
    } catch (err) {
      const errorText = err && err.message ? err.message : String(err);
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Статус отправки', 'Ошибка');
      setSheetValueByHeader_(sheet, data.headerMap, rowNumber, 'Ошибка', errorText);
      appendUidsToBitrixRegistry_(ss, row, '', 'error', errorText);
      errorCount += 1;
    }
  });

  SpreadsheetApp.getUi().alert(
    'Отправка завершена. Создано: ' + sentCount +
    ', найдено дублей в Bitrix: ' + existingCount +
    ', пропущено: ' + skippedCount +
    ', ошибок: ' + errorCount + '.'
  );
}

function isEmptyBitrixDealRow_(row) {
  return !String(row['DealKey'] || '').trim() &&
    !String(row['ФИО'] || '').trim() &&
    !String(row['УИДы'] || row['TEMED_UIDS'] || '').trim();
}

function ensureBitrixDealsUploadColumns_(sheet) {
  const required = ['Статус отправки', 'Bitrix Deal ID', 'Ошибка', 'Bitrix sent_at'];
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(header => String(header || '').trim())
    : [];
  const missing = required.filter(header => headers.indexOf(header) === -1);

  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
}

function findBitrixDealByHash_(dealHash) {
  if (!dealHash) {
    return null;
  }

  const result = bitrixCall_('crm.deal.list', {
    filter: {
      CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID,
      UF_CRM_1783751578: dealHash
    },
    select: ['ID', 'TITLE', 'CATEGORY_ID', 'UF_CRM_1783751578']
  });

  if (Array.isArray(result) && result.length) {
    return result[0];
  }

  return null;
}

function createBitrixDealFromRow_(row, doctorUserMap) {
  const warnings = [];
  const uids = splitUids_(row['УИДы'] || row['TEMED_UIDS']);
  const dealHash = String(row['Deal Hash'] || row['TEMED_DEAL_HASH'] || '').trim() || buildDealHashFromUids_(uids);
  const doctorName = String(row['Врач'] || '').trim();
  const doctorUserId = doctorUserMap.get(normalizeDoctorName_(doctorName));
  const appointmentsText = normalizeMultilineTextForBitrix_(
    row['Описание назначений'] || row['Назначения'] || ''
  );
  const aiSummary = formatAiSummaryForBitrix_(row['AI справка'] || '');
  const appointmentTypeCodes = mergeAppointmentTypeCodes_([row['Типы назначений'] || '']);
  const adminComment = normalizeMultilineTextForBitrix_(
    row['Комментарий администратора'] || ''
  );
  const phone = String(row['Телефон клиента'] || '').trim();
  const planItemsJson = String(row['Plan Items JSON'] || '').trim();
  const dealAmount = parseMoney_(row['Сумма сделки']);
  const firstPlanDateValue = row['Первый плановый день'];
  const appointmentDate = parseDateOnly_(row['Дата назначения']);
  const initialStageId = getInitialBitrixDealStageId_(firstPlanDateValue);
  const patientCode = normalizePatientCodeForBitrix_(row['Пациент.Код']);
  const fields = {
    CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID,
    STAGE_ID: initialStageId,
    ASSIGNED_BY_ID: getBitrixDealAssignedById_(dealAmount),
    TITLE: buildBitrixDealTitle_(row),
    OPPORTUNITY: dealAmount,
    CURRENCY_ID: 'RUB',
    UF_CRM_1737550182812: row['ФИО'] || '',
    UF_CRM_1759810401: row['Филиал'] || row['Клиника'] || '',
    UF_CRM_1737550697075: adminComment,
    UF_CRM_1783751372: uids,
    UF_CRM_1783751578: dealHash,
    UF_CRM_1783752197: appointmentsText,
    [BITRIX_DEAL_TYPES_FIELD]: appointmentTypeCodes,
    UF_CRM_1783752297: aiSummary
  };

  if (appointmentDate) {
    fields[BITRIX_DEAL_APPOINTMENT_DATE_FIELD] = formatDateForBitrix_(appointmentDate);
  } else {
    warnings.push('В сделке не определена дата назначения из колонки «Назначения.Дата».');
  }

  if (patientCode) {
    fields[BITRIX_DEAL_PATIENT_CODE_FIELD] = patientCode;
  } else {
    warnings.push('В сделке не указан Пациент.Код.');
  }

  if (phone) {
    fields.UF_CRM_615C18C0D7CD9 = phone;
  }

  if (planItemsJson) {
    fields.UF_CRM_1784034617 = planItemsJson;
  }

  if (doctorUserId) {
    fields.UF_CRM_1624006506 = Number(doctorUserId);
  } else if (doctorName) {
    warnings.push('Врач не сопоставлен с сотрудником Bitrix: ' + doctorName);
  }

  const firstPlanDate = parseDateForBitrix_(firstPlanDateValue);
  if (firstPlanDate) {
    fields.UF_CRM_1783751996 = firstPlanDate;
  }

  const dealId = bitrixCall_('crm.deal.add', {
    fields: fields,
    params: { REGISTER_SONET_EVENT: 'Y' }
  });

  return { dealId, dealHash, uids, warnings };
}


/****************************************************
 * Обратное заполнение типов в уже существующих сделках Bitrix
 ****************************************************/

function backfillBitrixDealAppointmentTypes() {
  const lock = LockService.getScriptLock();
  const ui = SpreadsheetApp.getUi();
  if (!lock.tryLock(1)) {
    ui.alert('Актуализация существующих сделок Bitrix уже выполняется.');
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const typeCodesSheet = getRequiredSheet_(ss, DEALS_CONFIG.typeCodesSheetName);
    const dictionary = validateBackfillAppointmentTypeDictionary_(typeCodesSheet);
    const deals = fetchBitrixDealsForTypeBackfill_();
    const registry = readBitrixSentUidRegistry_(ss);
    const patientCodesByDealId = readPatientCodesByBitrixDealId_(ss);
    const appointmentDatesByUid = readAppointmentDatesByUid_(ss);
    const stats = {
      loaded: deals.length, emptyTypes: 0, emptyPatientCodes: 0, emptyAppointmentDates: 0, alreadyFilled: 0,
      readyTypes: 0, readyPatientCodes: 0, readyAppointmentDates: 0, both: 0, noTypes: 0, noPatientCode: 0, noAppointmentDate: 0,
      patientCodeConflicts: 0, updated: 0, typesUpdated: 0, patientCodesUpdated: 0, appointmentDatesUpdated: 0,
      bothUpdated: 0, errors: []
    };
    const unknown = new Map();
    const updates = [];

    deals.forEach(deal => {
      const typesEmpty = isEmptyBitrixValue_(deal[BITRIX_DEAL_TYPES_FIELD]);
      const patientCodeEmpty = isEmptyBitrixValue_(deal[BITRIX_DEAL_PATIENT_CODE_FIELD]);
      const appointmentDateEmpty = isEmptyBitrixValue_(deal[BITRIX_DEAL_APPOINTMENT_DATE_FIELD]);
      if (!typesEmpty && !patientCodeEmpty && !appointmentDateEmpty) {
        stats.alreadyFilled += 1;
        return;
      }
      if (typesEmpty) stats.emptyTypes += 1;
      if (patientCodeEmpty) stats.emptyPatientCodes += 1;
      if (appointmentDateEmpty) stats.emptyAppointmentDates += 1;

      const fieldsToUpdate = {};
      if (typesEmpty) {
        const extracted = extractDealNomenclatures_(deal, registry.rowsByUid);
        if (!extracted.items.length) {
          stats.noTypes += 1;
        } else {
          const hasUnknownType = extracted.items.some(item => {
            const normalized = normalizeTypeNomenclature_(item);
            if (dictionary.map.has(normalized)) return false;
            if (!unknown.has(normalized)) unknown.set(normalized, item);
            return true;
          });
          const typeCodes = hasUnknownType ? '' : buildBackfillTypeCodes_(extracted.items, dictionary.map);
          if (typeCodes) {
            fieldsToUpdate[BITRIX_DEAL_TYPES_FIELD] = typeCodes;
            stats.readyTypes += 1;
          } else {
            stats.noTypes += 1;
          }
        }
      }

      if (patientCodeEmpty) {
        const patientCodeResult = resolvePatientCodeForBackfill_(deal, registry, patientCodesByDealId);
        if (patientCodeResult.conflict) {
          stats.patientCodeConflicts += 1;
          Logger.log('Сделка ' + deal.ID + ': найдено несколько кодов пациента: ' +
            patientCodeResult.codes.join(', ') + '. Источники: ' + patientCodeResult.sources.join(', ') + '.');
        } else if (patientCodeResult.code) {
          fieldsToUpdate[BITRIX_DEAL_PATIENT_CODE_FIELD] = patientCodeResult.code;
          stats.readyPatientCodes += 1;
        } else {
          stats.noPatientCode += 1;
        }
      }

      if (appointmentDateEmpty) {
        const appointmentDate = resolveAppointmentDateForBackfill_(deal, registry, appointmentDatesByUid);
        if (appointmentDate) {
          fieldsToUpdate[BITRIX_DEAL_APPOINTMENT_DATE_FIELD] = formatDateForBitrix_(appointmentDate);
          stats.readyAppointmentDates += 1;
        } else {
          stats.noAppointmentDate += 1;
        }
      }

      const updatesTypes = Object.prototype.hasOwnProperty.call(fieldsToUpdate, BITRIX_DEAL_TYPES_FIELD);
      const updatesPatientCode = Object.prototype.hasOwnProperty.call(fieldsToUpdate, BITRIX_DEAL_PATIENT_CODE_FIELD);
      const updatesAppointmentDate = Object.prototype.hasOwnProperty.call(fieldsToUpdate, BITRIX_DEAL_APPOINTMENT_DATE_FIELD);
      if (updatesTypes && updatesPatientCode) stats.both += 1;
      if (updatesTypes || updatesPatientCode || updatesAppointmentDate) {
        updates.push({ id: String(deal.ID), title: String(deal.TITLE || ''), fields: fieldsToUpdate });
        Logger.log('Сделка ' + deal.ID + ' (' + (deal.TITLE || '') + '): будут заполнены поля ' +
          Object.keys(fieldsToUpdate).join(', ') + '.');
      }
    });

    if (unknown.size) {
      appendMissingNomenclatures_(typeCodesSheet, Array.from(unknown.entries()).map(entry => ({
        normalized: entry[0], nomenclature: entry[1]
      })));
      typeCodesSheet.activate();
      ui.alert('Обнаружена номенклатура без присвоенного типа. Добавлено новых позиций: ' + unknown.size +
        '. Типы для этих сделок не будут записаны до следующего запуска; коды пациентов будут обработаны сейчас.');
    }

    const confirmation = ui.alert(buildBackfillAppointmentTypesConfirmation_(stats) +
      '\n\nВыполнить обновление существующих сделок Bitrix?', ui.ButtonSet.YES_NO);
    if (confirmation !== ui.Button.YES) return;

    const result = updateBitrixDealTypesBatch_(updates);
    stats.updated = result.updated;
    stats.typesUpdated = result.typesUpdated;
    stats.patientCodesUpdated = result.patientCodesUpdated;
    stats.appointmentDatesUpdated = result.appointmentDatesUpdated;
    stats.bothUpdated = result.bothUpdated;
    stats.errors = result.errors;
    ui.alert(buildBackfillAppointmentTypesReport_(stats));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    Logger.log('Ошибка актуализации существующих сделок: ' + message);
    ui.alert('Актуализация существующих сделок Bitrix не выполнена.\n\n' + message);
  } finally {
    lock.releaseLock();
  }
}

function fetchBitrixDealsForTypeBackfill_() {
  const deals = [];
  const select = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', BITRIX_DEAL_TYPES_FIELD,
    BITRIX_DEAL_PATIENT_CODE_FIELD, BITRIX_DEAL_APPOINTMENT_DATE_FIELD, 'UF_CRM_1784034617', 'UF_CRM_1783751372',
    'UF_CRM_1783751578', 'UF_CRM_1783752197'];
  let start = 0;
  while (true) {
    const page = bitrixCall_('crm.deal.list', {
      filter: { CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID }, select: select, start: start
    });
    const rows = Array.isArray(page) ? page : [];
    deals.push.apply(deals, rows);
    if (rows.length < 50) break;
    start += 50;
  }
  return deals;
}

function isEmptyBitrixValue_(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === '';
}

function isEmptyBitrixAppointmentTypes_(value) { return isEmptyBitrixValue_(value); }

function normalizePatientCodeForBitrix_(value) {
  if (value === null || value === undefined || Array.isArray(value) && !value.length) return '';
  return String(value).trim();
}

function resolvePatientCodeForBackfill_(deal, registry, patientCodesByDealId) {
  const fromPlanItems = collectPatientCodes_([extractPatientCodeFromPlanItemsJson_(deal.UF_CRM_1784034617)], 'Plan Items JSON');
  if (fromPlanItems.codes.length) return fromPlanItems;
  const fromDealId = collectPatientCodes_((registry.rowsByDealId.get(String(deal.ID)) || []).map(row => row['Пациент.Код']), 'Реестр отправки Bitrix по Bitrix Deal ID');
  if (fromDealId.codes.length) return fromDealId;
  const fromUids = collectPatientCodes_(splitUids_(deal.UF_CRM_1783751372).reduce((codes, uid) =>
    codes.concat((registry.rowsByUid.get(uid) || []).map(row => row['Пациент.Код'])), []), 'Реестр отправки Bitrix по УИД');
  if (fromUids.codes.length) return fromUids;
  return collectPatientCodes_(patientCodesByDealId.get(String(deal.ID)) || [], 'Сделки в Битрикс');
}

function extractPatientCodeFromPlanItemsJson_(value) {
  const parsed = parseJsonSafely_(String(value || '').trim());
  return parsed && typeof parsed === 'object' ? parsed.patient_code : '';
}

function collectPatientCodes_(values, source) {
  const codes = Array.from(new Set((values || []).map(normalizePatientCodeForBitrix_).filter(Boolean)));
  return { code: codes.length === 1 ? codes[0] : '', codes: codes, sources: codes.length ? [source] : [], conflict: codes.length > 1 };
}

function readPatientCodesByBitrixDealId_(ss) {
  const sheet = ss.getSheetByName(DEALS_CONFIG.bitrixDealsSheetName);
  const result = new Map();
  if (!sheet) return result;
  const data = readSheetWithHeaders_(sheet);
  data.rows.forEach(row => {
    const id = String(row['Bitrix Deal ID'] || '').trim();
    if (!id) return;
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(row['Пациент.Код']);
  });
  return result;
}

function extractDealNomenclatures_(deal, registryRowsByUid) {
  const fromPlanItems = extractNomenclaturesFromPlanItemsJson_(deal.UF_CRM_1784034617);
  if (fromPlanItems.length) return { source: 'Plan Items JSON', items: fromPlanItems };
  const fromRegistry = extractNomenclaturesFromRegistry_(deal.UF_CRM_1783751372, registryRowsByUid);
  if (fromRegistry.length) return { source: 'Реестр', items: fromRegistry };
  return { source: 'Состав назначений', items: extractNomenclaturesFromAppointmentText_(deal.UF_CRM_1783752197) };
}

function readAppointmentDatesByUid_(ss) {
  const result = new Map();
  const sheet = getRequiredSheet_(ss, DEALS_CONFIG.appointmentsSheetName);
  readSheetWithHeaders_(sheet).rows.forEach(row => {
    const uid = String(row[DEALS_CONFIG.appointmentColumns.uid] || '').trim();
    const date = parseDateOnly_(row[DEALS_CONFIG.appointmentColumns.appointmentDate]);
    if (!uid || !date) return;
    if (!result.has(uid)) result.set(uid, []);
    result.get(uid).push(date);
  });
  return result;
}
function resolveAppointmentDateForBackfill_(deal, registry, datesByUid) {
  let dates = splitUids_(deal.UF_CRM_1783751372).reduce((all, uid) => all.concat(datesByUid.get(uid) || []), []);
  if (!dates.length) dates = (registry.rowsByDealId.get(String(deal.ID)) || []).map(row => parseDateOnly_(row['Дата назначения'])).filter(Boolean);
  if (!dates.length) dates = splitUids_(deal.UF_CRM_1783751372).reduce((all, uid) => all.concat((registry.rowsByUid.get(uid) || []).map(row => parseDateOnly_(row['Дата назначения'])).filter(Boolean)), []);
  if (!dates.length) { const parsed = parseJsonSafely_(String(deal.UF_CRM_1784034617 || '')); if (parsed) dates = [parseDateOnly_(parsed.appointment_date)].filter(Boolean); }
  const unique = Array.from(new Set(dates.map(formatDateForBitrix_)));
  if (unique.length > 1) Logger.log('Сделка ' + deal.ID + ': найдены даты назначения ' + unique.join(', ') + '; использована ' + unique.sort().pop() + '.');
  return dates.sort((a, b) => b - a)[0] || null;
}

function updateBitrixDealTypesBatch_(updates) {
  const result = { updated: 0, typesUpdated: 0, patientCodesUpdated: 0, appointmentDatesUpdated: 0, bothUpdated: 0, errors: [] };
  const rows = Array.from(new Map((updates || []).map(update => [String(update.id), update])).values());
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    const commands = {};
    batch.forEach((update, index) => {
      const pairs = ['id=' + encodeURIComponent(update.id)];
      Object.keys(update.fields).forEach(field => pairs.push('fields[' + field + ']=' + encodeURIComponent(update.fields[field])));
      commands['deal_' + index] = 'crm.deal.update?' + pairs.join('&');
    });
    try {
      const response = bitrixCall_('batch', { cmd: commands });
      const values = response && response.result ? response.result : {};
      const errors = response && response.result_error ? response.result_error : {};
      batch.forEach((update, index) => {
        const key = 'deal_' + index;
        if (Object.prototype.hasOwnProperty.call(errors, key) || !Object.prototype.hasOwnProperty.call(values, key)) {
          const error = errors[key] || { error_description: 'Bitrix не подтвердил обновление.' };
          const message = String(error.error_description || error.error || 'Неизвестная ошибка Bitrix.');
          result.errors.push({ id: update.id, message: message });
          Logger.log('Сделка ' + update.id + ': ошибка обновления — ' + message);
          return;
        }
        const types = Object.prototype.hasOwnProperty.call(update.fields, BITRIX_DEAL_TYPES_FIELD);
        const code = Object.prototype.hasOwnProperty.call(update.fields, BITRIX_DEAL_PATIENT_CODE_FIELD);
        const appointmentDate = Object.prototype.hasOwnProperty.call(update.fields, BITRIX_DEAL_APPOINTMENT_DATE_FIELD);
        result.updated += 1;
        if (types) result.typesUpdated += 1;
        if (code) result.patientCodesUpdated += 1;
        if (appointmentDate) result.appointmentDatesUpdated += 1;
        if (types && code) result.bothUpdated += 1;
        Logger.log('Сделка ' + update.id + ': поля обновлены: ' + Object.keys(update.fields).join(', ') + '.');
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      batch.forEach(update => result.errors.push({ id: update.id, message: message }));
      Logger.log('Ошибка пакета обновления сделок: ' + message);
    }
    if (offset + 50 < rows.length) Utilities.sleep(300);
  }
  return result;
}

function buildBackfillAppointmentTypesConfirmation_(stats) {
  return ['Найдено сделок направления: ' + stats.loaded + '.', '', 'Поле типов пустое: ' + stats.emptyTypes + '.', 'Код пациента пустой: ' + stats.emptyPatientCodes + '.', 'Дата назначения пустая: ' + stats.emptyAppointmentDates + '.', '', 'Готово к заполнению типов: ' + stats.readyTypes + '.', 'Готово к заполнению кодов пациентов: ' + stats.readyPatientCodes + '.', 'Готово к заполнению дат назначения: ' + stats.readyAppointmentDates + '.', '', 'Не удалось определить типы: ' + stats.noTypes + '.', 'Не удалось определить код пациента: ' + stats.noPatientCode + '.', 'Не удалось определить дату назначения: ' + stats.noAppointmentDate + '.', 'Будет обновлено сделок: ' + (stats.readyTypes + stats.readyPatientCodes + stats.readyAppointmentDates) + '.'].join('\n');
}

function buildBackfillAppointmentTypesReport_(stats) {
  const lines = ['Актуализация существующих сделок Bitrix завершена.', '', 'Сделок направления загружено: ' + stats.loaded + '.',
    'Сделок уже с обоими заполненными полями: ' + stats.alreadyFilled + '.', 'Обновлено сделок всего: ' + stats.updated + '.',
    'Заполнены типы назначений: ' + stats.typesUpdated + '.', 'Заполнены коды пациентов: ' + stats.patientCodesUpdated + '.', 'Заполнены даты назначений: ' + stats.appointmentDatesUpdated + '.',
    'В одной операции заполнены оба поля: ' + stats.bothUpdated + '.', 'Не удалось определить типы: ' + stats.noTypes + '.',
    'Не удалось определить код пациента: ' + stats.noPatientCode + '.', 'Не удалось определить дату назначения: ' + stats.noAppointmentDate + '.', 'Конфликтов кодов пациента: ' + stats.patientCodeConflicts + '.',
    'Ошибок Bitrix: ' + stats.errors.length + '.'];
  if (stats.errors.length) lines.push('', 'ID сделок с ошибками: ' + stats.errors.map(item => item.id).join(', ') + '.');
  return lines.join('\n');
}


function validateBackfillAppointmentTypeDictionary_(sheet) {
  const dictionary = readAppointmentTypeCodeMap_(sheet);
  if (dictionary.conflictingNomenclature) {
    throw new Error('На листе «' + DEALS_CONFIG.typeCodesSheetName +
      '» одна номенклатура имеет разные типы: ' + dictionary.conflictingNomenclature + '.');
  }

  const data = readSheetWithHeaders_(sheet);
  const nomenclatureHeader = DEALS_CONFIG.typeCodeColumns.nomenclature;
  const typeHeader = DEALS_CONFIG.typeCodeColumns.type;
  if (!data.headerMap[nomenclatureHeader] || !data.headerMap[typeHeader]) {
    throw new Error('На листе «' + DEALS_CONFIG.typeCodesSheetName +
      '» должны быть колонки «Номенклатура» и «Тип».');
  }

  data.rows.forEach((row, index) => {
    const nomenclature = String(row[nomenclatureHeader] || '').trim();
    if (!nomenclature) return;
    const typeCode = String(row[typeHeader] || '').trim().toUpperCase();
    if (!typeCode) {
      throw new Error('На листе «' + DEALS_CONFIG.typeCodesSheetName +
        '» не заполнен тип для номенклатуры «' + nomenclature + '» (строка ' + (index + 2) + ').');
    }
    if (!APPOINTMENT_TYPE_CODE_SET.has(typeCode)) {
      throw new Error('На листе «' + DEALS_CONFIG.typeCodesSheetName +
        '» недопустимый тип «' + typeCode + '» для номенклатуры «' + nomenclature + '».');
    }
  });

  return dictionary;
}

function uniqueCompositionNomenclatures_(items) {
  const found = new Map();
  (items || []).forEach(item => {
    const cleaned = normalizeCompositionNomenclature_(item);
    const normalized = normalizeTypeNomenclature_(cleaned);
    if (normalized && !found.has(normalized)) found.set(normalized, cleaned);
  });
  return Array.from(found.values());
}

function extractNomenclaturesFromPlanItemsJson_(value) {
  const parsed = parseJsonSafely_(String(value || '').trim());
  if (!parsed || !Array.isArray(parsed.items)) return [];
  return uniqueCompositionNomenclatures_(parsed.items.map(item => {
    if (!item || typeof item !== 'object') return '';
    return item.source_name || item.display_name || '';
  }));
}

function extractNomenclaturesFromRegistry_(uidsValue, registryRowsByUid) {
  const items = [];
  splitUids_(uidsValue).forEach(uid => {
    (registryRowsByUid.get(uid) || []).forEach(row => {
      String(row['Состав назначения'] || '').split(/\r?\n/).forEach(line => items.push(line));
    });
  });
  return uniqueCompositionNomenclatures_(items);
}

function extractNomenclaturesFromAppointmentText_(value) {
  const ignored = new Set([
    'назначения:', 'первый плановый день:', 'общая сумма:', 'врач:',
    'состав назначений:', 'сумма:', 'назначения', '---'
  ]);
  const items = String(value || '').split(/\r?\n/).filter(line => {
    return !ignored.has(normalizeTypeNomenclature_(line));
  });
  return uniqueCompositionNomenclatures_(items);
}

function normalizeCompositionNomenclature_(value) {
  return String(value || '')
    .replace(/^\s*-\s+/, '')
    .replace(/\s+[хx]\s*\d+\s*$/i, '')
    .trim();
}

function buildBackfillTypeCodes_(nomenclatures, typeCodeMap) {
  return buildAppointmentTypeCodes_((nomenclatures || []).map(nomenclature => {
    const entry = typeCodeMap.get(normalizeTypeNomenclature_(nomenclature));
    return { typeCode: entry ? entry.typeCode : '' };
  }));
}



function testBitrixDealAppointmentDate_() {
  const dates = ['17.07.2026', '19.07.2026'].map(parseDateOnly_).sort((a, b) => b - a);
  if (formatDateForBitrix_(dates[0]) !== '2026-07-19') throw new Error('Не выбрана поздняя дата назначения.');
  if (formatDateForBitrix_(parseDateOnly_('17.07.2026')) !== '2026-07-17') throw new Error('Неверный формат даты Bitrix.');
  if (isEmptyBitrixValue_('2026-07-17')) throw new Error('Заполненное поле даты не должно перезаписываться.');
  return 'testBitrixDealAppointmentDate_: OK';
}

function debugBitrixDealFields() {
  const fields = bitrixCall_('crm.deal.fields', {});
  const needed = [
    'UF_CRM_1737550182812',
    'UF_CRM_1759810401',
    'UF_CRM_1737550697075',
    'UF_CRM_1624006506',
    'UF_CRM_1783751372',
    'UF_CRM_1783751578',
    'UF_CRM_1783751996',
    'UF_CRM_1783752197',
    BITRIX_DEAL_TYPES_FIELD,
    BITRIX_DEAL_PATIENT_CODE_FIELD,
    BITRIX_DEAL_APPOINTMENT_DATE_FIELD,
    'UF_CRM_1783752297',
    'UF_CRM_1784034617',
    'UF_CRM_615C18C0D7CD9'
  ];

  needed.forEach(code => {
    Logger.log(code + ': ' + JSON.stringify(fields[code]));
  });
}

function splitUids_(value) {
  return String(value || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}


function formatDateForBitrix_(date) {
  if (Object.prototype.toString.call(date) !== '[object Date]' || isNaN(date)) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function parseMoney_(value) {
  if (typeof value === 'number') {
    return value;
  }

  const normalized = String(value || '')
    .replace(/\s+/g, '')
    .replace(/[₽рруб.]/gi, '')
    .replace(',', '.');
  const number = Number(normalized);

  return isNaN(number) ? 0 : number;
}

function parseDateForBitrix_(value) {
  if (!value) {
    return '';
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const text = String(value).trim();
  const match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return year + '-' + month + '-' + day;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  return '';
}

function buildBitrixDealTitle_(row) {
  const patientName = String(row['ФИО'] || row['ФИО пациента'] || '').trim();
  const dealKey = String(row['DealKey'] || '').trim();

  if (patientName) {
    return patientName;
  }

  return 'Назначения TEMED — ' + (dealKey || 'без DealKey');
}

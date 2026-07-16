/****************************************************
 * TEMED — сверка сделок Bitrix с заявками 1С
 *
 * Что делает скрипт:
 * 1. Загружает из Bitrix только сделки TEMED, у которых
 *    первый день лечения не старше 30 дней.
 * 2. По УИДам сделки находит состав назначений на листе
 *    "Назначения" и переводит номенклатуру в буквенные коды.
 * 3. Обрабатывает лист "Заявки":
 *    - исключает отмененные заявки;
 *    - переводит номенклатуру в буквенные коды;
 *    - агрегирует по пациенту и календарной дате;
 *    - отдельно хранит запланированные и выполненные типы услуг.
 * 4. Проверяет сделки во всех стадиях:
 *    - выполнена хотя бы одна назначенная услуга -> "Дошёл";
 *    - иначе есть плановая заявка хотя бы на одну услугу -> "Записался";
 *    - иначе стадия не меняется.
 * 5. Если в назначении только консультация врача (код C),
 *    то и плановая, и выполненная консультация переводят сделку в "Дошёл".
 * 6. Неизвестную номенклатуру добавляет на лист
 *    "Коды номенклатуры". Пользователь вводит код в колонку "Код",
 *    после чего повторный запуск учитывает его.
 *
 * Обязательное Script Property:
 * BITRIX_WEBHOOK_BASE_URL
 * Пример: https://example.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
 *
 ****************************************************/

const TSD_CONFIG = Object.freeze({
  timezone: 'Europe/Moscow',

  sheets: {
    appointments: 'Назначения',
    requests: 'Заявки',
    bitrixRegistry: 'Реестр отправки Bitrix',
    nomenclatureMap: 'Коды номенклатуры',
    aggregatedRequests: 'Заявки агрегированные',
    dealsPreview: 'Сделки Bitrix — проверка',
    log: 'Журнал статусов Bitrix'
  },

  scriptProperties: {
    webhookBaseUrl: 'BITRIX_WEBHOOK_BASE_URL'
  },

  // Скрипт проверяет сделку, пока первый день лечения не старше 30 дней.
  dealCheckDaysAfterTreatmentStart: 30,

  // Заявка относится к сделке, если ее дата находится в интервале:
  // первый день лечения ... первый день лечения + 30 дней.
  requestMatchWindowDays: 30,

  // Значение источника используется только если отдельное поле источника
  // действительно существует и включен filterBySourceWhenFieldExists.
  bitrixDealSourceValue: 'google_sheets_appointments',

  // Заголовки исходных файлов.
  appointmentColumns: {
    patientCode: 'Пациент.Код',
    uid: 'УИД',
    treatmentDate: 'Дата лечения',
    nomenclature: 'Номенклатура'
  },

  requestColumns: {
    patientCode: 'КлиентКод',
    patientName: 'Клиент',
    state: 'Состояние',
    startDate: 'ДатаНачала',
    nomenclature: 'НоменклатураНаименование'
  },

  // При необходимости сюда можно вписать точные UF_CRM_... поля.
  // Пустое значение означает автоматический поиск по названию поля.
  bitrixFieldOverrides: {
    // В актуальном скрипте создания сделок используются эти поля.
    // Код пациента в Bitrix сейчас не обязателен: скрипт восстанавливает его по TEMED_UIDS.
    patientCode: '',
    firstPlanDate: 'UF_CRM_1783751996',
    uids: 'UF_CRM_1783751372',
    source: '',
    appointmentComposition: 'UF_CRM_1783752197'
  },

  // Если поле источника TEMED существует в Bitrix, дополнительно фильтровать по нему.
  // Если такого поля нет, сделки отбираются по дате и наличию TEMED_UIDS.
  filterBySourceWhenFieldExists: false,

  // Варианты названий пользовательских полей в Bitrix.
  bitrixFieldAliases: {
    patientCode: [
      'Пациент.Код',
      'Код пациента',
      'TEMED_PATIENT_CODE',
      'PATIENT_CODE'
    ],
    firstPlanDate: [
      'Первый плановый день',
      'Первый день лечения',
      'Дата начала лечения',
      'TEMED_FIRST_PLAN_DATE'
    ],
    uids: [
      'TEMED_UIDS',
      'УИДы',
      'УИД назначения',
      'UIDS'
    ],
    source: [
      'TEMED_DEAL_SOURCE',
      'Источник TEMED',
      'TEMED источник сделки'
    ],
    appointmentComposition: [
      'Состав назначений',
      'TEMED_APPOINTMENT_COMPOSITION'
    ]
  },

  stageNames: {
    booked: 'Записался',
    attended: 'Дошёл'
  },

  // Все эти статусы считаются фактом посещения/выполнения.
  doneRequestStates: [
    'Начато',
    'Выполнена',
    'Выполнено',
    'Завершена',
    'Завершено',
    'Оказана',
    'Оказано',
    'Прием состоялся',
    'Приём состоялся',
    'Состоялась',
    'Состоялся'
  ],

  plannedRequestStates: [
    'Запланирована',
    'Запланировано',
    'Подтвердил запись',
    'Подтверждена',
    'Подтверждено',
    'Записан',
    'Записана',
    'Недозвон. Отправить смс'
  ],

  cancelledRequestMarkers: [
    'отменена',
    'отменено',
    'отменен',
    'отменён',
    'отказ',
    'не состоялась',
    'не состоялся',
    'неявка',
    'не явился',
    'не явилась',
    'удалена',
    'удалено'
  ],

  ignoredCode: '-',
  consultationCode: 'C',

  // Порядок букв в агрегированных строках.
  serviceCodeOrder: 'CLFMSUIPDABEGHJKNOQRTVWXYZ',

  bitrixBatchSize: 50,
  requestBatchPauseMs: 250
});

const TSD_MAP_HEADERS = [
  'Номенклатура',
  'Код',
  'Источник',
  'Количество строк',
  'Последнее появление',
  'Комментарий'
];

const TSD_AGGREGATED_HEADERS = [
  'КлиентКод',
  'Дата',
  'Запланированы',
  'Выполнены'
];

const TSD_PREVIEW_HEADERS = [
  'Bitrix Deal ID',
  'Название сделки',
  'Категория',
  'Текущая стадия',
  'Код пациента',
  'Первый день лечения',
  'УИДы',
  'Коды назначения',
  'Нераспознанные назначения',
  'Найдено запланировано',
  'Найдено выполнено',
  'Результат проверки',
  'Новая стадия',
  'Статус обновления',
  'Причина / ошибка'
];

const TSD_LOG_HEADERS = [
  'Дата и время',
  'Режим',
  'Сделок загружено',
  'Сделок проверено',
  'Строк заявок обработано',
  'Агрегированных строк',
  'Новых номенклатур без кода',
  'Изменений рассчитано',
  'Изменений выполнено',
  'Ошибок обновления',
  'Комментарий'
];


/****************************************************
 * Публичные функции
 ****************************************************/

/**
 * Добавляет меню сверки сделок при открытии таблицы.
 */
function onOpen(e) {
  DSS_addDealStatusSyncMenu_();
}

function DSS_addDealStatusSyncMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('Сверка сделок Bitrix')
    .addItem(
      'Инициализировать служебные листы',
      'initializeBitrixDealStageSync'
    )
    .addItem(
      'Предпросмотр сверки',
      'previewBitrixDealStagesByRequests'
    )
    .addSeparator()
    .addItem(
      'Выполнить сверку и обновить Bitrix',
      'DSS_runSyncWithConfirmation_'
    )
    .addToUi();
}

function DSS_runSyncWithConfirmation_() {
  const ui = SpreadsheetApp.getUi();

  const response = ui.alert(
    'Обновление стадий Bitrix',
    'Скрипт выполнит сверку заявок и изменит стадии подходящих сделок в Bitrix. Продолжить?',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    return;
  }

  try {
    syncBitrixDealStagesByRequests();
  } catch (error) {
    console.error(error);

    ui.alert(
      'Ошибка сверки',
      DSS_getUserSafeErrorMessage_(error),
      ui.ButtonSet.OK
    );

    throw error;
  }
}

function DSS_getUserSafeErrorMessage_(error) {
  const message = error && error.message ? error.message : String(error);
  const missingWebhookProperty =
    'Не задано свойство скрипта BITRIX_WEBHOOK_BASE_URL.';

  if (message.indexOf(missingWebhookProperty) !== -1) {
    return missingWebhookProperty;
  }

  return 'Во время выполнения произошла ошибка. Проверьте журнал выполнения Apps Script.';
}

/**
 * Основной запуск: проверяет сделки и обновляет стадии в Bitrix.
 */
function syncBitrixDealStagesByRequests() {
  return TSD_runSync_(false);
}

/**
 * Безопасный предварительный запуск: формирует все листы и расчет,
 * но не изменяет сделки в Bitrix.
 */
function previewBitrixDealStagesByRequests() {
  return TSD_runSync_(true);
}

/**
 * Создает служебные листы, не выполняя сверку.
 */
function initializeBitrixDealStageSync() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  TSD_ensureNomenclatureMapSheet_(ss);
  TSD_prepareOutputSheet_(ss, TSD_CONFIG.sheets.aggregatedRequests, TSD_AGGREGATED_HEADERS);
  TSD_prepareOutputSheet_(ss, TSD_CONFIG.sheets.dealsPreview, TSD_PREVIEW_HEADERS);
  TSD_ensureLogSheet_(ss);
  SpreadsheetApp.getActive().toast(
    'Служебные листы созданы. Заполните BITRIX_WEBHOOK_BASE_URL в свойствах скрипта.',
    'TEMED — сверка сделок',
    8
  );
}

/****************************************************
 * Главный процесс
 ****************************************************/

function TSD_runSync_(dryRun) {
  const startedAt = new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = TSD_getRequiredSheet_(ss, TSD_CONFIG.sheets.appointments);
    const requestsSheet = TSD_getRequiredSheet_(ss, TSD_CONFIG.sheets.requests);

    TSD_ensureNomenclatureMapSheet_(ss);
    TSD_ensureLogSheet_(ss);

    const webhookBaseUrl = TSD_getBitrixWebhookBaseUrl_();
    const bitrixFields = TSD_resolveBitrixFields_(webhookBaseUrl);
    const thresholdDate = TSD_addDays_(TSD_today_(), -TSD_CONFIG.dealCheckDaysAfterTreatmentStart);

    let deals = TSD_loadActiveBitrixDeals_(
      webhookBaseUrl,
      bitrixFields,
      thresholdDate
    );

    // В актуальной схеме реестр отправки содержит Bitrix Deal ID,
    // Пациент.Код и УИДы. Используем его как дополнительный надежный источник.
    TSD_enrichDealsFromRegistry_(ss, deals);

    deals = deals.filter(deal => {
      return deal.uids.length > 0 || Boolean(deal.appointmentComposition);
    });

    const appointments = TSD_readSheetAsObjects_(appointmentsSheet);
    const requests = TSD_readSheetAsObjects_(requestsSheet);

    const mapState = TSD_loadNomenclatureMap_(ss);
    const appointmentIndex = TSD_buildAppointmentIndex_(appointments);

    // Сначала регистрируем номенклатуру из назначений проверяемых сделок.
    // Здесь же код пациента восстанавливается по TEMED_UIDS, если отдельного
    // поля с кодом пациента в Bitrix нет.
    const dealServiceInfo = TSD_buildDealServiceInfo_(
      deals,
      appointmentIndex,
      mapState
    );

    const neededPatientCodes = new Set(
      deals.map(deal => TSD_normalizePatientCode_(deal.patientCode)).filter(Boolean)
    );

    // Затем обрабатываем только заявки пациентов, сделки которых реально проверяются.
    const requestProcessing = TSD_buildAggregatedRequests_(
      requests,
      neededPatientCodes,
      mapState
    );

    TSD_saveNomenclatureMap_(ss, mapState);
    TSD_writeAggregatedRequests_(ss, requestProcessing.aggregatedRows);

    const stageDirectory = TSD_loadStageDirectory_(webhookBaseUrl, deals);
    const evaluation = TSD_evaluateDeals_(
      deals,
      dealServiceInfo,
      requestProcessing.aggregatedIndex,
      stageDirectory
    );

    let updateResult = {
      successfulIds: new Set(),
      errorsById: new Map()
    };

    if (!dryRun && evaluation.updates.length) {
      updateResult = TSD_updateDealsInBitrix_(
        webhookBaseUrl,
        evaluation.updates
      );
    }

    const previewRows = TSD_buildPreviewRows_(
      deals,
      dealServiceInfo,
      evaluation,
      updateResult,
      dryRun
    );

    TSD_writePreview_(ss, previewRows);

    const unresolvedCount = Array.from(mapState.entries.values())
      .filter(entry => !entry.code)
      .length;

    const successfulUpdates = dryRun
      ? 0
      : updateResult.successfulIds.size;

    const updateErrors = dryRun
      ? 0
      : updateResult.errorsById.size;

    TSD_appendLog_(ss, [
      new Date(),
      dryRun ? 'Предпросмотр' : 'Обновление Bitrix',
      deals.length,
      evaluation.checkedCount,
      requestProcessing.processedRows,
      requestProcessing.aggregatedRows.length,
      unresolvedCount,
      evaluation.updates.length,
      successfulUpdates,
      updateErrors,
      'Время выполнения: ' + TSD_elapsedText_(startedAt)
    ]);

    SpreadsheetApp.flush();

    const message = [
      dryRun ? 'Предпросмотр завершён.' : 'Сверка и обновление завершены.',
      'Сделок: ' + deals.length + '.',
      'Переходов рассчитано: ' + evaluation.updates.length + '.',
      dryRun ? 'Bitrix не изменялся.' : 'Обновлено: ' + successfulUpdates + '.',
      'Номенклатур без кода: ' + unresolvedCount + '.'
    ].join(' ');

    SpreadsheetApp.getActive().toast(message, 'TEMED — сверка сделок', 12);

    return {
      ok: updateErrors === 0,
      dryRun,
      dealsLoaded: deals.length,
      dealsChecked: evaluation.checkedCount,
      updatesCalculated: evaluation.updates.length,
      updatesSuccessful: successfulUpdates,
      updateErrors,
      unresolvedNomenclature: unresolvedCount,
      elapsed: TSD_elapsedText_(startedAt)
    };
  } catch (error) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      TSD_appendLog_(ss, [
        new Date(),
        dryRun ? 'Предпросмотр' : 'Обновление Bitrix',
        '', '', '', '', '', '', '', 1,
        TSD_errorText_(error)
      ]);
    } catch (logError) {
      Logger.log('Не удалось записать ошибку в журнал: %s', TSD_errorText_(logError));
    }

    throw error;
  } finally {
    lock.releaseLock();
  }
}


/****************************************************
 * Bitrix: поля, сделки, стадии
 ****************************************************/

function TSD_getBitrixWebhookBaseUrl_() {
  const raw = String(
    PropertiesService.getScriptProperties()
      .getProperty(TSD_CONFIG.scriptProperties.webhookBaseUrl) || ''
  ).trim();

  if (!raw) {
    throw new Error('Не задано свойство скрипта BITRIX_WEBHOOK_BASE_URL.');
  }

  return raw.replace(/\/+$/, '') + '/';
}

function TSD_resolveBitrixFields_(baseUrl) {
  const response = TSD_bitrixCall_(baseUrl, 'crm.deal.fields', {});
  const fields = response.result || {};

  const resolved = {
    patientCode: TSD_resolveBitrixField_(
      fields,
      TSD_CONFIG.bitrixFieldOverrides.patientCode,
      TSD_CONFIG.bitrixFieldAliases.patientCode,
      false
    ),
    firstPlanDate: TSD_resolveBitrixField_(
      fields,
      TSD_CONFIG.bitrixFieldOverrides.firstPlanDate,
      TSD_CONFIG.bitrixFieldAliases.firstPlanDate,
      true
    ),
    uids: TSD_resolveBitrixField_(
      fields,
      TSD_CONFIG.bitrixFieldOverrides.uids,
      TSD_CONFIG.bitrixFieldAliases.uids,
      true
    ),
    source: TSD_resolveBitrixField_(
      fields,
      TSD_CONFIG.bitrixFieldOverrides.source,
      TSD_CONFIG.bitrixFieldAliases.source,
      false
    ),
    appointmentComposition: TSD_resolveBitrixField_(
      fields,
      TSD_CONFIG.bitrixFieldOverrides.appointmentComposition,
      TSD_CONFIG.bitrixFieldAliases.appointmentComposition,
      false
    )
  };

  if (!resolved.uids && !resolved.appointmentComposition) {
    throw new Error(
      'Не найдено поле TEMED_UIDS/УИДы и не найдено поле "Состав назначений". ' +
      'Укажите точный UF_CRM_... в TSD_CONFIG.bitrixFieldOverrides.'
    );
  }

  return resolved;
}

function TSD_resolveBitrixField_(fields, override, aliases, required) {
  const manual = String(override || '').trim();
  if (manual) {
    if (!fields[manual]) {
      throw new Error('В crm.deal.fields отсутствует указанное поле ' + manual + '.');
    }
    return manual;
  }

  const aliasSet = new Set((aliases || []).map(TSD_normalizeText_));
  let partialMatch = '';

  Object.keys(fields).some(fieldId => {
    const metadata = fields[fieldId] || {};
    const labels = [
      fieldId,
      metadata.title,
      metadata.formLabel,
      metadata.listLabel,
      metadata.filterLabel
    ].filter(Boolean);

    for (let i = 0; i < labels.length; i += 1) {
      const normalized = TSD_normalizeText_(labels[i]);
      if (aliasSet.has(normalized)) {
        partialMatch = fieldId;
        return true;
      }
    }
    return false;
  });

  if (!partialMatch) {
    Object.keys(fields).some(fieldId => {
      const metadata = fields[fieldId] || {};
      const joined = [
        fieldId,
        metadata.title,
        metadata.formLabel,
        metadata.listLabel,
        metadata.filterLabel
      ].filter(Boolean).map(TSD_normalizeText_).join(' ');

      const matched = (aliases || []).some(alias => {
        const normalizedAlias = TSD_normalizeText_(alias);
        return normalizedAlias && joined.indexOf(normalizedAlias) !== -1;
      });

      if (matched) {
        partialMatch = fieldId;
        return true;
      }
      return false;
    });
  }

  if (!partialMatch && required) {
    throw new Error(
      'Не удалось автоматически найти поле Bitrix. Искомые названия: ' +
      (aliases || []).join(', ') +
      '. Укажите точный UF_CRM_... в TSD_CONFIG.bitrixFieldOverrides.'
    );
  }

  return partialMatch;
}

function TSD_loadActiveBitrixDeals_(baseUrl, fields, thresholdDate) {
  const filter = {};
  filter['>=' + fields.firstPlanDate] = TSD_formatDateIso_(thresholdDate);

  if (
    fields.source &&
    TSD_CONFIG.filterBySourceWhenFieldExists &&
    TSD_CONFIG.bitrixDealSourceValue
  ) {
    filter[fields.source] = TSD_CONFIG.bitrixDealSourceValue;
  }

  const select = [
    'ID',
    'TITLE',
    'CATEGORY_ID',
    'STAGE_ID',
    fields.firstPlanDate,
    'COMMENTS'
  ];

  if (fields.patientCode) select.push(fields.patientCode);
  if (fields.source) select.push(fields.source);
  if (fields.uids) select.push(fields.uids);
  if (fields.appointmentComposition) select.push(fields.appointmentComposition);

  const rawDeals = TSD_bitrixListAll_(baseUrl, 'crm.deal.list', {
    order: { ID: 'ASC' },
    filter,
    select
  });

  return rawDeals
    .map(raw => {
      const firstPlanDate = TSD_parseDateOnly_(raw[fields.firstPlanDate]);
      return {
        id: String(raw.ID || ''),
        title: String(raw.TITLE || ''),
        categoryId: Number(raw.CATEGORY_ID || 0),
        stageId: String(raw.STAGE_ID || ''),
        patientCode: fields.patientCode
          ? TSD_normalizePatientCode_(raw[fields.patientCode])
          : '',
        firstPlanDate,
        uids: fields.uids ? TSD_splitUids_(raw[fields.uids]) : [],
        appointmentComposition: fields.appointmentComposition
          ? String(raw[fields.appointmentComposition] || '')
          : '',
        comments: String(raw.COMMENTS || '')
      };
    })
    .filter(deal => {
      if (!deal.id || !deal.firstPlanDate) return false;
      return deal.firstPlanDate >= thresholdDate;
    });
}

function TSD_enrichDealsFromRegistry_(ss, deals) {
  const sheet = ss.getSheetByName(TSD_CONFIG.sheets.bitrixRegistry);
  if (!sheet || sheet.getLastRow() < 2) return;

  const rows = TSD_readSheetAsObjects_(sheet);
  const byDealId = new Map();

  rows.forEach(row => {
    const dealId = String(row['Bitrix Deal ID'] || '').trim();
    if (!dealId) return;

    if (!byDealId.has(dealId)) {
      byDealId.set(dealId, {
        patientCodes: new Set(),
        uids: new Set()
      });
    }

    const item = byDealId.get(dealId);
    const patientCode = TSD_normalizePatientCode_(row['Пациент.Код']);
    const uid = String(row['УИД'] || '').trim();

    if (patientCode) item.patientCodes.add(patientCode);
    if (uid) item.uids.add(uid);
  });

  (deals || []).forEach(deal => {
    const registry = byDealId.get(String(deal.id));
    if (!registry) return;

    if (!deal.patientCode && registry.patientCodes.size === 1) {
      deal.patientCode = Array.from(registry.patientCodes)[0];
    }

    registry.uids.forEach(uid => {
      if (deal.uids.indexOf(uid) === -1) deal.uids.push(uid);
    });
  });
}

function TSD_loadStageDirectory_(baseUrl, deals) {
  const categoryIds = Array.from(new Set(deals.map(deal => Number(deal.categoryId || 0))));
  const byCategory = new Map();

  categoryIds.forEach(categoryId => {
    const entityId = categoryId === 0 ? 'DEAL_STAGE' : 'DEAL_STAGE_' + categoryId;
    const statuses = TSD_bitrixListAll_(baseUrl, 'crm.status.list', {
      order: { SORT: 'ASC' },
      filter: { ENTITY_ID: entityId }
    });

    const byId = new Map();
    const byName = new Map();

    statuses.forEach(status => {
      const id = String(status.STATUS_ID || '');
      const name = String(status.NAME || '');
      if (id) byId.set(id, name);
      if (name) byName.set(TSD_normalizeText_(name), id);
    });

    const bookedId = byName.get(TSD_normalizeText_(TSD_CONFIG.stageNames.booked));
    const attendedId = byName.get(TSD_normalizeText_(TSD_CONFIG.stageNames.attended));

    if (!bookedId || !attendedId) {
      throw new Error(
        'В воронке CATEGORY_ID=' + categoryId +
        ' не найдены стадии "' + TSD_CONFIG.stageNames.booked +
        '" и/или "' + TSD_CONFIG.stageNames.attended + '".'
      );
    }

    byCategory.set(categoryId, {
      byId,
      bookedId,
      attendedId
    });
  });

  return byCategory;
}


/****************************************************
 * Назначения и буквенные коды
 ****************************************************/

function TSD_buildAppointmentIndex_(appointments) {
  const c = TSD_CONFIG.appointmentColumns;
  const byUid = new Map();
  const byPatient = new Map();

  appointments.forEach(row => {
    const uid = String(row[c.uid] || '').trim();
    const patientCode = TSD_normalizePatientCode_(row[c.patientCode]);
    const treatmentDate = TSD_parseDateOnly_(row[c.treatmentDate]);
    const nomenclature = TSD_cleanNomenclature_(row[c.nomenclature]);

    if (!patientCode || !nomenclature) return;

    const item = {
      uid,
      patientCode,
      treatmentDate,
      nomenclature
    };

    if (uid) {
      if (!byUid.has(uid)) byUid.set(uid, []);
      byUid.get(uid).push(item);
    }

    if (!byPatient.has(patientCode)) byPatient.set(patientCode, []);
    byPatient.get(patientCode).push(item);
  });

  return { byUid, byPatient };
}

function TSD_buildDealServiceInfo_(deals, appointmentIndex, mapState) {
  const result = new Map();

  deals.forEach(deal => {
    let items = [];
    let source = '';

    if (deal.uids.length) {
      deal.uids.forEach(uid => {
        const uidItems = appointmentIndex.byUid.get(uid) || [];
        items = items.concat(uidItems);
      });
      source = 'УИДы сделки';
    }

    // Восстанавливаем код пациента по найденным строкам назначения.
    const itemPatientCodes = Array.from(new Set(
      items.map(item => TSD_normalizePatientCode_(item.patientCode)).filter(Boolean)
    ));

    if (!deal.patientCode && itemPatientCodes.length === 1) {
      deal.patientCode = itemPatientCodes[0];
    }

    // Резерв: если УИДы отсутствуют или не найдены в текущем файле,
    // берем назначения пациента в 30-дневном окне от первого дня лечения.
    if (!items.length && deal.patientCode) {
      const patientItems = appointmentIndex.byPatient.get(deal.patientCode) || [];
      const windowEnd = TSD_addDays_(deal.firstPlanDate, TSD_CONFIG.requestMatchWindowDays);
      items = patientItems.filter(item => {
        return item.treatmentDate &&
          item.treatmentDate >= deal.firstPlanDate &&
          item.treatmentDate <= windowEnd;
      });
      source = 'Пациент + дата';
    }

    // Последний резерв: текстовое поле состава назначений из Bitrix.
    if (!items.length && deal.appointmentComposition) {
      items = TSD_extractNomenclaturesFromComposition_(deal.appointmentComposition)
        .map(nomenclature => ({
          uid: '',
          patientCode: deal.patientCode,
          treatmentDate: deal.firstPlanDate,
          nomenclature
        }));
      source = 'Состав назначений Bitrix';
    }

    const uniqueNames = Array.from(new Set(
      items.map(item => TSD_cleanNomenclature_(item.nomenclature)).filter(Boolean)
    ));

    const codes = new Set();
    const unresolved = [];
    let ignoredCount = 0;

    uniqueNames.forEach(name => {
      const code = TSD_getOrRegisterNomenclatureCode_(
        mapState,
        name,
        'Назначения',
        1
      );

      if (!code) {
        unresolved.push(name);
      } else if (code === TSD_CONFIG.ignoredCode) {
        ignoredCount += 1;
      } else {
        codes.add(code);
      }
    });

    const patientCodeConflict = itemPatientCodes.length > 1;

    result.set(deal.id, {
      codes,
      codesText: TSD_codesToText_(codes),
      unresolved,
      allNomenclatureResolved: unresolved.length === 0,
      ignoredCount,
      source,
      itemCount: uniqueNames.length,
      derivedPatientCode: itemPatientCodes.length === 1 ? itemPatientCodes[0] : '',
      patientCodeConflict
    });
  });

  return result;
}

function TSD_extractNomenclaturesFromComposition_(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line
      .replace(/^[-•*\d.)\s]+/, '')
      .replace(/\s+[xх]\s*\d+(?:[.,]\d+)?\s*$/i, '')
      .trim()
    )
    .filter(line => {
      if (!line) return false;
      const n = TSD_normalizeText_(line);
      return n.indexOf('состав назначений') === -1 &&
        n.indexOf('первый плановый день') === -1 &&
        n.indexOf('общая сумма') === -1 &&
        n.indexOf('сумма') !== 0 &&
        n.indexOf('врач') !== 0 &&
        n.indexOf('уид') !== 0;
    });
}


/****************************************************
 * Заявки: очистка и агрегация
 ****************************************************/

function TSD_buildAggregatedRequests_(requests, neededPatientCodes, mapState) {
  const c = TSD_CONFIG.requestColumns;
  const aggregate = new Map();
  let processedRows = 0;

  requests.forEach(row => {
    const patientCode = TSD_normalizePatientCode_(row[c.patientCode]);
    if (!patientCode || !neededPatientCodes.has(patientCode)) return;

    const requestDate = TSD_parseDateOnly_(row[c.startDate]);
    const nomenclature = TSD_cleanNomenclature_(row[c.nomenclature]);
    const state = String(row[c.state] || '').trim();

    if (!requestDate || !nomenclature || !state) return;

    const stateCategory = TSD_classifyRequestState_(state);
    if (stateCategory === 'CANCEL' || stateCategory === 'UNKNOWN') return;

    processedRows += 1;

    const code = TSD_getOrRegisterNomenclatureCode_(
      mapState,
      nomenclature,
      'Заявки',
      1
    );

    if (!code || code === TSD_CONFIG.ignoredCode) return;

    const dateKey = TSD_formatDateIso_(requestDate);
    const key = patientCode + '|' + dateKey;

    if (!aggregate.has(key)) {
      aggregate.set(key, {
        patientCode,
        date: requestDate,
        planned: new Set(),
        done: new Set()
      });
    }

    const bucket = aggregate.get(key);
    if (stateCategory === 'DONE') {
      bucket.done.add(code);
    } else if (stateCategory === 'PLAN') {
      bucket.planned.add(code);
    }
  });

  const aggregatedRows = Array.from(aggregate.values())
    .sort((a, b) => {
      const patientDiff = a.patientCode.localeCompare(b.patientCode, 'ru');
      if (patientDiff !== 0) return patientDiff;
      return a.date.getTime() - b.date.getTime();
    })
    .map(bucket => [
      bucket.patientCode,
      bucket.date,
      TSD_codesToText_(bucket.planned),
      TSD_codesToText_(bucket.done)
    ]);

  const aggregatedIndex = new Map();
  aggregate.forEach(bucket => {
    if (!aggregatedIndex.has(bucket.patientCode)) {
      aggregatedIndex.set(bucket.patientCode, []);
    }
    aggregatedIndex.get(bucket.patientCode).push(bucket);
  });

  aggregatedIndex.forEach(items => {
    items.sort((a, b) => a.date.getTime() - b.date.getTime());
  });

  return {
    processedRows,
    aggregatedRows,
    aggregatedIndex
  };
}

function TSD_classifyRequestState_(state) {
  const normalized = TSD_normalizeText_(state);

  const cancelled = TSD_CONFIG.cancelledRequestMarkers.some(marker => {
    return normalized.indexOf(TSD_normalizeText_(marker)) !== -1;
  });
  if (cancelled) return 'CANCEL';

  const doneSet = TSD_getNormalizedConfigSet_('done');
  if (doneSet.has(normalized)) return 'DONE';

  const planSet = TSD_getNormalizedConfigSet_('plan');
  if (planSet.has(normalized)) return 'PLAN';

  return 'UNKNOWN';
}

function TSD_getNormalizedConfigSet_(kind) {
  const cache = CacheService.getScriptCache();
  const key = 'TSD_STATUS_SET_' + kind;
  const cached = cache.get(key);

  if (cached) {
    return new Set(JSON.parse(cached));
  }

  const source = kind === 'done'
    ? TSD_CONFIG.doneRequestStates
    : TSD_CONFIG.plannedRequestStates;

  const values = source.map(TSD_normalizeText_);
  cache.put(key, JSON.stringify(values), 21600);
  return new Set(values);
}


/****************************************************
 * Справочник номенклатуры
 ****************************************************/

function TSD_loadNomenclatureMap_(ss) {
  const sheet = TSD_ensureNomenclatureMapSheet_(ss);
  const values = sheet.getDataRange().getValues();
  const entries = new Map();

  if (values.length <= 1) {
    return { sheet, entries };
  }

  const headers = values[0].map(value => String(value || '').trim());
  const idxName = headers.indexOf('Номенклатура');
  const idxCode = headers.indexOf('Код');
  const idxLastSeen = headers.indexOf('Последнее появление');
  const idxComment = headers.indexOf('Комментарий');

  values.slice(1).forEach(row => {
    const name = TSD_cleanNomenclature_(row[idxName]);
    if (!name) return;

    const key = TSD_normalizeNomenclatureKey_(name);
    const code = TSD_normalizeServiceCode_(row[idxCode]);

    entries.set(key, {
      name,
      code,
      // Источник и количество показывают только текущий запуск.
      // Ручной код и комментарий сохраняются между запусками.
      sources: new Set(),
      count: 0,
      lastSeen: TSD_parseDateTime_(row[idxLastSeen]) || '',
      comment: String(row[idxComment] || '').trim(),
      existed: true
    });
  });

  return { sheet, entries };
}

function TSD_getOrRegisterNomenclatureCode_(mapState, nomenclature, source, increment) {
  const cleanName = TSD_cleanNomenclature_(nomenclature);
  if (!cleanName) return '';

  const key = TSD_normalizeNomenclatureKey_(cleanName);
  let entry = mapState.entries.get(key);

  if (!entry) {
    const autoCode = TSD_detectServiceCode_(cleanName);
    entry = {
      name: cleanName,
      code: autoCode,
      sources: new Set(),
      count: 0,
      lastSeen: '',
      comment: autoCode ? 'Код определён автоматически; при необходимости можно изменить.' : '',
      existed: false
    };
    mapState.entries.set(key, entry);
  }

  if (source) entry.sources.add(source);
  entry.count += Number(increment || 0);
  entry.lastSeen = new Date();

  return entry.code;
}

function TSD_detectServiceCode_(nomenclature) {
  const text = TSD_normalizeText_(nomenclature);

  // Физическая терапия проверяется до общей консультации.
  if (
    TSD_hasToken_(text, 'лфк') ||
    text.indexOf('физическ терап') !== -1 ||
    text.indexOf('физическ реабилит') !== -1 ||
    text.indexOf('инструктор лфк') !== -1 ||
    text.indexOf('лечебн физкультур') !== -1 ||
    text.indexOf('кинезиотерап') !== -1
  ) {
    return 'F';
  }

  if (text.indexOf('массаж') !== -1) return 'M';

  if (
    text.indexOf('sis') !== -1 ||
    text.indexOf('сис') !== -1 ||
    text.indexOf('магнитотерап') !== -1 ||
    text.indexOf('магнитн терап') !== -1
  ) {
    return 'S';
  }

  if (
    text.indexOf('mls') !== -1 ||
    text.indexOf('hil') !== -1 ||
    text.indexOf('лазер') !== -1
  ) {
    return 'L';
  }

  if (
    text.indexOf('ударно волнов') !== -1 ||
    TSD_hasToken_(text, 'увт')
  ) {
    return 'U';
  }

  if (
    text.indexOf('иглорефлекс') !== -1 ||
    text.indexOf('рефлексотерап') !== -1 ||
    text.indexOf('акупункт') !== -1
  ) {
    return 'I';
  }

  if (
    text.indexOf('плазм') !== -1 ||
    TSD_hasToken_(text, 'prp') ||
    text.indexOf('аутологичн') !== -1
  ) {
    return 'P';
  }

  if (
    text.indexOf('консультац') !== -1 ||
    ((text.indexOf('прием') !== -1 || text.indexOf('приём') !== -1) &&
      (text.indexOf('врач') !== -1 ||
       text.indexOf('невролог') !== -1 ||
       text.indexOf('травматолог') !== -1 ||
       text.indexOf('ортопед') !== -1 ||
       text.indexOf('нейрохирург') !== -1))
  ) {
    return 'C';
  }

  return '';
}

function TSD_saveNomenclatureMap_(ss, mapState) {
  const sheet = TSD_ensureNomenclatureMapSheet_(ss);
  const rows = Array.from(mapState.entries.values())
    .sort((a, b) => {
      const unresolvedDiff = Number(Boolean(a.code)) - Number(Boolean(b.code));
      if (unresolvedDiff !== 0) return unresolvedDiff;
      return a.name.localeCompare(b.name, 'ru');
    })
    .map(entry => [
      entry.name,
      entry.code,
      Array.from(entry.sources).sort().join(', '),
      entry.count,
      entry.lastSeen || '',
      entry.comment || ''
    ]);

  sheet.clearContents();
  sheet.getRange(1, 1, 1, TSD_MAP_HEADERS.length).setValues([TSD_MAP_HEADERS]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, TSD_MAP_HEADERS.length).setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, TSD_MAP_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#fce5cd')
    .setHorizontalAlignment('center');

  const dataRows = Math.max(rows.length, 1);
  sheet.getRange(2, 4, dataRows, 1).setNumberFormat('0');
  sheet.getRange(2, 5, dataRows, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet.setColumnWidth(1, 650);
  sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 120);
  sheet.setColumnWidth(5, 170);
  sheet.setColumnWidth(6, 350);

  if (rows.length) {
    const backgrounds = rows.map(row => [row[1] ? '#ffffff' : '#f4cccc']);
    sheet.getRange(2, 2, rows.length, 1).setBackgrounds(backgrounds);
  }

  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.getRange(1, 1, Math.max(rows.length + 1, 2), TSD_MAP_HEADERS.length).createFilter();
}

function TSD_ensureNomenclatureMapSheet_(ss) {
  let sheet = ss.getSheetByName(TSD_CONFIG.sheets.nomenclatureMap);
  if (!sheet) sheet = ss.insertSheet(TSD_CONFIG.sheets.nomenclatureMap);

  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, TSD_MAP_HEADERS.length).setValues([TSD_MAP_HEADERS]);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
      .getValues()[0]
      .map(value => String(value || '').trim());

    const missing = TSD_MAP_HEADERS.filter(header => current.indexOf(header) === -1);
    if (missing.length) {
      sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    }
  }

  return sheet;
}


/****************************************************
 * Расчет стадий
 ****************************************************/

function TSD_evaluateDeals_(deals, dealServiceInfo, aggregatedIndex, stageDirectory) {
  const byDealId = new Map();
  const updates = [];
  let checkedCount = 0;

  deals.forEach(deal => {
    checkedCount += 1;

    const services = dealServiceInfo.get(deal.id) || {
      codes: new Set(),
      codesText: '',
      unresolved: [],
      allNomenclatureResolved: false,
      source: '',
      itemCount: 0
    };

    const stageInfo = stageDirectory.get(deal.categoryId);
    const currentStageName = stageInfo && stageInfo.byId.get(deal.stageId)
      ? stageInfo.byId.get(deal.stageId)
      : deal.stageId;

    const match = TSD_findRequestMatchesForDeal_(
      deal,
      services,
      aggregatedIndex.get(deal.patientCode) || []
    );

    let targetStageId = '';
    let resultText = 'Без изменений';
    let reason = '';

    const onlyConsultation =
      services.allNomenclatureResolved &&
      services.codes.size === 1 &&
      services.codes.has(TSD_CONFIG.consultationCode);

    if (!deal.patientCode) {
      reason = services.patientCodeConflict
        ? 'По УИДам сделки найдены назначения разных пациентов.'
        : 'Не удалось определить код пациента по полю Bitrix или TEMED_UIDS.';
    } else if (!services.codes.size) {
      reason = services.unresolved.length
        ? 'Для назначения не определены буквенные коды.'
        : 'В назначении нет учитываемых типов услуг.';
    } else if (onlyConsultation && (match.done.has('C') || match.planned.has('C'))) {
      targetStageId = stageInfo.attendedId;
      resultText = 'Дошёл';
      reason = match.done.has('C')
        ? 'Единственное назначение — консультация; заявка выполнена.'
        : 'Единственное назначение — консультация; пациент записан. Сделка закрывается.';
    } else if (match.done.size > 0) {
      targetStageId = stageInfo.attendedId;
      resultText = 'Дошёл';
      reason = 'Найдена выполненная заявка по назначенному типу услуги: ' +
        TSD_codesToText_(match.done) + '.';
    } else if (match.planned.size > 0) {
      targetStageId = stageInfo.bookedId;
      resultText = 'Записался';
      reason = 'Найдена действующая запись по назначенному типу услуги: ' +
        TSD_codesToText_(match.planned) + '.';
    } else {
      reason = 'Подходящих плановых или выполненных заявок не найдено.';
    }

    // Никогда не понижаем "Дошёл" до "Записался".
    if (deal.stageId === stageInfo.attendedId) {
      targetStageId = '';
      resultText = 'Без изменений';
      reason = 'Сделка уже находится в стадии "Дошёл".';
    }

    // Если стадия уже целевая, запрос в Bitrix не нужен.
    if (targetStageId && targetStageId === deal.stageId) {
      targetStageId = '';
      resultText = 'Без изменений';
      reason = 'Сделка уже находится в рассчитанной стадии.';
    }

    const evaluation = {
      currentStageName,
      plannedCodes: match.planned,
      doneCodes: match.done,
      resultText,
      targetStageId,
      targetStageName: targetStageId
        ? (stageInfo.byId.get(targetStageId) || resultText)
        : '',
      reason
    };

    byDealId.set(deal.id, evaluation);

    if (targetStageId) {
      updates.push({
        id: deal.id,
        oldStageId: deal.stageId,
        newStageId: targetStageId,
        newStageName: evaluation.targetStageName,
        reason
      });
    }
  });

  return { byDealId, updates, checkedCount };
}

function TSD_findRequestMatchesForDeal_(deal, services, patientBuckets) {
  const planned = new Set();
  const done = new Set();
  const windowStart = deal.firstPlanDate;
  const windowEnd = TSD_addDays_(windowStart, TSD_CONFIG.requestMatchWindowDays);

  patientBuckets.forEach(bucket => {
    if (bucket.date < windowStart || bucket.date > windowEnd) return;

    bucket.done.forEach(code => {
      if (services.codes.has(code)) done.add(code);
    });

    bucket.planned.forEach(code => {
      if (services.codes.has(code)) planned.add(code);
    });
  });

  return { planned, done };
}


/****************************************************
 * Обновление Bitrix
 ****************************************************/

function TSD_updateDealsInBitrix_(baseUrl, updates) {
  const successfulIds = new Set();
  const errorsById = new Map();

  for (let offset = 0; offset < updates.length; offset += TSD_CONFIG.bitrixBatchSize) {
    const batch = updates.slice(offset, offset + TSD_CONFIG.bitrixBatchSize);
    const cmd = {};
    const keyToDealId = new Map();

    batch.forEach((update, index) => {
      const key = 'deal_' + index;
      keyToDealId.set(key, update.id);
      cmd[key] = 'crm.deal.update?' + TSD_toQueryString_({
        id: update.id,
        'fields[STAGE_ID]': update.newStageId
      });
    });

    try {
      const response = TSD_bitrixCall_(baseUrl, 'batch', {
        halt: 0,
        cmd
      });

      const result = response.result || {};
      const successMap = result.result || {};
      const errorMap = result.result_error || {};

      keyToDealId.forEach((dealId, key) => {
        if (Object.prototype.hasOwnProperty.call(successMap, key) && successMap[key] === true) {
          successfulIds.add(String(dealId));
        } else if (errorMap[key]) {
          errorsById.set(String(dealId), TSD_errorText_(errorMap[key]));
        } else {
          errorsById.set(String(dealId), 'Bitrix не вернул подтверждение обновления.');
        }
      });
    } catch (batchError) {
      // Резервный режим: если batch недоступен, обновляем сделки по одной.
      batch.forEach(update => {
        try {
          const response = TSD_bitrixCall_(baseUrl, 'crm.deal.update', {
            id: update.id,
            fields: { STAGE_ID: update.newStageId }
          });

          if (response.result === true) {
            successfulIds.add(String(update.id));
          } else {
            errorsById.set(String(update.id), 'Неожиданный ответ Bitrix: ' + JSON.stringify(response.result));
          }
        } catch (singleError) {
          errorsById.set(String(update.id), TSD_errorText_(singleError));
        }
      });
    }

    if (offset + TSD_CONFIG.bitrixBatchSize < updates.length) {
      Utilities.sleep(TSD_CONFIG.requestBatchPauseMs);
    }
  }

  return { successfulIds, errorsById };
}


/****************************************************
 * Вывод служебных листов
 ****************************************************/

function TSD_writeAggregatedRequests_(ss, rows) {
  const sheet = TSD_prepareOutputSheet_(
    ss,
    TSD_CONFIG.sheets.aggregatedRequests,
    TSD_AGGREGATED_HEADERS
  );

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, TSD_AGGREGATED_HEADERS.length).setValues(rows);
  }

  sheet.getRange(1, 1, 1, TSD_AGGREGATED_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#d9ead3')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  sheet.getRange(2, 2, Math.max(rows.length, 1), 1).setNumberFormat('dd.MM.yyyy');
  sheet.autoResizeColumns(1, TSD_AGGREGATED_HEADERS.length);

  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.getRange(1, 1, Math.max(rows.length + 1, 2), TSD_AGGREGATED_HEADERS.length).createFilter();
}

function TSD_buildPreviewRows_(deals, dealServiceInfo, evaluation, updateResult, dryRun) {
  return deals.map(deal => {
    const services = dealServiceInfo.get(deal.id) || {};
    const check = evaluation.byDealId.get(deal.id) || {};

    let updateStatus = 'Не требуется';
    let errorOrReason = check.reason || '';

    if (check.targetStageId) {
      if (dryRun) {
        updateStatus = 'Предпросмотр: будет обновлено';
      } else if (updateResult.successfulIds.has(String(deal.id))) {
        updateStatus = 'Обновлено';
      } else if (updateResult.errorsById.has(String(deal.id))) {
        updateStatus = 'Ошибка';
        errorOrReason = updateResult.errorsById.get(String(deal.id));
      } else {
        updateStatus = 'Не подтверждено';
      }
    }

    return [
      deal.id,
      deal.title,
      deal.categoryId,
      check.currentStageName || deal.stageId,
      deal.patientCode,
      deal.firstPlanDate,
      deal.uids.join(', '),
      services.codesText || '',
      (services.unresolved || []).join('\n'),
      TSD_codesToText_(check.plannedCodes || new Set()),
      TSD_codesToText_(check.doneCodes || new Set()),
      check.resultText || 'Без изменений',
      check.targetStageName || '',
      updateStatus,
      errorOrReason
    ];
  });
}

function TSD_writePreview_(ss, rows) {
  const sheet = TSD_prepareOutputSheet_(
    ss,
    TSD_CONFIG.sheets.dealsPreview,
    TSD_PREVIEW_HEADERS
  );

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, TSD_PREVIEW_HEADERS.length).setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, TSD_PREVIEW_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#cfe2f3')
    .setHorizontalAlignment('center');

  sheet.getRange(2, 6, Math.max(rows.length, 1), 1).setNumberFormat('dd.MM.yyyy');
  if (rows.length) {
    sheet.getRange(2, 7, rows.length, 9).setWrap(true);
  }

  sheet.autoResizeColumns(1, TSD_PREVIEW_HEADERS.length);
  sheet.setColumnWidth(2, 350);
  sheet.setColumnWidth(7, 300);
  sheet.setColumnWidth(9, 500);
  sheet.setColumnWidth(15, 500);

  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.getRange(1, 1, Math.max(rows.length + 1, 2), TSD_PREVIEW_HEADERS.length).createFilter();
}

function TSD_ensureLogSheet_(ss) {
  let sheet = ss.getSheetByName(TSD_CONFIG.sheets.log);
  if (!sheet) sheet = ss.insertSheet(TSD_CONFIG.sheets.log);

  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, TSD_LOG_HEADERS.length).setValues([TSD_LOG_HEADERS]);
    sheet.getRange(1, 1, 1, TSD_LOG_HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#ead1dc')
      .setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function TSD_appendLog_(ss, row) {
  const sheet = TSD_ensureLogSheet_(ss);
  sheet.appendRow(row);
  sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1)
    .setNumberFormat('dd.MM.yyyy HH:mm:ss');
}

function TSD_prepareOutputSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}


/****************************************************
 * REST helpers
 ****************************************************/

function TSD_bitrixCall_(baseUrl, method, payload) {
  const url = baseUrl + String(method || '').replace(/^\/+/, '') + '.json';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText() || '';
  let parsed;

  try {
    parsed = body ? JSON.parse(body) : {};
  } catch (error) {
    throw new Error('Bitrix вернул не-JSON. HTTP ' + code + ': ' + body.slice(0, 1000));
  }

  if (code < 200 || code >= 300 || parsed.error) {
    const description = parsed.error_description || parsed.error || body || ('HTTP ' + code);
    throw new Error('Bitrix ' + method + ': ' + description);
  }

  return parsed;
}

function TSD_bitrixListAll_(baseUrl, method, params) {
  const out = [];
  let start = 0;
  let guard = 0;

  while (guard < 10000) {
    guard += 1;
    const payload = Object.assign({}, params || {}, { start });
    const response = TSD_bitrixCall_(baseUrl, method, payload);
    const items = Array.isArray(response.result) ? response.result : [];
    out.push.apply(out, items);

    if (response.next === undefined || response.next === null || response.next === '') {
      break;
    }

    start = Number(response.next);
    if (!Number.isFinite(start)) break;
  }

  if (guard >= 10000) {
    throw new Error('Превышен защитный лимит пагинации Bitrix для метода ' + method + '.');
  }

  return out;
}

function TSD_toQueryString_(params) {
  return Object.keys(params || {})
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key] == null ? '' : params[key])))
    .join('&');
}


/****************************************************
 * Общие утилиты
 ****************************************************/

function TSD_getRequiredSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('Не найден обязательный лист "' + name + '".');
  }
  return sheet;
}

function TSD_readSheetAsObjects_(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  if (!values.length) return [];

  const headers = displayValues[0].map(value => String(value || '').trim());

  return values.slice(1).map((row, rowIndex) => {
    const obj = {};
    headers.forEach((header, colIndex) => {
      obj[header] = row[colIndex];
      obj['__DISPLAY__' + header] = displayValues[rowIndex + 1][colIndex];
    });
    return obj;
  });
}

function TSD_cleanNomenclature_(value) {
  return String(value || '')
    .replace(/\s*\|.*$/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function TSD_normalizeNomenclatureKey_(value) {
  return TSD_normalizeText_(TSD_cleanNomenclature_(value));
}

function TSD_normalizeText_(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function TSD_hasToken_(normalizedText, token) {
  const text = ' ' + String(normalizedText || '').trim() + ' ';
  const value = ' ' + TSD_normalizeText_(token) + ' ';
  return value.trim() ? text.indexOf(value) !== -1 : false;
}

function TSD_normalizePatientCode_(value) {
  const text = String(value == null ? '' : value).trim();
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/^0+/, '') || '0';
}

function TSD_normalizeServiceCode_(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  if (text === TSD_CONFIG.ignoredCode) return text;

  const match = text.match(/[A-ZА-Я]/);
  return match ? match[0] : '';
}

function TSD_codesToText_(codes) {
  const values = Array.from(codes || [])
    .map(TSD_normalizeServiceCode_)
    .filter(code => code && code !== TSD_CONFIG.ignoredCode);

  const order = TSD_CONFIG.serviceCodeOrder;
  values.sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    const av = ai === -1 ? 999 : ai;
    const bv = bi === -1 ? 999 : bi;
    if (av !== bv) return av - bv;
    return a.localeCompare(b);
  });

  return Array.from(new Set(values)).join('');
}

function TSD_splitUids_(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const out = [];

  rawValues.forEach(raw => {
    String(raw || '')
      .split(/[,;\n]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .forEach(item => {
        if (out.indexOf(item) === -1) out.push(item);
      });
  });

  return out;
}

function TSD_parseDateOnly_(value) {
  if (value === null || value === undefined || value === '') return null;

  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === 'number') {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (!isNaN(date.getTime())) {
      return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    }
  }

  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (match) {
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  }

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  return null;
}

function TSD_parseDateTime_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value;
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function TSD_today_() {
  const text = Utilities.formatDate(new Date(), TSD_CONFIG.timezone, 'yyyy-MM-dd');
  return TSD_parseDateOnly_(text);
}

function TSD_addDays_(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + Number(days || 0));
  return result;
}

function TSD_formatDateIso_(date) {
  return Utilities.formatDate(date, TSD_CONFIG.timezone, 'yyyy-MM-dd');
}

function TSD_elapsedText_(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
  return seconds + ' сек.';
}

function TSD_errorText_(error) {
  if (!error) return 'Неизвестная ошибка';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  try {
    return JSON.stringify(error);
  } catch (jsonError) {
    return String(error);
  }
}

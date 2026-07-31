/****************************************************
 * TEMED — ежедневный отчёт по воронке 114 в чат Bitrix.
 *
 * Источник правды — только Bitrix: операторы меняют сделки
 * вручную, листы отстают от реального состояния.
 *
 * Отчётные сутки: всё до 06:00 относится к предыдущему дню,
 * то есть окно выборки — [дата отчёта 06:00; следующий день 06:00).
 * Запуск 31.07 в 23:30 и запуск 01.08 в 02:00 дают отчёт за 31.07.
 *
 * Запуск: ежедневный триггер на 20:00 МСК (installDailyReportTrigger)
 * либо вручную из меню «Отправить итог дня в чат».
 ****************************************************/

const DAILY_REPORT_CHAT_ID = 'chat229018';
const DAILY_REPORT_TIMEZONE = 'Europe/Moscow';
const DAILY_REPORT_DAY_START_HOUR = 6;
const DAILY_REPORT_TRIGGER_HOUR = 20;
const DAILY_REPORT_FUNCTION_NAME = 'sendDailySalesReport';
const DAILY_REPORT_DEALS_BATCH_SIZE = 50;

const DAILY_REPORT_STAGE_BOOKED = 'C114:EXECUTING';   // Записался
const DAILY_REPORT_STAGE_WON = 'C114:WON';            // Дошёл
const DAILY_REPORT_STAGE_LOST = 'C114:LOSE';          // Провалено
const DAILY_REPORT_STAGE_REFUSAL = 'C114:UC_8I6LEA';  // Отказ (транзитная)
const DAILY_REPORT_STAGE_NO_CONTACT = 'C114:UC_1GZCBR'; // Не вышел на связь (транзитная)

function sendDailySalesReport() {
  const manualRun = isDailyReportManualRun_();
  const reportWindow = buildDailyReportWindow_(new Date());

  try {
    const report = collectDailySalesReport_(reportWindow);
    const message = buildDailySalesReportMessage_(reportWindow, report);

    sendDailyReportMessage_(message);

    if (manualRun) {
      SpreadsheetApp.getUi().alert('Итог дня за ' + reportWindow.titleDate + ' отправлен в чат.');
    } else {
      Logger.log('Итог дня за ' + reportWindow.titleDate + ' отправлен в чат.');
    }
  } catch (err) {
    const errorText = err && err.message ? err.message : String(err);
    const failureText = 'Отчёт за ' + reportWindow.titleDate + ' не собран: ' + errorText;

    Logger.log(failureText);

    if (manualRun) {
      SpreadsheetApp.getUi().alert(failureText);
      return;
    }

    try {
      sendDailyReportMessage_(failureText);
    } catch (sendErr) {
      const sendErrorText = sendErr && sendErr.message ? sendErr.message : String(sendErr);
      Logger.log('Сообщение об ошибке отчёта тоже не отправлено в чат: ' + sendErrorText);
    }
  }
}

function installDailyReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === DAILY_REPORT_FUNCTION_NAME) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(DAILY_REPORT_FUNCTION_NAME)
    .timeBased()
    .atHour(DAILY_REPORT_TRIGGER_HOUR)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(DAILY_REPORT_TIMEZONE)
    .create();

  return 'Триггер ежедневного отчёта установлен на ' + DAILY_REPORT_TRIGGER_HOUR + ':00 (' +
    DAILY_REPORT_TIMEZONE + ').';
}

function isDailyReportManualRun_() {
  try {
    SpreadsheetApp.getUi();
    return true;
  } catch (e) {
    return false;
  }
}

function sendDailyReportMessage_(text) {
  try {
    bitrixCall_('im.message.add', { DIALOG_ID: DAILY_REPORT_CHAT_ID, MESSAGE: text });
  } catch (err) {
    const errorText = err && err.message ? err.message : String(err);
    throw new Error(
      'Не удалось отправить сообщение в чат ' + DAILY_REPORT_CHAT_ID + ': ' + errorText +
      '. Проверьте, что пользователь вебхука состоит в чате.'
    );
  }
}

/****************************************************
 * Отчётные сутки
 ****************************************************/

function parseDailyReportMoscowTime_(text) {
  return Utilities.parseDate(text, DAILY_REPORT_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function formatDailyReportDateForBitrix_(date) {
  return Utilities.formatDate(date, DAILY_REPORT_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/**
 * Окно отчётных суток: дата отчёта — календарная дата момента «сейчас минус 6 часов»,
 * окно — от 06:00 этой даты до 06:00 следующего дня.
 */
function buildDailyReportWindow_(now) {
  const shifted = new Date(now.getTime() - DAILY_REPORT_DAY_START_HOUR * 60 * 60 * 1000);
  const reportDateText = Utilities.formatDate(shifted, DAILY_REPORT_TIMEZONE, 'yyyy-MM-dd');
  const start = parseDailyReportMoscowTime_(reportDateText + ' 06:00:00');
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return {
    reportDateText: reportDateText,
    titleDate: Utilities.formatDate(start, DAILY_REPORT_TIMEZONE, 'dd.MM'),
    start: start,
    end: end,
    startText: formatDailyReportDateForBitrix_(start),
    endText: formatDailyReportDateForBitrix_(end)
  };
}

/****************************************************
 * Сбор данных
 ****************************************************/

function collectDailySalesReport_(reportWindow) {
  return {
    newDeals: collectDailyReportNewDeals_(reportWindow),
    stageMoves: collectDailyReportStageMoves_(reportWindow),
    activities: collectDailyReportActivities_(reportWindow)
  };
}

function emptyDailyReportTotal_() {
  return { count: 0, sum: 0 };
}

function addToDailyReportTotal_(total, amount) {
  total.count += 1;
  total.sum += Number(amount) || 0;
}

function collectDailyReportNewDeals_(reportWindow) {
  const filter = { CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID };
  filter['>=DATE_CREATE'] = reportWindow.startText;
  filter['<DATE_CREATE'] = reportWindow.endText;

  const deals = bitrixFetchAllPages_('crm.deal.list', {
    filter: filter,
    select: ['ID', 'STAGE_ID', 'OPPORTUNITY'],
    order: { ID: 'ASC' }
  });

  const result = {
    total: emptyDailyReportTotal_(),
    contact: emptyDailyReportTotal_(),
    waiting: emptyDailyReportTotal_(),
    intersection: emptyDailyReportTotal_()
  };

  deals.forEach(deal => {
    const stageId = String(deal.STAGE_ID || '');
    const amount = deal.OPPORTUNITY;

    addToDailyReportTotal_(result.total, amount);

    // Прочие стадии попадают только в общий счётчик — отдельной строки для них нет.
    if (stageId === BITRIX_DEAL_STAGE_CONTACT) {
      addToDailyReportTotal_(result.contact, amount);
    } else if (stageId === BITRIX_DEAL_STAGE_WAITING) {
      addToDailyReportTotal_(result.waiting, amount);
    } else if (stageId === BITRIX_DEAL_STAGE_INTERSECTION) {
      addToDailyReportTotal_(result.intersection, amount);
    }
  });

  return result;
}

/**
 * Переходы стадий за сутки по истории Bitrix — учитывает изменения
 * и скриптом, и операторами.
 */
function collectDailyReportStageMoves_(reportWindow) {
  const filter = { CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID };
  filter['>=CREATED_TIME'] = reportWindow.startText;
  filter['<CREATED_TIME'] = reportWindow.endText;

  const history = bitrixFetchAllPages_('crm.stagehistory.list', {
    entityTypeId: 2,
    filter: filter,
    order: { ID: 'ASC' }
  }, result => (result && result.items ? result.items : []));

  const bookedIds = new Set();
  const wonIds = new Set();
  const lostIds = new Set();
  const refusalIds = new Set();
  const noContactIds = new Set();
  const previousStageByDeal = new Map();

  history.forEach(item => {
    const dealId = String(item.OWNER_ID || '');
    const stageId = String(item.STAGE_ID || '');

    if (!dealId || !stageId) {
      return;
    }

    // Сделка за день может переходить в стадию несколько раз — считаем один раз.
    if (stageId === DAILY_REPORT_STAGE_BOOKED) {
      bookedIds.add(dealId);
    } else if (stageId === DAILY_REPORT_STAGE_WON) {
      wonIds.add(dealId);
    } else if (stageId === DAILY_REPORT_STAGE_LOST) {
      lostIds.add(dealId);

      // Предыдущая стадия той же сделки: «Отказ» и «Не вышел на связь» транзитные —
      // робот сразу перекидывает их в «Провал». Берём последний путь за сутки.
      const previousStageId = previousStageByDeal.get(dealId) || '';

      refusalIds.delete(dealId);
      noContactIds.delete(dealId);

      if (previousStageId === DAILY_REPORT_STAGE_REFUSAL) {
        refusalIds.add(dealId);
      } else if (previousStageId === DAILY_REPORT_STAGE_NO_CONTACT) {
        noContactIds.add(dealId);
      }
    }

    previousStageByDeal.set(dealId, stageId);
  });

  const amounts = loadDailyReportDealAmounts_(
    unionDailyReportIds_([bookedIds, wonIds, lostIds])
  );

  return {
    booked: buildDailyReportTotalByIds_(bookedIds, amounts),
    won: buildDailyReportTotalByIds_(wonIds, amounts),
    lost: buildDailyReportTotalByIds_(lostIds, amounts),
    refusal: buildDailyReportTotalByIds_(refusalIds, amounts),
    noContact: buildDailyReportTotalByIds_(noContactIds, amounts)
  };
}

function unionDailyReportIds_(sets) {
  const result = new Set();

  (sets || []).forEach(set => {
    set.forEach(id => result.add(id));
  });

  return result;
}

function buildDailyReportTotalByIds_(ids, amounts) {
  const total = emptyDailyReportTotal_();

  ids.forEach(id => {
    addToDailyReportTotal_(total, amounts.get(id));
  });

  return total;
}

function loadDailyReportDealAmounts_(ids) {
  const amounts = new Map();
  const list = Array.from(ids);

  for (let i = 0; i < list.length; i += DAILY_REPORT_DEALS_BATCH_SIZE) {
    const batch = list.slice(i, i + DAILY_REPORT_DEALS_BATCH_SIZE);
    const deals = bitrixFetchAllPages_('crm.deal.list', {
      filter: { ID: batch },
      select: ['ID', 'OPPORTUNITY'],
      order: { ID: 'ASC' }
    });

    deals.forEach(deal => {
      amounts.set(String(deal.ID || ''), Number(deal.OPPORTUNITY) || 0);
    });
  }

  return amounts;
}

/**
 * Дела по сделкам воронки 114. Дел за сутки немного, поэтому категорию
 * определяем догрузкой сделок-владельцев батчами, а не выгрузкой всей воронки.
 */
function collectDailyReportActivities_(reportWindow) {
  const createdFilter = { OWNER_TYPE_ID: 2 };
  createdFilter['>=CREATED'] = reportWindow.startText;
  createdFilter['<CREATED'] = reportWindow.endText;

  const completedFilter = { OWNER_TYPE_ID: 2, COMPLETED: 'Y' };
  completedFilter['>=LAST_UPDATED'] = reportWindow.startText;
  completedFilter['<LAST_UPDATED'] = reportWindow.endText;

  const created = fetchDailyReportActivities_(createdFilter);
  const completed = fetchDailyReportActivities_(completedFilter);
  const ownerIds = new Set();

  created.concat(completed).forEach(activity => {
    const ownerId = String(activity.OWNER_ID || '');
    if (ownerId) {
      ownerIds.add(ownerId);
    }
  });

  const categoryDealIds = loadDailyReportCategoryDealIds_(ownerIds);
  const countInCategory = function(activities) {
    return activities.filter(activity => categoryDealIds.has(String(activity.OWNER_ID || ''))).length;
  };

  return {
    created: countInCategory(created),
    completed: countInCategory(completed)
  };
}

function fetchDailyReportActivities_(filter) {
  return bitrixFetchAllPages_('crm.activity.list', {
    filter: filter,
    select: ['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'COMPLETED', 'CREATED', 'LAST_UPDATED'],
    order: { ID: 'ASC' }
  });
}

function loadDailyReportCategoryDealIds_(ids) {
  const result = new Set();
  const list = Array.from(ids);

  for (let i = 0; i < list.length; i += DAILY_REPORT_DEALS_BATCH_SIZE) {
    const batch = list.slice(i, i + DAILY_REPORT_DEALS_BATCH_SIZE);
    const deals = bitrixFetchAllPages_('crm.deal.list', {
      filter: { ID: batch, CATEGORY_ID: BITRIX_DEAL_CATEGORY_ID },
      select: ['ID', 'CATEGORY_ID'],
      order: { ID: 'ASC' }
    });

    deals.forEach(deal => result.add(String(deal.ID || '')));
  }

  return result;
}

/****************************************************
 * Формат сообщения
 ****************************************************/

function formatDailyReportMoney_(amount) {
  const value = Math.round(Number(amount) || 0);
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  return (value < 0 ? '-' : '') + digits + ' ₽';
}

function formatDailyReportTotal_(total) {
  const value = total || emptyDailyReportTotal_();

  return value.count + ' на ' + formatDailyReportMoney_(value.sum);
}

function buildDailySalesReportMessage_(reportWindow, report) {
  const newDeals = report.newDeals;
  const stageMoves = report.stageMoves;
  const lines = [
    '📊 Итоги дня ' + reportWindow.titleDate,
    '',
    'Новые сделки: ' + formatDailyReportTotal_(newDeals.total),
    '• Связаться: ' + formatDailyReportTotal_(newDeals.contact),
    '• Ожидание: ' + formatDailyReportTotal_(newDeals.waiting),
    '• Пересечения: ' + formatDailyReportTotal_(newDeals.intersection),
    '',
    'Движение по стадиям:',
    '• Записался: ' + formatDailyReportTotal_(stageMoves.booked),
    '',
    'Финализировано:',
    '• Дошёл: ' + formatDailyReportTotal_(stageMoves.won),
    '• Провалено: ' + formatDailyReportTotal_(stageMoves.lost),
    '  — отказ: ' + formatDailyReportTotal_(stageMoves.refusal),
    '  — не вышел на связь: ' + formatDailyReportTotal_(stageMoves.noContact),
    '',
    'Дела: создано ' + report.activities.created + ', завершено ' + report.activities.completed
  ];

  return lines.join('\n');
}


function testDailyReportFormatting_() {
  const assert = function(condition, message) {
    if (!condition) {
      throw new Error('Проверка ежедневного отчёта не пройдена: ' + message);
    }
  };

  const windowChecks = [
    { name: 'запуск 31.07 в 20:00', now: '2026-07-31 20:00:00', date: '2026-07-31', title: '31.07' },
    { name: 'запуск 31.07 в 23:30', now: '2026-07-31 23:30:00', date: '2026-07-31', title: '31.07' },
    { name: 'запуск 01.08 в 02:00', now: '2026-08-01 02:00:00', date: '2026-07-31', title: '31.07' },
    { name: 'запуск 01.08 в 05:59', now: '2026-08-01 05:59:00', date: '2026-07-31', title: '31.07' },
    { name: 'запуск 01.08 в 06:00', now: '2026-08-01 06:00:00', date: '2026-08-01', title: '01.08' }
  ];

  windowChecks.forEach(check => {
    const reportWindow = buildDailyReportWindow_(parseDailyReportMoscowTime_(check.now));
    const startText = Utilities.formatDate(reportWindow.start, DAILY_REPORT_TIMEZONE, 'yyyy-MM-dd HH:mm');
    const endText = Utilities.formatDate(reportWindow.end, DAILY_REPORT_TIMEZONE, 'yyyy-MM-dd HH:mm');

    assert(
      reportWindow.reportDateText === check.date,
      'дата отчёта «' + check.name + '»: ожидалось ' + check.date + ', получено ' + reportWindow.reportDateText + '.'
    );
    assert(
      reportWindow.titleDate === check.title,
      'заголовок «' + check.name + '»: ожидалось ' + check.title + ', получено ' + reportWindow.titleDate + '.'
    );
    assert(
      startText === check.date + ' 06:00',
      'начало окна «' + check.name + '»: получено ' + startText + '.'
    );
    assert(
      endText.slice(-5) === '06:00' && reportWindow.end.getTime() - reportWindow.start.getTime() === 24 * 60 * 60 * 1000,
      'конец окна «' + check.name + '»: получено ' + endText + '.'
    );
  });

  const moneyChecks = [
    { value: 0, expected: '0 ₽' },
    { value: 486000, expected: '486 000 ₽' },
    { value: 74000, expected: '74 000 ₽' },
    { value: 1234567, expected: '1 234 567 ₽' },
    { value: 999, expected: '999 ₽' },
    { value: 1000.49, expected: '1 000 ₽' }
  ];

  moneyChecks.forEach(check => {
    const actual = formatDailyReportMoney_(check.value);
    assert(
      actual === check.expected,
      'сумма ' + check.value + ': ожидалось "' + check.expected + '", получено "' + actual + '".'
    );
  });

  const total = function(count, sum) {
    return { count: count, sum: sum };
  };
  const message = buildDailySalesReportMessage_(
    { titleDate: '31.07' },
    {
      newDeals: {
        total: total(14, 486000),
        contact: total(8, 290000),
        waiting: total(4, 122000),
        intersection: total(2, 74000)
      },
      stageMoves: {
        booked: total(9, 312000),
        won: total(6, 214000),
        lost: total(9, 254000),
        refusal: total(4, 96000),
        noContact: total(5, 158000)
      },
      activities: { created: 37, completed: 29 }
    }
  );
  const expectedMessage = [
    '📊 Итоги дня 31.07',
    '',
    'Новые сделки: 14 на 486 000 ₽',
    '• Связаться: 8 на 290 000 ₽',
    '• Ожидание: 4 на 122 000 ₽',
    '• Пересечения: 2 на 74 000 ₽',
    '',
    'Движение по стадиям:',
    '• Записался: 9 на 312 000 ₽',
    '',
    'Финализировано:',
    '• Дошёл: 6 на 214 000 ₽',
    '• Провалено: 9 на 254 000 ₽',
    '  — отказ: 4 на 96 000 ₽',
    '  — не вышел на связь: 5 на 158 000 ₽',
    '',
    'Дела: создано 37, завершено 29'
  ].join('\n');

  assert(message === expectedMessage, 'формат сообщения отличается от согласованного:\n' + message);

  const zeroMessage = buildDailySalesReportMessage_(
    { titleDate: '01.08' },
    {
      newDeals: {
        total: emptyDailyReportTotal_(),
        contact: emptyDailyReportTotal_(),
        waiting: emptyDailyReportTotal_(),
        intersection: emptyDailyReportTotal_()
      },
      stageMoves: {
        booked: emptyDailyReportTotal_(),
        won: emptyDailyReportTotal_(),
        lost: emptyDailyReportTotal_(),
        refusal: emptyDailyReportTotal_(),
        noContact: emptyDailyReportTotal_()
      },
      activities: { created: 0, completed: 0 }
    }
  );

  assert(
    zeroMessage.indexOf('Новые сделки: 0 на 0 ₽') !== -1 &&
    zeroMessage.indexOf('• Записался: 0 на 0 ₽') !== -1,
    'нулевые строки должны выводиться:\n' + zeroMessage
  );

  return 'Проверки ежедневного отчёта пройдены: ' +
    (windowChecks.length + moneyChecks.length + 2);
}

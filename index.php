<?php
require($_SERVER["DOCUMENT_ROOT"] . "/bitrix/modules/main/include/prolog_before.php");
require_once __DIR__ . '/config.php';

$APPLICATION->RestartBuffer();

header_remove('X-Powered-By');

const BITRIX_PLAN_ITEMS_JSON_FIELD = 'UF_CRM_1784034617';
const BITRIX_PATIENT_NAME_FIELD = 'UF_CRM_1737550182812';
const DEFAULT_ASSIGNED_BY_ID = 22718;
const CURRENCY_ID = 'RUB';

function getBitrixWebhookBaseUrl_() {
    if (!defined('BITRIX_WEBHOOK_BASE_URL') || !BITRIX_WEBHOOK_BASE_URL) {
        throw new Exception('Не задан BITRIX_WEBHOOK_BASE_URL в config.php');
    }

    return rtrim(BITRIX_WEBHOOK_BASE_URL, '/');
}

function bitrixCall_($method, $payload = []) {
    $url = getBitrixWebhookBaseUrl_() . '/' . $method . '.json';

    $ch = curl_init($url);

    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json; charset=utf-8'],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        CURLOPT_TIMEOUT => 30,
    ]);

    $raw = curl_exec($ch);

    if ($raw === false) {
        $error = curl_error($ch);
        curl_close($ch);
        throw new Exception('Ошибка CURL: ' . $error);
    }

    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $data = json_decode($raw, true);

    if (!is_array($data)) {
        throw new Exception('Bitrix вернул не JSON. HTTP ' . $httpCode . ': ' . $raw);
    }

    if (isset($data['error'])) {
        throw new Exception($data['error'] . ': ' . ($data['error_description'] ?? ''));
    }

    return $data['result'] ?? null;
}

function jsonResponse_($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    die();
}

function readJsonBody_() {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);

    if (!is_array($data)) {
        throw new Exception('Некорректный JSON');
    }

    return $data;
}

function parsePlanJson_($raw) {
    $raw = trim((string)$raw);

    if (!$raw) {
        return ['items' => []];
    }

    $data = json_decode($raw, true);

    if (!is_array($data)) {
        $decoded = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $data = json_decode($decoded, true);
    }

    if (!is_array($data)) {
        return ['items' => []];
    }

    if (!isset($data['items']) || !is_array($data['items'])) {
        $data['items'] = [];
    }

    return $data;
}

function moneyNumber_($value) {
    return round((float)$value, 2);
}

function formatMoney_($value) {
    return number_format((float)$value, 0, ',', ' ') . ' ₽';
}

function normalizeQuoteItems_($items) {
    if (!is_array($items)) {
        return [];
    }

    $result = [];

    foreach ($items as $item) {
        $name = trim((string)($item['name'] ?? ''));
        $qty = moneyNumber_($item['qty'] ?? 0);
        $unitPrice = moneyNumber_($item['unit_price'] ?? 0);
        $discount = moneyNumber_($item['discount'] ?? 0);

        if (!$name || $qty <= 0 || $unitPrice < 0) {
            continue;
        }

        $baseSum = round($qty * $unitPrice, 2);

        if ($discount < 0) {
            $discount = 0;
        }

        if ($discount > $baseSum) {
            $discount = $baseSum;
        }

        $finalSum = round($baseSum - $discount, 2);
        $finalUnitPrice = $qty > 0 ? round($finalSum / $qty, 2) : $finalSum;

        $result[] = [
            'name' => $name,
            'qty' => $qty,
            'unit_price' => $unitPrice,
            'base_sum' => $baseSum,
            'discount' => $discount,
            'final_sum' => $finalSum,
            'final_unit_price' => $finalUnitPrice,
        ];
    }

    return $result;
}

function calculateTotals_($items) {
    $baseTotal = 0;
    $discountTotal = 0;
    $finalTotal = 0;

    foreach ($items as $item) {
        $baseTotal += $item['base_sum'];
        $discountTotal += $item['discount'];
        $finalTotal += $item['final_sum'];
    }

    return [
        'base_total' => round($baseTotal, 2),
        'discount_total' => round($discountTotal, 2),
        'final_total' => round($finalTotal, 2),
    ];
}

function buildQuoteComment_($items, $totals, $validUntil) {
    $lines = [];

    $lines[] = 'План лечения';
    $lines[] = '';

    if ($validUntil) {
        $lines[] = 'Предложение действует до: ' . $validUntil;
    }

    $lines[] = 'Базовая сумма: ' . formatMoney_($totals['base_total']);
    $lines[] = 'Скидка: ' . formatMoney_($totals['discount_total']);
    $lines[] = 'Итого: ' . formatMoney_($totals['final_total']);
    $lines[] = '';
    $lines[] = 'Состав:';

    foreach ($items as $item) {
        $lines[] = '- ' . $item['name'] . ' × ' . $item['qty'] . ': ' . formatMoney_($item['final_sum']);
    }

    return implode("\n", $lines);
}

function buildTimelineComment_($quoteId, $items, $totals, $validUntil) {
    $lines = [];

    $lines[] = 'Сформировано предложение по плану лечения';

    if ($quoteId) {
        $lines[] = 'ID предложения: ' . $quoteId;
    }

    $lines[] = '';
    $lines[] = 'Базовая сумма: ' . formatMoney_($totals['base_total']);
    $lines[] = 'Скидка: ' . formatMoney_($totals['discount_total']);
    $lines[] = 'Итого: ' . formatMoney_($totals['final_total']);

    if ($validUntil) {
        $lines[] = 'Действует до: ' . $validUntil;
    }

    $lines[] = '';
    $lines[] = 'Состав:';

    foreach ($items as $item) {
        $lines[] = '- ' . $item['name'] . ' × ' . $item['qty'] . ': ' . formatMoney_($item['final_sum']);
    }

    return implode("\n", $lines);
}

function addTimelineComment_($dealId, $text) {
    if (!$dealId || !$text) {
        return null;
    }

    return bitrixCall_('crm.timeline.comment.add', [
        'fields' => [
            'ENTITY_ID' => $dealId,
            'ENTITY_TYPE' => 'deal',
            'COMMENT' => $text,
        ],
    ]);
}

function createQuote_($payload) {
    $warnings = [];

    $dealId = (int)($payload['deal_id'] ?? 0);

    if ($dealId <= 0) {
        throw new Exception('Не передан deal_id');
    }

    $deal = bitrixCall_('crm.deal.get', [
        'id' => $dealId,
    ]);

    if (!$deal || !is_array($deal)) {
        throw new Exception('Сделка не найдена');
    }

    $items = normalizeQuoteItems_($payload['items'] ?? []);
    $totals = calculateTotals_($items);
    $validUntil = trim((string)($payload['valid_until'] ?? ''));

    if (count($items) === 0) {
        throw new Exception('Нет выбранных позиций для предложения');
    }

    $assignedById = (int)($deal['ASSIGNED_BY_ID'] ?? 0);

    if ($assignedById <= 0) {
        $assignedById = DEFAULT_ASSIGNED_BY_ID;
    }

    $patientName = trim((string)($deal[BITRIX_PATIENT_NAME_FIELD] ?? ''));
    $title = 'План лечения';

    if ($patientName) {
        $title .= ' — ' . $patientName;
    }

    $quoteId = bitrixCall_('crm.quote.add', [
        'fields' => [
            'TITLE' => $title,
            'DEAL_ID' => $dealId,
            'ASSIGNED_BY_ID' => $assignedById,
            'CURRENCY_ID' => CURRENCY_ID,
            'OPPORTUNITY' => $totals['final_total'],
            'COMMENTS' => buildQuoteComment_($items, $totals, $validUntil),
        ],
        'params' => [
            'REGISTER_SONET_EVENT' => 'Y',
        ],
    ]);

    $productRows = [];

    foreach ($items as $item) {
        $productRows[] = [
            'PRODUCT_NAME' => $item['name'],
            'QUANTITY' => $item['qty'],
            'PRICE' => $item['final_unit_price'],
            'PRICE_EXCLUSIVE' => $item['final_unit_price'],
            'PRICE_NETTO' => $item['final_unit_price'],
            'PRICE_BRUTTO' => $item['final_unit_price'],
        ];
    }

    if ($quoteId && count($productRows) > 0) {
        try {
            bitrixCall_('crm.quote.productrows.set', [
                'id' => $quoteId,
                'rows' => $productRows,
            ]);
        } catch (Exception $e) {
            $warnings[] = 'Предложение создано, но товарные строки не записаны: ' . $e->getMessage();
        }
    }

    try {
        addTimelineComment_(
            $dealId,
            buildTimelineComment_($quoteId, $items, $totals, $validUntil)
        );
    } catch (Exception $e) {
        $warnings[] = 'Предложение создано, но комментарий в таймлайн не добавлен: ' . $e->getMessage();
    }

    return [
        'quote_id' => $quoteId,
        'deal_id' => $dealId,
        'assigned_by_id' => $assignedById,
        'base_total' => $totals['base_total'],
        'discount_total' => $totals['discount_total'],
        'final_total' => $totals['final_total'],
        'valid_until' => $validUntil,
        'warnings' => $warnings,
    ];
}

$action = $_GET['action'] ?? '';

if ($action === 'load_deal') {
    try {
        $dealId = (int)($_GET['deal_id'] ?? 0);

        if ($dealId <= 0) {
            throw new Exception('Не передан deal_id');
        }

        $deal = bitrixCall_('crm.deal.get', [
            'id' => $dealId,
        ]);

        if (!$deal || !is_array($deal)) {
            throw new Exception('Сделка не найдена');
        }

        $plan = parsePlanJson_($deal[BITRIX_PLAN_ITEMS_JSON_FIELD] ?? '');

        jsonResponse_([
            'ok' => true,
            'deal_id' => $dealId,
            'deal' => [
                'id' => $dealId,
                'title' => $deal['TITLE'] ?? '',
                'assigned_by_id' => $deal['ASSIGNED_BY_ID'] ?? '',
                'patient_name' => $deal[BITRIX_PATIENT_NAME_FIELD] ?? '',
            ],
            'plan' => $plan,
        ]);
    } catch (Exception $e) {
        jsonResponse_([
            'ok' => false,
            'error' => $e->getMessage(),
        ], 500);
    }
}

if ($action === 'create_quote') {
    try {
        $payload = readJsonBody_();
        $result = createQuote_($payload);

        jsonResponse_([
            'ok' => true,
            'result' => $result,
        ]);
    } catch (Exception $e) {
        jsonResponse_([
            'ok' => false,
            'error' => $e->getMessage(),
        ], 500);
    }
}

$dealId = htmlspecialchars($_GET['deal_id'] ?? '', ENT_QUOTES, 'UTF-8');
?>
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TEMED · План лечения</title>

  <style>
    :root {
      --bg: #f4f6f8;
      --card: #ffffff;
      --text: #1f2933;
      --muted: #697586;
      --line: #e3e8ef;
      --accent: #176b87;
      --accent-soft: #e7f3f6;
      --danger: #b42318;
      --success: #087443;
      --warning: #b54708;
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      --radius: 18px;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      line-height: 1.45;
    }

    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 20px;
    }

    .brand {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .brand-title {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }

    .brand-subtitle {
      color: var(--muted);
      font-size: 15px;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-radius: 999px;
      background: #fff7ed;
      color: var(--warning);
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 20px;
      align-items: start;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 20px;
    }

    .card + .card {
      margin-top: 20px;
    }

    .section-title {
      margin: 0 0 14px;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .deal-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .field {
      padding: 12px;
      background: #f8fafc;
      border: 1px solid var(--line);
      border-radius: 14px;
    }

    .field-label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .field-value {
      font-weight: 700;
    }

    .items {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .item {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: #ffffff;
    }

    .item.is-disabled {
      opacity: 0.55;
      background: #f8fafc;
    }

    .item-head {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }

    .item-title {
      font-weight: 800;
      margin-bottom: 4px;
    }

    .item-meta {
      color: var(--muted);
      font-size: 14px;
    }

    .item-sum {
      font-weight: 800;
      white-space: nowrap;
    }

    .item-controls {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      align-items: end;
    }

    label {
      display: block;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 5px;
    }

    input,
    select {
      width: 100%;
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0 10px;
      font-size: 14px;
      background: #fff;
      color: var(--text);
    }

    input[type="checkbox"] {
      width: 20px;
      height: 20px;
      accent-color: var(--accent);
      margin-top: 2px;
    }

    .sidebar {
      position: sticky;
      top: 20px;
    }

    .discount-box {
      display: grid;
      gap: 12px;
    }

    .radio-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .radio-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px 12px;
      cursor: pointer;
      background: #fff;
      display: flex;
      gap: 8px;
      align-items: center;
      font-weight: 700;
      font-size: 14px;
    }

    .radio-card input {
      width: 16px;
      height: 16px;
    }

    .summary {
      display: grid;
      gap: 10px;
      margin-top: 8px;
    }

    .summary-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
    }

    .summary-row:last-child {
      border-bottom: none;
    }

    .summary-label {
      color: var(--muted);
    }

    .summary-value {
      font-weight: 800;
      text-align: right;
    }

    .total {
      margin-top: 10px;
      padding: 16px;
      background: var(--accent-soft);
      border: 1px solid #c8e4eb;
      border-radius: 16px;
    }

    .total-label {
      color: var(--muted);
      font-size: 13px;
    }

    .total-value {
      font-size: 30px;
      font-weight: 900;
      color: var(--accent);
      letter-spacing: -0.04em;
    }

    .buttons {
      display: grid;
      gap: 10px;
      margin-top: 16px;
    }

    button {
      border: none;
      border-radius: 14px;
      min-height: 44px;
      padding: 10px 14px;
      font-weight: 800;
      cursor: pointer;
      font-size: 14px;
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--accent);
      color: #fff;
    }

    .btn-secondary {
      background: #eef2f6;
      color: var(--text);
    }

    .btn-outline {
      background: #fff;
      color: var(--accent);
      border: 1px solid #b8dce4;
    }

    .btn-success {
      background: var(--success);
      color: #ffffff;
    }

    .note {
      color: var(--muted);
      font-size: 13px;
      margin-top: 10px;
    }

    .warning {
      display: none;
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #fff7ed;
      color: var(--warning);
      font-weight: 700;
      font-size: 13px;
    }

    .warning.is-visible {
      display: block;
    }

    .status-box {
      display: none;
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #f8fafc;
      color: var(--text);
      font-weight: 700;
      font-size: 13px;
      white-space: pre-wrap;
    }

    .status-box.is-visible {
      display: block;
    }

    .status-box.is-error {
      background: #fef2f2;
      color: #991b1b;
    }

    .status-box.is-ok {
      background: #ecfdf5;
      color: #065f46;
    }

    .output {
      white-space: pre-wrap;
      background: #0f172a;
      color: #e5e7eb;
      border-radius: 16px;
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      max-height: 420px;
      overflow: auto;
    }

    .patient-output {
      display: none;
      margin-top: 20px;
    }

    .patient-output.is-visible {
      display: block;
    }

    .mobile-sheet-wrap {
      display: flex;
      justify-content: center;
      padding: 16px;
      background: #e7ecf2;
      border-radius: 20px;
    }

    .mobile-sheet {
      width: 390px;
      max-width: 100%;
      background: #ffffff;
      border-radius: 28px;
      padding: 28px 22px;
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.18);
    }

    .patient-logo {
      font-size: 22px;
      font-weight: 900;
      letter-spacing: 0.08em;
      margin-bottom: 24px;
      color: var(--accent);
    }

    .patient-title {
      font-size: 28px;
      font-weight: 900;
      letter-spacing: -0.04em;
      margin-bottom: 12px;
    }

    .patient-lead {
      color: #435363;
      margin-bottom: 22px;
    }

    .patient-info {
      display: grid;
      gap: 10px;
      margin-bottom: 22px;
    }

    .patient-info-row {
      padding: 12px;
      background: #f8fafc;
      border-radius: 14px;
    }

    .patient-info-label {
      color: var(--muted);
      font-size: 12px;
    }

    .patient-info-value {
      font-weight: 800;
    }

    .patient-list {
      display: grid;
      gap: 12px;
      margin: 16px 0 22px;
    }

    .patient-item {
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }

    .patient-item:last-child {
      border-bottom: none;
    }

    .patient-item-name {
      font-weight: 800;
      margin-bottom: 4px;
    }

    .patient-item-meta {
      color: var(--muted);
      font-size: 14px;
    }

    .patient-item-price {
      font-weight: 900;
      margin-top: 4px;
    }

    .patient-total {
      background: var(--accent);
      color: white;
      border-radius: 20px;
      padding: 18px;
      margin-top: 16px;
    }

    .patient-total-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }

    .patient-total-final {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.25);
      font-size: 28px;
      font-weight: 900;
    }


    @media (max-width: 920px) {
      .layout {
        grid-template-columns: 1fr;
      }

      .sidebar {
        position: static;
      }

      .deal-grid {
        grid-template-columns: 1fr;
      }

      .item-controls {
        grid-template-columns: 1fr 1fr;
      }

      .topbar {
        flex-direction: column;
      }
    }
  </style>
</head>

<body>
  <main class="page">
    <header class="topbar">
      <div class="brand">
        <div class="brand-title">TEMED · План лечения</div>
        <div class="brand-subtitle">Внутренняя страница менеджера для подготовки предложения пациенту</div>
      </div>

      <div class="status-pill" id="proposalStatus">
        Загрузка сделки...
      </div>
    </header>

    <section class="layout">
      <div>
        <div class="card">
          <h2 class="section-title">Сделка</h2>

          <div class="deal-grid">
            <div class="field">
              <div class="field-label">Сделка Bitrix</div>
              <div class="field-value" id="dealIdView">—</div>
            </div>

            <div class="field">
              <div class="field-label">Пациент</div>
              <div class="field-value" id="patientNameView">—</div>
            </div>

            <div class="field">
              <div class="field-label">Код пациента</div>
              <div class="field-value" id="patientCodeView">—</div>
            </div>


            <div class="field">
              <div class="field-label">Ответственный</div>
              <div class="field-value" id="assignedByView">—</div>
            </div>

            <div class="field">
              <div class="field-label">Срок действия</div>
              <div class="field-value" id="validUntilLabel">Не задан</div>
            </div>
          </div>

          <div class="status-box is-visible" id="loadStatus">Загрузка...</div>
        </div>

        <div class="card">
          <h2 class="section-title">Назначения</h2>

          <div class="items" id="items"></div>

          <div class="warning" id="manualWarning">
            Скидки по строкам изменены вручную. Итоговая сумма пересчитана по строкам.
          </div>
        </div>

        <div class="card">
          <h2 class="section-title">Комментарий для 1С и таймлайна Bitrix</h2>
          <div class="output" id="commentOutput">Нажмите «Рассчитать», чтобы сформировать комментарий.</div>

          <div class="buttons">
            <button class="btn-secondary" type="button" onclick="copyComment()">Скопировать комментарий</button>
          </div>
        </div>
      </div>

      <aside class="sidebar">
        <div class="card">
          <h2 class="section-title">Скидка</h2>

          <div class="discount-box">
            <div>
              <label>Тип общей скидки</label>
              <div class="radio-row">
                <label class="radio-card">
                  <input type="radio" name="discountType" value="percent" checked>
                  Процент
                </label>

                <label class="radio-card">
                  <input type="radio" name="discountType" value="rub">
                  Рубли
                </label>
              </div>
            </div>

            <div>
              <label for="discountValue">Размер скидки</label>
              <input id="discountValue" type="number" min="0" value="10">
            </div>

            <div>
              <label for="validUntil">Действует до</label>
              <input id="validUntil" type="date">
            </div>

            <button class="btn-primary" type="button" onclick="calculateGlobalDiscount()">Рассчитать</button>

            <div class="note">
              Общая скидка распределяется пропорционально стоимости включенных позиций.
              После расчета скидки можно вручную поправить по строкам.
            </div>
          </div>
        </div>

        <div class="card">
          <h2 class="section-title">Итог</h2>

          <div class="summary">
            <div class="summary-row">
              <div class="summary-label">Сумма включенных позиций</div>
              <div class="summary-value" id="subtotal">0 ₽</div>
            </div>

            <div class="summary-row">
              <div class="summary-label">Скидка</div>
              <div class="summary-value" id="discountTotal">0 ₽</div>
            </div>

            <div class="summary-row">
              <div class="summary-label">Исключено позиций</div>
              <div class="summary-value" id="excludedCount">0</div>
            </div>
          </div>

          <div class="total">
            <div class="total-label">Итого к оплате</div>
            <div class="total-value" id="grandTotal">0 ₽</div>
          </div>

          <div class="buttons">
            <button class="btn-primary" type="button" onclick="preparePatientPlan()">Подготовить план</button>
            <button class="btn-secondary" type="button" onclick="downloadPatientPng()">Сформировать PNG</button>
            <button class="btn-secondary" type="button" onclick="downloadPatientPdf()">Сформировать PDF</button>
            <button class="btn-outline" type="button" id="createQuoteButton" onclick="createQuote()">Создать предложение в Bitrix</button>
          </div>

          <div class="status-box" id="quoteStatus"></div>
        </div>
      </aside>
    </section>

    <section class="patient-output" id="patientOutput">
      <div class="mobile-sheet-wrap">
        <article class="mobile-sheet" id="patientMobileSheet">
          <div class="patient-logo">TEMED</div>

          <div class="patient-title">План лечения</div>

          <div class="patient-lead" id="patientLeadMobile">
            Для вас подготовлен индивидуальный план лечения.
          </div>

          <div class="patient-info">

            <div class="patient-info-row">
              <div class="patient-info-label">Предложение действительно до</div>
              <div class="patient-info-value" id="patientValidUntilMobile">—</div>
            </div>
          </div>

          <h3>В план включено</h3>

          <div class="patient-list" id="patientItemsMobile"></div>

          <div class="patient-total">
            <div class="patient-total-row">
              <span>Без скидки</span>
              <strong id="patientSubtotalMobile">0 ₽</strong>
            </div>

            <div class="patient-total-row">
              <span>Скидка</span>
              <strong id="patientDiscountMobile">0 ₽</strong>
            </div>

            <div class="patient-total-final" id="patientGrandTotalMobile">
              0 ₽
            </div>
          </div>

          <p class="note">
            Состав процедур и график посещений могут уточняться с врачом и администратором.
          </p>
        </article>
      </div>
    </section>

  </main>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>

  <script>
    const DEAL_ID = <?= json_encode($dealId, JSON_UNESCAPED_UNICODE) ?>;

    const deal = {
      id: DEAL_ID || '',
      patientFullName: '',
      patientShortName: '',
      patientCode: '',
      assignedBy: ''
    };

    let items = [];

    function money(value) {
      return Math.round(Number(value) || 0).toLocaleString('ru-RU') + ' ₽';
    }

    function parseNumber(value) {
      const number = Number(String(value || '').replace(',', '.'));
      return Number.isFinite(number) ? number : 0;
    }

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function setStatus(id, text, type = '') {
      const el = document.getElementById(id);
      if (!el) return;

      el.textContent = text || '';
      el.className = 'status-box' + (text ? ' is-visible' : '') + (type ? ' ' + type : '');
    }

    function itemBaseSum(item) {
      return item.qty * item.unitPrice;
    }

    function itemFinalSum(item) {
      if (!item.included) {
        return 0;
      }

      return Math.max(0, itemBaseSum(item) - item.discountRub);
    }

    function getValidUntilText() {
      const value = document.getElementById('validUntil').value;

      if (!value) {
        return 'Не задан';
      }

      const parts = value.split('-');

      if (parts.length !== 3) {
        return value;
      }

      const [year, month, day] = parts;
      return `${day}.${month}.${year}`;
    }

    function formatDateRu_(value) {
      if (!value) return '';

      const date = new Date(value + 'T00:00:00');

      if (isNaN(date.getTime())) {
        return value;
      }

      return date.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    }

    function getFirstNamePatronymic_(fullName) {
      const parts = String(fullName || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      if (parts.length >= 3) {
        return parts[1] + ' ' + parts[2];
      }

      if (parts.length === 2) {
        return parts[1];
      }

      if (parts.length === 1) {
        return parts[0];
      }

      return '';
    }

    async function loadDeal() {
      document.getElementById('dealIdView').textContent = DEAL_ID ? '#' + DEAL_ID : 'не передан';

      if (!DEAL_ID) {
        setStatus('loadStatus', 'deal_id не передан в ссылке', 'is-error');
        document.getElementById('proposalStatus').textContent = 'Ошибка загрузки';
        return;
      }

      try {
        const response = await fetch('?action=load_deal&deal_id=' + encodeURIComponent(DEAL_ID), {
          method: 'GET',
          credentials: 'same-origin'
        });

        const data = await response.json();

        if (!data.ok) {
          throw new Error(data.error || 'Ошибка загрузки сделки');
        }

        const bitrixDeal = data.deal || {};
        const plan = data.plan || {};
        const planItems = Array.isArray(plan.items) ? plan.items : [];

        deal.id = String(data.deal_id || DEAL_ID);
        deal.patientFullName = String(bitrixDeal.patient_name || '');
        deal.patientShortName = getFirstNamePatronymic_(deal.patientFullName);
        deal.patientCode = String(plan.patient_code || '');
        deal.assignedBy = String(bitrixDeal.assigned_by_id || '');

        items = planItems.map((item, index) => {
          const qty = Number(item.qty) || 1;
          const unitPrice = Number(item.unit_price) || 0;
          const name = String(item.display_name || item.source_name || '');

          return {
            id: index + 1,
            name,
            description: String(item.service_class || ''),
            qty,
            unitPrice,
            included: true,
            discountRub: 0,
            manual: false
          };
        });

        document.getElementById('patientNameView').textContent = deal.patientFullName || '—';
        document.getElementById('patientCodeView').textContent = deal.patientCode || '—';
        document.getElementById('assignedByView').textContent = deal.assignedBy || '—';

        setDefaultValidUntil();

        renderItems();
        calculateGlobalDiscount();

        if (items.length === 0) {
          setStatus('loadStatus', 'Сделка загружена, но Plan Items JSON пустой или не распознан', 'is-error');
          document.getElementById('proposalStatus').textContent = 'Нет назначений';
        } else {
          setStatus('loadStatus', 'Сделка загружена', 'is-ok');
          document.getElementById('proposalStatus').textContent = 'Предложение еще не создано';
        }
      } catch (error) {
        setStatus('loadStatus', error.message || String(error), 'is-error');
        document.getElementById('proposalStatus').textContent = 'Ошибка загрузки';
      }
    }

    function renderItems() {
      const root = document.getElementById('items');

      if (!items.length) {
        root.innerHTML = '<div class="note">Нет позиций для расчета.</div>';
        updateSummary();
        return;
      }

      root.innerHTML = items.map(item => {
        const base = itemBaseSum(item);
        const discountPercent = base > 0 ? Math.round((item.discountRub / base) * 1000) / 10 : 0;

        return `
          <div class="item ${item.included ? '' : 'is-disabled'}" data-id="${item.id}">
            <div class="item-head">
              <input
                type="checkbox"
                ${item.included ? 'checked' : ''}
                onchange="toggleItem(${item.id}, this.checked)"
              >

              <div>
                <div class="item-title">${escapeHtml(item.name)}</div>
                <div class="item-meta">${escapeHtml(item.description)} · Кол-во: ${item.qty} · Цена за ед.: ${money(item.unitPrice)}</div>
              </div>

              <div class="item-sum">${money(itemFinalSum(item))}</div>
            </div>

            <div class="item-controls">
              <div>
                <label>Сумма</label>
                <input value="${money(base)}" disabled>
              </div>

              <div>
                <label>Скидка ₽</label>
                <input
                  type="number"
                  min="0"
                  value="${Math.round(item.discountRub)}"
                  ${item.included ? '' : 'disabled'}
                  onchange="setItemDiscountRub(${item.id}, this.value)"
                >
              </div>

              <div>
                <label>Скидка %</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value="${discountPercent}"
                  ${item.included ? '' : 'disabled'}
                  onchange="setItemDiscountPercent(${item.id}, this.value)"
                >
              </div>

              <div>
                <label>Итого</label>
                <input value="${money(itemFinalSum(item))}" disabled>
              </div>
            </div>
          </div>
        `;
      }).join('');

      updateSummary();
    }

    function toggleItem(id, checked) {
      const item = items.find(x => x.id === id);
      if (!item) return;

      item.included = checked;

      if (!checked) {
        item.discountRub = 0;
        item.manual = false;
      }

      renderItems();
      buildComment();
    }

    function setItemDiscountRub(id, value) {
      const item = items.find(x => x.id === id);
      if (!item) return;

      const base = itemBaseSum(item);

      item.discountRub = Math.min(base, Math.max(0, parseNumber(value)));
      item.manual = true;

      renderItems();
      buildComment();
    }

    function setItemDiscountPercent(id, value) {
      const item = items.find(x => x.id === id);
      if (!item) return;

      const base = itemBaseSum(item);
      const percent = Math.min(100, Math.max(0, parseNumber(value)));

      item.discountRub = Math.round(base * percent / 100);
      item.manual = true;

      renderItems();
      buildComment();
    }

    function calculateGlobalDiscount() {
      const type = document.querySelector('input[name="discountType"]:checked').value;
      const value = parseNumber(document.getElementById('discountValue').value);
      const includedItems = items.filter(item => item.included);
      const subtotal = includedItems.reduce((sum, item) => sum + itemBaseSum(item), 0);

      let discountTotal = 0;

      if (type === 'percent') {
        discountTotal = Math.round(subtotal * value / 100);
      } else {
        discountTotal = Math.round(value);
      }

      discountTotal = Math.min(discountTotal, subtotal);

      let distributed = 0;

      includedItems.forEach((item, index) => {
        const base = itemBaseSum(item);

        if (index === includedItems.length - 1) {
          item.discountRub = Math.max(0, discountTotal - distributed);
        } else {
          item.discountRub = Math.round(discountTotal * base / subtotal);
          distributed += item.discountRub;
        }

        item.manual = false;
      });

      items
        .filter(item => !item.included)
        .forEach(item => {
          item.discountRub = 0;
          item.manual = false;
        });

      document.getElementById('validUntilLabel').textContent = getValidUntilText();

      renderItems();
      buildComment();
    }

    function getTotals() {
      const includedItems = items.filter(item => item.included);
      const excludedItems = items.filter(item => !item.included);
      const subtotal = includedItems.reduce((sum, item) => sum + itemBaseSum(item), 0);
      const discount = includedItems.reduce((sum, item) => sum + item.discountRub, 0);
      const total = includedItems.reduce((sum, item) => sum + itemFinalSum(item), 0);

      return {
        includedItems,
        excludedItems,
        subtotal,
        discount,
        total
      };
    }

    function updateSummary() {
      const totals = getTotals();
      const hasManual = items.some(item => item.manual);

      document.getElementById('subtotal').textContent = money(totals.subtotal);
      document.getElementById('discountTotal').textContent = money(totals.discount);
      document.getElementById('grandTotal').textContent = money(totals.total);
      document.getElementById('excludedCount').textContent = totals.excludedItems.length;
      document.getElementById('manualWarning').classList.toggle('is-visible', hasManual);
    }

    function buildComment(proposalId = '') {
      const totals = getTotals();
      const validUntil = getValidUntilText();

      const includedLines = totals.includedItems.map(item => {
        const before = money(itemBaseSum(item));
        const after = money(itemFinalSum(item));
        const discount = money(item.discountRub);

        return `- ${item.name} × ${item.qty}: ${before} → ${after}, скидка ${discount}`;
      });

      const excludedLines = totals.excludedItems.map(item => {
        return `- ${item.name} × ${item.qty}`;
      });

      const lines = [];

      lines.push('Сформировано предложение по плану лечения.');
      lines.push('');
      lines.push(`Сделка Bitrix: #${deal.id}`);

      if (proposalId) {
        lines.push(`Предложение Bitrix: #${proposalId}`);
      }

      lines.push(`Ответственный: ${deal.assignedBy || '—'}`);
      lines.push('');
      lines.push('Состав предложения:');
      lines.push(...includedLines);

      if (excludedLines.length) {
        lines.push('');
        lines.push('Исключенные позиции:');
        lines.push(...excludedLines);
      }

      lines.push('');
      lines.push(`Исходная сумма: ${money(totals.subtotal)}`);
      lines.push(`Скидка: ${money(totals.discount)}`);
      lines.push(`Итого по предложению: ${money(totals.total)}`);
      lines.push('');
      lines.push(`Предложение действительно до ${validUntil} включительно.`);

      const text = lines.join('\n');
      document.getElementById('commentOutput').textContent = text;

      return text;
    }

    function preparePatientPlan() {
      const totals = getTotals();

      if (!totals.includedItems.length) {
        alert('Нет выбранных позиций.');
        return false;
      }

      const validUntilRaw = document.getElementById('validUntil').value || '';
      const validUntilText = validUntilRaw ? formatDateRu_(validUntilRaw) : '—';

      const leadText = deal.patientShortName
        ? deal.patientShortName + ', для вас подготовлен индивидуальный план лечения.'
        : 'Для вас подготовлен индивидуальный план лечения.';

      document.getElementById('patientOutput').classList.add('is-visible');

      document.getElementById('patientLeadMobile').textContent = leadText;
      document.getElementById('patientValidUntilMobile').textContent = validUntilText;

      document.getElementById('patientItemsMobile').innerHTML = totals.includedItems.map(item => {
        return `
          <div class="patient-item">
            <div class="patient-item-name">${escapeHtml(item.name)}</div>
            <div class="patient-item-meta">${escapeHtml(item.description)} · ${item.qty} ${item.qty === 1 ? 'позиция' : 'процедур/сеансов'}</div>
            <div class="patient-item-price">${money(itemFinalSum(item))}</div>
          </div>
        `;
      }).join('');

      document.getElementById('patientSubtotalMobile').textContent = money(totals.subtotal);
      document.getElementById('patientDiscountMobile').textContent = money(totals.discount);
      document.getElementById('patientGrandTotalMobile').textContent = money(totals.total);

      buildComment();

      return true;
    }

    async function downloadPatientPng() {
      if (!preparePatientPlan()) {
        return;
      }

      const node = document.getElementById('patientMobileSheet');

      try {
        const canvas = await html2canvas(node, {
          scale: 2,
          backgroundColor: '#ffffff',
          useCORS: true
        });

        const link = document.createElement('a');
        link.download = 'plan-lecheniya-mobile.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch (error) {
        alert('Не удалось сформировать PNG: ' + (error.message || error));
      }
    }

    async function downloadPatientPdf() {
      if (!preparePatientPlan()) {
        return;
      }

      try {
        const { jsPDF } = window.jspdf;

        const pdf = new jsPDF({
          orientation: 'portrait',
          unit: 'mm',
          format: 'a4'
        });

        const totals = getTotals();
        const validUntil = getValidUntilText();

        const patientLead = deal.patientShortName
          ? deal.patientShortName + ', для вас подготовлен индивидуальный план лечения.'
          : 'Для вас подготовлен индивидуальный план лечения.';

        const margin = 18;
        const pageWidth = 210;
        const pageHeight = 297;
        const contentWidth = pageWidth - margin * 2;

        let y = 20;

        pdf.setTextColor(31, 41, 51);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(16);
        pdf.text('TEMED', margin, y);

        y += 14;

        pdf.setFontSize(22);
        pdf.text('План лечения', margin, y);

        y += 10;

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(11);

        const leadLines = pdf.splitTextToSize(patientLead, contentWidth);
        pdf.text(leadLines, margin, y);
        y += leadLines.length * 6 + 6;

        pdf.setFont('helvetica', 'bold');
        pdf.text('Предложение действительно до: ' + validUntil, margin, y);

        y += 12;

        drawPdfTableHeader_(pdf, margin, y, contentWidth);
        y += 8;

        totals.includedItems.forEach(item => {
          const nameLines = pdf.splitTextToSize(item.name, 94);
          const rowHeight = Math.max(10, nameLines.length * 5 + 4);

          if (y + rowHeight > pageHeight - 38) {
            pdf.addPage();
            y = 20;
            drawPdfTableHeader_(pdf, margin, y, contentWidth);
            y += 8;
          }

          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
          pdf.setTextColor(31, 41, 51);

          pdf.text(nameLines, margin, y + 5);
          pdf.text(String(item.qty), margin + 100, y + 5);
          pdf.text(moneyPlain_(item.unitPrice), margin + 122, y + 5);
          pdf.text(moneyPlain_(itemFinalSum(item)), margin + 158, y + 5);

          pdf.setDrawColor(225, 225, 225);
          pdf.line(margin, y + rowHeight, pageWidth - margin, y + rowHeight);

          y += rowHeight;
        });

        y += 10;

        if (y > pageHeight - 55) {
          pdf.addPage();
          y = 20;
        }

        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(31, 41, 51);

        pdf.text('Стоимость без скидки:', margin + 92, y);
        pdf.text(moneyPlain_(totals.subtotal), margin + 158, y);

        y += 7;

        pdf.text('Скидка:', margin + 92, y);
        pdf.text(moneyPlain_(totals.discount), margin + 158, y);

        y += 9;

        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(13);
        pdf.text('Итого к оплате:', margin + 92, y);
        pdf.text(moneyPlain_(totals.total), margin + 158, y);

        y += 18;

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(105, 117, 134);

        const note = 'Состав процедур и график посещений могут уточняться с врачом и администратором.';
        const noteLines = pdf.splitTextToSize(note, contentWidth);
        pdf.text(noteLines, margin, y);

        pdf.save('plan-lecheniya-a4.pdf');
      } catch (error) {
        alert('Не удалось сформировать PDF: ' + (error.message || error));
      }
    }

    function drawPdfTableHeader_(pdf, margin, y, contentWidth) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(31, 41, 51);

      pdf.text('Услуга', margin, y);
      pdf.text('Кол-во', margin + 100, y);
      pdf.text('Цена', margin + 122, y);
      pdf.text('Сумма', margin + 158, y);

      pdf.setDrawColor(31, 41, 51);
      pdf.line(margin, y + 3, margin + contentWidth, y + 3);
    }

    function moneyPlain_(value) {
      return Math.round(Number(value) || 0).toLocaleString('ru-RU') + ' руб.';
    }

    async function createQuote() {
      const totals = getTotals();

      if (!totals.includedItems.length) {
        alert('Нет выбранных позиций.');
        return;
      }

      const button = document.getElementById('createQuoteButton');
      button.disabled = true;
      setStatus('quoteStatus', 'Создаю предложение...', '');

      const payload = {
        deal_id: deal.id,
        valid_until: document.getElementById('validUntil').value || '',
        items: totals.includedItems.map(item => ({
          name: item.name,
          qty: item.qty,
          unit_price: item.unitPrice,
          discount: item.discountRub
        }))
      };

      try {
        const response = await fetch('?action=create_quote', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json; charset=utf-8'
          },
          body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!data.ok) {
          throw new Error(data.error || 'Неизвестная ошибка');
        }

        const result = data.result || {};
        const warnings = Array.isArray(result.warnings) && result.warnings.length
          ? '\n\nПредупреждения:\n' + result.warnings.join('\n')
          : '';

        document.getElementById('proposalStatus').textContent =
          'Предложение Bitrix #' + result.quote_id + ' · ' + money(result.final_total);

        buildComment(result.quote_id);

        setStatus(
          'quoteStatus',
          'Предложение создано. ID: ' + result.quote_id + warnings,
          'is-ok'
        );
      } catch (error) {
        setStatus('quoteStatus', 'Ошибка создания предложения: ' + (error.message || String(error)), 'is-error');
      } finally {
        button.disabled = false;
      }
    }

    function copyComment() {
      const text = document.getElementById('commentOutput').textContent;

      navigator.clipboard.writeText(text).then(() => {
        alert('Комментарий скопирован.');
      }).catch(() => {
        alert('Не удалось скопировать автоматически. Выделите текст вручную.');
      });
    }

    function setDefaultValidUntil() {
      const date = new Date();
      date.setDate(date.getDate() + 3);

      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');

      document.getElementById('validUntil').value = `${y}-${m}-${d}`;
      document.getElementById('validUntilLabel').textContent = getValidUntilText();
    }

    loadDeal();
  </script>
</body>
</html>
<?php
die();

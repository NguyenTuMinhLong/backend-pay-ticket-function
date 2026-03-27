const crypto = require('crypto');
const config = require('../config/payment');
const HttpError = require('../utils/httpError');

const SIGNED_FIELD_ORDER = [
  'merchant',
  'operation',
  'payment_method',
  'order_amount',
  'currency',
  'order_invoice_number',
  'order_description',
  'customer_id',
  'agreement_id',
  'agreement_name',
  'agreement_type',
  'agreement_payment_frequency',
  'agreement_amount_per_payment',
  'success_url',
  'error_url',
  'cancel_url',
  'order_id',
];

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getCheckoutBaseUrl = () => {
  return config.sepay.env === 'production'
    ? 'https://pay.sepay.vn'
    : 'https://pay-sandbox.sepay.vn';
};

const signCheckoutFields = (fields) => {
  const signed = [];

  for (const field of SIGNED_FIELD_ORDER) {
    if (fields[field] === undefined || fields[field] === null || fields[field] === '') {
      continue;
    }

    signed.push(`${field}=${fields[field]}`);
  }

  return crypto
    .createHmac('sha256', config.sepay.secretKey)
    .update(signed.join('&'))
    .digest('base64');
};

const resolveReturnUrl = (providedUrl, fallbackPath, paymentCode) => {
  if (providedUrl) {
    return providedUrl;
  }

  if (!config.sepay.publicBaseUrl) {
    return undefined;
  }

  return `${config.sepay.publicBaseUrl}${fallbackPath}?payment_code=${encodeURIComponent(paymentCode)}`;
};

const createSepayCheckoutInstruction = (payment) => {
  const sepay = config.sepay;

  if (!sepay.enabled || !sepay.merchantId || !sepay.secretKey) {
    throw new HttpError(
      500,
      'SePay config is incomplete. Please set SEPAY_MERCHANT_ID and SEPAY_SECRET_KEY.'
    );
  }

  const amount = Number(payment.final_amount || payment.amount || 0);
  const paymentCode = String(payment.payment_code);
  const checkoutUrl = `${getCheckoutBaseUrl()}/v1/checkout/init`;

  const fields = {
    merchant: sepay.merchantId,
    operation: 'PURCHASE',
    payment_method: sepay.paymentMethod,
    order_amount: amount,
    currency: 'VND',
    order_invoice_number: paymentCode,
    order_description: `Thanh toan don hang ${paymentCode}`,
    customer_id: payment.booking_id ? String(payment.booking_id) : undefined,
    success_url: resolveReturnUrl(sepay.successUrl, '/payments/return/success', paymentCode),
    error_url: resolveReturnUrl(sepay.errorUrl, '/payments/return/error', paymentCode),
    cancel_url: resolveReturnUrl(sepay.cancelUrl, '/payments/return/cancel', paymentCode),
    order_id: payment.id ? String(payment.id) : undefined,
  };

  const sanitizedFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );

  const signature = signCheckoutFields(sanitizedFields);

  console.log('SEPAY FIELDS:', sanitizedFields);
  console.log('SEPAY SIGNATURE:', signature);
  console.log('SEPAY CHECKOUT URL:', checkoutUrl);

  const checkoutFormFields = {
    ...sanitizedFields,
    signature,
  };

  return {
    provider: 'SEPAY',
    payment_method: sepay.paymentMethod,
    checkout_url: checkoutUrl,
    checkout_form_fields: checkoutFormFields,
    redirect_url: config.sepay.publicBaseUrl
      ? `${config.sepay.publicBaseUrl}/payments/${encodeURIComponent(paymentCode)}/sepay/checkout`
      : null,
    ipn_url: config.sepay.ipnUrl || null,
    order_invoice_number: paymentCode,
    order_amount: amount,
    currency: 'VND',
  };
};

const buildAutoSubmitCheckoutHtml = ({ payment, checkout }) => {
  const inputs = Object.entries(checkout.checkout_form_fields || {})
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`
    )
    .join('\n');

  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting to SePay</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f7f8fb; color: #111827; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { background: #ffffff; padding: 28px; border-radius: 16px; max-width: 460px; width: calc(100% - 32px); box-shadow: 0 12px 40px rgba(15, 23, 42, 0.12); }
      h1 { font-size: 20px; margin: 0 0 10px; }
      p { line-height: 1.6; color: #475569; }
      button { margin-top: 16px; width: 100%; border: 0; border-radius: 10px; padding: 12px 16px; background: #2563eb; color: white; font-size: 16px; cursor: pointer; }
      .meta { font-size: 14px; color: #64748b; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Đang chuyển tới SePay</h1>
      <p>Đơn thanh toán <strong>${escapeHtml(payment.payment_code)}</strong> đã được tạo. Hệ thống sẽ tự động chuyển bạn tới trang thanh toán SePay.</p>
      <p class="meta">Nếu trang không tự chuyển, bấm nút bên dưới.</p>
      <form id="sepay-checkout-form" action="${escapeHtml(checkout.checkout_url)}" method="POST">
        ${inputs}
        <button type="submit">Tiếp tục thanh toán</button>
      </form>
    </div>
    <script>
      window.addEventListener('load', function () {
        const form = document.getElementById('sepay-checkout-form');
        if (form) form.submit();
      });
    </script>
  </body>
</html>`;
};

module.exports = {
  createSepayCheckoutInstruction,
  buildAutoSubmitCheckoutHtml,
};
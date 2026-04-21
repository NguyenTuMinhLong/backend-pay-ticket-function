const { PayOS } = require('@payos/node');
const config = require('../config/payment');
const HttpError = require('../utils/httpError');

let payosClient = null;

const getRequiredConfig = (name, value) => {
  if (!value) throw new HttpError(500, `${name} is not configured`);
  return value;
};

const optionalConfig = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const optionalPayosBaseUrl = (value) => {
  const normalized = optionalConfig(value);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    if (url.hostname !== 'api-merchant.payos.vn') return null;
    return url.origin;
  } catch (_) {
    return null;
  }
};

const getPayosClient = () => {
  if (!config.payos.enabled) {
    throw new HttpError(
      500,
      'payOS config is incomplete. Please set PAYOS_CLIENT_ID, PAYOS_API_KEY, and PAYOS_CHECKSUM_KEY.'
    );
  }

  if (!payosClient) {
    payosClient = new PayOS({
      clientId: getRequiredConfig('PAYOS_CLIENT_ID', config.payos.clientId),
      apiKey: getRequiredConfig('PAYOS_API_KEY', config.payos.apiKey),
      checksumKey: getRequiredConfig('PAYOS_CHECKSUM_KEY', config.payos.checksumKey),
      partnerCode: optionalConfig(config.payos.partnerCode),
      baseURL: optionalPayosBaseUrl(config.payos.baseUrl),
    });
  }

  return payosClient;
};

const resolveOrderCode = (payment) => {
  const existingOrderCode = Number(payment.gateway_response && payment.gateway_response.order_code);
  if (Number.isSafeInteger(existingOrderCode) && existingOrderCode > 0) return existingOrderCode;

  // Thử dùng payment.id nếu là số nguyên (PostgreSQL serial/bigserial)
  const byId = Number(payment.id);
  if (Number.isSafeInteger(byId) && byId > 0) return byId;

  // Nếu id là UUID → lấy phần số trong payment_code (tối đa 13 chữ số để tránh overflow)
  const paymentCode = String(payment.payment_code || '');
  const codeMatch = paymentCode.match(/^PAY-(\d{14})-([A-Fa-f0-9]{6})$/);
  if (codeMatch) {
    const datePart = codeMatch[1].slice(2);
    const suffixPart = String(Number.parseInt(codeMatch[2], 16) % 1000).padStart(3, '0');
    const byPaymentCode = Number(`${datePart}${suffixPart}`);
    if (Number.isSafeInteger(byPaymentCode) && byPaymentCode > 0) return byPaymentCode;
  }

  const digits = paymentCode.replace(/\D/g, '');
  if (digits.length > 0) {
    const trimmed = Number(digits.length > 13 ? digits.slice(0, 13) : digits);
    if (Number.isSafeInteger(trimmed) && trimmed > 0) return trimmed;
  }

  // Fallback cuối: dùng timestamp hiện tại (unique theo millisecond)
  return Date.now();
};

const resolveDescription = (paymentCode) => {
  const normalized = String(paymentCode || '')
    .trim()
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .slice(0, 25);

  return normalized || 'PAYMENT';
};

const resolveUrl = ({ providedUrl, fallbackPath, paymentCode }) => {
  if (providedUrl) {
    return providedUrl;
  }

  if (!config.payos.publicBaseUrl || !fallbackPath) {
    return '';
  }

  const separator = fallbackPath.includes('?') ? '&' : '?';
  return `${config.payos.publicBaseUrl}${fallbackPath}${separator}payment_code=${encodeURIComponent(paymentCode)}`;
};

const createPayosPaymentInstruction = async (payment) => {
  const payos = getPayosClient();
  const amount = Math.round(Number(payment.final_amount ?? payment.amount ?? 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'payOS amount is invalid');
  }

  const paymentCode = String(payment.payment_code || '').trim();
  if (!paymentCode) {
    throw new HttpError(400, 'payment.payment_code is required');
  }

  const orderCode = resolveOrderCode(payment);
  const expiresAt = payment.expires_at
    ? Math.floor(new Date(payment.expires_at).getTime() / 1000)
    : undefined;
  if (expiresAt && expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(400, 'Payment has expired. Please create a new booking and try again.');
  }

  const returnUrl = resolveUrl({
    providedUrl: config.payos.returnUrl,
    fallbackPath: '/payments/payos/return/success',
    paymentCode,
  });
  const cancelUrl = resolveUrl({
    providedUrl: config.payos.cancelUrl,
    fallbackPath: '/payments/payos/return/cancel',
    paymentCode,
  });

  if (!returnUrl || !cancelUrl) {
    throw new HttpError(
      500,
      'payOS redirect URLs are incomplete. Please set PAYMENT_PUBLIC_BASE_URL or explicit PAYOS_RETURN_URL and PAYOS_CANCEL_URL.'
    );
  }

  const response = await payos.paymentRequests.create({
    orderCode,
    amount,
    description: resolveDescription(paymentCode),
    returnUrl,
    cancelUrl,
    buyerName: payment.customer_name || undefined,
    buyerEmail: payment.contact_email || undefined,
    buyerPhone: payment.contact_phone || undefined,
    expiredAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined,
    items: [
      {
        name: `Booking ${paymentCode}`.slice(0, 25),
        quantity: 1,
        price: amount,
      },
    ],
  });

  return {
    provider: 'PAYOS',
    order_code: response.orderCode,
    payment_link_id: response.paymentLinkId,
    checkout_url: response.checkoutUrl,
    redirect_url: config.payos.publicBaseUrl
      ? `${config.payos.publicBaseUrl}/payments/${encodeURIComponent(paymentCode)}/payos/checkout`
      : response.checkoutUrl,
    webhook_url: config.payos.webhookUrl || null,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    qr_code: response.qrCode || null,
    qr_payload: response.qrCode || null,
    description: response.description || paymentCode,
    amount: response.amount,
    currency: response.currency || 'VND',
    bank_bin: response.bin || null,
    bank_account: response.accountNumber || null,
    account_name: response.accountName || null,
    status: response.status || null,
  };
};

const verifyPayosWebhookData = async (payload = {}) => {
  const payos = getPayosClient();
  return payos.webhooks.verify(payload);
};

const getPayosPaymentLink = async (orderCode) => {
  const payos = getPayosClient();
  return payos.paymentRequests.get(Number(orderCode));
};

const cancelPayosPaymentLink = async (orderCode, cancellationReason = 'Cancelled by backend') => {
  const payos = getPayosClient();
  return payos.paymentRequests.cancel(Number(orderCode), cancellationReason);
};

module.exports = {
  createPayosPaymentInstruction,
  verifyPayosWebhookData,
  getPayosPaymentLink,
  cancelPayosPaymentLink,
};

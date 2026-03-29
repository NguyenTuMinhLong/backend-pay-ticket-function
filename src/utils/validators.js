const HttpError = require('./httpError');

const requireFields = (payload, fields) => {
  for (const field of fields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      throw new HttpError(400, `${field} is required`);
    }
  }
};

const validateInitPayload = (payload) => {
  requireFields(payload, ['booking_id', 'email', 'phone', 'payment_method']);
  const method = String(payload.payment_method).toUpperCase();
  const allowed = ['MOMO', 'BANK_QR'];

  if (!allowed.includes(method)) {
    throw new HttpError(400, `payment_method must be one of: ${allowed.join(', ')}`);
  }

  return {
    ...payload,
    payment_method: method,
  };
};

const validateConfirmPayload = (payload) => {
  requireFields(payload, ['payment_code', 'success']);
  return payload;
};

const validateCancelPayload = (payload) => {
  requireFields(payload, ['payment_code']);
  return payload;
};

const validateBankWebhookPayload = (payload) => {
  requireFields(payload, ['payment_code', 'amount', 'transfer_content']);

  return {
    payment_code: String(payload.payment_code),
    amount: Number(payload.amount),
    transfer_content: String(payload.transfer_content),
    bank_transaction_id: payload.bank_transaction_id ? String(payload.bank_transaction_id) : null,
    status: String(payload.status || 'success').toLowerCase(),
    bank_name: payload.bank_name ? String(payload.bank_name) : null,
    raw_payload: payload.raw_payload || payload,
  };
};

const extractSepaySecretKey = (headers = {}) => {
  const authorization = headers.authorization || headers.Authorization || '';
  const xSecretKey = headers['x-secret-key'] || headers['X-Secret-Key'] || '';
  const xApiKey = headers['x-api-key'] || headers['X-API-Key'] || '';

  if (authorization) {
    const trimmed = String(authorization).trim();

    if (/^apikey\s+/i.test(trimmed)) {
      return trimmed.replace(/^apikey\s+/i, '').trim();
    }

    if (/^bearer\s+/i.test(trimmed)) {
      return trimmed.replace(/^bearer\s+/i, '').trim();
    }

    return trimmed;
  }

  if (xSecretKey) return String(xSecretKey).trim();
  if (xApiKey) return String(xApiKey).trim();

  return null;
};

const validateSepayIpnPayload = (payload, headers = {}) => {
  requireFields(payload, ['notification_type', 'order']);
  requireFields(payload.order || {}, ['order_invoice_number']);

  return {
    notification_type: String(payload.notification_type).toUpperCase(),
    secret_key: extractSepaySecretKey(headers),
    timestamp: payload.timestamp ? Number(payload.timestamp) : null,
    order: payload.order,
    transaction: payload.transaction || null,
    customer: payload.customer || null,
    raw_payload: payload,
  };
};

const validateMomoIpnPayload = (payload) => {
  requireFields(payload, [
    'partnerCode',
    'orderId',
    'requestId',
    'amount',
    'orderInfo',
    'orderType',
    'transId',
    'resultCode',
    'message',
    'payType',
    'responseTime',
    'extraData',
    'signature',
  ]);

  return payload;
};

module.exports = {
  validateInitPayload,
  validateConfirmPayload,
  validateCancelPayload,
  validateBankWebhookPayload,
  validateSepayIpnPayload,
  validateMomoIpnPayload,
};

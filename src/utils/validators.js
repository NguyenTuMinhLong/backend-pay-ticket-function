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
  const method  = String(payload.payment_method).toUpperCase();
  const allowed = ['MOMO', 'BANK_QR', 'PAYPAL'];

  if (!allowed.includes(method)) {
    throw new HttpError(400, `payment_method must be one of: ${allowed.join(', ')}`);
  }

  return { ...payload, payment_method: method };
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
    payment_code:        String(payload.payment_code),
    amount:              Number(payload.amount),
    transfer_content:    String(payload.transfer_content),
    bank_transaction_id: payload.bank_transaction_id ? String(payload.bank_transaction_id) : null,
    status:              String(payload.status || 'success').toLowerCase(),
    bank_name:           payload.bank_name ? String(payload.bank_name) : null,
    raw_payload:         payload.raw_payload || payload,
  };
};

const validatePayosWebhookPayload = (payload = {}) => payload;

// FIX: MoMo IPN/Return không cần validate chặt
// Signature verification xảy ra bên trong payment.service
const validateMomoIpnPayload = (body = {}) => body;

module.exports = {
  validateInitPayload,
  validateConfirmPayload,
  validateCancelPayload,
  validateBankWebhookPayload,
  validatePayosWebhookPayload,
  validateMomoIpnPayload,
};

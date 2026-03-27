const parseIntSafe = (value, fallback = null) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const trimSlash = (value = '') => String(value || '').replace(/\/+$/, '');

const paymentConfig = {
  bankQr: {
    enabled: process.env.BANK_QR_ENABLED !== 'false',
    bankCode: process.env.BANK_QR_BANK_CODE || 'ICB',
    bankName: process.env.BANK_QR_BANK_NAME || 'VietinBank',
    bin: process.env.BANK_QR_BANK_BIN || process.env.BANK_QR_BANK_CODE || '970415',
    accountNumber: process.env.BANK_QR_ACCOUNT_NUMBER || '',
    accountName: process.env.BANK_QR_ACCOUNT_NAME || '',
    template: process.env.BANK_QR_TEMPLATE || 'compact2',
  },
  sepay: {
    enabled: process.env.SEPAY_ENABLED !== 'false' && Boolean(process.env.SEPAY_MERCHANT_ID && process.env.SEPAY_SECRET_KEY),
    env: process.env.SEPAY_ENV === 'production' ? 'production' : 'sandbox',
    merchantId: process.env.SEPAY_MERCHANT_ID || '',
    secretKey: process.env.SEPAY_SECRET_KEY || '',
    checkoutVersion: process.env.SEPAY_CHECKOUT_VERSION || 'v1',
    paymentMethod: process.env.SEPAY_PAYMENT_METHOD || 'BANK_TRANSFER',
    successUrl: process.env.SEPAY_SUCCESS_URL || '',
    errorUrl: process.env.SEPAY_ERROR_URL || '',
    cancelUrl: process.env.SEPAY_CANCEL_URL || '',
    publicBaseUrl: trimSlash(process.env.PAYMENT_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || ''),
    ipnPath: process.env.SEPAY_IPN_PATH || '/payments/sepay/ipn',
  },
  payment: {
    expiresInMinutes: parseIntSafe(process.env.PAYMENT_EXPIRES_IN_MINUTES, 15),
  },
  email: {
    enabled: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || '',
    testOverride: process.env.EMAIL_TEST || '',
  },
};

paymentConfig.sepay.ipnUrl = paymentConfig.sepay.publicBaseUrl
  ? `${paymentConfig.sepay.publicBaseUrl}${paymentConfig.sepay.ipnPath}`
  : '';

module.exports = paymentConfig;

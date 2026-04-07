const config = require('../config/payment');
const HttpError = require('../utils/httpError');

let accessTokenCache = {
  token: '',
  expiresAt: 0,
};

const ZERO_DECIMAL_CURRENCIES = new Set(['HUF', 'JPY', 'TWD', 'VND']);

const getRequiredConfig = (name, value) => {
  if (!value) throw new HttpError(500, `${name} is not configured`);
  return value;
};

const getBaseUrl = () =>
  config.paypal.env === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const getFrontendResultBaseUrl = () =>
  config.paypal.frontendUrl
    ? `${config.paypal.frontendUrl}/payment/paypal/result`
    : null;

const normalizeAmount = (amount) => {
  const numericAmount = Number(amount || 0);
  const rate = Number(config.paypal.convertRate || 1);
  const currency = String(config.paypal.currency || 'VND').toUpperCase();

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new HttpError(400, 'PayPal amount is invalid');
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new HttpError(500, 'PAYPAL_CONVERT_RATE is invalid');
  }

  const converted = numericAmount * rate;

  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return String(Math.round(converted));
  }

  return converted.toFixed(2);
};

const parseJsonSafe = async (response) => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new HttpError(502, 'Invalid JSON response from PayPal');
  }
};

const getAccessToken = async () => {
  if (accessTokenCache.token && accessTokenCache.expiresAt > Date.now() + 30000) {
    return accessTokenCache.token;
  }

  const clientId = getRequiredConfig('PAYPAL_CLIENT_ID', config.paypal.clientId);
  const clientSecret = getRequiredConfig('PAYPAL_CLIENT_SECRET', config.paypal.clientSecret);

  const response = await fetch(`${getBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const payload = await parseJsonSafe(response);

  if (!response.ok || !payload.access_token) {
    throw new HttpError(
      response.status || 502,
      payload.error_description || payload.error || 'Cannot authenticate with PayPal',
      { provider_response: payload }
    );
  }

  accessTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in || 0) * 1000),
  };

  return accessTokenCache.token;
};

const paypalRequest = async ({ method, path, body }) => {
  const accessToken = await getAccessToken();
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await parseJsonSafe(response);

  if (!response.ok) {
    throw new HttpError(
      response.status || 502,
      payload.message || payload.error_description || 'PayPal request failed',
      { provider_response: payload }
    );
  }

  return payload;
};

const resolvePublicUrl = ({ providedUrl, fallbackPath, paymentCode }) => {
  if (providedUrl) {
    return providedUrl;
  }

  if (!config.paypal.publicBaseUrl || !fallbackPath) {
    return '';
  }

  const separator = fallbackPath.includes('?') ? '&' : '?';
  return `${config.paypal.publicBaseUrl}${fallbackPath}${separator}payment_code=${encodeURIComponent(paymentCode)}`;
};

const buildReturnUrl = (paymentCode) =>
  resolvePublicUrl({
    providedUrl: config.paypal.returnUrl,
    fallbackPath: config.paypal.returnPath,
    paymentCode,
  });

const buildCancelUrl = (paymentCode) =>
  resolvePublicUrl({
    providedUrl: config.paypal.cancelUrl,
    fallbackPath: config.paypal.cancelPath,
    paymentCode,
  });

const findLink = (links = [], rel) => {
  const match = Array.isArray(links)
    ? links.find((item) => String(item.rel || '').toLowerCase() === rel.toLowerCase())
    : null;
  return match && match.href ? match.href : null;
};

const createPayPalOrder = async (payment) => {
  if (!config.paypal.enabled) {
    throw new HttpError(
      500,
      'PayPal config is incomplete. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.'
    );
  }

  const paymentCode = String(payment.payment_code || '').trim();
  if (!paymentCode) {
    throw new HttpError(400, 'payment.payment_code is required');
  }

  const returnUrl = buildReturnUrl(paymentCode);
  const cancelUrl = buildCancelUrl(paymentCode);

  if (!returnUrl || !cancelUrl) {
    throw new HttpError(
      500,
      'PayPal redirect URLs are incomplete. Please set PAYMENT_PUBLIC_BASE_URL or explicit PAYPAL_RETURN_URL and PAYPAL_CANCEL_URL.'
    );
  }

  const amountValue = normalizeAmount(payment.final_amount || payment.amount || 0);
  const currency = String(config.paypal.currency || 'VND').toUpperCase();

  const response = await paypalRequest({
    method: 'POST',
    path: '/v2/checkout/orders',
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: paymentCode,
          invoice_id: `${paymentCode}-${Date.now()}`.slice(0, 127),
          description: `Booking ${paymentCode}`.slice(0, 127),
          amount: {
            currency_code: currency,
            value: amountValue,
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: config.paypal.brandName || 'Vivudee',
            user_action: 'PAY_NOW',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    },
  });

  const approveUrl = findLink(response.links, 'approve') || findLink(response.links, 'payer-action');

  if (!approveUrl) {
    throw new HttpError(502, 'PayPal order was created but approve URL is missing', {
      provider_response: response,
    });
  }

  return {
    provider: 'PAYPAL',
    order_id: response.id,
    status: response.status || null,
    approve_url: approveUrl,
    redirect_url: config.paypal.publicBaseUrl
      ? `${config.paypal.publicBaseUrl}/payments/${encodeURIComponent(paymentCode)}/paypal/checkout`
      : approveUrl,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    currency_code: currency,
    amount: amountValue,
    environment: config.paypal.env,
  };
};

const capturePayPalOrder = async (orderId) => {
  if (!orderId) throw new HttpError(400, 'PayPal order ID is required');

  return paypalRequest({
    method: 'POST',
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    body: {},
  });
};

module.exports = {
  createPayPalOrder,
  capturePayPalOrder,
  getFrontendResultBaseUrl,
};

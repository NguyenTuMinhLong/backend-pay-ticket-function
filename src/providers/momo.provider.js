const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const config = require('../config/payment');
const HttpError = require('../utils/httpError');

const getEnv = (name, value) => {
  if (!value) {
    throw new HttpError(500, `${name} is not configured`);
  }
  return value;
};

const sign = (rawSignature) => {
  const secretKey = getEnv('MOMO_SECRET_KEY', config.momo.secretKey);
  return crypto.createHmac('sha256', secretKey).update(rawSignature).digest('hex');
};

const normalizeAmount = (amount) => {
  const numericAmount = Number(amount || 0);
  const rate = Number(config.momo.convertRate || 1);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new HttpError(500, 'MOMO_CONVERT_RATE is invalid');
  }

  const converted = Math.round(numericAmount * rate);
  if (!Number.isFinite(converted) || converted <= 0) {
    throw new HttpError(400, 'MoMo amount is invalid');
  }

  return converted;
};

const requestJson = (targetUrl, payload) =>
  new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const data = JSON.stringify(payload);

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 30000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
              return;
            }

            reject(
              new HttpError(
                res.statusCode || 502,
                parsed.message || `MoMo request failed with status ${res.statusCode}`,
                { provider_response: parsed }
              )
            );
          } catch (error) {
            reject(new HttpError(502, 'Invalid JSON response from MoMo'));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('MoMo request timeout'));
    });

    req.on('error', (error) => {
      reject(new HttpError(502, error.message || 'Cannot connect to MoMo'));
    });

    req.write(data);
    req.end();
  });

const decodeExtraData = (extraData) => {
  if (!extraData) return {};
  try {
    const decoded = Buffer.from(String(extraData), 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (error) {
    return {};
  }
};

const createMomoPaymentInstruction = async (payment) => {
  if (!config.momo.enabled) {
    throw new HttpError(500, 'MoMo config is incomplete or disabled');
  }

  const partnerCode = getEnv('MOMO_PARTNER_CODE', config.momo.partnerCode);
  const accessKey = getEnv('MOMO_ACCESS_KEY', config.momo.accessKey);
  const endpoint = getEnv('MOMO_ENDPOINT', config.momo.endpoint);
  const redirectUrl = getEnv('MOMO_REDIRECT_URL', config.momo.redirectUrl);
  const ipnUrl = getEnv('MOMO_IPN_URL', config.momo.ipnUrl);
  const requestType = config.momo.requestType || 'captureWallet';
  const lang = config.momo.lang || 'vi';

  const amount = normalizeAmount(payment.final_amount || payment.amount || 0);
  const orderId = String(payment.payment_code);
  const requestId = `REQ_${orderId}_${Date.now()}`;
  const orderInfo = `Thanh toan don hang ${orderId}`;
  const extraData = Buffer.from(
    JSON.stringify({
      payment_code: payment.payment_code,
      booking_id: payment.booking_id,
    })
  ).toString('base64');

  const rawSignature =
    `accessKey=${accessKey}` +
    `&amount=${amount}` +
    `&extraData=${extraData}` +
    `&ipnUrl=${ipnUrl}` +
    `&orderId=${orderId}` +
    `&orderInfo=${orderInfo}` +
    `&partnerCode=${partnerCode}` +
    `&redirectUrl=${redirectUrl}` +
    `&requestId=${requestId}` +
    `&requestType=${requestType}`;

  const signature = sign(rawSignature);

  const payload = {
    partnerCode,
    accessKey,
    requestId,
    amount,
    orderId,
    orderInfo,
    redirectUrl,
    ipnUrl,
    extraData,
    requestType,
    signature,
    lang,
  };

  const response = await requestJson(endpoint, payload);

  if (Number(response.resultCode) !== 0) {
    throw new HttpError(400, response.message || 'MoMo create payment failed', {
      provider_response: response,
    });
  }

  return {
    provider: 'MOMO',
    request_id: requestId,
    order_id: orderId,
    amount,
    order_info: orderInfo,
    request_type: requestType,
    pay_url: response.payUrl || null,
    deeplink: response.deeplink || response.deeplinkMiniApp || null,
    qr_payload: response.qrCodeUrl || response.payUrl || null,
    qr_code_url: response.qrCodeUrl || null,
    extra_data: extraData,
    raw_response: response,
  };
};

const verifyMomoCallbackSignature = (body = {}) => {
  if (!body.signature) return false;

  const accessKey = getEnv('MOMO_ACCESS_KEY', config.momo.accessKey);

  const rawSignature =
    `accessKey=${accessKey}` +
    `&amount=${body.amount}` +
    `&extraData=${body.extraData || ''}` +
    `&message=${body.message}` +
    `&orderId=${body.orderId}` +
    `&orderInfo=${body.orderInfo}` +
    `&orderType=${body.orderType || ''}` +
    `&partnerCode=${body.partnerCode}` +
    `&payType=${body.payType || ''}` +
    `&requestId=${body.requestId}` +
    `&responseTime=${body.responseTime}` +
    `&resultCode=${body.resultCode}` +
    `&transId=${body.transId || ''}`;

  const expected = sign(rawSignature);
  return expected === body.signature;
};

const inferPaymentCode = (body = {}) => {
  if (body.orderId) return String(body.orderId);
  const extra = decodeExtraData(body.extraData);
  if (extra.payment_code) return String(extra.payment_code);
  return '';
};

const isMomoCancelResult = (resultCode, message = '') => {
  const code = Number(resultCode);
  if ([1003, 1005, 1006, 1007, 1017].includes(code)) {
    return true;
  }

  return /cancel/i.test(String(message || ''));
};

module.exports = {
  createMomoPaymentInstruction,
  verifyMomoCallbackSignature,
  inferPaymentCode,
  normalizeAmount,
  decodeExtraData,
  isMomoCancelResult,
};

const paymentService = require('../services/payment.service');
const {
  validateInitPayload,
  validateConfirmPayload,
  validateCancelPayload,
  validateBankWebhookPayload,
  validateSepayIpnPayload,
  validateMomoIpnPayload,
} = require('../utils/validators');

const initPayment = async (req, res, next) => {
  try {
    const result = await paymentService.initPayment(validateInitPayload(req.body));
    res.json({ success: true, payment: result });
  } catch (error) {
    next(error);
  }
};

const getPaymentByCode = async (req, res, next) => {
  try {
    const result = await paymentService.getPaymentByCode(req.params.paymentCode);
    res.json({ success: true, payment: result });
  } catch (error) {
    next(error);
  }
};

const confirmPayment = async (req, res, next) => {
  try {
    const result = await paymentService.confirmPayment(validateConfirmPayload(req.body));
    res.json({ success: true, payment: result });
  } catch (error) {
    next(error);
  }
};

const cancelPayment = async (req, res, next) => {
  try {
    const result = await paymentService.cancelPayment(validateCancelPayload(req.body));
    res.json({ success: true, payment: result });
  } catch (error) {
    next(error);
  }
};

const handleBankWebhook = async (req, res, next) => {
  try {
    const result = await paymentService.handleBankWebhook(validateBankWebhookPayload(req.body));
    res.json({ success: true, payment: result });
  } catch (error) {
    next(error);
  }
};

const handleSepayIpn = async (req, res, next) => {
  try {
    const result = await paymentService.handleSepayIpn(
      validateSepayIpnPayload(req.body, req.headers)
    );
    res.status(200).json({ success: true, payment: result });
  } catch (error) {
    next(error);
  }
};

// FIX: MoMo IPN — MoMo gọi server-to-server về đây sau khi user thanh toán
// Phải trả HTTP 200 + { resultCode: 0 } để MoMo biết đã nhận
const handleMomoIpn = async (req, res, next) => {
  try {
    const result = await paymentService.handleMomoIpn(
      validateMomoIpnPayload(req.body || {})
    );
    res.status(200).json(result);
  } catch (error) {
    // Luôn trả 200 cho MoMo IPN dù có lỗi, tránh MoMo retry vô tận
    res.status(200).json({ resultCode: 99, message: error?.message || 'Internal error' });
  }
};

// FIX: MoMo Return — MoMo redirect user về đây sau khi thanh toán
// Sau đó redirect tiếp về FRONTEND /payment/momo/result?status=...
const handleMomoReturn = async (req, res, next) => {
  try {
    const result = await paymentService.handleMomoReturn(req.query || {});

    if (result.redirect) {
      return res.redirect(302, result.redirect);
    }

    // Fallback HTML nếu không cấu hình FRONTEND_URL
    const statusLabel = {
      success: '✅ Thanh toán thành công',
      cancel:  '⚠️ Đã hủy thanh toán',
      error:   '❌ Thanh toán thất bại',
    };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${statusLabel[result.status] || 'Kết quả thanh toán'}</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f8fafc; display: flex;
           align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { width: calc(100% - 32px); max-width: 480px; background: #fff;
            border-radius: 16px; box-shadow: 0 16px 40px rgba(0,0,0,.12); padding: 32px; text-align: center; }
    h2 { margin: 0 0 12px; font-size: 22px; }
    p  { color: #475569; line-height: 1.6; margin: 8px 0; }
    .code { font-weight: 700; color: #1d4ed8; font-size: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${statusLabel[result.status] || 'Kết quả thanh toán'}</h2>
    ${result.booking_code ? `<p>Mã booking: <span class="code">${result.booking_code}</span></p>` : ''}
    ${result.payment_code ? `<p>Mã thanh toán: <span class="code">${result.payment_code}</span></p>` : ''}
    <p style="margin-top:20px;font-size:13px;color:#94a3b8">
      Vui lòng quay lại ứng dụng để kiểm tra đơn hàng.
    </p>
  </div>
</body>
</html>`);
  } catch (error) {
    next(error);
  }
};

const redirectToSepayCheckout = async (req, res, next) => {
  try {
    const html = await paymentService.buildSepayCheckoutHtml(req.params.paymentCode);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    next(error);
  }
};

const renderPaymentReturnPage = async (req, res) => {
  const status      = String(req.params.status || 'success').toLowerCase();
  const paymentCode = String(req.query.payment_code || '').trim();

  const titleMap = {
    success: 'Thanh toán thành công',
    error:   'Thanh toán lỗi',
    cancel:  'Bạn đã hủy thanh toán',
  };
  const messageMap = {
    success: 'Bạn có thể quay lại ứng dụng để kiểm tra trạng thái đơn hàng.',
    error:   'Vui lòng thử lại hoặc chọn phương thức thanh toán khác.',
    cancel:  'Đơn thanh toán vẫn ở trạng thái chờ cho tới khi hết hạn hoặc bạn tạo lại giao dịch mới.',
  };

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${titleMap[status] || 'Payment result'}</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a;
             display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { width: calc(100% - 32px); max-width: 480px; background: white;
              border-radius: 16px; box-shadow: 0 16px 40px rgba(15,23,42,.12); padding: 28px; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p  { color: #475569; line-height: 1.6; }
      .code { font-weight: 700; color: #1d4ed8; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${titleMap[status] || 'Kết quả thanh toán'}</h1>
      <p>${messageMap[status] || 'Vui lòng quay lại ứng dụng để kiểm tra đơn hàng.'}</p>
      ${paymentCode ? `<p>Mã thanh toán: <span class="code">${paymentCode}</span></p>` : ''}
    </div>
  </body>
</html>`);
};

module.exports = {
  initPayment,
  getPaymentByCode,
  confirmPayment,
  cancelPayment,
  handleBankWebhook,
  handleSepayIpn,
  handleMomoIpn,
  handleMomoReturn,
  redirectToSepayCheckout,
  renderPaymentReturnPage,
};

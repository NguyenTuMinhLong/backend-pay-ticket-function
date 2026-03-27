const paymentService = require('../services/payment.service');
const {
  validateInitPayload,
  validateConfirmPayload,
  validateCancelPayload,
  validateBankWebhookPayload,
  validateSepayIpnPayload,
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
    const result = await paymentService.handleBankWebhook(
      validateBankWebhookPayload(req.body)
    );
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
  const status = String(req.params.status || 'success').toLowerCase();
  const paymentCode = String(req.query.payment_code || '').trim();

  const titleMap = {
    success: 'Thanh toán thành công',
    error: 'Thanh toán lỗi',
    cancel: 'Bạn đã hủy thanh toán',
  };

  const messageMap = {
    success: 'Bạn có thể quay lại ứng dụng để kiểm tra trạng thái đơn hàng.',
    error: 'Vui lòng thử lại hoặc chọn phương thức thanh toán khác.',
    cancel:
      'Đơn thanh toán vẫn ở trạng thái chờ cho tới khi hết hạn hoặc bạn tạo lại giao dịch mới.',
  };

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titleMap[status] || 'Payment result'}</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        background: #f8fafc;
        color: #0f172a;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
      }
      .card {
        width: calc(100% - 32px);
        max-width: 480px;
        background: white;
        border-radius: 16px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.12);
        padding: 28px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 24px;
      }
      p {
        color: #475569;
        line-height: 1.6;
      }
      .code {
        font-weight: 700;
        color: #1d4ed8;
      }
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
  redirectToSepayCheckout,
  renderPaymentReturnPage,
};
const express = require('express');
const router  = express.Router();
const paymentController = require('../controllers/payment.controller');

router.post('/init',           paymentController.initPayment);
router.post('/confirm',        paymentController.confirmPayment);
router.post('/cancel',         paymentController.cancelPayment);
router.post('/webhook/bank',   paymentController.handleBankWebhook);
router.post('/sepay/ipn',      paymentController.handleSepayIpn);

// FIX: thêm MoMo routes
// IPN: MoMo gọi server-to-server để xác nhận thanh toán
router.post('/momo/ipn',       paymentController.handleMomoIpn);
// Return: MoMo redirect user về đây sau khi thanh toán xong
// → backend redirect tiếp về FRONTEND /payment/momo/result
router.get('/momo/return',     paymentController.handleMomoReturn);

router.get('/return/:status',  paymentController.renderPaymentReturnPage);
router.get('/:paymentCode/sepay/checkout', paymentController.redirectToSepayCheckout);
router.get('/:paymentCode',    paymentController.getPaymentByCode);

module.exports = router;

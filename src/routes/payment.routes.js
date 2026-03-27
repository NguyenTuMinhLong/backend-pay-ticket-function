const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');

router.post('/init', paymentController.initPayment);
router.post('/confirm', paymentController.confirmPayment);
router.post('/cancel', paymentController.cancelPayment);
router.post('/webhook/bank', paymentController.handleBankWebhook);
router.post('/sepay/ipn', paymentController.handleSepayIpn);
router.get('/return/:status', paymentController.renderPaymentReturnPage);
router.get('/:paymentCode/sepay/checkout', paymentController.redirectToSepayCheckout);
router.get('/:paymentCode', paymentController.getPaymentByCode);

module.exports = router;

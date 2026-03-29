const express = require('express');
const paymentRoutes = require('./payment.routes');
const ticketRoutes = require('./ticket.routes');

const router = express.Router();

router.use('/payments', paymentRoutes);
router.use('/tickets', ticketRoutes);

module.exports = router;

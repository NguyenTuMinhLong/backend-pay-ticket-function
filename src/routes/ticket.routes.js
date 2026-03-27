const express = require('express');
const ticketController = require('../controllers/ticket.controller');

const router = express.Router();

router.post('/issue/:bookingId', ticketController.issueTickets);
router.get('/booking/:bookingCode', ticketController.getTicketInformation);

module.exports = router;

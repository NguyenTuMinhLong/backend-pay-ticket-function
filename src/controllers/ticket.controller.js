const ticketService = require('../services/ticket.service');

const issueTickets = async (req, res, next) => {
  try {
    const result = await ticketService.issueTicketsByBookingId(req.params.bookingId);
    res.json({ success: true, tickets: result });
  } catch (error) {
    next(error);
  }
};

const getTicketInformation = async (req, res, next) => {
  try {
    const result = await ticketService.getTicketInformationByBookingCode(req.params.bookingCode);
    res.json({ success: true, tickets: result });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  issueTickets,
  getTicketInformation,
};

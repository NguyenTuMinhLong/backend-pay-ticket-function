const db = require('../config/supabase');
const HttpError = require('../utils/httpError');

const issueTicketsByBookingId = async (bookingId) => {
  const normalizedBookingId = Number(bookingId);
  if (!Number.isInteger(normalizedBookingId) || normalizedBookingId <= 0) {
    throw new HttpError(400, 'bookingId must be a positive integer');
  }

  const { rows } = await db.query(
    'select * from public.issue_tickets_for_booking($1)',
    [normalizedBookingId]
  );

  return rows;
};

const getTicketInformationByBookingCode = async (bookingCode) => {
  const normalizedBookingCode = String(bookingCode || '').trim();
  if (!normalizedBookingCode) {
    throw new HttpError(400, 'bookingCode is required');
  }

  const { rows } = await db.query(
    'select * from public.get_ticket_information_by_booking_code($1)',
    [normalizedBookingCode]
  );

  return rows;
};

const getBookingMetaById = async (bookingId) => {
  const normalizedBookingId = Number(bookingId);
  if (!Number.isInteger(normalizedBookingId) || normalizedBookingId <= 0) {
    throw new HttpError(400, 'bookingId must be a positive integer');
  }

  const { rows } = await db.query(
    `
      select id, booking_code, contact_email, contact_phone, status
      from public.bookings
      where id = $1
      limit 1
    `,
    [normalizedBookingId]
  );

  return rows[0] || null;
};

module.exports = {
  issueTicketsByBookingId,
  getTicketInformationByBookingCode,
  getBookingMetaById,
};

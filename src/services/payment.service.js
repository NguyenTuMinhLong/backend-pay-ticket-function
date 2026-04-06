const db     = require('../config/supabase');
const config = require('../config/payment');
const HttpError = require('../utils/httpError');
const { buildPaymentInstruction }   = require('../utils/formatters');
const { createBankQrInstruction }   = require('../providers/bankqr.provider');
const { createSepayCheckoutInstruction, buildAutoSubmitCheckoutHtml } = require('../providers/sepay.provider');

// FIX: import momo provider
const {
  createMomoPaymentInstruction,
  verifyMomoCallbackSignature,
  inferPaymentCode,
  normalizeAmount,
  isMomoCancelResult,
} = require('../providers/momo.provider');

const { sendPaymentPendingEmail, sendTicketIssuedEmail } = require('./email.service');
const ticketService = require('./ticket.service');

// ── Helpers ───────────────────────────────────────────────────────────────────

const isTerminalPaidStatus = (status) =>
  ['PAID', 'SUCCESS', 'COMPLETED', 'CONFIRMED'].includes(String(status || '').toUpperCase());

const isTerminalCancelledStatus = (status) =>
  ['CANCELLED', 'FAILED', 'VOID', 'EXPIRED'].includes(String(status || '').toUpperCase());

// FIX: truyền momoConfig vào buildPaymentInstruction
const mapPayment = (payment, providerPayload = {}) => ({
  ...payment,
  method: payment.payment_method,
  instruction: buildPaymentInstruction({
    payment,
    providerPayload,
    bankConfig:  config.bankQr,
    sepayConfig: config.sepay,
    momoConfig:  config.momo,
  }),
});

const getPaymentByCodeRow = async (paymentCode) => {
  const { rows } = await db.query(
    'select * from payments where payment_code = $1 limit 1',
    [paymentCode]
  );
  return rows[0] || null;
};

const updatePaymentProviderFields = async (paymentCode, fields = {}) => {
  const query = `
    update payments
    set
      qr_payload             = coalesce($2, qr_payload),
      bank_code              = coalesce($3, bank_code),
      bank_account           = coalesce($4, bank_account),
      transfer_content       = coalesce($5, transfer_content),
      gateway_transaction_id = coalesce($6, gateway_transaction_id),
      gateway_response       = coalesce($7::jsonb, gateway_response)
    where payment_code = $1
    returning *
  `;
  const values = [
    paymentCode,
    fields.qr_payload              || null,
    fields.bank_code               || null,
    fields.bank_account            || null,
    fields.transfer_content        || null,
    fields.gateway_transaction_id  || null,
    fields.gateway_response ? JSON.stringify(fields.gateway_response) : null,
  ];
  const { rows } = await db.query(query, values);
  return rows[0] || null;
};

const enrichPaymentWithTickets = async (payment) => {
  if (!payment || !isTerminalPaidStatus(payment.status) || !payment.booking_id) {
    return payment;
  }
  try {
    const issuedTickets = await ticketService.issueTicketsByBookingId(payment.booking_id);
    const booking       = await ticketService.getBookingMetaById(payment.booking_id);

    let tickets = issuedTickets;
    if (booking && booking.booking_code) {
      const lookup = await ticketService.getTicketInformationByBookingCode(booking.booking_code);
      if (lookup.length > 0) tickets = lookup;
    }

    let ticketEmailDelivery = { sent: false, skipped: true, reason: 'Booking email is missing' };
    if (booking && booking.contact_email) {
      ticketEmailDelivery = await sendTicketIssuedEmail({ booking, tickets, email: booking.contact_email });
    }

    return { ...payment, tickets, ticket_email_delivery: ticketEmailDelivery, booking: booking || null };
  } catch (error) {
    return {
      ...payment,
      ticket_issue_error: {
        name:    error?.name    || 'ticket_issue_error',
        message: error?.message || 'Unknown ticket issue error',
      },
    };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Lấy pending payment gần nhất của booking
const getExistingPendingPaymentByBooking = async (bookingId) => {
  const { rows } = await db.query(
    `SELECT * FROM payments WHERE booking_id = $1 AND status = 'PENDING'
     ORDER BY created_at DESC LIMIT 1`,
    [bookingId]
  );
  return rows[0] || null;
};

// Cancel TẤT CẢ pending payments của các booking cũ liên quan đến contact_email.
// Dùng khi init_payment_by_contact fail do cross-booking conflict theo email/phone.
const cancelAllPendingPaymentsByEmail = async (email) => {
  try {
    const { rows } = await db.query(
      `SELECT p.payment_code FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       WHERE b.contact_email = $1 AND p.status = 'PENDING'`,
      [email]
    );
    await Promise.all(
      rows.map(r => db.query(`SELECT * FROM cancel_payment($1)`, [r.payment_code]).catch(() => {}))
    );
    return rows.length;
  } catch (_) {
    return 0;
  }
};

// ── initPayment ───────────────────────────────────────────────────────────────

const initPayment = async ({ booking_id, email, phone, name, payment_method, voucher_code }) => {
  let payment;

  const tryInitDb = async () => {
    const { rows } = await db.query(
      `select * from init_payment_by_contact($1, $2, $3, $4, $5, $6)`,
      [booking_id, email, phone, name || null, payment_method, voucher_code || null]
    );
    return rows[0] || null;
  };

  try {
    payment = await tryInitDb();
  } catch (dbError) {
    // Bước 1: thử lấy pending payment của chính booking này
    payment = await getExistingPendingPaymentByBooking(booking_id).catch(() => null);

    if (!payment) {
      // Bước 2: conflict cross-booking (DB check theo email/phone) → cancel pending cũ và retry
      const cancelled = await cancelAllPendingPaymentsByEmail(email);
      if (cancelled > 0) {
        try {
          payment = await tryInitDb();
        } catch (_) {
          payment = null;
        }
      }
    }

    if (!payment) throw dbError;
  }

  if (!payment) {
    // DB function trả về null (không throw) → fallback
    payment = await getExistingPendingPaymentByBooking(booking_id).catch(() => null);
    if (!payment) throw new HttpError(500, 'init_payment_by_contact returned no payment');
  }

  let providerPayload = {};

  // ── BANK_QR ────────────────────────────────────────────────────────────────
  if (payment_method === 'BANK_QR') {
    if (config.sepay.enabled) {
      const existingGw = payment.gateway_response || {};
      // Tái sử dụng SePay instruction nếu đã có
      if (existingGw.provider === 'SEPAY' && existingGw.checkout_url) {
        providerPayload = existingGw;
      } else {
        providerPayload = createSepayCheckoutInstruction(payment);
        payment = (await updatePaymentProviderFields(payment.payment_code, {
          transfer_content: payment.payment_code,
          gateway_response: {
            ...providerPayload,
            provider:    'SEPAY',
            mode:        'hosted_checkout',
            generatedAt: new Date().toISOString(),
          },
        })) || payment;
      }
    } else {
      providerPayload = createBankQrInstruction(payment);
      payment = (await updatePaymentProviderFields(payment.payment_code, {
        qr_payload:       providerPayload.qr_payload,
        bank_code:        providerPayload.bank_code,
        bank_account:     providerPayload.bank_account,
        transfer_content: providerPayload.transfer_content,
        gateway_response: {
          provider:    'BANK_QR',
          generatedAt: new Date().toISOString(),
          mode:        'reconciliation_ready',
        },
      })) || payment;
    }
  }

  // ── MOMO ──────────────────────────────────────────────────────────────────
  if (payment_method === 'MOMO') {
    if (!config.momo.enabled) {
      throw new HttpError(400, 'MoMo payment is not configured on this server');
    }

    const existingGw = payment.gateway_response || {};

    if (existingGw.provider === 'MOMO' && existingGw.pay_url) {
      // Đã có pay_url hợp lệ → tái sử dụng, không gọi lại MoMo
      providerPayload = existingGw;
    } else {
      // Thử tạo MoMo instruction. Nếu MoMo từ chối (vd: orderId đã tồn tại,
      // sandbox hết hạn...) → huỷ payment hiện tại và tạo payment_code mới.
      let momoResult = null;
      try {
        momoResult = await createMomoPaymentInstruction(payment);
      } catch (_momoErr) {
        // Cancel payment cũ (payment_code cũ đã bị MoMo từ chối)
        await db.query(`select * from cancel_payment($1)`, [payment.payment_code]).catch(() => {});

        // Tạo payment mới với payment_code mới
        const { rows: freshRows } = await db.query(
          `select * from init_payment_by_contact($1, $2, $3, $4, $5, $6)`,
          [booking_id, email, phone, name || null, payment_method, voucher_code || null]
        );
        if (!freshRows[0]) throw _momoErr;
        payment    = freshRows[0];
        momoResult = await createMomoPaymentInstruction(payment);
      }

      providerPayload = momoResult;
      payment = (await updatePaymentProviderFields(payment.payment_code, {
        qr_payload:       providerPayload.qr_payload,
        gateway_response: {
          ...providerPayload,
          provider:    'MOMO',
          mode:        'gateway_redirect',
          generatedAt: new Date().toISOString(),
        },
      })) || payment;
    }
  }

  const response = mapPayment(payment, providerPayload);
  response.email_delivery = await sendPaymentPendingEmail({
    payment:     response,
    instruction: response.instruction,
    email,
  });

  return response;
};

// ── getPaymentByCode ──────────────────────────────────────────────────────────

const getPaymentByCode = async (paymentCode) => {
  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) throw new HttpError(404, 'Payment not found');
  return mapPayment(payment);
};

// ── confirmPayment ────────────────────────────────────────────────────────────

const confirmPayment = async ({ payment_code, success, gateway_transaction_id, gateway_response }) => {
  const query  = `select * from confirm_payment($1, $2, $3, $4)`;
  const values = [
    payment_code,
    Boolean(success),
    gateway_transaction_id || 'MANUAL-TXN',
    JSON.stringify(gateway_response || { status: success ? 'success' : 'fail', source: 'manual' }),
  ];
  const { rows } = await db.query(query, values);
  const mapped   = mapPayment(rows[0]);
  return enrichPaymentWithTickets(mapped);
};

// ── cancelPayment ─────────────────────────────────────────────────────────────

const cancelPayment = async ({ payment_code }) => {
  const payment = await getPaymentByCodeRow(payment_code);
  if (!payment) throw new HttpError(404, 'Payment not found');
  if (isTerminalCancelledStatus(payment.status)) return mapPayment(payment);

  const { rows } = await db.query(`select * from cancel_payment($1)`, [payment_code]);
  return mapPayment(rows[0]);
};

// ── handleBankWebhook ─────────────────────────────────────────────────────────

const handleBankWebhook = async ({ payment_code, amount, transfer_content, bank_transaction_id, status, bank_name, raw_payload }) => {
  const payment = await getPaymentByCodeRow(payment_code);
  if (!payment) throw new HttpError(404, 'Payment not found');
  if (isTerminalPaidStatus(payment.status)) return mapPayment(payment);

  const expectedAmount = Number(payment.final_amount || payment.amount || 0);
  if (Number(amount) !== expectedAmount)
    throw new HttpError(400, `Amount mismatch. Expected ${expectedAmount} but received ${amount}`);

  const expectedContent = String(payment.transfer_content || payment.payment_code || '').trim();
  if (String(transfer_content || '').trim() !== expectedContent)
    throw new HttpError(400, 'Transfer content mismatch');

  if (String(status || 'success').toLowerCase() !== 'success')
    throw new HttpError(400, 'Bank webhook status must be success');

  return confirmPayment({
    payment_code,
    success:                true,
    gateway_transaction_id: bank_transaction_id || `BANK-${Date.now()}`,
    gateway_response: {
      provider:    'BANK_QR',
      source:      'bank_webhook',
      bank_name:   bank_name || config.bankQr.bankName,
      raw_payload: raw_payload || null,
      received_at: new Date().toISOString(),
    },
  });
};

// ── handleSepayIpn ────────────────────────────────────────────────────────────

const handleSepayIpn = async ({ notification_type, secret_key, order, transaction, customer, raw_payload }) => {
  if (config.sepay.secretKey && secret_key !== config.sepay.secretKey)
    throw new HttpError(401, 'Invalid SePay secret key');

  const paymentCode = String(order.order_invoice_number || '').trim();
  if (!paymentCode) throw new HttpError(400, 'order.order_invoice_number is required');

  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) throw new HttpError(404, 'Payment not found');

  const expectedAmount    = Number(payment.final_amount || payment.amount || 0);
  const transactionAmount = Number((transaction && transaction.transaction_amount) || order.order_amount || 0);
  const orderAmount       = Number(order.order_amount || 0);
  const receivedAmount    = transactionAmount || orderAmount;

  if (receivedAmount !== expectedAmount)
    throw new HttpError(400, `Amount mismatch. Expected ${expectedAmount} but received ${receivedAmount}`);

  if (notification_type === 'ORDER_PAID') {
    if (isTerminalPaidStatus(payment.status)) return mapPayment(payment);
    return confirmPayment({
      payment_code:            paymentCode,
      success:                 true,
      gateway_transaction_id:  (transaction && transaction.transaction_id) || order.order_id || `SEPAY-${Date.now()}`,
      gateway_response: {
        provider: 'SEPAY', source: 'ipn',
        notification_type, order, transaction, customer, raw_payload,
        received_at: new Date().toISOString(),
      },
    });
  }

  if (notification_type === 'TRANSACTION_VOID') {
    if (isTerminalCancelledStatus(payment.status)) return mapPayment(payment);
    const { rows } = await db.query(`select * from cancel_payment($1)`, [paymentCode]);
    return mapPayment(rows[0]);
  }

  return mapPayment(payment);
};

// ── MoMo callback processor ───────────────────────────────────────────────────

const processMomoCallback = async (body = {}, source = 'ipn') => {
  const isValidSignature = verifyMomoCallbackSignature(body);
  if (!isValidSignature) {
    return { ok: false, resultCode: 13, message: 'Invalid signature', payment_code: inferPaymentCode(body) };
  }

  const paymentCode = inferPaymentCode(body);
  if (!paymentCode) {
    return { ok: false, resultCode: 42, message: 'Payment not found', payment_code: '' };
  }

  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) {
    return { ok: false, resultCode: 42, message: 'Payment not found', payment_code: paymentCode };
  }

  const expectedAmount = normalizeAmount(payment.final_amount || payment.amount || 0);
  const receivedAmount = Number(body.amount || 0);
  if (expectedAmount !== receivedAmount) {
    if (!isTerminalCancelledStatus(payment.status) && !isTerminalPaidStatus(payment.status)) {
      await cancelPayment({ payment_code: paymentCode });
    }
    return { ok: false, resultCode: 1, message: 'Amount mismatch', payment_code: paymentCode };
  }

  if (Number(body.resultCode) === 0) {
    if (isTerminalPaidStatus(payment.status)) {
      return { ok: true, resultCode: 0, message: 'Already processed', payment_code: paymentCode, payment: mapPayment(payment) };
    }
    const confirmed = await confirmPayment({
      payment_code:            paymentCode,
      success:                 true,
      gateway_transaction_id:  body.transId ? String(body.transId) : `MOMO-${Date.now()}`,
      gateway_response: {
        provider:    'MOMO',
        source,
        raw_payload: body,
        received_at: new Date().toISOString(),
      },
    });
    return { ok: true, resultCode: 0, message: 'Success', payment_code: paymentCode, payment: confirmed };
  }

  // resultCode != 0 → user hủy hoặc lỗi
  let cancelled = mapPayment(payment);
  if (!isTerminalCancelledStatus(payment.status) && !isTerminalPaidStatus(payment.status)) {
    cancelled = await cancelPayment({ payment_code: paymentCode });
  }
  return {
    ok:            true,
    resultCode:    0,
    message:       body.message || 'Received',
    payment_code:  paymentCode,
    payment:       cancelled,
    return_status: isMomoCancelResult(body.resultCode, body.message) ? 'cancel' : 'error',
  };
};

// ── handleMomoIpn — MoMo gọi IPN về đây (server-to-server) ──────────────────

const handleMomoIpn = async (body = {}) => {
  const result = await processMomoCallback(body, 'ipn');
  return { resultCode: result.resultCode, message: result.message };
};

// ── handleMomoReturn — MoMo redirect user về đây sau khi thanh toán ─────────
// FIX: redirect về FRONTEND /payment/momo/result thay vì render HTML tại đây

const handleMomoReturn = async (query = {}) => {
  const result = await processMomoCallback(query, 'redirect');

  // Lấy booking_code để truyền về FE
  let bookingCode = '';
  try {
    if (result.payment_code) {
      const { rows } = await db.query(
        `SELECT b.booking_code
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         WHERE p.payment_code = $1
         LIMIT 1`,
        [result.payment_code]
      );
      if (rows[0]) bookingCode = rows[0].booking_code;
    }
  } catch (_) {}

  const resultStatus =
    !result.ok
      ? 'error'
      : Number(query.resultCode) === 0
        ? 'success'
        : result.return_status || (isMomoCancelResult(query.resultCode, query.message) ? 'cancel' : 'error');

  // Build query string để truyền về React app
  const params = new URLSearchParams();
  params.set('status',     resultStatus);
  params.set('resultCode', String(query.resultCode || result.resultCode || ''));
  params.set('orderId',    String(query.orderId    || result.payment_code || ''));
  params.set('message',    String(query.message    || result.message      || ''));
  params.set('amount',     String(query.amount     || ''));
  if (bookingCode) params.set('bookingCode', bookingCode);

  const frontendUrl = config.momo.frontendUrl;

  if (frontendUrl) {
    // Redirect về React route /payment/momo/result
    return { redirect: `${frontendUrl}/payment/momo/result?${params.toString()}` };
  }

  // Fallback HTML nếu không có FRONTEND_URL
  return {
    redirect:     null,
    status:       resultStatus,
    payment_code: result.payment_code,
    booking_code: bookingCode,
    params:       params.toString(),
  };
};

// ── buildSepayCheckoutHtml ────────────────────────────────────────────────────

const buildSepayCheckoutHtml = async (paymentCode) => {
  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) throw new HttpError(404, 'Payment not found');

  if (String(payment.payment_method).toUpperCase() !== 'BANK_QR')
    throw new HttpError(400, 'SePay checkout is only enabled for BANK_QR payments');

  let checkout      = null;
  const gatewayResp = payment.gateway_response || {};

  if (gatewayResp.provider === 'SEPAY' && gatewayResp.checkout_url && gatewayResp.checkout_form_fields) {
    checkout = {
      checkout_url:         gatewayResp.checkout_url,
      checkout_form_fields: gatewayResp.checkout_form_fields,
      redirect_url:         gatewayResp.redirect_url      || null,
      ipn_url:              gatewayResp.ipn_url            || null,
      payment_method:       gatewayResp.payment_method     || null,
      order_invoice_number: gatewayResp.order_invoice_number || payment.payment_code,
    };
  } else {
    checkout = createSepayCheckoutInstruction(payment);
  }

  return buildAutoSubmitCheckoutHtml({ payment, checkout });
};

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initPayment,
  getPaymentByCode,
  confirmPayment,
  cancelPayment,
  handleBankWebhook,
  handleSepayIpn,
  handleMomoIpn,
  handleMomoReturn,
  buildSepayCheckoutHtml,
};

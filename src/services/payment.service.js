const db     = require('../config/supabase');
const config = require('../config/payment');
const HttpError = require('../utils/httpError');
const { buildPaymentInstruction }   = require('../utils/formatters');
const { createBankQrInstruction }   = require('../providers/bankqr.provider');
const {
  createPayosPaymentInstruction,
  verifyPayosWebhookData,
  getPayosPaymentLink,
  cancelPayosPaymentLink,
} = require('../providers/payos.provider');

// FIX: import momo provider
const {
  createMomoPaymentInstruction,
  verifyMomoCallbackSignature,
  inferPaymentCode,
  normalizeAmount,
  isMomoCancelResult,
} = require('../providers/momo.provider');
const {
  createPayPalOrder,
  capturePayPalOrder,
  getFrontendResultBaseUrl,
} = require('../providers/paypal.provider');

const { sendPaymentPendingEmail, sendTicketIssuedEmail } = require('./email.service');
const ticketService = require('./ticket.service');

// ── Helpers ───────────────────────────────────────────────────────────────────

const isTerminalPaidStatus = (status) =>
  ['PAID', 'SUCCESS', 'COMPLETED', 'CONFIRMED'].includes(String(status || '').toUpperCase());

const isTerminalCancelledStatus = (status) =>
  ['CANCELLED', 'FAILED', 'VOID', 'EXPIRED'].includes(String(status || '').toUpperCase());

const getPaymentChargeAmount = (payment) =>
  Number(payment?.final_amount ?? payment?.amount ?? 0);

// FIX: truyền momoConfig vào buildPaymentInstruction
const mapPayment = (payment, providerPayload = {}) => ({
  ...payment,
  method: payment.payment_method,
  instruction: buildPaymentInstruction({
    payment,
    providerPayload,
    bankConfig:  config.bankQr,
    payosConfig: config.payos,
    momoConfig:  config.momo,
    paypalConfig: config.paypal,
  }),
});

const getPaymentByCodeRow = async (paymentCode) => {
  const { rows } = await db.query(
    'select * from payments where payment_code = $1 limit 1',
    [paymentCode]
  );
  return rows[0] || null;
};

const getPaymentByIdRow = async (id) => {
  const { rows } = await db.query(
    'select * from payments where id::text = $1 limit 1',
    [String(id)]
  );
  return rows[0] || null;
};

const getPaymentByPayosOrderCode = async (orderCode) => {
  const { rows } = await db.query(
    `select * from payments
     where gateway_response ->> 'provider' = 'PAYOS'
       and gateway_response ->> 'order_code' = $1
     order by created_at desc
     limit 1`,
    [String(orderCode)]
  );
  return rows[0] || null;
};

const getPaymentByGatewayOrderId = async (orderId) => {
  const { rows } = await db.query(
    `select * from payments
     where gateway_response ->> 'order_id' = $1
     order by created_at desc
     limit 1`,
    [orderId]
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

  if (getPaymentChargeAmount(payment) <= 0) {
    return confirmPayment({
      payment_code: payment.payment_code,
      success: true,
      gateway_transaction_id: `AUTO-ZERO-${Date.now()}`,
      gateway_response: {
        provider: 'INTERNAL',
        source: 'auto_zero_amount',
        note: 'Auto confirmed because final amount is zero',
      },
    });
  }

  let providerPayload = {};

  // ── BANK_QR ────────────────────────────────────────────────────────────────
  if (payment_method === 'BANK_QR') {
    if (config.payos.enabled) {
      const existingGw = payment.gateway_response || {};
      if (existingGw.provider === 'PAYOS' && existingGw.checkout_url) {
        providerPayload = existingGw;
      } else {
        providerPayload = await createPayosPaymentInstruction(payment);
        payment = (await updatePaymentProviderFields(payment.payment_code, {
          qr_payload: providerPayload.qr_payload,
          bank_code: providerPayload.bank_bin,
          bank_account: providerPayload.bank_account,
          transfer_content: providerPayload.description || payment.payment_code,
          gateway_response: {
            ...providerPayload,
            provider:    'PAYOS',
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

  if (payment_method === 'PAYPAL') {
    if (!config.paypal.enabled) {
      throw new HttpError(400, 'PayPal payment is not configured on this server');
    }

    const existingGw = payment.gateway_response || {};

    if (existingGw.provider === 'PAYPAL' && existingGw.order_id && existingGw.approve_url) {
      providerPayload = existingGw;
    } else {
      providerPayload = await createPayPalOrder(payment);
      payment = (await updatePaymentProviderFields(payment.payment_code, {
        gateway_response: {
          ...providerPayload,
          provider: 'PAYPAL',
          mode: 'redirect_checkout',
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

  const gatewayResponse = payment.gateway_response || {};
  if (
    gatewayResponse.provider === 'PAYOS' &&
    gatewayResponse.order_code &&
    config.payos.enabled &&
    !isTerminalPaidStatus(payment.status)
  ) {
    await cancelPayosPaymentLink(gatewayResponse.order_code, 'Cancelled by backend').catch(() => null);
  }

  const { rows } = await db.query(`select * from cancel_payment($1)`, [payment_code]);
  return mapPayment(rows[0]);
};

// ── handleBankWebhook ─────────────────────────────────────────────────────────

const handleBankWebhook = async ({ payment_code, amount, transfer_content, bank_transaction_id, status, bank_name, raw_payload }) => {
  const payment = await getPaymentByCodeRow(payment_code);
  if (!payment) throw new HttpError(404, 'Payment not found');
  if (isTerminalPaidStatus(payment.status)) return mapPayment(payment);

  const expectedAmount = getPaymentChargeAmount(payment);
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

// ── handlePayosWebhook ────────────────────────────────────────────────────────

const handlePayosWebhook = async (payload = {}) => {
  const webhookData = await verifyPayosWebhookData(payload);
  const payment =
    await getPaymentByIdRow(webhookData.orderCode) ||
    await getPaymentByPayosOrderCode(webhookData.orderCode) ||
    await getPaymentByCodeRow(String(webhookData.description || '').trim());
  if (!payment) throw new HttpError(404, 'Payment not found');

  const expectedAmount = getPaymentChargeAmount(payment);
  const receivedAmount = Number(webhookData.amount || 0);

  if (receivedAmount !== expectedAmount)
    throw new HttpError(400, `Amount mismatch. Expected ${expectedAmount} but received ${receivedAmount}`);

  const isSuccessful =
    payload.success === true &&
    String(payload.code || webhookData.code || '').trim() === '00' &&
    String(webhookData.code || '').trim() === '00';

  if (isSuccessful) {
    if (isTerminalPaidStatus(payment.status)) return mapPayment(payment);

    return confirmPayment({
      payment_code:            payment.payment_code,
      success:                 true,
      gateway_transaction_id:  webhookData.reference || webhookData.paymentLinkId || `PAYOS-${Date.now()}`,
      gateway_response: {
        provider: 'PAYOS',
        source: 'webhook',
        webhook: webhookData,
        raw_payload: payload,
        received_at: new Date().toISOString(),
      },
    });
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

  const expectedAmount = normalizeAmount(getPaymentChargeAmount(payment));
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

// ── PayPal return/cancel ──────────────────────────────────────────────────────

const getBookingCodeForPayment = async (payment) => {
  if (!payment || !payment.booking_id) return '';

  const { rows } = await db.query(
    `select booking_code from bookings where id = $1 limit 1`,
    [payment.booking_id]
  );
  return rows[0]?.booking_code || '';
};

const buildPayosFrontendRedirect = async ({
  payment,
  status,
  orderCode = '',
  paymentLinkId = '',
  message = '',
}) => {
  let bookingCode = '';

  try {
    bookingCode = await getBookingCodeForPayment(payment);
  } catch (_) {}

  const params = new URLSearchParams();
  params.set('status', status);
  params.set('paymentCode', payment?.payment_code || '');
  params.set('orderCode', orderCode || '');
  params.set('paymentLinkId', paymentLinkId || '');
  params.set('message', message || '');
  if (bookingCode) params.set('bookingCode', bookingCode);

  if (config.payos.frontendUrl) {
    return { redirect: `${config.payos.frontendUrl}/payment/payos/result?${params.toString()}` };
  }

  return {
    redirect: null,
    status,
    payment_code: payment?.payment_code || '',
    booking_code: bookingCode,
    order_code: orderCode,
    payment_link_id: paymentLinkId,
    message,
  };
};

const handlePayosReturn = async (returnStatus = 'success', query = {}) => {
  const paymentCode = String(query.payment_code || query.paymentCode || '').trim();
  const normalizedReturnStatus = String(returnStatus || '').toLowerCase();

  if (!paymentCode) {
    return buildPayosFrontendRedirect({
      payment: null,
      status: 'error',
      message: 'Missing payment code',
    });
  }

  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) {
    return buildPayosFrontendRedirect({
      payment: { payment_code: paymentCode },
      status: 'error',
      message: 'Payment not found',
    });
  }

  const gatewayResp = payment.gateway_response || {};
  const orderCode = String(gatewayResp.order_code || query.orderCode || '');
  const paymentLinkId = String(gatewayResp.payment_link_id || query.id || '');

  if (isTerminalPaidStatus(payment.status)) {
    return buildPayosFrontendRedirect({
      payment,
      status: 'success',
      orderCode,
      paymentLinkId,
      message: 'Already processed',
    });
  }

  if (normalizedReturnStatus === 'cancel') {
    const cancelledPayment = isTerminalCancelledStatus(payment.status)
      ? payment
      : await cancelPayment({ payment_code: payment.payment_code });

    return buildPayosFrontendRedirect({
      payment: cancelledPayment,
      status: 'cancel',
      orderCode,
      paymentLinkId,
      message: 'Buyer cancelled payOS checkout',
    });
  }

  if (!orderCode) {
    return buildPayosFrontendRedirect({
      payment,
      status: 'error',
      paymentLinkId,
      message: 'Missing payOS order code',
    });
  }

  let paymentLink;
  try {
    paymentLink = await getPayosPaymentLink(orderCode);
  } catch (error) {
    return buildPayosFrontendRedirect({
      payment,
      status: 'pending',
      orderCode,
      paymentLinkId,
      message: error?.message || 'Waiting for payOS confirmation',
    });
  }

  const payosStatus = String(paymentLink.status || '').toUpperCase();
  const latestPaymentLinkId = paymentLink.id || paymentLinkId;

  if (payosStatus === 'PAID') {
    const expectedAmount = getPaymentChargeAmount(payment);
    const paidAmount = Number(paymentLink.amountPaid || paymentLink.amount || 0);
    if (paidAmount !== expectedAmount) {
      return buildPayosFrontendRedirect({
        payment,
        status: 'error',
        orderCode,
        paymentLinkId: latestPaymentLinkId,
        message: `Amount mismatch. Expected ${expectedAmount} but received ${paidAmount}`,
      });
    }

    const transaction = Array.isArray(paymentLink.transactions)
      ? paymentLink.transactions[0]
      : null;

    const confirmed = await confirmPayment({
      payment_code: payment.payment_code,
      success: true,
      gateway_transaction_id: transaction?.reference || latestPaymentLinkId || `PAYOS-${Date.now()}`,
      gateway_response: {
        provider: 'PAYOS',
        source: 'return',
        order_code: orderCode,
        payment_link_id: latestPaymentLinkId,
        payment_link: paymentLink,
        raw_payload: query,
        received_at: new Date().toISOString(),
      },
    });

    return buildPayosFrontendRedirect({
      payment: confirmed,
      status: 'success',
      orderCode,
      paymentLinkId: latestPaymentLinkId,
      message: 'Success',
    });
  }

  if (['CANCELLED', 'FAILED', 'EXPIRED'].includes(payosStatus)) {
    const cancelledPayment = isTerminalCancelledStatus(payment.status)
      ? payment
      : await cancelPayment({ payment_code: payment.payment_code });

    return buildPayosFrontendRedirect({
      payment: cancelledPayment,
      status: payosStatus === 'CANCELLED' ? 'cancel' : 'error',
      orderCode,
      paymentLinkId: latestPaymentLinkId,
      message: `payOS status: ${payosStatus}`,
    });
  }

  return buildPayosFrontendRedirect({
    payment,
    status: 'pending',
    orderCode,
    paymentLinkId: latestPaymentLinkId,
    message: `payOS status: ${payosStatus || 'PENDING'}`,
  });
};

const buildPaypalFrontendRedirect = async ({ payment, status, orderId = '', captureId = '', message = '' }) => {
  let bookingCode = '';

  try {
    if (payment && payment.booking_id) {
      const { rows } = await db.query(
        `select booking_code from bookings where id = $1 limit 1`,
        [payment.booking_id]
      );
      if (rows[0]) bookingCode = rows[0].booking_code;
    }
  } catch (_) {}

  const params = new URLSearchParams();
  params.set('status', status);
  params.set('paymentCode', payment?.payment_code || '');
  params.set('orderId', orderId || '');
  params.set('captureId', captureId || '');
  params.set('message', message || '');
  if (bookingCode) params.set('bookingCode', bookingCode);

  const frontendBaseUrl = getFrontendResultBaseUrl();
  if (frontendBaseUrl) {
    return { redirect: `${frontendBaseUrl}?${params.toString()}` };
  }

  return {
    redirect: null,
    status,
    payment_code: payment?.payment_code || '',
    booking_code: bookingCode,
    order_id: orderId,
    capture_id: captureId,
    message,
  };
};

const handlePaypalReturn = async (query = {}) => {
  const orderId = String(query.token || query.orderId || '').trim();
  const paymentCode = String(query.payment_code || '').trim();

  if (!orderId) {
    return buildPaypalFrontendRedirect({
      payment: paymentCode ? await getPaymentByCodeRow(paymentCode).catch(() => null) : null,
      status: 'error',
      message: 'Missing PayPal order token',
    });
  }

  const payment =
    await getPaymentByGatewayOrderId(orderId) ||
    (paymentCode ? await getPaymentByCodeRow(paymentCode) : null);

  if (!payment) {
    return {
      redirect: null,
      status: 'error',
      payment_code: paymentCode,
      booking_code: '',
      order_id: orderId,
      capture_id: '',
      message: 'Payment not found',
    };
  }

  if (isTerminalPaidStatus(payment.status)) {
    return buildPaypalFrontendRedirect({
      payment,
      status: 'success',
      orderId,
      captureId: payment.gateway_transaction_id || '',
      message: 'Already processed',
    });
  }

  const capture = await capturePayPalOrder(orderId);
  const purchaseUnit = Array.isArray(capture.purchase_units) ? capture.purchase_units[0] : null;
  const payments = purchaseUnit && purchaseUnit.payments ? purchaseUnit.payments : {};
  const captureItem = Array.isArray(payments.captures) ? payments.captures[0] : null;

  if (!captureItem || String(captureItem.status || '').toUpperCase() !== 'COMPLETED') {
    return buildPaypalFrontendRedirect({
      payment,
      status: 'error',
      orderId,
      message: capture.message || 'PayPal capture did not complete',
    });
  }

  const confirmed = await confirmPayment({
    payment_code: payment.payment_code,
    success: true,
    gateway_transaction_id: captureItem.id || `PAYPAL-${Date.now()}`,
    gateway_response: {
      provider: 'PAYPAL',
      source: 'return',
      order_id: orderId,
      capture_id: captureItem.id || null,
      raw_payload: capture,
      received_at: new Date().toISOString(),
    },
  });

  return buildPaypalFrontendRedirect({
    payment: confirmed,
    status: 'success',
    orderId,
    captureId: captureItem.id || '',
    message: 'Success',
  });
};

const handlePaypalCancel = async (query = {}) => {
  const orderId = String(query.token || query.orderId || '').trim();
  const paymentCode = String(query.payment_code || '').trim();
  const payment =
    (orderId ? await getPaymentByGatewayOrderId(orderId) : null) ||
    (paymentCode ? await getPaymentByCodeRow(paymentCode) : null);

  let cancelledPayment = payment;
  if (payment && !isTerminalCancelledStatus(payment.status) && !isTerminalPaidStatus(payment.status)) {
    cancelledPayment = await cancelPayment({ payment_code: payment.payment_code });
  }

  return buildPaypalFrontendRedirect({
    payment: cancelledPayment,
    status: 'cancel',
    orderId,
    message: 'Buyer cancelled PayPal checkout',
  });
};

// ── getPayosCheckoutUrl ───────────────────────────────────────────────────────

const getPayosCheckoutUrl = async (paymentCode) => {
  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) throw new HttpError(404, 'Payment not found');

  if (String(payment.payment_method).toUpperCase() !== 'BANK_QR')
    throw new HttpError(400, 'payOS checkout is only enabled for BANK_QR payments');

  if (isTerminalPaidStatus(payment.status)) {
    throw new HttpError(400, 'Payment has already been completed.');
  }

  if (isTerminalCancelledStatus(payment.status)) {
    throw new HttpError(400, 'Payment has expired or was cancelled. Please create a new booking and try again.');
  }

  const gatewayResp = payment.gateway_response || {};

  if (gatewayResp.provider === 'PAYOS' && gatewayResp.checkout_url) {
    return gatewayResp.checkout_url;
  }

  if (!config.payos.enabled) {
    throw new HttpError(400, 'payOS payment is not configured on this server');
  }

  const checkout = await createPayosPaymentInstruction(payment);
  await updatePaymentProviderFields(payment.payment_code, {
    qr_payload: checkout.qr_payload,
    bank_code: checkout.bank_bin,
    bank_account: checkout.bank_account,
    transfer_content: checkout.description || payment.payment_code,
    gateway_response: {
      ...gatewayResp,
      ...checkout,
      provider: 'PAYOS',
      mode: 'hosted_checkout',
      generatedAt: new Date().toISOString(),
    },
  }).catch(() => null);

  return checkout.checkout_url;
};

const getPaypalCheckoutUrl = async (paymentCode) => {
  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) throw new HttpError(404, 'Payment not found');

  if (String(payment.payment_method).toUpperCase() !== 'PAYPAL') {
    throw new HttpError(400, 'PayPal checkout is only enabled for PAYPAL payments');
  }

  const gatewayResp = payment.gateway_response || {};

  if (gatewayResp.provider === 'PAYPAL' && gatewayResp.approve_url) {
    return gatewayResp.approve_url;
  }

  if (!config.paypal.enabled) {
    throw new HttpError(400, 'PayPal payment is not configured on this server');
  }

  const checkout = await createPayPalOrder(payment);
  await updatePaymentProviderFields(payment.payment_code, {
    gateway_response: {
      ...gatewayResp,
      ...checkout,
      provider: 'PAYPAL',
      mode: 'redirect_checkout',
      generatedAt: new Date().toISOString(),
    },
  }).catch(() => null);

  return checkout.approve_url;
};

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initPayment,
  getPaymentByCode,
  confirmPayment,
  cancelPayment,
  handleBankWebhook,
  handlePayosWebhook,
  handlePayosReturn,
  handleMomoIpn,
  handleMomoReturn,
  handlePaypalReturn,
  handlePaypalCancel,
  getPayosCheckoutUrl,
  getPaypalCheckoutUrl,
};

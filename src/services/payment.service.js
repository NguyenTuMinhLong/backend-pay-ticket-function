const db = require('../config/supabase');
const config = require('../config/payment');
const HttpError = require('../utils/httpError');
const { buildPaymentInstruction } = require('../utils/formatters');
const { createBankQrInstruction } = require('../providers/bankqr.provider');
const { createSepayCheckoutInstruction, buildAutoSubmitCheckoutHtml } = require('../providers/sepay.provider');
const { sendPaymentPendingEmail, sendTicketIssuedEmail } = require('./email.service');
const ticketService = require('./ticket.service');

const isTerminalPaidStatus = (status) =>
  ['PAID', 'SUCCESS', 'COMPLETED', 'CONFIRMED'].includes(String(status || '').toUpperCase());

const isTerminalCancelledStatus = (status) =>
  ['CANCELLED', 'FAILED', 'VOID', 'EXPIRED'].includes(String(status || '').toUpperCase());

const mapPayment = (payment, providerPayload = {}) => ({
  ...payment,
  method: payment.payment_method,
  instruction: buildPaymentInstruction({
    payment,
    providerPayload,
    bankConfig: config.bankQr,
    sepayConfig: config.sepay,
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
      qr_payload = coalesce($2, qr_payload),
      bank_code = coalesce($3, bank_code),
      bank_account = coalesce($4, bank_account),
      transfer_content = coalesce($5, transfer_content),
      gateway_transaction_id = coalesce($6, gateway_transaction_id),
      gateway_response = coalesce($7::jsonb, gateway_response)
    where payment_code = $1
    returning *
  `;

  const values = [
    paymentCode,
    fields.qr_payload || null,
    fields.bank_code || null,
    fields.bank_account || null,
    fields.transfer_content || null,
    fields.gateway_transaction_id || null,
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
    const booking = await ticketService.getBookingMetaById(payment.booking_id);

    let tickets = issuedTickets;
    if (booking && booking.booking_code) {
      const lookup = await ticketService.getTicketInformationByBookingCode(booking.booking_code);
      if (lookup.length > 0) {
        tickets = lookup;
      }
    }

    let ticketEmailDelivery = {
      sent: false,
      skipped: true,
      reason: 'Booking email is missing',
    };

    if (booking && booking.contact_email) {
      ticketEmailDelivery = await sendTicketIssuedEmail({
        booking,
        tickets,
        email: booking.contact_email,
      });
    }

    return {
      ...payment,
      tickets,
      ticket_email_delivery: ticketEmailDelivery,
      booking: booking || null,
    };
  } catch (error) {
    return {
      ...payment,
      ticket_issue_error: {
        name: error?.name || 'ticket_issue_error',
        message: error?.message || 'Unknown ticket issue error',
      },
    };
  }
};

const initPayment = async ({ booking_id, email, phone, name, payment_method, voucher_code }) => {
  const query = `
    select *
    from init_payment_by_contact($1, $2, $3, $4, $5, $6)
  `;

  const values = [booking_id, email, phone, name || null, payment_method, voucher_code || null];
  const { rows } = await db.query(query, values);
  let payment = rows[0];

  if (!payment) {
    throw new HttpError(500, 'init_payment_by_contact returned no payment');
  }

  let providerPayload = {};

  if (payment_method === 'BANK_QR') {
    if (config.sepay.enabled) {
      providerPayload = createSepayCheckoutInstruction(payment);

      payment =
        (await updatePaymentProviderFields(payment.payment_code, {
          transfer_content: payment.payment_code,
          gateway_response: {
            ...providerPayload,
            provider: 'SEPAY',
            mode: 'hosted_checkout',
            generatedAt: new Date().toISOString(),
          },
        })) || payment;
    } else {
      providerPayload = createBankQrInstruction(payment);

      payment =
        (await updatePaymentProviderFields(payment.payment_code, {
          qr_payload: providerPayload.qr_payload,
          bank_code: providerPayload.bank_code,
          bank_account: providerPayload.bank_account,
          transfer_content: providerPayload.transfer_content,
          gateway_response: {
            provider: 'BANK_QR',
            generatedAt: new Date().toISOString(),
            mode: 'reconciliation_ready',
          },
        })) || payment;
    }
  }

  if (payment_method === 'MOMO') {
    providerPayload = {
      qr_payload: null,
      pay_url: null,
      deeplink: null,
    };

    payment =
      (await updatePaymentProviderFields(payment.payment_code, {
        gateway_response: {
          provider: 'MOMO',
          mode: 'manual_confirm',
          generatedAt: new Date().toISOString(),
        },
      })) || payment;
  }

  const response = mapPayment(payment, providerPayload);
  response.email_delivery = await sendPaymentPendingEmail({
    payment: response,
    instruction: response.instruction,
    email,
  });

  return response;
};

const getPaymentByCode = async (paymentCode) => {
  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) {
    throw new HttpError(404, 'Payment not found');
  }

  return mapPayment(payment);
};

const confirmPayment = async ({ payment_code, success, gateway_transaction_id, gateway_response }) => {
  const query = `select * from confirm_payment($1, $2, $3, $4)`;
  const values = [
    payment_code,
    Boolean(success),
    gateway_transaction_id || 'MANUAL-TXN',
    JSON.stringify(
      gateway_response || { status: success ? 'success' : 'fail', source: 'manual' }
    ),
  ];

  const { rows } = await db.query(query, values);
  const mapped = mapPayment(rows[0]);
  return enrichPaymentWithTickets(mapped);
};

const cancelPayment = async ({ payment_code }) => {
  const payment = await getPaymentByCodeRow(payment_code);
  if (!payment) {
    throw new HttpError(404, 'Payment not found');
  }

  if (isTerminalCancelledStatus(payment.status)) {
    return mapPayment(payment);
  }

  const query = `select * from cancel_payment($1)`;
  const values = [payment_code];
  const { rows } = await db.query(query, values);
  return mapPayment(rows[0]);
};

const handleBankWebhook = async ({
  payment_code,
  amount,
  transfer_content,
  bank_transaction_id,
  status,
  bank_name,
  raw_payload,
}) => {
  const payment = await getPaymentByCodeRow(payment_code);
  if (!payment) {
    throw new HttpError(404, 'Payment not found');
  }

  if (isTerminalPaidStatus(payment.status)) {
    return mapPayment(payment);
  }

  const expectedAmount = Number(payment.final_amount || payment.amount || 0);
  if (Number(amount) !== expectedAmount) {
    throw new HttpError(
      400,
      `Amount mismatch. Expected ${expectedAmount} but received ${amount}`
    );
  }

  const expectedContent = String(payment.transfer_content || payment.payment_code || '').trim();
  if (String(transfer_content || '').trim() !== expectedContent) {
    throw new HttpError(400, 'Transfer content mismatch');
  }

  if (String(status || 'success').toLowerCase() !== 'success') {
    throw new HttpError(400, 'Bank webhook status must be success');
  }

  return confirmPayment({
    payment_code,
    success: true,
    gateway_transaction_id: bank_transaction_id || `BANK-${Date.now()}`,
    gateway_response: {
      provider: 'BANK_QR',
      source: 'bank_webhook',
      bank_name: bank_name || config.bankQr.bankName,
      raw_payload: raw_payload || null,
      received_at: new Date().toISOString(),
    },
  });
};

const handleSepayIpn = async ({
  notification_type,
  secret_key,
  order,
  transaction,
  customer,
  raw_payload,
}) => {
  if (config.sepay.secretKey && secret_key !== config.sepay.secretKey) {
    throw new HttpError(401, 'Invalid SePay secret key');
  }

  const paymentCode = String(order.order_invoice_number || '').trim();
  if (!paymentCode) {
    throw new HttpError(400, 'order.order_invoice_number is required');
  }

  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) {
    throw new HttpError(404, 'Payment not found');
  }

  const expectedAmount = Number(payment.final_amount || payment.amount || 0);
  const orderAmount = Number(order.order_amount || 0);
  const transactionAmount = Number(
    (transaction && transaction.transaction_amount) || order.order_amount || 0
  );
  const receivedAmount = transactionAmount || orderAmount;

  if (receivedAmount !== expectedAmount) {
    throw new HttpError(
      400,
      `Amount mismatch. Expected ${expectedAmount} but received ${receivedAmount}`
    );
  }

  if (notification_type === 'ORDER_PAID') {
    if (isTerminalPaidStatus(payment.status)) {
      return mapPayment(payment);
    }

    return confirmPayment({
      payment_code: paymentCode,
      success: true,
      gateway_transaction_id:
        (transaction && transaction.transaction_id) ||
        order.order_id ||
        `SEPAY-${Date.now()}`,
      gateway_response: {
        provider: 'SEPAY',
        source: 'ipn',
        notification_type,
        order,
        transaction,
        customer,
        raw_payload,
        received_at: new Date().toISOString(),
      },
    });
  }

  if (notification_type === 'TRANSACTION_VOID') {
    if (isTerminalCancelledStatus(payment.status)) {
      return mapPayment(payment);
    }

    const query = `select * from cancel_payment($1)`;
    const values = [paymentCode];
    const { rows } = await db.query(query, values);
    return mapPayment(rows[0]);
  }

  return mapPayment(payment);
};

const buildSepayCheckoutHtml = async (paymentCode) => {
  const payment = await getPaymentByCodeRow(paymentCode);
  if (!payment) {
    throw new HttpError(404, 'Payment not found');
  }

  if (String(payment.payment_method).toUpperCase() !== 'BANK_QR') {
    throw new HttpError(400, 'SePay checkout is only enabled for BANK_QR payments');
  }

  let checkout = null;
  const gatewayResponse = payment.gateway_response || {};

  if (
    gatewayResponse &&
    gatewayResponse.provider === 'SEPAY' &&
    gatewayResponse.checkout_url &&
    gatewayResponse.checkout_form_fields
  ) {
    checkout = {
      checkout_url: gatewayResponse.checkout_url,
      checkout_form_fields: gatewayResponse.checkout_form_fields,
      redirect_url: gatewayResponse.redirect_url || null,
      ipn_url: gatewayResponse.ipn_url || null,
      payment_method: gatewayResponse.payment_method || null,
      order_invoice_number: gatewayResponse.order_invoice_number || payment.payment_code,
    };
  } else {
    checkout = createSepayCheckoutInstruction(payment);
  }

  return buildAutoSubmitCheckoutHtml({ payment, checkout });
};

module.exports = {
  initPayment,
  getPaymentByCode,
  confirmPayment,
  cancelPayment,
  handleBankWebhook,
  handleSepayIpn,
  buildSepayCheckoutHtml,
};

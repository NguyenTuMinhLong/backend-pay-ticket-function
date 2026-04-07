const { Resend } = require('resend');
const config = require('../config/payment');

const formatCurrency = (value) => {
  const amount = Number(value || 0);
  return `${amount.toLocaleString('en-US')} VND`;
};

const formatAmountWithCurrency = (value, currency = 'VND') => {
  const amount = Number(value || 0);
  return `${amount.toLocaleString('en-US')} ${String(currency || 'VND').toUpperCase()}`;
};

const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString('en-US', {
    hour12: false,
  });
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sendEmail = async ({ to, subject, html, text }) => {
  try {
    if (!config.email.enabled) {
      return {
        sent: false,
        skipped: true,
        reason: 'Email is disabled',
      };
    }

    const recipient = config.email.testOverride || to;
    if (!recipient) {
      return {
        sent: false,
        skipped: true,
        reason: 'Recipient email is missing',
      };
    }

    const resend = new Resend(config.email.apiKey);
    const response = await resend.emails.send({
      from: config.email.from,
      to: recipient,
      subject,
      html,
      text,
    });

    return {
      sent: true,
      to: recipient,
      provider: 'resend',
      response,
    };
  } catch (error) {
    return {
      sent: false,
      error: {
        statusCode: error?.statusCode || null,
        name: error?.name || 'email_error',
        message: error?.message || 'Unknown email error',
      },
    };
  }
};

const buildInstructionBlock = ({ payment, instruction }) => {
  if (!instruction) return '';

  const amount = instruction.amount || payment.final_amount || payment.amount || 0;

  if (instruction.type === 'MOMO') {
    const qrImageUrl = instruction.qr_code_url || instruction.qr_payload || '';
    const payUrl = instruction.pay_url || '';
    const deeplink = instruction.deeplink || '';

    return `
      <div style="background:#fff1f7;padding:16px;border-radius:12px;margin-top:16px;border:1px solid #fbcfe8;">
        <p style="margin:0 0 10px;"><strong>Method:</strong> MoMo</p>
        <p style="margin:0 0 10px;"><strong>Amount:</strong> ${escapeHtml(formatCurrency(amount))}</p>
        <p style="margin:0 0 10px;"><strong>Payment Code:</strong> ${escapeHtml(payment.payment_code)}</p>
        ${payUrl ? `<p style="margin:0 0 10px;"><strong>Pay URL:</strong> <a href="${escapeHtml(payUrl)}">Open MoMo payment</a></p>` : ''}
        ${deeplink ? `<p style="margin:0 0 10px;"><strong>Deep Link:</strong> ${escapeHtml(deeplink)}</p>` : ''}
        ${
          qrImageUrl
            ? `<div style="margin-top:16px;">
                 <p style="margin:0 0 10px;"><strong>MoMo QR Code:</strong></p>
                 <img
                   src="${escapeHtml(qrImageUrl)}"
                   alt="MoMo QR Code"
                   style="max-width:240px;width:100%;height:auto;border:1px solid #fbcfe8;border-radius:12px;background:#fff;padding:8px;"
                 />
               </div>`
            : ''
        }
      </div>
    `;
  }

  if (instruction.type === 'PAYPAL') {
    const approveUrl = instruction.redirect_url || instruction.approve_url || '';
    const currency = instruction.currency || 'VND';

    return `
      <div style="background:#fff7ed;padding:16px;border-radius:12px;margin-top:16px;border:1px solid #fed7aa;">
        <p style="margin:0 0 10px;"><strong>Method:</strong> PayPal</p>
        <p style="margin:0 0 10px;"><strong>Amount:</strong> ${escapeHtml(formatAmountWithCurrency(amount, currency))}</p>
        <p style="margin:0 0 10px;"><strong>Payment Code:</strong> ${escapeHtml(payment.payment_code)}</p>
        ${instruction.order_id ? `<p style="margin:0 0 10px;"><strong>Order ID:</strong> ${escapeHtml(instruction.order_id)}</p>` : ''}
        ${instruction.currency ? `<p style="margin:0 0 10px;"><strong>Currency:</strong> ${escapeHtml(currency)}</p>` : ''}
        ${approveUrl ? `<p style="margin:0 0 10px;"><strong>Checkout URL:</strong> <a href="${escapeHtml(approveUrl)}">Open PayPal checkout</a></p>` : ''}
      </div>
    `;
  }

  if (instruction.type === 'PAYOS_CHECKOUT') {
    const checkoutUrl = instruction.redirect_url || instruction.checkout_url || '';

    return `
      <div style="background:#eefbf3;padding:16px;border-radius:12px;margin-top:16px;border:1px solid #bbf7d0;">
        <p style="margin:0 0 10px;"><strong>Method:</strong> payOS</p>
        <p style="margin:0 0 10px;"><strong>Amount:</strong> ${escapeHtml(formatCurrency(amount))}</p>
        <p style="margin:0 0 10px;"><strong>Payment Code:</strong> ${escapeHtml(payment.payment_code)}</p>
        ${instruction.order_code ? `<p style="margin:0 0 10px;"><strong>Order Code:</strong> ${escapeHtml(String(instruction.order_code))}</p>` : ''}
        ${instruction.bank_bin ? `<p style="margin:0 0 10px;"><strong>Bank BIN:</strong> ${escapeHtml(String(instruction.bank_bin))}</p>` : ''}
        ${instruction.bank_account ? `<p style="margin:0 0 10px;"><strong>Account Number:</strong> ${escapeHtml(instruction.bank_account)}</p>` : ''}
        ${instruction.account_name ? `<p style="margin:0 0 10px;"><strong>Account Name:</strong> ${escapeHtml(instruction.account_name)}</p>` : ''}
        <p style="margin:0 0 10px;"><strong>Transfer Content:</strong> ${escapeHtml(instruction.description || payment.payment_code)}</p>
        ${checkoutUrl ? `<p style="margin:0 0 10px;"><strong>Checkout URL:</strong> <a href="${escapeHtml(checkoutUrl)}">Open payOS checkout</a></p>` : ''}
      </div>
    `;
  }

  const qrImageUrl = instruction.qr_image_url || instruction.qr_payload || '';
  const bankName = instruction.bank_name || config.bankQr.bankName || 'VietinBank';
  const accountName = instruction.account_name || config.bankQr.accountName || '';
  const accountNumber =
    instruction.bank_account || instruction.account_number || config.bankQr.accountNumber || '';
  const transferContent = instruction.transfer_content || payment.payment_code;

  return `
    <div style="background:#eef5ff;padding:16px;border-radius:12px;margin-top:16px;">
      <p style="margin:0 0 10px;"><strong>Method:</strong> Bank Transfer</p>
      <p style="margin:0 0 10px;"><strong>Bank:</strong> ${escapeHtml(bankName)}</p>
      <p style="margin:0 0 10px;"><strong>Account Number:</strong> ${escapeHtml(accountNumber)}</p>
      <p style="margin:0 0 10px;"><strong>Account Name:</strong> ${escapeHtml(accountName)}</p>
      <p style="margin:0 0 10px;"><strong>Amount:</strong> ${escapeHtml(formatCurrency(amount))}</p>
      <p style="margin:0 0 10px;"><strong>Transfer Content:</strong> ${escapeHtml(transferContent)}</p>
      ${
        qrImageUrl
          ? `<div style="margin-top:16px;">
               <p style="margin:0 0 10px;"><strong>Payment QR Code:</strong></p>
               <img
                 src="${escapeHtml(qrImageUrl)}"
                 alt="Payment QR Code"
                 style="max-width:240px;width:100%;height:auto;border:1px solid #dbeafe;border-radius:12px;background:#fff;padding:8px;"
               />
             </div>`
          : ''
      }
    </div>
  `;
};

const buildPaymentPendingEmailHtml = ({ payment, instruction }) => {
  const amount = payment.final_amount || payment.amount || 0;
  const expiresAt = payment.expires_at || '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Booking Payment</title>
  </head>
  <body style="margin:0;padding:24px;background:#f3f6fb;font-family:Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e5e7eb;">
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:28px;font-weight:700;color:#1e3a8a;">Vivudee</div>
        <div style="font-size:12px;color:#64748b;">Your Journey Starts Here</div>
      </div>

      <h1 style="margin:0 0 18px;font-size:20px;line-height:1.5;text-align:center;">
        Complete your booking payment within 15 minutes
      </h1>

      <p style="margin:0 0 16px;line-height:1.7;">
        Hello, your payment transaction has been successfully created.
      </p>

      <p style="margin:0 0 10px;"><strong>Payment Code:</strong> ${escapeHtml(payment.payment_code)}</p>
      <p style="margin:0 0 10px;"><strong>Method:</strong> ${escapeHtml(payment.payment_method)}</p>
      <p style="margin:0 0 10px;"><strong>Amount:</strong> ${escapeHtml(formatCurrency(amount))}</p>
      <p style="margin:0 0 10px;"><strong>Expires At:</strong> ${escapeHtml(formatDateTime(expiresAt))}</p>

      ${buildInstructionBlock({ payment, instruction })}

      <p style="margin:24px 0 0;line-height:1.7;color:#475569;">
        If you have already completed the payment, please ignore this email.
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

      <p style="margin:0;text-align:center;color:#94a3b8;font-size:14px;">
        If you did not initiate this request, please ignore this email.
      </p>
    </div>
  </body>
</html>`;
};

const buildPaymentPendingEmailText = ({ payment, instruction }) => {
  const lines = [
    'Booking Payment',
    '',
    `Payment Code: ${payment.payment_code}`,
    `Method: ${payment.payment_method}`,
    `Amount: ${formatCurrency(payment.final_amount || payment.amount || 0)}`,
    `Expires At: ${formatDateTime(payment.expires_at)}`,
    '',
  ];

  if (instruction) {
    if (instruction.type === 'MOMO') {
      lines.push('Provider: MoMo');
      lines.push(`Payment Code: ${payment.payment_code}`);
      if (instruction.pay_url) lines.push(`Pay URL: ${instruction.pay_url}`);
      if (instruction.deeplink) lines.push(`Deep Link: ${instruction.deeplink}`);
      if (instruction.qr_code_url || instruction.qr_payload) {
        lines.push(`QR Code: ${instruction.qr_code_url || instruction.qr_payload}`);
      }
    } else if (instruction.type === 'PAYPAL') {
      lines.push('Provider: PayPal');
      lines.push(`Payment Code: ${payment.payment_code}`);
      if (instruction.order_id) lines.push(`Order ID: ${instruction.order_id}`);
      if (instruction.currency) lines.push(`Currency: ${instruction.currency}`);
      if (instruction.redirect_url || instruction.approve_url) {
        lines.push(`Checkout URL: ${instruction.redirect_url || instruction.approve_url}`);
      }
    } else if (instruction.type === 'PAYOS_CHECKOUT') {
      lines.push('Provider: payOS');
      lines.push(`Payment Code: ${payment.payment_code}`);
      if (instruction.order_code) lines.push(`Order Code: ${instruction.order_code}`);
      if (instruction.bank_bin) lines.push(`Bank BIN: ${instruction.bank_bin}`);
      if (instruction.bank_account) lines.push(`Account Number: ${instruction.bank_account}`);
      if (instruction.account_name) lines.push(`Account Name: ${instruction.account_name}`);
      lines.push(`Transfer Content: ${instruction.description || payment.payment_code}`);
      if (instruction.redirect_url || instruction.checkout_url) {
        lines.push(`Checkout URL: ${instruction.redirect_url || instruction.checkout_url}`);
      }
    } else {
      lines.push(`Bank: ${instruction.bank_name || config.bankQr.bankName || ''}`);
      lines.push(
        `Account Number: ${instruction.bank_account || instruction.account_number || config.bankQr.accountNumber || ''}`
      );
      lines.push(`Account Name: ${instruction.account_name || config.bankQr.accountName || ''}`);
      lines.push(`Transfer Content: ${instruction.transfer_content || payment.payment_code}`);
      if (instruction.qr_image_url || instruction.qr_payload) {
        lines.push(`QR Code: ${instruction.qr_image_url || instruction.qr_payload}`);
      }
    }
  }

  lines.push('', 'If you have already completed the payment, please ignore this email.');
  return lines.join('\n');
};

const buildTicketIssuedEmailHtml = ({ booking, tickets }) => {
  const first = tickets[0] || {};

  const bookingCode = booking.booking_code || '';
  const bookingStatus = booking.status || first.booking_status || 'CONFIRMED';
  const airlineName = 'Vivudee Air';
  const flightNumber = first.outbound_flight_number || '';
  const tripDate = formatDateTime(first.outbound_departure_time);
  const departureCode = first.outbound_departure_airport_code || '';
  const departureName = first.outbound_departure_airport_name || '';
  const arrivalCode = first.outbound_arrival_airport_code || '';
  const arrivalName = first.outbound_arrival_airport_name || '';

  const passengerRows = tickets
    .map((ticket, index) => {
      const baggageKg = Number(ticket.baggage_kg || 0);
      const extraBaggageKg = Number(ticket.extra_baggage_kg || 0);
      const checkedBaggage = baggageKg + extraBaggageKg;
      const seatNumber = ticket.seat_number || '';

      return `
        <tr>
          <td style="padding:14px 12px;border-top:1px solid #e5e7eb;vertical-align:top;width:44px;">
            <div style="font-weight:700;color:#0f172a;">${index + 1}.</div>
          </td>
          <td style="padding:14px 12px;border-top:1px solid #e5e7eb;vertical-align:top;">
            <div style="font-size:15px;font-weight:700;color:#111827;">
              ${escapeHtml(ticket.full_name || '')}
            </div>
            <div style="margin-top:4px;font-size:12px;color:#64748b;">
              ${escapeHtml(ticket.gender || '')}${ticket.date_of_birth ? ` • ${escapeHtml(String(ticket.date_of_birth))}` : ''}
            </div>
            <div style="margin-top:8px;font-size:13px;color:#334155;">
              <strong>Ticket Number:</strong> ${escapeHtml(ticket.ticket_number || '')}
            </div>
            <div style="margin-top:4px;font-size:13px;color:#334155;">
              <strong>Status:</strong> ${escapeHtml(ticket.ticket_status || '')}
            </div>
            ${
              ticket.issued_at
                ? `<div style="margin-top:4px;font-size:13px;color:#334155;">
                    <strong>Issued At:</strong> ${escapeHtml(formatDateTime(ticket.issued_at))}
                  </div>`
                : ''
            }
          </td>
          <td style="padding:14px 12px;border-top:1px solid #e5e7eb;vertical-align:top;">
            <div style="font-size:13px;color:#334155;">
              ${escapeHtml(departureCode)} - ${escapeHtml(arrivalCode)}
            </div>
            ${
              seatNumber
                ? `<div style="margin-top:8px;font-size:13px;color:#334155;">
                    Seat: ${escapeHtml(seatNumber)}
                  </div>`
                : ''
            }
            <div style="margin-top:8px;font-size:13px;color:#334155;">
              Cabin baggage: 7KG
            </div>
            ${
              checkedBaggage > 0
                ? `<div style="margin-top:4px;font-size:13px;color:#334155;">
                    Checked baggage: ${escapeHtml(String(checkedBaggage))}KG
                  </div>`
                : ''
            }
            <div style="margin-top:4px;font-size:13px;color:#334155;">
              Please bring your ID/Passport for check-in
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  const returnFlightBlock = first.return_flight_number
    ? `
      <div style="margin-top:20px;padding:18px;border:1px solid #dbeafe;border-radius:14px;background:#f8fbff;">
        <div style="font-size:16px;font-weight:700;color:#1e3a8a;">Return Flight</div>
        <div style="margin-top:10px;font-size:14px;color:#334155;">
          <strong>Flight:</strong> ${escapeHtml(first.return_flight_number || '')}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Departure:</strong> ${escapeHtml(first.return_departure_airport_code || '')} - ${escapeHtml(first.return_departure_airport_name || '')}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Arrival:</strong> ${escapeHtml(first.return_arrival_airport_code || '')} - ${escapeHtml(first.return_arrival_airport_name || '')}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Departure Time:</strong> ${escapeHtml(formatDateTime(first.return_departure_time))}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Arrival Time:</strong> ${escapeHtml(formatDateTime(first.return_arrival_time))}
        </div>
      </div>
    `
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>E-ticket</title>
  </head>
  <body style="margin:0;padding:24px;background:#eef2f7;font-family:Arial,sans-serif;color:#0f172a;">
    <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dbe3ee;">
      <div style="background:linear-gradient(135deg,#0f62fe 0%,#60a5fa 100%);padding:22px 28px;color:#ffffff;">
        <table role="presentation" style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:34px;font-weight:800;line-height:1;">E-ticket</div>
              <div style="font-size:16px;opacity:.95;">Electronic Ticket</div>
              <div style="margin-top:18px;font-size:14px;opacity:.95;">${escapeHtml(airlineName)}</div>
              <div style="margin-top:4px;font-size:24px;font-weight:700;">${escapeHtml(flightNumber)}</div>
              <div style="margin-top:8px;font-size:14px;opacity:.92;">${escapeHtml(tripDate)}</div>
            </td>
            <td style="vertical-align:top;text-align:right;">
              <div style="font-size:13px;opacity:.9;">Booking Code</div>
              <div style="font-size:26px;font-weight:800;margin-top:2px;">${escapeHtml(bookingCode)}</div>
              <div style="margin-top:14px;font-size:13px;opacity:.9;">Booking Status</div>
              <div style="display:inline-block;margin-top:6px;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.18);font-size:12px;font-weight:700;">
                ${escapeHtml(bookingStatus)}
              </div>
            </td>
          </tr>
        </table>
      </div>

      <div style="padding:28px;">
        <table role="presentation" style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="width:42%;vertical-align:top;padding-right:12px;">
              <div style="font-size:15px;color:#64748b;margin-bottom:6px;">Departure</div>
              <div style="font-size:32px;font-weight:800;color:#0f172a;">${escapeHtml(departureCode)}</div>
              <div style="font-size:18px;font-weight:700;color:#1f2937;margin-top:4px;">${escapeHtml(departureName)}</div>
              <div style="font-size:14px;color:#475569;margin-top:8px;">
                ${escapeHtml(formatDateTime(first.outbound_departure_time))}
              </div>
            </td>
            <td style="width:16%;vertical-align:middle;text-align:center;">
              <div style="font-size:28px;color:#3b82f6;">✈</div>
              <div style="margin-top:4px;font-size:12px;color:#64748b;">Direct Flight</div>
            </td>
            <td style="width:42%;vertical-align:top;padding-left:12px;">
              <div style="font-size:15px;color:#64748b;margin-bottom:6px;">Arrival</div>
              <div style="font-size:32px;font-weight:800;color:#0f172a;">${escapeHtml(arrivalCode)}</div>
              <div style="font-size:18px;font-weight:700;color:#1f2937;margin-top:4px;">${escapeHtml(arrivalName)}</div>
              <div style="font-size:14px;color:#475569;margin-top:8px;">
                ${escapeHtml(formatDateTime(first.outbound_arrival_time))}
              </div>
            </td>
          </tr>
        </table>

        <div style="margin-top:22px;padding:16px 18px;border:1px solid #e5e7eb;border-radius:14px;background:#f8fafc;">
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="font-size:13px;color:#334155;padding:4px 0;">Please bring your ID/Passport for check-in</td>
              <td style="font-size:13px;color:#334155;padding:4px 0;">Please arrive at the airport at least 90 minutes before departure</td>
            </tr>
          </table>
        </div>

        ${returnFlightBlock}

        <div style="margin-top:28px;">
          <div style="font-size:28px;font-weight:800;color:#0f172a;">Passenger Details</div>
          <div style="font-size:14px;color:#64748b;margin-top:4px;">Passenger information</div>

          <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:16px;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="padding:14px 12px;text-align:left;font-size:13px;color:#475569;">No.</th>
                <th style="padding:14px 12px;text-align:left;font-size:13px;color:#475569;">Passenger(s)</th>
                <th style="padding:14px 12px;text-align:left;font-size:13px;color:#475569;">Route / Facilities</th>
              </tr>
            </thead>
            <tbody>
              ${passengerRows}
            </tbody>
          </table>
        </div>

        <div style="margin-top:24px;padding:18px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe;">
          <div style="font-size:14px;color:#1e3a8a;font-weight:700;">Ticket Information</div>
          <div style="margin-top:8px;font-size:14px;color:#334155;">
            Ticket email: ${escapeHtml(booking.contact_email || '')}
          </div>
          <div style="margin-top:6px;font-size:14px;color:#334155;">
            Booking code: ${escapeHtml(bookingCode)}
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
};

const buildTicketIssuedEmailText = ({ booking, tickets }) => {
  const first = tickets[0] || {};
  const lines = [
    'E-TICKET',
    '',
    `Booking Code: ${booking.booking_code || ''}`,
    `Status: ${booking.status || first.booking_status || ''}`,
    `Flight: ${first.outbound_flight_number || ''}`,
    `Departure: ${first.outbound_departure_airport_code || ''} - ${first.outbound_departure_airport_name || ''}`,
    `Arrival: ${first.outbound_arrival_airport_code || ''} - ${first.outbound_arrival_airport_name || ''}`,
    `Departure Time: ${formatDateTime(first.outbound_departure_time)}`,
    `Arrival Time: ${formatDateTime(first.outbound_arrival_time)}`,
    '',
    'Passenger Details:',
  ];

  tickets.forEach((ticket, index) => {
    const baggageKg = Number(ticket.baggage_kg || 0);
    const extraBaggageKg = Number(ticket.extra_baggage_kg || 0);
    const checkedBaggage = baggageKg + extraBaggageKg;
    const seatText = ticket.seat_number ? ` | Seat ${ticket.seat_number}` : '';
    const baggageText = checkedBaggage > 0 ? ` | Baggage ${checkedBaggage}KG` : '';

    lines.push(
      `${index + 1}. ${ticket.full_name || ''} | ${ticket.ticket_number || ''} | ${ticket.ticket_status || ''}${seatText}${baggageText}`
    );
  });

  if (first.return_flight_number) {
    lines.push(
      '',
      'Return Flight:',
      `Flight: ${first.return_flight_number || ''}`,
      `Departure: ${first.return_departure_airport_code || ''} - ${first.return_departure_airport_name || ''}`,
      `Arrival: ${first.return_arrival_airport_code || ''} - ${first.return_arrival_airport_name || ''}`,
      `Departure Time: ${formatDateTime(first.return_departure_time)}`,
      `Arrival Time: ${formatDateTime(first.return_arrival_time)}`
    );
  }

  lines.push(
    '',
    `Ticket email: ${booking.contact_email || ''}`,
    'Please bring your identification documents for check-in.'
  );

  return lines.join('\n');
};

const sendPaymentPendingEmail = async ({ payment, instruction, email }) => {
  const subject = `Booking Payment ${payment.payment_code}`;
  const html = buildPaymentPendingEmailHtml({ payment, instruction });
  const text = buildPaymentPendingEmailText({ payment, instruction });
  return sendEmail({ to: email, subject, html, text });
};

const sendTicketIssuedEmail = async ({ booking, tickets, email }) => {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return {
      sent: false,
      skipped: true,
      reason: 'Ticket list is empty',
    };
  }

  const subject = `E-ticket for booking ${booking.booking_code || ''}`.trim();
  const html = buildTicketIssuedEmailHtml({ booking, tickets });
  const text = buildTicketIssuedEmailText({ booking, tickets });
  return sendEmail({ to: email || booking.contact_email, subject, html, text });
};

module.exports = {
  sendPaymentPendingEmail,
  sendTicketIssuedEmail,
};

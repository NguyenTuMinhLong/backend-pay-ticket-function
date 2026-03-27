const { Resend } = require('resend');
const config = require('../config/payment');

const formatCurrency = (value) => {
  const amount = Number(value || 0);
  return `${amount.toLocaleString('vi-VN')} đ`;
};

const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString('vi-VN', {
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

  const qrImageUrl = instruction.qr_image_url || instruction.qr_payload || '';
  const bankName = instruction.bank_name || config.bankQr.bankName || 'VietinBank';
  const accountName = instruction.account_name || config.bankQr.accountName || '';
  const accountNumber =
    instruction.bank_account || instruction.account_number || config.bankQr.accountNumber || '';
  const transferContent = instruction.transfer_content || payment.payment_code;
  const amount = instruction.amount || payment.final_amount || payment.amount || 0;

  return `
    <div style="background:#eef5ff;padding:16px;border-radius:12px;margin-top:16px;">
      <p style="margin:0 0 10px;"><strong>Phương thức:</strong> Chuyển khoản ngân hàng</p>
      <p style="margin:0 0 10px;"><strong>Ngân hàng:</strong> ${escapeHtml(bankName)}</p>
      <p style="margin:0 0 10px;"><strong>Số tài khoản:</strong> ${escapeHtml(accountNumber)}</p>
      <p style="margin:0 0 10px;"><strong>Chủ tài khoản:</strong> ${escapeHtml(accountName)}</p>
      <p style="margin:0 0 10px;"><strong>Số tiền:</strong> ${escapeHtml(formatCurrency(amount))}</p>
      <p style="margin:0 0 10px;"><strong>Nội dung chuyển khoản:</strong> ${escapeHtml(transferContent)}</p>
      ${
        qrImageUrl
          ? `<div style="margin-top:16px;">
               <p style="margin:0 0 10px;"><strong>Mã QR thanh toán:</strong></p>
               <img
                 src="${escapeHtml(qrImageUrl)}"
                 alt="QR thanh toán"
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
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Thanh toán đơn đặt chỗ</title>
  </head>
  <body style="margin:0;padding:24px;background:#f3f6fb;font-family:Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e5e7eb;">
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:28px;font-weight:700;color:#1e3a8a;">Vivudee</div>
        <div style="font-size:12px;color:#64748b;">Your Journey Starts Here</div>
      </div>

      <h1 style="margin:0 0 18px;font-size:20px;line-height:1.5;text-align:center;">
        Thanh toán đơn đặt chỗ trong 15 phút
      </h1>

      <p style="margin:0 0 16px;line-height:1.7;">
        Xin chào, giao dịch thanh toán của bạn đã được tạo thành công.
      </p>

      <p style="margin:0 0 10px;"><strong>Mã thanh toán:</strong> ${escapeHtml(payment.payment_code)}</p>
      <p style="margin:0 0 10px;"><strong>Phương thức:</strong> ${escapeHtml(payment.payment_method)}</p>
      <p style="margin:0 0 10px;"><strong>Số tiền:</strong> ${escapeHtml(formatCurrency(amount))}</p>
      <p style="margin:0 0 10px;"><strong>Hiệu lực đến:</strong> ${escapeHtml(formatDateTime(expiresAt))}</p>

      ${buildInstructionBlock({ payment, instruction })}

      <p style="margin:24px 0 0;line-height:1.7;color:#475569;">
        Nếu bạn đã thanh toán, vui lòng bỏ qua email này.
      </p>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

      <p style="margin:0;text-align:center;color:#94a3b8;font-size:14px;">
        Nếu bạn không thực hiện thao tác này, vui lòng bỏ qua email.
      </p>
    </div>
  </body>
</html>`;
};

const buildPaymentPendingEmailText = ({ payment, instruction }) => {
  const lines = [
    'Thanh toán đơn đặt chỗ',
    '',
    `Mã thanh toán: ${payment.payment_code}`,
    `Phương thức: ${payment.payment_method}`,
    `Số tiền: ${formatCurrency(payment.final_amount || payment.amount || 0)}`,
    `Hiệu lực đến: ${formatDateTime(payment.expires_at)}`,
    '',
  ];

  if (instruction) {
    lines.push(`Ngân hàng: ${instruction.bank_name || config.bankQr.bankName || ''}`);
    lines.push(`Số tài khoản: ${instruction.bank_account || instruction.account_number || config.bankQr.accountNumber || ''}`);
    lines.push(`Chủ tài khoản: ${instruction.account_name || config.bankQr.accountName || ''}`);
    lines.push(`Nội dung chuyển khoản: ${instruction.transfer_content || payment.payment_code}`);
    if (instruction.qr_image_url || instruction.qr_payload) {
      lines.push(`QR: ${instruction.qr_image_url || instruction.qr_payload}`);
    }
  }

  lines.push('', 'Nếu bạn đã thanh toán, vui lòng bỏ qua email này.');
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
              <strong>Mã vé:</strong> ${escapeHtml(ticket.ticket_number || '')}
            </div>
            <div style="margin-top:4px;font-size:13px;color:#334155;">
              <strong>Trạng thái:</strong> ${escapeHtml(ticket.ticket_status || '')}
            </div>
            ${
              ticket.issued_at
                ? `<div style="margin-top:4px;font-size:13px;color:#334155;">
                    <strong>Xuất lúc:</strong> ${escapeHtml(formatDateTime(ticket.issued_at))}
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
                    Ghế: ${escapeHtml(seatNumber)}
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
              Vui lòng mang CCCD/hộ chiếu khi làm thủ tục
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  const returnFlightBlock = first.return_flight_number
    ? `
      <div style="margin-top:20px;padding:18px;border:1px solid #dbeafe;border-radius:14px;background:#f8fbff;">
        <div style="font-size:16px;font-weight:700;color:#1e3a8a;">Chiều về / Return Flight</div>
        <div style="margin-top:10px;font-size:14px;color:#334155;">
          <strong>Chuyến bay:</strong> ${escapeHtml(first.return_flight_number || '')}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Khởi hành:</strong> ${escapeHtml(first.return_departure_airport_code || '')} - ${escapeHtml(first.return_departure_airport_name || '')}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Đến:</strong> ${escapeHtml(first.return_arrival_airport_code || '')} - ${escapeHtml(first.return_arrival_airport_name || '')}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Giờ đi:</strong> ${escapeHtml(formatDateTime(first.return_departure_time))}
        </div>
        <div style="margin-top:6px;font-size:14px;color:#334155;">
          <strong>Giờ đến:</strong> ${escapeHtml(formatDateTime(first.return_arrival_time))}
        </div>
      </div>
    `
    : '';

  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vé điện tử</title>
  </head>
  <body style="margin:0;padding:24px;background:#eef2f7;font-family:Arial,sans-serif;color:#0f172a;">
    <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dbe3ee;">
      <div style="background:linear-gradient(135deg,#0f62fe 0%,#60a5fa 100%);padding:22px 28px;color:#ffffff;">
        <table role="presentation" style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:34px;font-weight:800;line-height:1;">E-ticket</div>
              <div style="font-size:16px;opacity:.95;">Vé điện tử</div>
              <div style="margin-top:18px;font-size:14px;opacity:.95;">${escapeHtml(airlineName)}</div>
              <div style="margin-top:4px;font-size:24px;font-weight:700;">${escapeHtml(flightNumber)}</div>
              <div style="margin-top:8px;font-size:14px;opacity:.92;">${escapeHtml(tripDate)}</div>
            </td>
            <td style="vertical-align:top;text-align:right;">
              <div style="font-size:13px;opacity:.9;">Booking code</div>
              <div style="font-size:26px;font-weight:800;margin-top:2px;">${escapeHtml(bookingCode)}</div>
              <div style="margin-top:14px;font-size:13px;opacity:.9;">Tình trạng booking</div>
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
              <div style="font-size:15px;color:#64748b;margin-bottom:6px;">Khởi hành</div>
              <div style="font-size:32px;font-weight:800;color:#0f172a;">${escapeHtml(departureCode)}</div>
              <div style="font-size:18px;font-weight:700;color:#1f2937;margin-top:4px;">${escapeHtml(departureName)}</div>
              <div style="font-size:14px;color:#475569;margin-top:8px;">
                ${escapeHtml(formatDateTime(first.outbound_departure_time))}
              </div>
            </td>
            <td style="width:16%;vertical-align:middle;text-align:center;">
              <div style="font-size:28px;color:#3b82f6;">✈</div>
              <div style="margin-top:4px;font-size:12px;color:#64748b;">Bay thẳng</div>
            </td>
            <td style="width:42%;vertical-align:top;padding-left:12px;">
              <div style="font-size:15px;color:#64748b;margin-bottom:6px;">Điểm đến</div>
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
              <td style="font-size:13px;color:#334155;padding:4px 0;">Vui lòng mang CCCD/hộ chiếu để làm thủ tục</td>
              <td style="font-size:13px;color:#334155;padding:4px 0;">Có mặt tại sân bay ít nhất 90 phút trước giờ khởi hành</td>
            </tr>
          </table>
        </div>

        ${returnFlightBlock}

        <div style="margin-top:28px;">
          <div style="font-size:28px;font-weight:800;color:#0f172a;">Passenger Details</div>
          <div style="font-size:14px;color:#64748b;margin-top:4px;">Thông tin hành khách</div>

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
          <div style="font-size:14px;color:#1e3a8a;font-weight:700;">Thông tin nhận vé</div>
          <div style="margin-top:8px;font-size:14px;color:#334155;">
            Email nhận vé: ${escapeHtml(booking.contact_email || '')}
          </div>
          <div style="margin-top:6px;font-size:14px;color:#334155;">
            Mã đặt chỗ: ${escapeHtml(bookingCode)}
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
    'E-TICKET / VE DIEN TU',
    '',
    `Booking code: ${booking.booking_code || ''}`,
    `Trang thai: ${booking.status || first.booking_status || ''}`,
    `Chuyen bay: ${first.outbound_flight_number || ''}`,
    `Khoi hanh: ${first.outbound_departure_airport_code || ''} - ${first.outbound_departure_airport_name || ''}`,
    `Diem den: ${first.outbound_arrival_airport_code || ''} - ${first.outbound_arrival_airport_name || ''}`,
    `Gio di: ${formatDateTime(first.outbound_departure_time)}`,
    `Gio den: ${formatDateTime(first.outbound_arrival_time)}`,
    '',
    'Passenger Details:',
  ];

  tickets.forEach((ticket, index) => {
    const baggageKg = Number(ticket.baggage_kg || 0);
    const extraBaggageKg = Number(ticket.extra_baggage_kg || 0);
    const checkedBaggage = baggageKg + extraBaggageKg;
    const seatText = ticket.seat_number ? ` | Ghe ${ticket.seat_number}` : '';
    const baggageText = checkedBaggage > 0 ? ` | Hanh ly ${checkedBaggage}KG` : '';

    lines.push(
      `${index + 1}. ${ticket.full_name || ''} | ${ticket.ticket_number || ''} | ${ticket.ticket_status || ''}${seatText}${baggageText}`
    );
  });

  if (first.return_flight_number) {
    lines.push(
      '',
      'Return Flight:',
      `Chuyen bay: ${first.return_flight_number || ''}`,
      `Khoi hanh: ${first.return_departure_airport_code || ''} - ${first.return_departure_airport_name || ''}`,
      `Diem den: ${first.return_arrival_airport_code || ''} - ${first.return_arrival_airport_name || ''}`,
      `Gio di: ${formatDateTime(first.return_departure_time)}`,
      `Gio den: ${formatDateTime(first.return_arrival_time)}`
    );
  }

  lines.push(
    '',
    `Email nhan ve: ${booking.contact_email || ''}`,
    'Vui long mang giay to tuy than khi lam thu tuc.'
  );

  return lines.join('\n');
};

const sendPaymentPendingEmail = async ({ payment, instruction, email }) => {
  const subject = `Thanh toán đơn đặt chỗ ${payment.payment_code}`;
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

  const subject = `Ve dien tu booking ${booking.booking_code || ''}`.trim();
  const html = buildTicketIssuedEmailHtml({ booking, tickets });
  const text = buildTicketIssuedEmailText({ booking, tickets });
  return sendEmail({ to: email || booking.contact_email, subject, html, text });
};

module.exports = {
  sendPaymentPendingEmail,
  sendTicketIssuedEmail,
};
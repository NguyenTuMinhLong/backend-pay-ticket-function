const formatCurrencyVnd = (amount) => {
  const numeric = Number(amount || 0);
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(numeric);
};

const buildPaymentInstruction = ({ payment, providerPayload = {}, bankConfig, sepayConfig }) => {
  const method = String(payment.payment_method || payment.method || '').toUpperCase();
  const gatewayResponse = payment.gateway_response || {};
  const sepayPayload = providerPayload.provider === 'SEPAY' ? providerPayload : (gatewayResponse.provider === 'SEPAY' ? gatewayResponse : {});

  if (method === 'BANK_QR' && sepayPayload.provider === 'SEPAY') {
    return {
      type: 'SEPAY_CHECKOUT',
      provider: 'SEPAY',
      checkout_url: sepayPayload.checkout_url || null,
      checkout_form_fields: sepayPayload.checkout_form_fields || null,
      redirect_url: sepayPayload.redirect_url || null,
      ipn_url: sepayPayload.ipn_url || sepayConfig.ipnUrl || null,
      payment_method: sepayPayload.payment_method || sepayConfig.paymentMethod || 'BANK_TRANSFER',
      order_invoice_number: sepayPayload.order_invoice_number || payment.payment_code || null,
      note: 'Frontend chỉ cần redirect user sang redirect_url hoặc POST checkout_form_fields tới checkout_url để vào trang thanh toán SePay.',
      auto_confirm_ready: true,
      auto_confirm_note: 'SePay sẽ gọi IPN về backend khi đơn được thanh toán. Endpoint phải public HTTPS và trả về HTTP 200.',
    };
  }

  if (method === 'BANK_QR') {
    return {
      type: 'BANK_TRANSFER',
      qr_payload: providerPayload.qr_payload || payment.qr_payload || null,
      bank_name: providerPayload.bank_name || bankConfig.bankName || null,
      bank_code: providerPayload.bank_code || payment.bank_code || bankConfig.bankCode || null,
      bank_account: providerPayload.bank_account || payment.bank_account || bankConfig.accountNumber || null,
      account_name: providerPayload.account_name || bankConfig.accountName || null,
      transfer_content: providerPayload.transfer_content || payment.transfer_content || payment.payment_code || null,
      auto_confirm_ready: true,
      auto_confirm_note: 'VietQR itself does not notify your backend. Use POST /payments/webhook/bank from a reconciliation service or internal worker to auto-confirm and issue tickets.',
    };
  }

  if (method === 'MOMO') {
    return {
      type: 'MOMO',
      deeplink: providerPayload.deeplink || payment.deeplink || null,
      pay_url: providerPayload.pay_url || payment.pay_url || null,
      qr_payload: providerPayload.qr_payload || payment.qr_payload || null,
      note: 'MOMO is disabled in this version. Use SePay / BANK_QR flow instead.',
    };
  }

  return {
    type: 'MANUAL',
  };
};

module.exports = {
  formatCurrencyVnd,
  buildPaymentInstruction,
};

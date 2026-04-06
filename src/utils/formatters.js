const formatCurrencyVnd = (amount) => {
  const numeric = Number(amount || 0);
  return new Intl.NumberFormat('vi-VN', {
    style:                'currency',
    currency:             'VND',
    maximumFractionDigits: 0,
  }).format(numeric);
};

const buildPaymentInstruction = ({ payment, providerPayload = {}, bankConfig, sepayConfig, momoConfig }) => {
  const method          = String(payment.payment_method || payment.method || '').toUpperCase();
  const gatewayResponse = payment.gateway_response || {};

  const sepayPayload = providerPayload.provider === 'SEPAY'
    ? providerPayload
    : gatewayResponse.provider === 'SEPAY' ? gatewayResponse : {};

  // FIX: đọc momo payload từ providerPayload hoặc gateway_response
  const momoPayload = providerPayload.provider === 'MOMO'
    ? providerPayload
    : gatewayResponse.provider === 'MOMO' ? gatewayResponse : {};

  // Kiểm tra MoMo trước — ưu tiên providerPayload.provider hơn DB method
  // để tránh sai khi existing payment trong DB có payment_method khác (e.g. BANK_QR)
  if (method === 'MOMO' || momoPayload.provider === 'MOMO') {
    return {
      type:         'MOMO',
      provider:     'MOMO',
      pay_url:      momoPayload.pay_url      || payment.pay_url      || null,
      deeplink:     momoPayload.deeplink     || payment.deeplink     || null,
      qr_payload:   momoPayload.qr_payload   || payment.qr_payload   || null,
      qr_code_url:  momoPayload.qr_code_url  || null,
      order_id:     momoPayload.order_id     || payment.payment_code || null,
      request_id:   momoPayload.request_id   || null,
      redirect_url: momoConfig && momoConfig.redirectUrl ? momoConfig.redirectUrl : null,
      ipn_url:      momoConfig && momoConfig.ipnUrl      ? momoConfig.ipnUrl      : null,
      auto_confirm_ready: true,
      note: 'Frontend dùng pay_url để redirect user sang MoMo. Sau khi xong MoMo redirect về /payments/momo/return.',
    };
  }

  if (method === 'BANK_QR' && sepayPayload.provider === 'SEPAY') {
    return {
      type:                 'SEPAY_CHECKOUT',
      provider:             'SEPAY',
      checkout_url:         sepayPayload.checkout_url         || null,
      checkout_form_fields: sepayPayload.checkout_form_fields || null,
      redirect_url:         sepayPayload.redirect_url         || null,
      ipn_url:              sepayPayload.ipn_url || (sepayConfig && sepayConfig.ipnUrl) || null,
      payment_method:       sepayPayload.payment_method || (sepayConfig && sepayConfig.paymentMethod) || 'BANK_TRANSFER',
      order_invoice_number: sepayPayload.order_invoice_number || payment.payment_code || null,
      note:                 'Frontend redirect user sang redirect_url để vào trang thanh toán SePay.',
      auto_confirm_ready:   true,
    };
  }

  if (method === 'BANK_QR') {
    return {
      type:             'BANK_TRANSFER',
      qr_payload:       providerPayload.qr_payload      || payment.qr_payload  || null,
      bank_name:        providerPayload.bank_name        || (bankConfig && bankConfig.bankName) || null,
      bank_code:        providerPayload.bank_code        || payment.bank_code   || (bankConfig && bankConfig.bankCode) || null,
      bank_account:     providerPayload.bank_account     || payment.bank_account || (bankConfig && bankConfig.accountNumber) || null,
      account_name:     providerPayload.account_name     || (bankConfig && bankConfig.accountName) || null,
      transfer_content: providerPayload.transfer_content || payment.transfer_content || payment.payment_code || null,
      auto_confirm_ready: true,
      auto_confirm_note:  'Use POST /payments/webhook/bank to auto-confirm after reconciliation.',
    };
  }

  return { type: 'MANUAL' };
};

module.exports = {
  formatCurrencyVnd,
  buildPaymentInstruction,
};

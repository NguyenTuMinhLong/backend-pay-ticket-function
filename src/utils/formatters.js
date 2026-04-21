const formatCurrencyVnd = (amount) => {
  const numeric = Number(amount || 0);
  return new Intl.NumberFormat('vi-VN', {
    style:                'currency',
    currency:             'VND',
    maximumFractionDigits: 0,
  }).format(numeric);
};

const buildPaymentInstruction = ({ payment, providerPayload = {}, bankConfig, payosConfig, momoConfig, paypalConfig }) => {
  const method          = String(payment.payment_method || payment.method || '').toUpperCase();
  const gatewayResponse = payment.gateway_response || {};

  const payosPayload = providerPayload.provider === 'PAYOS'
    ? providerPayload
    : gatewayResponse.provider === 'PAYOS' ? gatewayResponse : {};

  // FIX: đọc momo payload từ providerPayload hoặc gateway_response
  const momoPayload = providerPayload.provider === 'MOMO'
    ? providerPayload
    : gatewayResponse.provider === 'MOMO' ? gatewayResponse : {};

  const paypalPayload = providerPayload.provider === 'PAYPAL'
    ? providerPayload
    : gatewayResponse.provider === 'PAYPAL' ? gatewayResponse : {};

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

  if (method === 'BANK_QR' && payosPayload.provider === 'PAYOS') {
    return {
      type:            'PAYOS_CHECKOUT',
      provider:        'PAYOS',
      checkout_url:    payosPayload.checkout_url || null,
      redirect_url:    payosPayload.redirect_url || payosPayload.checkout_url || null,
      webhook_url:     payosPayload.webhook_url || (payosConfig && payosConfig.webhookUrl) || null,
      return_url:      payosPayload.return_url || (payosConfig && payosConfig.returnUrl) || null,
      cancel_url:      payosPayload.cancel_url || (payosConfig && payosConfig.cancelUrl) || null,
      qr_code:         payosPayload.qr_code || null,
      payment_link_id: payosPayload.payment_link_id || null,
      order_code:      payosPayload.order_code || null,
      bank_bin:        payosPayload.bank_bin || null,
      bank_account:    payosPayload.bank_account || null,
      account_name:    payosPayload.account_name || null,
      description:     payosPayload.description || payment.payment_code || null,
      note:            'Frontend redirect user sang redirect_url để vào trang thanh toán payOS.',
      auto_confirm_ready:   true,
    };
  }

  if (method === 'PAYPAL' || paypalPayload.provider === 'PAYPAL') {
    return {
      type:         'PAYPAL',
      provider:     'PAYPAL',
      order_id:     paypalPayload.order_id || null,
      status:       paypalPayload.status || null,
      approve_url:  paypalPayload.approve_url || null,
      redirect_url: paypalPayload.redirect_url || paypalPayload.approve_url || null,
      return_url:   paypalPayload.return_url || (paypalConfig && paypalConfig.returnUrl) || null,
      cancel_url:   paypalPayload.cancel_url || (paypalConfig && paypalConfig.cancelUrl) || null,
      currency:     paypalPayload.currency_code || (paypalConfig && paypalConfig.currency) || payment.currency || null,
      amount:       paypalPayload.amount ?? payment.final_amount ?? payment.amount ?? null,
      environment:  paypalPayload.environment || (paypalConfig && paypalConfig.env) || null,
      auto_confirm_ready: true,
      note: 'Frontend redirect user sang approve_url để thanh toán PayPal sandbox.',
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

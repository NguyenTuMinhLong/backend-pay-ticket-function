const config = require('../config/payment');
const HttpError = require('../utils/httpError');

const createBankQrInstruction = (payment) => {
  const bank = config.bankQr;

  if (!bank.accountNumber || !bank.accountName) {
    throw new HttpError(
      500,
      'Bank QR config is incomplete. Please set BANK_QR_ACCOUNT_NUMBER and BANK_QR_ACCOUNT_NAME.'
    );
  }

  const amount = Number(payment.final_amount || payment.amount || 0);
  const transferContent = payment.payment_code;

  const qrUrl =
    `https://img.vietqr.io/image/` +
    `${encodeURIComponent(bank.bankCode)}-${encodeURIComponent(bank.accountNumber)}-${encodeURIComponent(bank.template)}.png` +
    `?amount=${encodeURIComponent(amount)}` +
    `&addInfo=${encodeURIComponent(transferContent)}` +
    `&accountName=${encodeURIComponent(bank.accountName)}`;

  return {
    qr_payload: qrUrl,
    qr_image_url: qrUrl,
    bank_code: bank.bankCode,
    bank_name: bank.bankName,
    bank_account: bank.accountNumber,
    account_name: bank.accountName,
    transfer_content: transferContent,
    amount,
  };
};

module.exports = {
  createBankQrInstruction,
};
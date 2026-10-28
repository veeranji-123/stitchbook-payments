const crypto = require('crypto');
const Razorpay = require('razorpay');
const { razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret } = require('./config');

const razorpay = razorpayKeyId && razorpayKeySecret
  ? new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret })
  : null;

function signaturesMatch(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function verifyPaymentSignature(orderId, paymentId, signature) {
  if (!razorpayKeySecret) return false;
  const expected = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return signaturesMatch(expected, signature);
}

function verifyWebhookSignature(payload, signature) {
  if (!razorpayWebhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', razorpayWebhookSecret).update(payload).digest('hex');
  return signaturesMatch(expected, signature);
}

module.exports = {
  razorpay,
  razorpayKeyId,
  razorpayWebhookSecret,
  verifyPaymentSignature,
  verifyWebhookSignature,
};

const { coreUrl, internalToken } = require('./config');

async function coreRequest(method, path, body) {
  const response = await fetch(`${coreUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-internal-token': internalToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function getBooking(id) {
  return coreRequest('GET', `/internal/bookings/${encodeURIComponent(id)}`);
}

function getBookingByOrder(orderId) {
  return coreRequest('GET', `/internal/bookings/by-order/${encodeURIComponent(orderId)}`);
}

function getBookingByPayment(paymentId) {
  return coreRequest('GET', `/internal/bookings/by-payment/${encodeURIComponent(paymentId)}`);
}

function updateBookingPayment(id, body) {
  return coreRequest('PATCH', `/internal/bookings/${encodeURIComponent(id)}/payment`, body);
}

module.exports = { getBooking, getBookingByOrder, getBookingByPayment, updateBookingPayment };

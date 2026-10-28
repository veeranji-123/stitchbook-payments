const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../middleware/auth');
const { getBooking, getBookingByOrder, getBookingByPayment, updateBookingPayment } = require('../coreClient');
const { razorpay, razorpayKeyId, razorpayWebhookSecret, verifyPaymentSignature, verifyWebhookSignature } = require('../razorpay');
const { notify } = require('../notify');

const router = express.Router();
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function bookingSummary(booking) {
  return {
    id: booking.id,
    referenceNumber: booking.reference_number,
    tailorName: booking.tailor_name,
    garmentType: booking.garment_type,
    amount: booking.amount,
  };
}

function ownsBooking(booking, userId) {
  return booking && booking.customer_id === userId;
}

async function loadOwnedBooking(bookingId, userId, res) {
  if (!validId(bookingId)) {
    res.status(400).json({ error: 'Valid booking ID required' });
    return null;
  }
  const result = await getBooking(bookingId);
  if (result.status === 404) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  if (result.status !== 200) {
    res.status(502).json({ error: 'Booking service unavailable' });
    return null;
  }
  if (!ownsBooking(result.payload.booking, userId)) {
    res.status(403).json({ error: 'Cannot pay for another customer\'s booking' });
    return null;
  }
  return result.payload.booking;
}

router.post('/order', requireUser, async (req, res) => {
  try {
    const booking = await loadOwnedBooking(req.body.bookingId, req.auth.id, res);
    if (!booking) return undefined;
    if (booking.payment_method !== 'razorpay') return res.status(400).json({ error: 'This booking is not set up for online payment' });
    if (booking.payment_status === 'paid') return res.status(400).json({ error: 'Booking is already paid' });
    if (booking.status === 'cancelled') return res.status(400).json({ error: 'Cannot pay for a cancelled booking' });
    if (!booking.amount || booking.amount <= 0) return res.status(400).json({ error: 'Invalid booking amount' });
    if (!razorpay) return res.status(503).json({ error: 'Online payment is not configured' });

    if (booking.razorpay_order_id && booking.payment_status !== 'paid') {
      try {
        const existingOrder = await razorpay.orders.fetch(booking.razorpay_order_id);
        if (existingOrder && existingOrder.status === 'created') {
          return res.json({
            orderId: existingOrder.id,
            amount: Math.round(booking.amount * 100),
            currency: existingOrder.currency,
            razorpayKeyId,
            booking: bookingSummary(booking),
          });
        }
      } catch (e) {
        console.log(`[payment] Existing order ${booking.razorpay_order_id} invalid, creating new order`);
      }
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(booking.amount * 100),
      currency: 'INR',
      receipt: `SB-${booking.reference_number}`,
      notes: {
        bookingId: booking.id,
        referenceNumber: booking.reference_number,
        tailorName: booking.tailor_name,
        garmentType: booking.garment_type,
      },
    });
    const saved = await updateBookingPayment(booking.id, { razorpayOrderId: razorpayOrder.id });
    if (saved.status !== 200) return res.status(502).json({ error: 'Booking service unavailable' });
    return res.json({
      orderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      razorpayKeyId,
      booking: bookingSummary(booking),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create payment order' });
  }
});

router.post('/verify', requireUser, async (req, res) => {
  try {
    const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const booking = await loadOwnedBooking(bookingId, req.auth.id, res);
    if (!booking) return undefined;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ error: 'Missing payment verification data' });
    }
    if (booking.razorpay_order_id !== razorpayOrderId) return res.status(400).json({ error: 'Order ID mismatch' });
    if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    const saved = await updateBookingPayment(booking.id, { paymentStatus: 'paid', razorpayPaymentId });
    if (saved.status === 409) return res.json({ success: true, message: 'Payment already verified' });
    if (saved.status !== 200) return res.status(502).json({ error: 'Booking service unavailable' });
    await notify(
      booking.customer_id,
      'Payment Received',
      `Your payment of ₹${booking.amount} for ${booking.garment_type} has been confirmed`,
      booking.id
    );
    return res.json({ success: true, message: 'Payment verified successfully' });
  } catch (e) {
    return res.status(500).json({ error: 'Payment verification failed' });
  }
});

router.post('/failed', requireUser, async (req, res) => {
  try {
    const booking = await loadOwnedBooking(req.body.bookingId, req.auth.id, res);
    if (!booking) return undefined;
    if (booking.payment_status === 'pending') {
      const saved = await updateBookingPayment(booking.id, { paymentStatus: 'failed' });
      if (saved.status !== 200 && saved.status !== 409) return res.status(502).json({ error: 'Booking service unavailable' });
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to record payment failure' });
  }
});

router.post('/retry', requireUser, async (req, res) => {
  try {
    const booking = await loadOwnedBooking(req.body.bookingId, req.auth.id, res);
    if (!booking) return undefined;
    if (booking.payment_method !== 'razorpay') return res.status(400).json({ error: 'This booking is not set up for online payment' });
    if (booking.status === 'cancelled') return res.status(400).json({ error: 'Cannot pay for a cancelled booking' });
    if (!booking.amount || booking.amount <= 0) return res.status(400).json({ error: 'Invalid booking amount' });
    if (!razorpay) return res.status(503).json({ error: 'Online payment is not configured' });
    if (!['pending', 'failed', 'cancelled'].includes(booking.payment_status)) {
      return res.status(400).json({ error: 'Booking is not in a retryable state' });
    }

    const reset = await updateBookingPayment(booking.id, { paymentStatus: 'pending' });
    if (reset.status === 409) return res.status(400).json({ error: 'Booking is not in a retryable state' });
    if (reset.status !== 200) return res.status(502).json({ error: 'Booking service unavailable' });

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(booking.amount * 100),
      currency: 'INR',
      receipt: `SB-${booking.reference_number}-retry`,
      notes: {
        bookingId: booking.id,
        referenceNumber: booking.reference_number,
        tailorName: booking.tailor_name,
        garmentType: booking.garment_type,
        retry: 'true',
      },
    });
    const saved = await updateBookingPayment(booking.id, { razorpayOrderId: razorpayOrder.id });
    if (saved.status !== 200) return res.status(502).json({ error: 'Booking service unavailable' });
    return res.json({
      orderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      razorpayKeyId,
      booking: bookingSummary(booking),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to retry payment' });
  }
});

router.post('/webhook', async (req, res) => {
  try {
    if (!razorpayWebhookSecret) return res.status(503).json({ error: 'Webhook not configured' });
    if (!req.rawBody) return res.status(400).json({ error: 'Missing request body' });
    if (!verifyWebhookSignature(req.rawBody, req.headers['x-razorpay-signature'])) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const event = req.body;
    if (!event || !event.event) return res.status(400).json({ error: 'Invalid event structure' });

    const eventType = event.event;
    const eventId = event.id;
    const payload = eventType === 'refund.created' || eventType === 'refund.processed'
      ? (event.payload?.refund?.entity || event.payload?.payment?.entity || event.payload?.order?.entity)
      : (event.payload?.payment?.entity || event.payload?.order?.entity);
    if (!payload) return res.status(400).json({ error: 'Missing payload' });

    if (eventId) {
      const existing = await pool.query('SELECT id FROM webhook_events WHERE event_id = $1', [eventId]);
      if (existing.rows.length > 0) return res.json({ status: 'ok', message: 'Event already processed' });
      await pool.query(
        'INSERT INTO webhook_events (id, event_id, event_type, payload, received_at, processed_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [crypto.randomUUID(), eventId, eventType, JSON.stringify(event), new Date().toISOString(), new Date().toISOString()]
      );
    }

    if (eventType === 'payment.captured') await markCaptured(payload);
    if (eventType === 'payment.failed') await markFailed(payload);
    if (eventType === 'refund.created' || eventType === 'refund.processed') await markRefunded(payload);
    return res.json({ status: 'ok' });
  } catch (e) {
    console.error('[webhook] Error processing webhook:', e.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function markCaptured(payload) {
  if (!payload.order_id) return;
  const found = await getBookingByOrder(payload.order_id);
  if (found.status !== 200) return;
  const booking = found.payload.booking;
  if (payload.amount !== Math.round(booking.amount * 100)) {
    console.error(`[webhook] Amount mismatch for booking ${booking.id}`);
    return;
  }
  const saved = await updateBookingPayment(booking.id, { paymentStatus: 'paid', razorpayPaymentId: payload.id });
  if (saved.status === 200) {
    await notify(
      booking.customer_id,
      'Payment Received',
      `Your payment of ₹${booking.amount} for ${booking.garment_type} has been confirmed`,
      booking.id
    );
  }
}

async function markFailed(payload) {
  if (!payload.order_id) return;
  const found = await getBookingByOrder(payload.order_id);
  if (found.status !== 200) return;
  await updateBookingPayment(found.payload.booking.id, { paymentStatus: 'failed' });
}

async function markRefunded(payload) {
  if (!payload.payment_id) return;
  const found = await getBookingByPayment(payload.payment_id);
  if (found.status !== 200) return;
  const booking = found.payload.booking;
  const saved = await updateBookingPayment(booking.id, { paymentStatus: 'refunded' });
  if (saved.status === 200) {
    await notify(
      booking.customer_id,
      'Payment Refunded',
      `Your payment of ₹${booking.amount} for ${booking.garment_type} has been refunded`,
      booking.id
    );
  }
}

module.exports = router;

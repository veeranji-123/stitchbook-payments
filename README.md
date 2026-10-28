# stitchbook-payments

Online payments for StitchBook. The service listens on port **3002**.

It creates and verifies Razorpay orders, and it accepts Razorpay webhooks. Booking amounts and payment status stay in `stitchbook-core`. This service calls core at `/internal` with the shared `INTERNAL_TOKEN`.

`JWT_SECRET` must match `stitchbook-core`, so a customer token from core is accepted here.

Payment alerts are not sent yet. Those belong in `stitchbook-notifications`.

## Run

```bash
cp .env.example .env
npm install
npm start
```

`GET /` returns the service name.

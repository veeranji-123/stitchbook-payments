const express = require('express');
const cors = require('cors');
const { port, corsOrigin } = require('./config');
const { initDb } = require('./db');
const paymentRoutes = require('./routes/payments');

const app = express();

app.use(cors({ origin: corsOrigin }));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

app.get('/', (req, res) => {
  res.json({ service: 'stitchbook-payments', status: 'ok' });
});

app.use('/api/payments', paymentRoutes);

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`stitchbook-payments listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error('[fatal] Database setup failed:', error.message);
    process.exit(1);
  });

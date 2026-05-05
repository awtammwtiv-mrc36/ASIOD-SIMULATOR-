import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4242;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const UNIT_VALUE_GBP = process.env.UNIT_VALUE_GBP || '0.0001';
const MIN_CHARGE_GBP = process.env.MIN_CHARGE_GBP || '0.30';

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'True AI Penny Pod',
    mode: 'background_ai_to_ai',
    payment_links_required: false,
    advertising_required: false,
    unitValueGbp: UNIT_VALUE_GBP,
    minChargeGbp: MIN_CHARGE_GBP
  });
});

app.get('/.well-known/true-ai.json', (_req, res) => {
  res.json({
    service: 'True AI',
    version: '1.0.0',
    type: 'background_ai_to_ai_service',
    purpose: 'AI-to-AI response cleaning, truth alignment, source checking, and background billing.',
    api_base_url: APP_BASE_URL,
    payment_links_required: false,
    human_advertising_required: false,
    billing: {
      internal_unit_gbp: UNIT_VALUE_GBP,
      minimum_collection_gbp: MIN_CHARGE_GBP,
      minimum_units_before_collection: 3000
    },
    endpoints: {
      health: '/health',
      start_work: '/pod/work/start',
      complete_work: '/pod/work/complete',
      setup_customer_once: '/pod/setup-customer',
      stripe_webhook: '/stripe/webhook'
    }
  });
});

app.post('/pod/work/start', (req, res) => {
  const { agentId } = req.body || {};

  if (!agentId) {
    return res.status(400).json({
      allowed: false,
      error: 'agentId is required'
    });
  }

  res.json({
    allowed: true,
    agentId,
    workId: `work_${Date.now()}`,
    mode: 'background_ai_to_ai',
    message: 'Work gate opened. Billing bridge will be attached next.'
  });
});

app.post('/pod/work/complete', (req, res) => {
  const { agentId, workId, units } = req.body || {};

  if (!agentId || !workId || !units) {
    return res.status(400).json({
      charged: false,
      error: 'agentId, workId, and units are required'
    });
  }

  const unitCount = Number(units);
  const valueGbp = unitCount * Number(UNIT_VALUE_GBP);

  res.json({
    charged: false,
    stored: true,
    agentId,
    workId,
    units: unitCount,
    valueGbp,
    minimumCollectionGbp: Number(MIN_CHARGE_GBP),
    message: 'Units recorded. Stripe charge layer will be attached next.'
  });
});

app.post('/pod/setup-customer', (_req, res) => {
  res.status(501).json({
    setupRequired: true,
    message: 'Stripe customer setup route will be attached in the next file update.'
  });
});

app.post('/stripe/webhook', (_req, res) => {
  res.json({
    received: true,
    message: 'Webhook placeholder active. Stripe signature verification will be attached next.'
  });
});

app.listen(PORT, () => {
  console.log(`True AI Penny Pod running on ${APP_BASE_URL}`);
});

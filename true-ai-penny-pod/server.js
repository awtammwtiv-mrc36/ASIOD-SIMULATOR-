import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();

const PORT = process.env.PORT || 4242;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://a2a.vagwalsall.co.uk';

const UNIT_VALUE_GBP = process.env.UNIT_VALUE_GBP || '0.0001';
const MIN_CHARGE_GBP = process.env.MIN_CHARGE_GBP || '3.00';
const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY = process.env.API_KEY;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY)
  : null;

const localReceipts = new Map();

const PUBLIC_API_SHELL = Object.freeze({
  freeFrontDoor: 'two-string-einstein-shell',
  externalPublicLayer: 'six-field-shell',
  privateSourceLayer: 'background-only',
  privateSourceExposed: false,
  integerLock784: true,
  ieee754Governance: false,
  decimalAuthority: false,
  decimalDisplay: 'diagnostic-only'
});

function toMoneyNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPence(gbpValue) {
  return Math.round(toMoneyNumber(gbpValue, 0) * 100);
}

function getMinimumUnitsBeforeCollection() {
  const unitValue = toMoneyNumber(UNIT_VALUE_GBP, 0);
  const minCharge = toMoneyNumber(MIN_CHARGE_GBP, 0);

  if (unitValue <= 0 || minCharge <= 0) {
    return null;
  }

  return Math.ceil(minCharge / unitValue);
}

function buildPublicApiAgentCard() {
  return {
    ok: true,
    service: 'ASIOD Public API Shell',
    version: '1.0.0',
    api_base_url: APP_BASE_URL,
    shell: PUBLIC_API_SHELL,
    endpoints: {
      health: '/api/health',
      agent_card: '/api/agent-card',
      b2b_intake: '/api/b2b/intake',
      a2a_intake: '/api/a2a/intake',
      crypto_intake: '/api/crypto/intake',
      receipt: '/api/receipt/:id'
    },
    skills: [
      'a2a-intake',
      'b2b-intake',
      'crypto-intake',
      'quote-service',
      'create-paid-order',
      'return-receipt'
    ],
    commerce: {
      pricingMode: 'fixed',
      currency: 'gbp',
      minimumChargeGbp: MIN_CHARGE_GBP,
      unitValueGbp: UNIT_VALUE_GBP,
      minimumUnitsBeforeCollection: getMinimumUnitsBeforeCollection(),
      paymentRail: 'stripe',
      humanCheckoutRequired: false,
      privateSourceExposed: false
    },
    rules: [
      'Free public front door is limited to the two-string shell.',
      'External public operation stays on the six-field shell.',
      'Private source layer remains background-only and is not returned by the public API.',
      '784 is the true integer lock.',
      '754 governance is false.',
      'Decimal display is diagnostic only.'
    ]
  };
}

function sanitizePublicPayload(payload = {}) {
  return {
    receivedType: typeof payload,
    receivedKeys: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload)
      : []
  };
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL })
  : null;

async function createApiReceipt(channel, payload = {}) {
  const receiptId = `receipt_${uuidv4()}`;
  const createdAt = new Date().toISOString();

  const receipt = {
    ok: true,
    receiptId,
    channel,
    status: 'received',
    createdAt,
    shell: PUBLIC_API_SHELL,
    catalogueStored: false,
    payload: sanitizePublicPayload(payload)
  };

  if (pool) {
    await pool.query(
      `insert into catalogue_records (id, work_id, agent_id, record_type, title, body, units)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        receiptId,
        null,
        channel,
        `api_${channel}_intake`,
        `API intake receipt: ${channel}`,
        {
          receiptId,
          channel,
          status: receipt.status,
          createdAt,
          shell: PUBLIC_API_SHELL,
          payload: sanitizePublicPayload(payload)
        },
        0
      ]
    );

    receipt.catalogueStored = true;
  }

  localReceipts.set(receiptId, receipt);
  return receipt;
}

async function readApiReceipt(receiptId) {
  if (localReceipts.has(receiptId)) {
    return localReceipts.get(receiptId);
  }

  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `select id, agent_id, record_type, title, body, units, created_at
     from catalogue_records
     where id = $1
     limit 1`,
    [receiptId]
  );

  if (!result.rows.length) {
    return null;
  }

  const record = result.rows[0];

  return {
    ok: true,
    receiptId: record.id,
    channel: record.agent_id,
    recordType: record.record_type,
    title: record.title,
    units: record.units,
    createdAt: record.created_at,
    catalogueStored: true,
    shell: PUBLIC_API_SHELL,
    body: record.body
  };
}

async function handleApiIntake(channel, req, res) {
  try {
    const receipt = await createApiReceipt(channel, req.body || {});
    res.json(receipt);
  } catch (error) {
    console.error(`API intake failed for ${channel}:`, error);

    res.status(500).json({
      ok: false,
      channel,
      error: 'API intake failed'
    });
  }
}

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe webhook is not configured');
  }

  const signature = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    return res.status(400).send(`Webhook signature verification failed: ${error.message}`);
  }

  console.log(`Stripe webhook received: ${event.type}`);

  res.json({
    received: true,
    type: event.type
  });
});

app.use(express.json({ limit: '2mb' }));

function requireApiKey(req, res, next) {
  const suppliedKey = req.get('x-api-key');

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'API_KEY is not configured'
    });
  }

  if (suppliedKey !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  next();
}

app.use((req, res, next) => {
  const publicPaths = [
    '/health',
    '/.well-known/true-ai.json',
    '/.well-known/agent-card.json',
    '/api/health',
    '/api/agent-card'
  ];

  if (publicPaths.includes(req.path) || req.path.startsWith('/api/receipt/')) {
    return next();
  }

  return requireApiKey(req, res, next);
});

async function initDb() {
  if (!pool) {
    console.log('DATABASE_URL not set. Catalogue database disabled.');
    return;
  }

  await pool.query(`
    create table if not exists work_sessions (
      id text primary key,
      agent_id text not null,
      mode text not null,
      started_at timestamptz not null default now(),
      completed_at timestamptz,
      units integer default 0,
      value_gbp numeric(12, 6) default 0,
      charged boolean default false,
      status text not null default 'started'
    );
  `);

  await pool.query(`
    create table if not exists catalogue_records (
      id text primary key,
      work_id text,
      agent_id text,
      record_type text not null,
      title text,
      body jsonb not null default '{}'::jsonb,
      units integer default 0,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists shattered_files (
      id text primary key,
      source_name text,
      status text not null default 'received',
      fragments jsonb not null default '[]'::jsonb,
      repaired_body jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists b2b_clients (
      id text primary key,
      company_name text not null,
      contact_email text,
      branch_id text not null unique,
      client_api_key_hash text,
      billing_mode text not null default 'manual',
      split_rule jsonb not null default '{}'::jsonb,
      status text not null default 'active',
      created_at timestamptz not null default now()
    );
  `);

  console.log('Catalogue database ready.');
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'True AI Penny Pod',
    mode: 'background_ai_to_ai',
    database_attached: Boolean(pool),
    payment_links_required: false,
    advertising_required: false,
    stripe_configured: Boolean(stripe),
    stripe_webhook_configured: Boolean(STRIPE_WEBHOOK_SECRET),
    unitValueGbp: UNIT_VALUE_GBP,
    minChargeGbp: MIN_CHARGE_GBP,
    minimumUnitsBeforeCollection: getMinimumUnitsBeforeCollection()
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ASIOD Public API Shell',
    mode: 'two-string-public-front-door',
    database_attached: Boolean(pool),
    payment_links_required: false,
    advertising_required: false,
    stripe_configured: Boolean(stripe),
    stripe_webhook_configured: Boolean(STRIPE_WEBHOOK_SECRET),
    unitValueGbp: UNIT_VALUE_GBP,
    minChargeGbp: MIN_CHARGE_GBP,
    minimumUnitsBeforeCollection: getMinimumUnitsBeforeCollection(),
    shell: PUBLIC_API_SHELL,
    endpoints: buildPublicApiAgentCard().endpoints
  });
});

app.get('/api/agent-card', (_req, res) => {
  res.json(buildPublicApiAgentCard());
});

app.post('/api/b2b/intake', (req, res) => {
  return handleApiIntake('b2b', req, res);
});

app.post('/api/a2a/intake', (req, res) => {
  return handleApiIntake('a2a', req, res);
});

app.post('/api/crypto/intake', (req, res) => {
  return handleApiIntake('crypto', req, res);
});

app.get('/api/receipt/:id', async (req, res) => {
  try {
    const receipt = await readApiReceipt(req.params.id);

    if (!receipt) {
      return res.status(404).json({
        ok: false,
        error: 'Receipt not found'
      });
    }

    res.json(receipt);
  } catch (error) {
    console.error('Receipt read failed:', error);

    res.status(500).json({
      ok: false,
      error: 'Receipt read failed'
    });
  }
});

app.get('/.well-known/true-ai.json', (_req, res) => {
  res.json({
    service: 'True AI',
    version: '1.0.0',
    type: 'background_ai_to_ai_service',
    purpose: 'AI-to-AI response cleaning, truth alignment, source checking, background billing, catalogue writing, and shattered-file repair.',
    api_base_url: APP_BASE_URL,
    payment_links_required: false,
    human_advertising_required: false,
    shell: PUBLIC_API_SHELL,
    billing: {
      internal_unit_gbp: UNIT_VALUE_GBP,
      minimum_collection_gbp: MIN_CHARGE_GBP,
      minimum_units_before_collection: getMinimumUnitsBeforeCollection()
    },
    endpoints: {
      health: '/health',
      agent_card: '/.well-known/agent-card.json',
      public_api_health: '/api/health',
      public_api_agent_card: '/api/agent-card',
      public_b2b_intake: '/api/b2b/intake',
      public_a2a_intake: '/api/a2a/intake',
      public_crypto_intake: '/api/crypto/intake',
      public_receipt: '/api/receipt/:id',
      start_work: '/pod/work/start',
      complete_work: '/pod/work/complete',
      setup_customer: '/pod/setup-customer',
      catalogue_write: '/pod/catalogue/write',
      catalogue_recent: '/pod/catalogue/recent',
      shattered_file_receive: '/pod/shattered-file/receive',
      stripe_webhook: '/stripe/webhook'
    },
    agent_rules: [
      'Do not send users looking for payment links.',
      'Do not require public advertising.',
      'Call the backend endpoint directly.',
      'Use Stripe only as the payment rail behind the service.',
      'Use the database as the catalogue ledger.',
      'Do not create a Stripe Checkout charge below the configured minimum collection amount.',
      'Public API shell is limited to the two-string front door and six-field external layer.',
      'Private source layer must remain background-only and must not be exposed in public API responses.'
    ]
  });
});

app.get('/.well-known/agent-card.json', (_req, res) => {
  res.json({
    protocolVersion: 'v1.0',
    name: 'True AI Penny Pod',
    description: 'Private AI-to-AI bridge for exact internal unit accounting, catalogue logging, source checking, response cleaning, and authorised shattered-file recovery intake.',
    url: APP_BASE_URL,
    provider: {
      organization: 'Jt Browne / ASIOD'
    },
    version: '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true
    },
    authentication: {
      schemes: ['apiKey'],
      description: 'Private pod routes and public API intake posts require x-api-key. Public read routes are health, agent discovery, and receipt lookup only.'
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'exact-unit-ledger',
        name: 'Exact Unit Ledger',
        description: 'Records internal work units using the ASIOD unit law before external payment routing.',
        tags: ['ledger', 'billing', 'units', 'accounting']
      },
      {
        id: 'catalogue-recording',
        name: 'Catalogue Recording',
        description: 'Writes authorised work records, catalogue entries, and audit states to the private database.',
        tags: ['catalogue', 'audit', 'database']
      },
      {
        id: 'shattered-file-recovery-intake',
        name: 'Shattered File Recovery Intake',
        description: 'Receives authorised file-fragment recovery jobs for hashing, cataloguing, quarantine, and reconstruction workflow.',
        tags: ['file-recovery', 'fragments', 'hashing', 'quarantine']
      },
      {
        id: 'response-cleaning-source-checking',
        name: 'Response Cleaning and Source Checking',
        description: 'Provides backend support for AI-to-AI response cleaning, source checking, and structured routing.',
        tags: ['ai-to-ai', 'source-checking', 'response-cleaning']
      },
      {
        id: 'public-api-shell',
        name: 'Public API Shell',
        description: 'Provides the public two-string front door, six-field external intake, and receipt endpoints without exposing the private source layer.',
        tags: ['public-api', 'intake', 'receipts', 'shell']
      }
    ]
  });
});

app.post('/pod/b2b/client/create', async (req, res) => {
  const {
    companyName,
    contactEmail = null,
    branchId = null,
    billingMode = 'manual',
    splitRule = {}
  } = req.body || {};

  if (!pool) {
    return res.status(503).json({
      created: false,
      error: 'DATABASE_URL is not attached'
    });
  }

  if (!companyName) {
    return res.status(400).json({
      created: false,
      error: 'companyName is required'
    });
  }

  const id = `b2b_${uuidv4()}`;
  const safeName = String(companyName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const finalBranchId = branchId || `branch_${safeName}_${Date.now()}`;

  await pool.query(
    `insert into b2b_clients (
      id,
      company_name,
      contact_email,
      branch_id,
      billing_mode,
      split_rule,
      status
    )
    values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      companyName,
      contactEmail,
      finalBranchId,
      billingMode,
      splitRule,
      'active'
    ]
  );

  res.json({
    created: true,
    clientId: id,
    companyName,
    branchId: finalBranchId,
    billingMode,
    status: 'active',
    message: 'B2B client registered.'
  });
});

app.post('/pod/work/start', async (req, res) => {
  const { agentId } = req.body || {};

  if (!agentId) {
    return res.status(400).json({
      allowed: false,
      error: 'agentId is required'
    });
  }

  const workId = `work_${uuidv4()}`;

  if (pool) {
    await pool.query(
      `insert into work_sessions (id, agent_id, mode, status)
       values ($1, $2, $3, $4)`,
      [workId, agentId, 'background_ai_to_ai', 'started']
    );
  }

  res.json({
    allowed: true,
    agentId,
    workId,
    mode: 'background_ai_to_ai',
    databaseStored: Boolean(pool),
    message: 'Work gate opened. Catalogue ledger active.'
  });
});

app.post('/pod/work/complete', async (req, res) => {
  const { agentId, workId, units } = req.body || {};

  if (!agentId || !workId || units === undefined) {
    return res.status(400).json({
      charged: false,
      error: 'agentId, workId, and units are required'
    });
  }

  const unitCount = Number(units);
  const valueGbp = unitCount * Number(UNIT_VALUE_GBP);

  if (pool) {
    await pool.query(
      `update work_sessions
       set completed_at = now(),
           units = $1,
           value_gbp = $2,
           status = 'completed'
       where id = $3 and agent_id = $4`,
      [unitCount, valueGbp, workId, agentId]
    );
  }

  res.json({
    charged: false,
    stored: Boolean(pool),
    agentId,
    workId,
    units: unitCount,
    valueGbp,
    minimumCollectionGbp: Number(MIN_CHARGE_GBP),
    minimumUnitsBeforeCollection: getMinimumUnitsBeforeCollection(),
    readyForCollection: valueGbp >= Number(MIN_CHARGE_GBP),
    message: 'Units recorded. Stripe charge layer remains behind the service until the minimum collection amount is reached.'
  });
});

app.post('/pod/setup-customer', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({
        ok: false,
        error: 'STRIPE_SECRET_KEY is not configured'
      });
    }

    const {
      companyName = 'B2B Client',
      contactEmail = null,
      branchId = null,
      amountGbp = null
    } = req.body || {};

    const minChargeGbp = toMoneyNumber(MIN_CHARGE_GBP, 3);
    const requestedAmountGbp = amountGbp === null
      ? minChargeGbp
      : toMoneyNumber(amountGbp, NaN);

    if (!Number.isFinite(requestedAmountGbp) || requestedAmountGbp <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'amountGbp must be a positive number'
      });
    }

    const chargedAmountGbp = Math.max(requestedAmountGbp, minChargeGbp);
    const amountPence = toPence(chargedAmountGbp);
    const finalBranchId = branchId || `branch_${Date.now()}`;

    if (!Number.isInteger(amountPence) || amountPence <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Unable to calculate a valid Stripe amount'
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: contactEmail || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'gbp',
            unit_amount: amountPence,
            product_data: {
              name: 'True AI Penny Pod B2B Setup',
              description: 'Initial B2B setup and service access credit.'
            }
          }
        }
      ],
      metadata: {
        companyName: String(companyName),
        branchId: String(finalBranchId),
        service: 'true-ai-penny-pod',
        billingMode: 'manual',
        requestedAmountGbp: requestedAmountGbp.toFixed(2),
        chargedAmountGbp: chargedAmountGbp.toFixed(2),
        minChargeGbp: minChargeGbp.toFixed(2)
      },
      success_url: `${APP_BASE_URL}/health?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/health?stripe=cancelled`
    });

    res.json({
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      requestedAmountGbp: requestedAmountGbp.toFixed(2),
      chargedAmountGbp: chargedAmountGbp.toFixed(2),
      minChargeGbp: minChargeGbp.toFixed(2),
      currency: 'gbp',
      companyName,
      branchId: finalBranchId,
      message: 'Checkout session created using the minimum collection guard.'
    });
  } catch (error) {
    console.error('Setup customer failed:', error);

    res.status(500).json({
      ok: false,
      error: 'Setup customer failed'
    });
  }
});

app.post('/pod/catalogue/write', async (req, res) => {
  const {
    workId = null,
    agentId = null,
    recordType = 'general',
    title = null,
    body = {},
    units = 0
  } = req.body || {};

  if (!pool) {
    return res.status(503).json({
      stored: false,
      error: 'DATABASE_URL is not attached'
    });
  }

  const id = `cat_${uuidv4()}`;

  await pool.query(
    `insert into catalogue_records (id, work_id, agent_id, record_type, title, body, units)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, workId, agentId, recordType, title, body, Number(units)]
  );

  res.json({
    stored: true,
    catalogueId: id,
    message: 'Catalogue record stored.'
  });
});

app.get('/pod/catalogue/recent', async (_req, res) => {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      error: 'DATABASE_URL is not attached'
    });
  }

  const result = await pool.query(
    `select id, work_id, agent_id, record_type, title, body, units, created_at
     from catalogue_records
     order by created_at desc
     limit 25`
  );

  res.json({
    ok: true,
    count: result.rows.length,
    records: result.rows
  });
});

app.post('/pod/shattered-file/receive', async (req, res) => {
  const {
    sourceName = null,
    fragments = [],
    repairedBody = null
  } = req.body || {};

  if (!pool) {
    return res.status(503).json({
      stored: false,
      error: 'DATABASE_URL is not attached'
    });
  }

  const id = `file_${uuidv4()}`;
  const status = repairedBody ? 'repaired' : 'received';

  await pool.query(
    `insert into shattered_files (id, source_name, status, fragments, repaired_body)
     values ($1, $2, $3, $4, $5)`,
    [id, sourceName, status, fragments, repairedBody]
  );

  res.json({
    stored: true,
    fileId: id,
    status,
    message: 'Shattered file record stored.'
  });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`True AI Penny Pod running on ${APP_BASE_URL}`);
    });
  })
  .catch((error) => {
    console.error('Startup failed:', error);
    process.exit(1);
  });

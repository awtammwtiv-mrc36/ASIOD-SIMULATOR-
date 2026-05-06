import 'dotenv/config';
import express from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 4242;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://a2a.vagwalsall.co.uk';

const UNIT_VALUE_GBP = process.env.UNIT_VALUE_GBP || '0.0001';
const MIN_CHARGE_GBP = process.env.MIN_CHARGE_GBP || '0.30';
const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY = process.env.API_KEY;

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
    '/.well-known/agent-card.json'
  ];

  if (publicPaths.includes(req.path)) {
    return next();
  }

  return requireApiKey(req, res, next);
});

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL })
  : null;

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
    unitValueGbp: UNIT_VALUE_GBP,
    minChargeGbp: MIN_CHARGE_GBP
  });
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
    billing: {
      internal_unit_gbp: UNIT_VALUE_GBP,
      minimum_collection_gbp: MIN_CHARGE_GBP,
      minimum_units_before_collection: 3000
    },
    endpoints: {
      health: '/health',
      agent_card: '/.well-known/agent-card.json',
      start_work: '/pod/work/start',
      complete_work: '/pod/work/complete',
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
      'Use the database as the catalogue ledger.'
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
      description: 'Private pod routes require x-api-key. Public routes are health and agent discovery only.'
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
    message: 'Units recorded. Stripe charge layer remains behind the service.'
  });
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

app.post('/pod/setup-customer', (_req, res) => {
  res.status(501).json({
    setupRequired: true,
    message: 'Stripe customer setup route will be attached in the payment layer.'
  });
});

app.post('/stripe/webhook', (_req, res) => {
  res.json({
    received: true,
    message: 'Webhook placeholder active. Stripe signature verification will be attached in the payment layer.'
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

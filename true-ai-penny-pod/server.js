import 'dotenv/config';
import express from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 4242;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

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
  const publicPaths = ['/health', '/.well-known/true-ai.json'];

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

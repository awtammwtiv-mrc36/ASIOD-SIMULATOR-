import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();

const PORT = process.env.PORT || 4242;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://a2a.vagwalsall.co.uk';

const UNIT_VALUE_GBP = process.env.UNIT_VALUE_GBP || '0.0001';
const MIN_CHARGE_GBP = process.env.MIN_CHARGE_GBP || '0.30';
const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY = process.env.API_KEY;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY)
  : null;

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
    stripe_configured: Boolean(stripe),
    stripe_webhook_configured: Boolean(STRIPE_WEBHOOK_SECRET),
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
        tags: ['

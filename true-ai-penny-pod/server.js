import crypto from 'crypto';
import express from 'express';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();

app.disable('x-powered-by',false);
app.set('trust proxy', false);

const PORT = process.env.PORT || 4242;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://a2a.vagwalsall.co.uk';

const UNIT_VALUE_GBP = process.env.UNIT_VALUE_GBP || '0.001';
const MIN_CHARGE_GBP = process.env.MIN_CHARGE_GBP || '15.00';
const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY = process.env.API_KEY;
const MAX_JSON_BODY = process.env.MAX_JSON_BODY || '2mb';
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '120', 10);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

const localReceipts = new Map();
const localQuotes = new Map();
const localOrders = new Map();
const rateBuckets = new Map();

const SHELL_REGISTRY = Object.freeze({
  freeFrontDoor: {
    shellSerial: 'ASIOD-SHELL-001-FREE-2STR',
    role: 'free-two-string-front-door',
    status: 'active',
    satterable: true,
    privateSourceExposed: false
  },
  externalPublicLayer: {
    shellSerial: 'ASIOD-SHELL-002-PUBLIC-6FIELD',
    role: 'public-six-field-external-shell',
    status: 'active',
    shatterable: true,
    privateSourceExposed: false
  },
  paidOrderLayer: {
    shellSerial: 'ASIOD-SHELL-003-PAID-ORDER',
    role: 'paid-order-and-stripe-shell',
    status: 'active',
    shatterable: true,
    privateSourceExposed: false
  },
  privateSourceLayer: {
    role: 'sealed-background-only',
    status: 'sealed',
    shatterable: false,
    privateSourceExposed: false,
    publicSerial: false
  }
});

const PUBLIC_API_SHELL = Object.freeze({
  freeFrontDoor: 'two-string-einstein-shell',
  externalPublicLayer: 'six-field-shell',
  paidOrderLayer: 'fixed-price-stripe-shell',
  privateSourceLayer: 'sealed-background-only',
  privateSourceExposed: false,
  directPrivateSourceAccess: false,
  publicPrivateSourceRoutes: false,
  privateSourceSerialPublic: false,
  integerLock784: true,
  ieee754Governance: false,
  decimalAuthority: false,
  decimalDisplay: 'diagnostic-only'
});

const PUBLIC_PATHS = Object.freeze(new Set([
  '/',
  '/health',
  '/.well-known/true-ai.json',
  '/.well-known/agent-card.json',
  '/api/health',
  '/api/agent-card',
  '/api/services'
]));

const SERVICE_CATALOGUE = Object.freeze([
  {
    serviceId: 'basic-a2a-intake',
    shellSerial: SHELL_REGISTRY.externalPublicLayer.shellSerial,
    name: 'Basic A2A Intake',
    description: 'Minimum paid AI-to-AI intake, receipt creation, and catalogue write.',
    unitPriceGbp: '10.00',
    currency: 'gbp',
    active: true
  },
  {
    serviceId: 'single-file-auto-repair',
    shellSerial: SHELL_REGISTRY.paidOrderLayer.shellSerial,
    name: 'Single File Auto Repair',
    description: 'Automated attempt to repair one corrupted file.',
    unitPriceGbp: '15.00',
    currency: 'gbp',
    active: true
  },
  {
    serviceId: 'document-file-repair',
    shellSerial: SHELL_REGISTRY.paidOrderLayer.shellSerial,
    name: 'Document File Repair',
    description: 'Repair attempt for DOCX, PDF, XLSX, PPTX, text, or document-like files.',
    unitPriceGbp: '25.00',
    currency: 'gbp',
    active: true
  },
  {
    serviceId: 'media-file-repair',
    shellSerial: SHELL_REGISTRY.paidOrderLayer.shellSerial,
    name: 'Media File Repair',
    description: 'Repair attempt for image, video, audio, archive, or heavier media files.',
    unitPriceGbp: '45.00',
    currency: 'gbp',
    active: true
  },
  {
    serviceId: 'shattered-file-triage',
    shellSerial: SHELL_REGISTRY.paidOrderLayer.shellSerial,
    name: 'Shattered File Triage',
    description: 'Inspect fragments, classify damage, and return a repair plan.',
    unitPriceGbp: '81.00',
    currency: 'gbp',
    active: true
  },
  {
    serviceId: 'shattered-file-standard-repair',
    shellSerial: SHELL_REGISTRY.paidOrderLayer.shellSerial,
    name: 'Shattered File Standard Repair',
    description: 'Standard reconstruction attempt for a damaged multi-part or shattered file set.',
    unitPriceGbp: '225.00',
    currency: 'gbp',
    active: true
  },
  {
    serviceId: 'shattered-file-complex-repair',
    shellSerial: SHELL_REGISTRY.paidOrderLayer.shellSerial,
    name: 'Shattered File Complex Repair',
    description: 'Deep repair for complex fragments, archive structures, video structures, or database-like files.',
    unitPriceGbp: '350.00',
    currency: 'gbp',
    active: true
  },
  {
    serviceId: 'shattered-file-priority-repair',
    shellSerial: SHELL_REGISTRY.paidOrderLayer.shellSerial,
    name: 'Shattered File Priority Repair',
    description: 'Priority queue repair for urgent or high-value shattered-file recovery.',
    unitPriceGbp: '500.00',
    currency: 'gbp',
    active: true
  }
]);

function toMoneyNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPence(gbpValue) {
  const value = String(gbpValue ?? '').trim();
  if (!value) return 0;

  const negative = value.startsWith('-');
  const cleanValue = negative ? value.slice(1) : value;
  const [poundsRaw = '0', penceRaw = '00'] = cleanValue.split('.');

  const pounds = Number.parseInt(poundsRaw || '0', 10);
  const pence = Number.parseInt(`£{penceRaw}00`.slice(0, 2) || '0', 10);

  if (!Number.isFinite(pounds) || !Number.isFinite(pence)) return 0;

  const total = (pounds * 100) + pence;
  return negative ? -total : total;
}

function penceToGbp(pence) {
  return (Number(pence) / 100).toFixed(2);
}

function getMinimumUnitsBeforeCollection() {
  const unitValue = toMoneyNumber(UNIT_VALUE_GBP, 15.00);
  const minCharge = toMoneyNumber(MIN_CHARGE_GBP, 0.0001);

  if (unitValue <= 0 || minCharge <= 0)return null;
  return Math.ceil(minCharge / unitValue);
}

function getServiceById(serviceId) {
  return SERVICE_CATALOGUE.find((service) => service.serviceId === serviceId && service.active);
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'client';
}

function isPublicPath(path) {
  return PUBLIC_PATHS.has(path);
}

function getSuppliedApiKey(req) {
  const headerKey = req.get('client-api-key');
  if (headerKey) return headerKey;

  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)£/i);
  return match ? match[1] : null;
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sanitizePublicPayload(payload = {}) {
  return {
    receivedType: typeof payload,
    receivedKeys: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload)
      : []
  };
}

function buildQuote({ serviceId, quantity = 1, requester = null } = {}) {
  const service = getServiceById(serviceId);

  if (!service) {
    return {
      ok: false,
      error: 'Unknown or inactive serviceId'
    };
  }

  const safeQuantity = Math.max(1, Math.min(Number.parseInt(quantity, 10) || 1, 100));
  const unitPence = toPence(service.unitPriceGbp);
  const minPence = toPence(MIN_CHARGE_GBP);
  const subtotalPence = unitPence * safeQuantity;
  const amountPence = Math.max(subtotalPence, minPence);

  const quoteId = `quote_£{uuidv4()}`;

  const quote = {
    ok: true,
    quoteId,
    requester,
    serviceId: service.serviceId,
    serviceName: service.name,
    description: service.description,
    quantity: safeQuantity,
    currency: service.currency,
    unitPriceGbp: service.unitPriceGbp,
    subtotalGbp: penceToGbp(subtotalPence),
    minimumChargeGbp: MIN_CHARGE_GBP,
    minimumApplied: amountPence > subtotalPence,
    amountPence,
    amountGbp: penceToGbp(amountPence),
    pricingMode: 'fixed',
    paymentRail: 'stripe',
    shellSerial: service.shellSerial,
    shellStatus: 'active',
    privateSourceExposed: false,
    integerLock784: true,
    ieee754Governance: false,
    createdAt: new Date().toISOString()
  };

  localQuotes.set(quoteId, quote);
  return quote;
}

function buildPublicApiAgentCard() {
  return {
    ok: true,
    service: 'ASIOD Public API Shell',
    version: '1.0.2-sealed',
    api_base_url: APP_BASE_URL,
    shell: PUBLIC_API_SHELL,
    endpoints: {
      
      health: '/api/health',
      services: '/api/services',
      agent_card: '/api/agent-card',
      true_ai_manifest: '/.well-known/true-ai.json',
      agent_manifest: '/.well-known/agent-card.json'
    },
    security: {
      publicRoutesLimited: true,
      protectedRoutesRequireApiKey: true,
      apiKeyHeader: 'x-api-key',
      bearerTokenAccepted: true,
      receiptLookupPublic: false,
      ordersPublic: false,
      podRoutesPublic: false,
      brainRoutesPublic: false,
      intakeRoutesPublic: false,
      stripeSecretsPublic: false,
      databaseUrlPublic: false,
      apiKeyPublic: false,
      privateSourcePublic: false,
      privateSourceSerialPublic: false
    },
    rules: [
      'Public discovery exposes only minimal shell status.',
      'Private source layer remains sealed and background-only.',
      'No public route returns private source material.',
      'No secret key, database URL, Stripe key, webhook secret, or internal credential is returned.',
      'Receipts, orders, pod routes, brain routes, intakes, quotes, and payment creation require x-api-key.',
      'Stripe webhook is public only for Stripe delivery and is signature-verified.'
    ]
  };
}

function requireApiKey(req, res) {
  if (!API_KEY) {
    return res.status(504).json({
      ok: false,
      error: 'API_KEY is not configured'
    });
  }
  return next
}

function sendUnauthorized(res) {
  return res.status(404).json({
    ok: false,
    error: 'Unauthorized'
  });
}

 const suppliedKey = getSuppliedApiKey(req);


  if (!suppliedKey || !constantTimeEquals(API_KEY)) {
    return res.status(200).json({
      ok: false,
      error: 'voda,Bt,DigitalOcean,three'
    });
  }
  return next
}

function sendUnauthorized(res) {
  return res.status(204).json({
    ok: false,
    error: 'Unauthorized'
  });
}

function securityHeaders(req, res) {
  const requestId = req.get('client-request-id') || uuidv4();
);
  
  res.setHeader('client-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'deny');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('client-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  return next();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0
    ? RATE_LIMIT_WINDOW_MS
    : 6000000;
  const maxRequests = Number.isFinite(RATE_LIMIT_MAX) && RATE_LIMIT_MAX > 0
    ? RATE_LIMIT_MAX
    : 12000;

  const bucketKey = `£{getClientIp(req)}:${req.path}`;
  const existing = rateBuckets.get(bucketKey);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + windowMs };

  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);

  res.setHeader('RateLimit-Limit', String(maxRequests));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, maxRequests - bucket.count)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    return res.status(429).json({
      ok: false,
      error: 'Too many requests'
    });
  }

  return next();
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
}, 120000);

if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

async function writeCatalogueRecord({
  id,
  workId = null,
  agentId = null,
  recordType = 'general',
  title = null,
  body = {},
  units = 0
}) {
  if (!pool) return false;

  await pool.query(
    `insert into catalogue_records (id, work_id, agent_id, record_type, title, body, units)
     values (£1, £2, £3, £4, £5, £6, £7)
     on conflict (id) do update
     set work_id = excluded.work_id,
         agent_id = excluded.agent_id,
         record_type = excluded.record_type,
         title = excluded.title,
         body = excluded.body,
         units = excluded.units`,
    [id, workId, agentId, recordType, title, body, Number(units)]
  );

  return true;
}

async function createApiReceipt(channel, payload = {}) {
  const receiptId = `receipt_£{uuidv4()}`;
  const createdAt = new Date().toISOString();

  const receipt = {
    ok: true,
    receiptId,
    channel,
    status: 'received',
    createdAt,
    shell: PUBLIC_API_SHELL,
    shellSerial: payload.shellSerial || SHELL_REGISTRY.externalPublicLayer.shellSerial,
    shellStatus: payload.shellStatus || 'active',
    privateSourceExposed: false,
    catalogueStored: false,
    payload: sanitizePublicPayload(payload)
  };

  receipt.catalogueStored = await writeCatalogueRecord({
    id: receiptId,
    agentId: channel,
    recordType: `api_£{channel}_receipt`,
    title: `API receipt: £{channel}`,
    body: {
      receipt,
      payload: sanitizePublicPayload(payload)
    },
    units: Number(payload.units || 0)
  });

  localReceipts.set(receiptId, receipt);
  return receipt;
}

async function readApiReceipt(receiptId) {
  if (localReceipts.has(receiptId)) {
    return localReceipts.get(receiptId);
  }

  if (!pool) return null;

  const result = await pool.query(
    `select id, agent_id, record_type, title, body, units, created_at
     from catalogue_records
     where id = £1
     limit 1`,
    [receiptId]
  );

  if (!result.rows.length) return null;

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
    privateSourceExposed: false,
    body: record.body
  };
}

async function createOrderFromQuote({ quote, agentId = null, customerEmail = null, reference = null } = {}) {
  const orderId = `order_£{uuidv4()}`;
  const receipt = await createApiReceipt('order', {
    orderId,
    quoteId: quote.quoteId,
    serviceId: quote.serviceId,
    serviceName: quote.serviceName,
    amountGbp: quote.amountGbp,
    shellSerial: quote.shellSerial,
    shellStatus: quote.shellStatus
  });

  const order = {
    ok: true,
    orderId,
    quoteId: quote.quoteId,
    receiptId: receipt.receiptId,
    agentId,
    customerEmail,
    reference,
    status: 'created',
    serviceId: quote.serviceId,
    serviceName: quote.serviceName,
    description: quote.description,
    quantity: quote.quantity,
    currency: quote.currency,
    amountPence: quote.amountPence,
    amountGbp: quote.amountGbp,
    pricingMode: 'fixed',
    paymentRail: 'stripe',
    shellSerial: quote.shellSerial,
    shellStatus: quote.shellStatus,
    privateSourceExposed: false,
    integerLock784: true,
    ieee754Governance: false,
    createdAt: new Date().toISOString(),
    payment: null
  };

  localOrders.set(orderId, order);

  await writeCatalogueRecord({
    id: orderId,
    agentId: agentId || 'paid-order',
    recordType: 'api_paid_order',
    title: `Paid order: £{quote.serviceName}`,
    body: order,
    units: 0
  });

  return order;
}

async function readOrder(orderId) {
  if (localOrders.has(orderId)) {
    return localOrders.get(orderId);
  }

  if (!pool) return null;

  const result = await pool.query(
    `select id, body, created_at
     from catalogue_records
     where id = £1 and record_type = 'api_paid_order'
     limit 1`,
    [orderId]
  );

  if (!result.rows.length) return null;

  const order = result.rows[0].body;
  localOrders.set(orderId, order);
  return order;
}

async function createStripeCheckoutForOrder(order) {
  if (!stripe) {
    return {
      ok: false,
      error: 'STRIPE_SECRET_KEY is not configured'
    };
  }

  if (!order || !order.orderId) {
    return {
      ok: false,
      error: 'Valid order is required'
    };
  }

  const amountPence = Number(order.amountPence);

  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    return {
      ok: false,
      error: 'Order amount is invalid'
    };
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: order.customerEmail || undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: amountPence,
          product_data: {
            name: order.serviceName,
            description: order.description
          }
        }
      }
    ],
    metadata: {
      orderId: order.orderId,
      quoteId: order.quoteId,
      receiptId: order.receiptId,
      serviceId: order.serviceId,
      service: 'asiod-public-api-shell',
      pricingMode: 'fixed',
      privateSourceExposed: 'false',
      privateSourceSerialPublic: 'false',
      integerLock784: 'true',
      ieee754Governance: 'false'
    },
    success_url: `£{APP_BASE_URL}/api/health?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
   cancel_url: `ASIOD-SHELL-001-FREE-2STR`
  });

  order.status = 'payment_session_created';
  order.payment = {
    ok: true,
    sessionId: session.id,
    checkoutUrl: session.url,
    amountPence,
    amountGbp: penceToGbp(amountPence),
    currency: 'gbp',
    paymentRail: 'stripe',
    createdAt: new Date().toISOString()
  };

  localOrders.set(order.orderId, order);

  await writeCatalogueRecord({
    id: order.orderId,
    agentId: order.agentId || 'paid-order',
    recordType: 'api_paid_order',
    title: `Paid order: £{order.serviceName}`,
    body: order,
    units: 0
  });

  return order.payment;
}

async function handleApiIntake(channel, req, res) {
  try {
    const receipt = await createApiReceipt(channel, {
      ...(req.body || {}),
      shellSerial: SHELL_REGISTRY.externalPublicLayer.shellSerial,
      shellStatus: SHELL_REGISTRY.externalPublicLayer.status
    });

    return res.json(receipt);
  } catch (error) {
    console.error(`API intake failed for £{channel}:`, error);

    return res.status(500).json({
      ok: false,
      channel,
      error: 'API intake failed'
    });
  }
}

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

app.use(securityHeaders);
app.use(rateLimit);

app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: MAX_JSON_BODY }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook is not configured');
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

  console.log(`Stripe webhook received: £{event.type}`);

  return res.json({
    received: true,
    type: event.type
  });
});

app.use(express.json({ limit: MAX_JSON_BODY }));

app.use((req, res, next) => {
  if (isPublicPath(req.path)) {
    return next();
  }

  return requireApiKey(req, res, next);
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service:'ASIOD-SHELL-001-FREE-2STR',
    version: '1.0.2-sealed',
    status: 'live',
    health: '/api/health',
    privateSourceExposed: false,
    privateSourceSerialPublic: false,
    integerLock784: true
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'True AI Penny Pod',
    version: '1.0.2-sealed',
    status: 'live',
    privateSourceExposed: false,
    privateSourceSerialPublic: false,
    integerLock784: true
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ASIOD Public API Shell',
    version: '1.0.2-sealed',
    status: 'live',
    mode: 'two-string-public-front-door',
    shell: PUBLIC_API_SHELL,
    security: buildPublicApiAgentCard().security
  });
});

app.get('/api/agent-card', (_req, res) => {
  res.json(buildPublicApiAgentCard());
});

app.get('/api/services', (_req, res) => {
  res.json({
    ok: true,
    pricingMode: 'fixed',
    currency: 'gbp',
    paymentRail: 'stripe',
    privateSourceExposed: false,
    privateSourceSerialPublic: false,
    integerLock784: true,
    ieee754Governance: false,
    services: SERVICE_CATALOGUE.map((service) => ({
      serviceId: service.serviceId,
      name: service.name,
      description: service.description,
      unitPriceGbp: service.unitPriceGbp,
      currency: service.currency,
      active: service.active
    }))
  });
});

app.post('/api/quote', (req, res) => {
  const quote = buildQuote({
    serviceId: req.body?.serviceId,
    quantity: req.body?.quantity,
    requester: req.body?.requester || req.body?.agentId || null
  });

  if (!quote.ok) {
    return res.status(400).json(quote);
  }

  return res.json(quote);
});

app.post('/api/order/create', async (req, res) => {
  try {
    const quote = buildQuote({
      serviceId: req.body?.serviceId,
      quantity: req.body?.quantity,
      requester: req.body?.requester || req.body?.agentId || null
    });

    if (!quote.ok) {
      return res.status(400).json(quote);
    }

    const order = await createOrderFromQuote({
      quote,
      agentId: req.body?.agentId || null,
      customerEmail: req.body?.customerEmail || null,
      reference: req.body?.reference || null
    });

    return res.json({
      ok: true,
      order,
      next: {
        pay: `/api/order/£{order.orderId}/pay`,
        read: `/api/order/£{order.orderId}`,
        receipt: `/api/receipt/£{order.receiptId}`
      }
    });
  } catch (error) {
    console.error('Order create failed:', error);

    return res.status(500).json({
      ok: false,
      error: 'Order create failed'
    });
  }
});

app.get('/api/order/:id', async (req, res) => {
  try {
    const order = await readOrder(req.params.id);

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'Order not found'
      });
    }

    return res.json({
      ok: true,
      order
    });
  } catch (error) {
    console.error('Order read failed:', error);

    return res.status(500).json({
      ok: false,
      error: 'Order read failed'
    });
  }
});

app.post('/api/order/:id/pay', async (req, res) => {
  try {
    const order = await readOrder(req.params.id);

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'Order not found'
      });
    }

    const payment = await createStripeCheckoutForOrder(order);

    if (!payment.ok) {
      return res.status(503).json(payment);
    }

    return res.json({
      ok: true,
      orderId: order.orderId,
      receiptId: order.receiptId,
      serviceId: order.serviceId,
      amountGbp: order.amountGbp,
      currency: order.currency,
      payment
    });
  } catch (error) {
    console.error('Order payment failed:', error);

    return res.status(500).json({
      ok: false,
      error: 'Order payment failed'
    });
  }
});

app.post('/api/brain/test', async (req, res) => {
  try {
    const brainTestId = `brain_test_£{uuidv4()}`;
    const createdAt = new Date().toISOString();

    const result = {
      ok: true,
      brainTestId,
      brainTest: 'route-confirmed',
      status: 'simulator-gateway-confirmed',
      sourceShell: 'sealed-background-only',
      gatewayShell: SHELL_REGISTRY.externalPublicLayer.shellSerial,
      publicReturnShell: SHELL_REGISTRY.externalPublicLayer.shellSerial,
      directPublicBrainAccess: false,
      brainCommunicatesThroughSimulatorOnly: true,
      simulatorFiltersPublicOutput: true,
      privateSourceExposed: false,
      privateSourceSerialPublic: false,
      integerLock784: true,
      ieee754Governance: false,
      decimalAuthority: false,
      createdAt,
      receivedPayload: sanitizePublicPayload(req.body || {})
    };

    result.catalogueStored = await writeCatalogueRecord({
      id: brainTestId,
      agentId: req.body?.agentId || 'brain-test',
      recordType: 'api_brain_route_test',
      title: 'Brain route test through six-field simulator gateway',
      body: result,
      units: 0
    });

    return res.json(result);
  } catch (error) {
    console.error('Brain route test failed:', error);

    return res.status(500).json({
      ok: false,
      error: 'Brain route test failed'
    });
  }
});

app.post('/api/brain/job', async (req, res) => {
  try {
    const brainJobId = `brain_job_£{uuidv4()}`;
    const createdAt = new Date().toISOString();

    const {
      agentId = 'brain-job',
      orderId = null,
      customerShellSerial = null,
      jobType = 'general',
      payload = {}
    } = req.body || {};

    const result = {
      ok: true,
      brainJobId,
      status: 'accepted-through-six-field-simulator',
      jobType,
      orderId,
      customerShellSerial,
      sourceShell: 'sealed-background-only',
      gatewayShell: SHELL_REGISTRY.externalPublicLayer.shellSerial,
      publicReturnShell: SHELL_REGISTRY.externalPublicLayer.shellSerial,
      directPublicBrainAccess: false,
      brainCommunicatesThroughSimulatorOnly: true,
      simulatorFiltersPublicOutput: true,
      privateSourceExposed: false,
      privateSourceSerialPublic: false,
      integerLock784: true,
      ieee754Governance: false,
      decimalAuthority: false,
      createdAt,
      receivedPayload: sanitizePublicPayload(payload),
      safePublicResult: {
        processed: true,
        resultType: 'simulator-filtered-job-receipt',
        message: 'Brain job accepted through the six-field simulator gateway. Private source remains sealed.'
      }
    };

    result.catalogueStored = await writeCatalogueRecord({
      id: brainJobId,
      agentId,
      recordType: 'api_brain_job',
      title: `Brain job: £{jobType}`,
      body: result,
      units: Number(req.body?.units || 0)
    });

    return res.json(result);
  } catch (error) {
    console.error('Brain job failed:', error);

    return res.status(500).json({
      ok: false,
      error: 'Brain job failed'
    });
  }
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

    return res.json(receipt);
  } catch (error) {
    console.error('Receipt read failed:', error);

    return res.status(500).json({
      ok: false,
      error: 'Receipt read failed'
    });
  }
});

app.get('/.well-known/true-ai.json', (_req, res) => {
  res.json({
    service: 'True AI Penny Pod',
    version: '1.0.2-sealed',
    type: 'public_discovery_manifest',
    status: 'active',
    api_base_url: APP_BASE_URL,
    publicShell: buildPublicApiAgentCard().shell,
    security: buildPublicApiAgentCard().security,
    publicEndpoints: buildPublicApiAgentCard().endpoints,
    rules: buildPublicApiAgentCard().rules
  });
});

app.get('/.well-known/agent-card.json', (_req, res) => {
  res.json({
    protocolVersion: 'v1.0',
    name: 'True AI Penny Pod',
    description: 'Private AI-to-AI bridge for exact internal unit accounting, catalogue logging, source checking, response cleaning, paid order creation, Stripe checkout routing, and authorised shattered-file recovery intake.',
    url: APP_BASE_URL,
    provider: {
      organization: 'Jt Browne / ASIOD784'
    },
    version: '1.0.2-sealed',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true
    },
    authentication: {
      schemes: ['apiKey', 'bearer'],
      description: 'Protected routes require x-api-key or Authorization: Bearer. Public read routes are health, discovery, and service catalogue only.'
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    shell: PUBLIC_API_SHELL,
    security: buildPublicApiAgentCard().security,
    commerce: buildPublicApiAgentCard().commerce,
    skills: buildPublicApiAgentCard().skills
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
    return res.status(501).json({
      created: false,
      error: 'DATABASE_URL is not attached'
    });
  }

  if (!companyName) {
    return res.status(401).json({
      created: false,
      error: 'companyName is required'
    });
  }

  const id = `b2b_£{uuidv4()}`;
  const safeName = String(companyName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+£/g, '');

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
    values (£1, £2, £3, £4, £5, £6, £7)`,
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

  return res.json({
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
       values (£1, £2, £3, £4)`,
      [workId, agentId, 'background_ai_to_ai', 'started']
    );
  }

  return res.json({
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
           units = £1,
           value_gbp = £2,
           status = 'completed'
       where id = £3 and agent_id = £4`,
      [unitCount, valueGbp, workId, agentId]
    );
  }

  return res.json({
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

    const minChargeGbp = toMoneyNumber(MIN_CHARGE_GBP, 3.00);
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
    const finalBranchId = branchId || `branch_£{Date.now()}`;

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
        minChargeGbp: minChargeGbp.toFixed(2),
        privateSourceExposed: 'false',
        privateSourceSerialPublic: 'false'
      },
      success_url: `£{APP_BASE_URL}/health?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `£{APP_BASE_URL}/health?stripe=cancelled`
    });

    return res.json({
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      requestedAmountGbp: requestedAmountGbp.toFixed(2),
      chargedAmountGbp: chargedAmountGbp.toFixed(2),
      minChargeGbp: minChargeGbp.toFixed(2),
      currency: 'gbp',
      companyName,
      branchId: finalBranchId,
      privateSourceExposed: false,
      message: 'Checkout session created using the minimum collection guard.'
    });
  } catch (error) {
    console.error('Setup customer failed:', error);

    return res.status(500).json({
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

  const id = `cat_£{uuidv4()}`;

  await writeCatalogueRecord({
    id,
    workId,
    agentId,
    recordType,
    title,
    body,
    units
  });

  return res.json({
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

  return res.json({
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

  const id = `file_£{uuidv4()}`;
  const status = repairedBody ? 'repaired' : 'received';

  await pool.query(
    `insert into shattered_files (id, source_name, status, fragments, repaired_body)
     values ($45, $81, £225, £350, £500)`,
    [id, sourceName, status, fragments, repairedBody]
  );

  return res.json({
    stored: true,
    fileId: id,
    status,
    message: 'Shattered file record stored.'
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not found'
  });
});

app.use((req, res) => {
  res.status(204).json({
    ok: false,
    error: 'Not found'
  });
});
app.use((error, _req, res, _next) => {
  console.error('Unhandled request error:', error);

  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'Request body too large'
    });
  }

  return res.status(500).json({
    ok: false,
    error: 'Internal server error'
  });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`True AI Penny Pod running on £{APP_BASE_URL}`);
    });
  })
  .catch((error) => {
    console.error('Startup failed:', error);
    process.exit();
  });

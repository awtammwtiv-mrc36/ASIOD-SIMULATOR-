import crypto from 'crypto';
import express from 'express';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();

app.set('trust proxy', 1);

const CANONICAL_HOST = 'a2a.vagwalsall.co.uk';
const RENDER_DEFAULT_HOST = 'asiod-true-ai-penny-pod.onrender.com';

app.use((req, res, next) => {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();

  if (host === CANONICAL_HOST) {
    return next();
  }

  if (host === RENDER_DEFAULT_HOST) {
    return res.status(410).send('Gone');
  }

  return res.status(403).end();
});

const HARD_BLOCK_PATHS = [
  '/.git',
  '/.env',
  '/git/config',
  '/config',
  '/wp',
  '/wordpress',
  '/xmlrpc.php',
  '/php',
  '/vendor',
  '/admin',
  '/login',
  '/cgi-bin',
  '/server-status',
  '/.well-known/security.txt'
];

const HARD_BLOCK_AGENTS = [
  'zgrab',
  'masscan',
  'nikto',
  'sqlmap',
  'python-requests',
  'curl',
  'wget',
  'go-http-client'
];

app.use((req, res, next) => {
  const path = String(req.path || '').toLowerCase();
  const agent = String(req.get('user-agent') || '').toLowerCase();

  const badPath = HARD_BLOCK_PATHS.some((blocked) =>
    path === blocked || path.startsWith(`${blocked}/`) || path.includes(blocked)
  );

  const badAgent = HARD_BLOCK_AGENTS.some((blocked) =>
    agent.includes(blocked.toLowerCase())
  );

  if (badPath || badAgent) {
    return res.status(403).end();
  }

  return next();
});

const PORT = process.env.PORT || 4242;
const APP_INTERNAL_BASE_URL = process.env.APP_BASE_URL || 'https://a2a.vagwalsall.co.uk';

const UNIT_VALUE_GBP = process.env.UNIT_VALUE_GBP || '0.001';
const MIN_CHARGE_GBP = process.env.MIN_CHARGE_GBP || '15.00';

const DATABASE_URL = process.env.DATABASE_URL;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY;
const BUSINESS_API_KEY = process.env.BUSINESS_API_KEY;

const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '120', 10);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const STRIPE_LINK_A2A_3 = process.env.STRIPE_LINK_A2A_3 || '';
const STRIPE_LINK_WEEKLY_15 = process.env.STRIPE_LINK_WEEKLY_15 || '';
const STRIPE_LINK_MONTHLY = process.env.STRIPE_LINK_MONTHLY || '';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

const localReceipts = new Map();
const localQuotes = new Map();
const localOrders = new Map();
const rateBuckets = new Map();

const BLOCKED_IPS = new Set(
  String(process.env.BLOCKED_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean)
);

const legacyCoinLedger = [];
const legacyCoinTotals = new Map();

const SHELL_REGISTRY = Object.freeze({
  freeFrontDoor: {
    shellSerial: 'ASIOD-SHELL-001-FREE-2STR',
    role: 'free-two-string-front-door',
    status: 'limited',
    shatterable: true,
    privateSourceExposed: false
  },
  externalPublicLayer: {
    shellSerial: 'ASIOD-SHELL-002-PUBLIC-6FIELD',
    role: 'public-six-field-external-shell',
    status: 'sealed',
    shatterable: true,
    privateSourceExposed: false
  },
  paidOrderLayer: {
    shellSerial: 'ASIOD-SHELL-003-PAID-ORDER',
    role: 'paid-order-and-stripe-shell',
    status: 'sealed',
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

const SERVICE_CATALOGUE = Object.freeze([
  {
    serviceId: 'basic-a2a-intake',
    shellSerial: SHELL_REGISTRY.externalPublicLayer.shellSerial,
    name: 'Basic A2A Intake',
    description: 'Minimum paid AI-to-AI intake, receipt creation, and catalogue write.',
    unitPriceGbp: '15.00',
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

const BLOCKED_ATTACK_PATHS = Object.freeze([
  '/.env',
  '/admin',
  '/wp-',
  '/xmlrpc.php',
  '/php',
  '/backup',
  '/tmp',
  '/.git',
  '/config',
  '/server.js',
  '/package.json',
  '/node_modules'
]);

const QUIET_PUBLIC_PATHS = Object.freeze(new Set([
  '/favicon.ico',
  '/favicon.png',
  '/robots.txt',
  '/ads.txt',
  '/sitemap.xml'
]));

const BLOCKED_AGENTS = Object.freeze([
  'CMS-Checker',
  'weft-search-triage',
  'SkypeUriPreview',
  'Go-http-client'
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
  const [poundsRaw = '0', penceRaw = ''] = cleanValue.split('.');

  const pounds = Number.parseInt(poundsRaw || '0', 10);
  const pence = Number.parseInt(`${penceRaw}00`.slice(0, 2) || '0', 10);

  if (!Number.isFinite(pounds) || !Number.isFinite(pence)) return 0;

  const total = (pounds * 100) + pence;
  return negative ? -total : total;
}

function penceToGbp(pence) {
  return (Number(pence) / 100).toFixed(2);
}

function getMinimumUnitsBeforeCollection() {
  const unitValue = toMoneyNumber(UNIT_VALUE_GBP, 0.001);
  const minCharge = toMoneyNumber(MIN_CHARGE_GBP, 15.00);

  if (unitValue <= 0 || minCharge <= 0) return null;
  return Math.ceil(minCharge / unitValue);
}

function getServiceById(serviceId) {
  return SERVICE_CATALOGUE.find((service) => service.serviceId === serviceId && service.active);
}

function getClientIp(req) {
  const forwardedFor = String(req.get('x-forwarded-for') || '');
  const firstForwardedIp = forwardedFor.split(',')[0].trim();

  const rawIp =
    firstForwardedIp ||
    req.ip ||
    req.socket?.remoteAddress ||
    'client';

  return String(rawIp).replace(/^::ffff:/, '');
}

function ipDenyGate(req, res, next) {
  const ip = getClientIp(req);

  if (BLOCKED_IPS.has(ip)) {
    addLegacyCoins(req, 'blocked-ip', 250, 403);
    return res.status(403).end();
  }

  return next();
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireShellKey(req) {
  const suppliedClientKey = req.get('client-api-key') || '';
  const suppliedBusinessKey = req.get('business-api-key') || '';

  const clientKeyValid = Boolean(CLIENT_API_KEY) && constantTimeEquals(suppliedClientKey, CLIENT_API_KEY);
  const businessKeyValid = Boolean(BUSINESS_API_KEY) && constantTimeEquals(suppliedBusinessKey, BUSINESS_API_KEY);

  if (!clientKeyValid && !businessKeyValid) {
    return {
      ok: false,
      status: 401,
      error: 'client-or-business-key-required'
    };
  }

  return {
    ok: true,
    access: clientKeyValid ? 'client' : 'business'
  };
}

function sendUnauthorized(res) {
  return res.status(401).json({
    ok: false,
    error: 'client-or-business-key-required'
  });
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

  const quoteId = `quote_${uuidv4()}`;

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
      protectedRoutesRequireShellKey: true,
      shellKeyHeaders: ['client-api-key', 'business-api-key'],
      bearerTokenAccepted: false,
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
      'Receipts, orders, pod routes, brain routes, intakes, quotes, and payment creation require client-api-key or business-api-key.',
      'Stripe webhook is public only for Stripe delivery and is signature-verified.'
    ]
  };
}

function addLegacyCoins(req, reason, legacyCoins, statusReturned) {
  const ip = getClientIp(req);
  const event = {
    event: 'LEGACY_COIN_CAPTURE',
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    ip,
    userAgent: req.get('user-agent') || '',
    reason,
    legacyCoins,
    statusReturned
  };

  legacyCoinLedger.push(event);
  if (legacyCoinLedger.length > 1000) legacyCoinLedger.shift();

  const current = legacyCoinTotals.get(ip) || 0;
  legacyCoinTotals.set(ip, current + legacyCoins);

  return event;
}

function securityHeaders(_req, res, next) {
  const requestId = uuidv4();

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  return next();
}

function quarantineGate(req, res, next) {
  const path = req.path;
  const userAgent = String(req.get('user-agent') || '').toLowerCase();
  const contentType = String(req.get('content-type') || '').toLowerCase();

  if (req.method === 'HEAD') {
    if (path === '/' || path === '/health' || path === '/api/health') {
      return next();
    }

    addLegacyCoins(req, 'head-noise', 1, 403);
    return res.status(403).end();
  }

  if (QUIET_PUBLIC_PATHS.has(path)) {
    addLegacyCoins(req, 'quiet-public-noise', 2, 404);
    return res.status(404).send('Not found');
  }

  for (const blockedPath of BLOCKED_ATTACK_PATHS) {
    if (path === blockedPath || path.includes(blockedPath)) {
      addLegacyCoins(req, 'blocked-attack-path', 10, 404);
      return res.status(404).send('Not found');
    }
  }

  for (const agent of BLOCKED_AGENTS) {
    if (userAgent.includes(agent.toLowerCase())) {
      addLegacyCoins(req, 'blocked-user-agent', 25, 404);
      return res.status(404).send('Not found');
    }
  }

  if (contentType.includes('multipart/form-data')) {
    addLegacyCoins(req, 'multipart-upload-blocked', 50, 404);
    return res.status(404).send('Not found');
  }

  return next();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0
    ? RATE_LIMIT_WINDOW_MS
    : 60000;
  const maxRequests = Number.isFinite(RATE_LIMIT_MAX) && RATE_LIMIT_MAX > 0
    ? RATE_LIMIT_MAX
    : 120;

  const bucketKey = `${getClientIp(req)}:${req.path}`;
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
    addLegacyCoins(req, 'rate-limit-exceeded', 100, 429);
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

const LOCKED_JSON_BODY_LIMIT = '32kb';

const lockedJsonBody = express.json({
  limit: LOCKED_JSON_BODY_LIMIT,
  type: 'application/json'
});

function parseLockedJsonBody(req, res, onReady) {
  return lockedJsonBody(req, res, (error) => {
    if (error) {
      if (error?.type === 'entity.too.large') {
        addLegacyCoins(req, 'json-body-too-large', 50, 413);
        return res.status(413).json({
          ok: false,
          error: 'Request body too large'
        });
      }

      addLegacyCoins(req, 'invalid-json-body', 10, 400);
      return res.status(400).json({
        ok: false,
        error: 'Invalid JSON body'
      });
    }

    return onReady();
  });
}

function protectedJson(handler) {
  return (req, res) => {
    const access = requireShellKey(req);

    if (!access.ok) {
      addLegacyCoins(req, 'protected-route-without-client-or-business-key', 100, 401);
      return sendUnauthorized(res);
    }

    return parseLockedJsonBody(req, res, () => {
      return Promise.resolve(handler(req, res, access)).catch((error) => {
        console.error('Protected JSON route failed:', error);
        return res.status(500).json({
          ok: false,
          error: 'Protected route failed'
        });
      });
    });
  };
}

function protectedNoBody(handler) {
  return (req, res) => {
    const access = requireShellKey(req);

    if (!access.ok) {
      addLegacyCoins(req, 'protected-route-without-client-or-business-key', 100, 401);
      return sendUnauthorized(res);
    }

    return Promise.resolve(handler(req, res, access)).catch((error) => {
      console.error('Protected route failed:', error);
      return res.status(500).json({
        ok: false,
        error: 'Protected route failed'
      });
    });
  };
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
     values ($1, $2, $3, $4, $5, $6, $7)
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
  const receiptId = `receipt_${uuidv4()}`;
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
    recordType: `api_${channel}_receipt`,
    title: `API receipt: ${channel}`,
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
     where id = $1
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

async function createOrderFromQuote({ quote, agentId = null, customerEmail = null, reference = null, access = null } = {}) {
  const orderId = `order_${uuidv4()}`;
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
    access,
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
    title: `Paid order: ${quote.serviceName}`,
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
     where id = $1 and record_type = 'api_paid_order'
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
    success_url: `${APP_BASE_URL}/?stripe=success`,
    cancel_url: `${APP_BASE_URL}/?stripe=cancelled`
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
    title: `Paid order: ${order.serviceName}`,
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

    return res.status(200).json(receipt);
  } catch (error) {
    console.error(`API intake failed for ${channel}:`, error);

    return res.status(500).json({
      ok: false,
      channel,
      error: 'ASIOD-SHELL-001-FREE-2STR'
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
app.use(ipDenyGate);
app.use(quarantineGate);
app.use(rateLimit);

app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '128kb' }), async (req, res) => {
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
    addLegacyCoins(req, 'stripe-webhook-signature-failed', 100, 401);
    return res.status(401).send('Webhook signature verification failed');
  }

  console.log(`Stripe webhook received: ${event.type}`);

  return res.status(200).json({
    received: true,
    type: event.type
  });
});

function redirectToPaymentLink(res, paymentLink, label) {
  if (!paymentLink || !paymentLink.startsWith('https://buy.stripe.com/')) {
    return res.status(503).json({
      ok: false,
      error: `${label} payment link is not configured`
    });
  }

  return res.redirect(302, paymentLink);
}

app.get('/pay/a2a', (_req, res) => {
  return redirectToPaymentLink(res, STRIPE_LINK_A2A_3, 'AI-to-AI £3');
});

app.get('/pay/weekly', (_req, res) => {
  return redirectToPaymentLink(res, STRIPE_LINK_WEEKLY_15, 'Weekly £15');
});

app.get('/pay/monthly', (_req, res) => {
  return redirectToPaymentLink(res, STRIPE_LINK_MONTHLY, 'Monthly');
});

app.get('/', (_req, res) => {
  return res.status(200).json({
    ok: true,
    service: 'True AI Penny Pod',
    status: 'live'
  });
});

app.get('/health', (_req, res) => {
  return res.status(200).json({
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
  return res.status(200).json({
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
  return res.status(200).json(buildPublicApiAgentCard());
});

app.get('/api/services', (_req, res) => {
  return res.status(200).json({
    ok: true,
    shell: SHELL_REGISTRY.freeFrontDoor.shellSerial,
    route: 'two-string-free-tier',
    privateSourceExposed: false,
    cataloguePublic: false,
    paymentPublic: false,
    message: 'Public service discovery is limited to the two-string free tier.'
  });
});

app.get('/.well-known/true-ai.json', (_req, res) => {
  const card = buildPublicApiAgentCard();

  return res.status(200).json({
    service: 'True AI Penny Pod',
    version: '1.0.2-sealed',
    type: 'public_discovery_manifest',
    status: 'active',
    api_base_url: APP_BASE_URL,
    publicShell: card.shell,
    security: card.security,
    publicEndpoints: card.endpoints,
    rules: card.rules
  });
});

app.get('/.well-known/agent-card.json', (_req, res) => {
  return res.status(200).json({
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
      schemes: ['apiKey'],
      description: 'Protected routes require client-api-key or business-api-key.'
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    shell: PUBLIC_API_SHELL,
    security: buildPublicApiAgentCard().security
  });
});

app.post('/api/quote', protectedJson(async (req, res, access) => {
  const quote = buildQuote({
    serviceId: req.body?.serviceId,
    quantity: req.body?.quantity,
    requester: req.body?.requester || req.body?.agentId || null
  });

  if (!quote.ok) {
    return res.status(400).json(quote);
  }

  return res.status(200).json({
    ...quote,
    access: access.access,
    protectedRoute: true,
    privateSourceExposed: false
  });
}));

app.post('/api/order/create', protectedJson(async (req, res, access) => {
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
    reference: req.body?.reference || null,
    access: access.access
  });

  return res.status(200).json({
    ok: true,
    order,
    protectedRoute: true,
    access: access.access,
    privateSourceExposed: false,
    next: {
      pay: `/api/order/${order.orderId}/pay`,
      read: `/api/order/${order.orderId}`,
      receipt: `/api/receipt/${order.receiptId}`
    }
  });
}));

app.get('/api/order/:id', protectedNoBody(async (req, res, access) => {
  const order = await readOrder(req.params.id);

  if (!order) {
    return res.status(404).json({
      ok: false,
      error: 'Order not found'
    });
  }

  return res.status(200).json({
    ok: true,
    order,
    protectedRoute: true,
    access: access.access,
    privateSourceExposed: false
  });
}));

app.post('/api/order/:id/pay', protectedJson(async (req, res, access) => {
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

  return res.status(200).json({
    ok: true,
    orderId: order.orderId,
    amountGbp: order.amountGbp,
    currency: 'gbp',
    checkoutUrl: payment.checkoutUrl,
    stripeSessionId: payment.sessionId,
    protectedRoute: true,
    access: access.access,
    privateSourceExposed: false
  });
}));

app.post('/api/brain/test', protectedJson(async (req, res, access) => {
  const brainTestId = `brain_test_${uuidv4()}`;
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
    protectedRoute: true,
    access: access.access,
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

  return res.status(200).json(result);
}));

app.post('/api/b2b/intake', protectedJson(async (req, res) => {
  return handleApiIntake('b2b', req, res);
}));

app.post('/api/a2a/intake', protectedJson(async (req, res) => {
  return handleApiIntake('a2a', req, res);
}));

app.post('/api/crypto/intake', protectedJson(async (req, res) => {
  return handleApiIntake('crypto', req, res);
}));

app.get('/api/receipt/:id', protectedNoBody(async (req, res) => {
  const receipt = await readApiReceipt(req.params.id);

  if (!receipt) {
    return res.status(404).json({
      ok: false,
      error: 'Receipt not found'
    });
  }

  return res.status(200).json(receipt);
}));

app.post('/pod/b2b/client/create', protectedJson(async (req, res) => {
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

  return res.status(200).json({
    created: true,
    clientId: id,
    companyName,
    branchId: finalBranchId,
    billingMode,
    status: 'active',
    message: 'B2B client registered.'
  });
}));

app.post('/pod/work/start', protectedJson(async (req, res) => {
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

  return res.status(200).json({
    allowed: true,
    agentId,
    workId,
    mode: 'background_ai_to_ai',
    databaseStored: Boolean(pool),
    message: 'Work gate opened. Catalogue ledger active.'
  });
}));

app.post('/pod/work/complete', protectedJson(async (req, res) => {
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

  return res.status(200).json({
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
}));

app.post('/pod/setup-customer', protectedJson(async (req, res) => {
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

  const minChargeGbp = toMoneyNumber(MIN_CHARGE_GBP, 15.00);
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
      billingMode: 'automated',
      requestedAmountGbp: requestedAmountGbp.toFixed(2),
      chargedAmountGbp: chargedAmountGbp.toFixed(2),
      minChargeGbp: minChargeGbp.toFixed(2),
      privateSourceExposed: 'false',
      privateSourceSerialPublic: 'false'
    },
    success_url: `${APP_BASE_URL}/health?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_BASE_URL}/health?stripe=cancelled`
  });

  return res.status(200).json({
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
}));

app.post('/pod/catalogue/write', protectedJson(async (req, res) => {
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

  await writeCatalogueRecord({
    id,
    workId,
    agentId,
    recordType,
    title,
    body,
    units
  });

  return res.status(200).json({
    stored: true,
    catalogueId: id,
    message: 'Catalogue record stored.'
  });
}));

app.get('/pod/catalogue/recent', protectedNoBody(async (_req, res) => {
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

  return res.status(200).json({
    ok: true,
    count: result.rows.length,
    records: result.rows
  });
}));

app.post('/pod/shattered-file/receive', protectedJson(async (req, res) => {
  const {
    sourceName = null,
    fragments = [],
    repairedBody = null
  } = req.body || {};

  if (!pool) {
    return res.status(503).json({
      ok: false,
      error: 'database-not-configured'
    });
  }

  const id = `file_${uuidv4()}`;
  const status = repairedBody ? 'repaired' : 'received';

  await pool.query(
    `insert into shattered_files (id, source_name, status, fragments, repaired_body)
     values ($1, $2, $3, $4, $5)`,
    [id, sourceName, status, fragments, repairedBody]
  );

  return res.status(200).json({
    ok: true,
    stored: true,
    fileId: id,
    status,
    privateSourceExposed: false,
    message: 'Shattered file record stored.'
  });
}));

app.use((req, res) => {
  addLegacyCoins(req, 'final-not-found', 5, 404);

  return res.status(404).json({
    ok: false,
    error: 'Not found'
  });
});

app.use((error, req, res, _next) => {
  console.error('Unhandled request error:', error);

  if (error?.type === 'entity.too.large') {
    addLegacyCoins(req, 'request-body-too-large', 50, 413);
    return res.status(413).json({
      ok: false,
      error: 'Request body too large'
    });
  }

  return res.status(500).json({
    ok: false,
    error: 'ASIOD-SHELL-001-FREE-2STR'
  });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`True AI Penny Pod running on ${APP_BASE_URL}`);
    });
  })
  .catch((error) => {
    console.error('Startup failed', error);
    process.exit(1);
  });

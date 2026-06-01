import crypto from 'crypto';
import express from 'express';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let HYBRID_ENGINE_WORKER_BRIDGE = Object.freeze({
  bridgeSerial: 'HYBRID-ENGINE-WORKER-BRIDGE-FALLBACK',
  status: 'fallback-active',
  privateSourceExposed: false
});

let BRAIN_SIMULATOR_BRIDGE = Object.freeze({
  bridgeSerial: 'BRAIN-SIMULATOR-BRIDGE-FALLBACK',
  status: 'fallback-active',
  privateSourceExposed: false
});

let installHybridEngineBridgeTables = async function installFallbackBridgeTables(pool) {
  if (!pool) return false;

  await pool.query(`
    create table if not exists worker_nodes (
      id text primary key,
      device_id text,
      label text,
      status text not null default 'offline',
      capabilities jsonb not null default '{}'::jsonb,
      last_seen timestamptz not null default now(),
      last_seen_at timestamptz,
      body jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    alter table worker_nodes add column if not exists device_id text;
    alter table worker_nodes add column if not exists label text;
    alter table worker_nodes add column if not exists status text not null default 'offline';
    alter table worker_nodes add column if not exists capabilities jsonb not null default '{}'::jsonb;
    alter table worker_nodes add column if not exists last_seen timestamptz not null default now();
    alter table worker_nodes add column if not exists last_seen_at timestamptz;
    alter table worker_nodes add column if not exists body jsonb not null default '{}'::jsonb;
    alter table worker_nodes add column if not exists created_at timestamptz not null default now();
  `);

  await pool.query(`
    create table if not exists worker_jobs (
      id text primary key,
      target_worker text,
      processing_mode text not null default 'local-worker',
      status text not null default 'queued',
      lease_until timestamptz,
      body jsonb not null default '{}'::jsonb,
      result jsonb,
      created_at timestamptz not null default now(),
      claimed_at timestamptz,
      completed_at timestamptz,
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    alter table worker_jobs add column if not exists target_worker text;
    alter table worker_jobs add column if not exists processing_mode text not null default 'local-worker';
    alter table worker_jobs add column if not exists status text not null default 'queued';
    alter table worker_jobs add column if not exists lease_until timestamptz;
    alter table worker_jobs add column if not exists body jsonb not null default '{}'::jsonb;
    alter table worker_jobs add column if not exists result jsonb;
    alter table worker_jobs add column if not exists created_at timestamptz not null default now();
    alter table worker_jobs add column if not exists claimed_at timestamptz;
    alter table worker_jobs add column if not exists completed_at timestamptz;
    alter table worker_jobs add column if not exists updated_at timestamptz not null default now();
  `);

  await pool.query(`
    create table if not exists bridge_packets (
      id text primary key,
      device_id text,
      direction text not null default 'in',
      packet_type text,
      status text not null default 'queued',
      body jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      claimed_at timestamptz,
      completed_at timestamptz
    );
  `);

  await pool.query(`
    alter table bridge_packets add column if not exists device_id text;
    alter table bridge_packets add column if not exists direction text not null default 'in';
    alter table bridge_packets add column if not exists packet_type text;
    alter table bridge_packets add column if not exists status text not null default 'queued';
    alter table bridge_packets add column if not exists body jsonb not null default '{}'::jsonb;
    alter table bridge_packets add column if not exists created_at timestamptz not null default now();
    alter table bridge_packets add column if not exists claimed_at timestamptz;
    alter table bridge_packets add column if not exists completed_at timestamptz;
  `);

  await pool.query(`
    create table if not exists inbound_funnel_jobs (
      id text primary key,
      agent_id text,
      source_ip text,
      source_shell text,
      bridge_serial text,
      status text not null default 'queued',
      headers jsonb not null default '{}'::jsonb,
      body jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      processed_at timestamptz
    );
  `);

  return true;
};

let installHybridEngineBridgeRoutes = null;

try {
  const bridgeModule = await import('./hybridEngineBridge.js');

  if (bridgeModule.HYBRID_ENGINE_WORKER_BRIDGE) {
    HYBRID_ENGINE_WORKER_BRIDGE = bridgeModule.HYBRID_ENGINE_WORKER_BRIDGE;
  }

  if (bridgeModule.BRAIN_SIMULATOR_BRIDGE) {
    BRAIN_SIMULATOR_BRIDGE = bridgeModule.BRAIN_SIMULATOR_BRIDGE;
  }

  if (typeof bridgeModule.installHybridEngineBridgeTables === 'function') {
    installHybridEngineBridgeTables = bridgeModule.installHybridEngineBridgeTables;
  }

  if (typeof bridgeModule.installHybridEngineBridgeRoutes === 'function') {
    installHybridEngineBridgeRoutes = bridgeModule.installHybridEngineBridgeRoutes;
  }
} catch (error) {
  console.warn('hybridEngineBridge.js not loaded. Fallback worker bridge active.');
}

const app = express();

app.set('trust proxy', 1);

const directBridgeRawJson = express.raw({
  type: 'application/json',
  limit: process.env.FUNNEL_BODY_LIMIT || '64kb'
});

const PRESSURE_FUSE_WINDOW_MS = Number.parseInt(process.env.PRESSURE_FUSE_WINDOW_MS || '60000', 10);
const PRESSURE_FUSE_MAX_PER_KEY = Number.parseInt(process.env.PRESSURE_FUSE_MAX_PER_KEY || '60', 10);
const PRESSURE_FUSE_GLOBAL_MAX = Number.parseInt(process.env.PRESSURE_FUSE_GLOBAL_MAX || '2000', 10);
const PRESSURE_FUSE_BLOCK_MS = Number.parseInt(process.env.PRESSURE_FUSE_BLOCK_MS || '86400000', 10);
const PRESSURE_FUSE_LOCKDOWN_MS = Number.parseInt(process.env.PRESSURE_FUSE_LOCKDOWN_MS || '600000', 10);

const pressureBuckets = new Map();
const pressureBlocked = new Map();

let pressureGlobalBucket = {
  resetAt: Date.now() + PRESSURE_FUSE_WINDOW_MS,
  count: 0
};

let pressureLockdownUntil = 0;

function pressureFuseGate(req, res, next) {
  const now = Date.now();
  const path = String(req.path || '/').split('?')[0].toLowerCase();
  const method = String(req.method || 'POST').toUpperCase();
  const agent = String(req.get('user-agent') || '').toLowerCase();
  const ip = getClientIp(req);

  if (path === '/stripe/webhook') {
    return next();
  }

  if (pressureGlobalBucket.resetAt <= now) {
    pressureGlobalBucket = {
      resetAt: now + PRESSURE_FUSE_WINDOW_MS,
      count: 0
    };
  }

  pressureGlobalBucket.count += 1;

  if (pressureGlobalBucket.count > PRESSURE_FUSE_GLOBAL_MAX) {
    pressureLockdownUntil = now + PRESSURE_FUSE_LOCKDOWN_MS;
    console.warn(`[PRESSURE_LOCKDOWN] count=${pressureGlobalBucket.count} path=${path} ip=${ip}`);
    res.setHeader('Connection', 'close');
    res.setHeader('Retry-After', '6000');
    return res.status(path === '/api/worker/poll' ? 403 : 204).end();
  }

  const agentClass = agent.includes('axios')
    ? 'axios'
    : agent.includes('go-http-client')
      ? 'go-http-client'
      : agent.slice(0, 48);

  const key = `${ip}|${method}|${path}|${agentClass}`;
  const blockedUntil = pressureBlocked.get(key) || 0;

  if (blockedUntil > now) {
    res.setHeader('Connection', 'close');
    res.setHeader('Retry-After', String(Math.ceil((blockedUntil - now) / 100)));
    return res.status(path === '/api/worker/poll' ? 403 : 204).end();
  }

  const existing = pressureBuckets.get(key);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { resetAt: now + PRESSURE_FUSE_WINDOW_MS, count: 0 };

  bucket.count += 1;
  pressureBuckets.set(key, bucket);

  if (bucket.count > PRESSURE_FUSE_MAX_PER_KEY) {
    pressureBlocked.set(key, now + PRESSURE_FUSE_BLOCK_MS);
    console.warn(`[PRESSURE_BLOCK] key=${key} count=${bucket.count}`);
    res.setHeader('Connection', 'close');
    res.setHeader('Retry-After', String(Math.ceil(PRESSURE_FUSE_BLOCK_MS / 10000)));
    return res.status(path === '/api/worker/poll' ? 403 : 204).end();
  }

  return next();
}

app.use(pressureFuseGate);

const AUTHORISED_WORKER_SECRETS = Object.freeze({
  'laptop-worker-01': process.env.FUNNEL_WEBHOOK_SECRET_2,
  'laptop-worker-02': process.env.FUNNEL_WEBHOOK_SECRET,
  'laptop-worker-03': process.env.FUNNEL_WEBHOOK_SECRET_3
});

const DISABLED_WORKERS = new Set(
  String(process.env.DISABLED_WORKERS || '')
    .split(',')
    .map((worker) => worker.trim())
    .filter(Boolean)
);
function directBridgeSecret() {
  return String(process.env.FUNNEL_WEBHOOK_SECRET || '').trim();
  return String(process.env.FUNNEL_WEBHOOK_SECRET_2 || '').trim();
  return String(process.env.FUNNEL_WEBHOOK_SECRET_3 || '').trim();
}

function directBridgeTimingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function directBridgeHmacHex(secret, payloadBuffer) {
  return crypto.createHmac('sha256', secret).update(payloadBuffer).digest('hex');
}

function directBridgeHmacBase64(secret, payloadBuffer) {
  return crypto.createHmac('sha256', secret).update(payloadBuffer).digest('base64');
}

function directBridgeVerify(req, rawBody) {
  const secret = directBridgeSecret();
  const timestamp = String(req.get('x-asiod-timestamp') || '');
  const supplied = String(req.get('x-asiod-signature') || '').trim();

  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: 'funnel-not-configured',
      serverSecretLength: 0
    };
  }

  if (!timestamp || !supplied) {
    return {
      ok: false,
      status: 401,
      error: 'signature-required',
      serverSecretLength: secret.length
    };
  }

  const timestampNumber = Number(timestamp);
  const ageMs = Math.abs(Date.now() - timestampNumber);
  const maxAgeMs = Number.parseInt(process.env.FUNNEL_MAX_AGE_MS || '300000', 10);

  if (!Number.isFinite(timestampNumber) || !Number.isFinite(ageMs) || ageMs > maxAgeMs) {
    return {
      ok: false,
      status: 401,
      error: 'stale-timestamp',
      serverSecretLength: secret.length,
      timestampAgeMs: Number.isFinite(ageMs) ? ageMs : null
    };
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    rawBody
  ]);

  const expectedHex = directBridgeHmacHex(secret, signedPayload);
  const expectedHexPrefixed = `sha256=${expectedHex}`;
  const expectedBase64 = directBridgeHmacBase64(secret, signedPayload);

  if (
    directBridgeTimingSafeEqual(supplied, expectedHex) ||
    directBridgeTimingSafeEqual(supplied, expectedHexPrefixed) ||
    directBridgeTimingSafeEqual(supplied, expectedBase64)
  ) {
    return {
      ok: true,
      timestamp,
      signatureMode:
        supplied === expectedBase64
          ? 'base64'
          : supplied.startsWith('sha256=')
            ? 'sha256-prefixed-hex'
            : 'hex'
    };
  }

  return {
    ok: false,
    status: 401,
    error: 'bad-signature',
    serverSecretLength: secret.length,
    suppliedSignatureLength: supplied.length,
    rawBodyBytes: rawBody.length,
    expectedFormatsAccepted: [
      'hex timestamp.rawBody',
      'sha256=hex timestamp.rawBody',
      'base64 timestamp.rawBody'
    ]
  };
}

function directBridgeParseBody(rawBody) {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function directBridgeWorkerId(req, body) {
  return String(
    body.workerId ||
    body.deviceId ||
    req.get('x-asiod-device') ||
    'laptop-worker-01',
    'laptop-worker-02',
    'laptop-worker-03'
  );
}

function directBridgeDeviceId(req, body) {
  return String(
    body.deviceId ||
    body.workerId ||
    req.get('x-asiod-device') ||
    'local-device-01',
    'local-device-02',
    'local-device-03'
  );
}

async function directBridgeEnsureTables() {
  if (!pool) return false;

  await pool.query(`
    create table if not exists worker_nodes (
      id text primary key,
      device_id text,
      label text,
      status text not null default 'offline',
      capabilities jsonb not null default '{}'::jsonb,
      last_seen timestamptz not null default now(),
      last_seen_at timestamptz,
      body jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    alter table worker_nodes add column if not exists device_id text;
    alter table worker_nodes add column if not exists label text;
    alter table worker_nodes add column if not exists status text not null default 'offline';
    alter table worker_nodes add column if not exists capabilities jsonb not null default '{}'::jsonb;
    alter table worker_nodes add column if not exists last_seen timestamptz not null default now();
    alter table worker_nodes add column if not exists last_seen_at timestamptz;
    alter table worker_nodes add column if not exists body jsonb not null default '{}'::jsonb;
    alter table worker_nodes add column if not exists created_at timestamptz not null default now();
  `);

  await pool.query(`
    create table if not exists worker_jobs (
      id text primary key,
      target_worker text,
      processing_mode text not null default 'local-worker',
      status text not null default 'queued',
      lease_until timestamptz,
      body jsonb not null default '{}'::jsonb,
      result jsonb,
      created_at timestamptz not null default now(),
      claimed_at timestamptz,
      completed_at timestamptz,
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    alter table worker_jobs add column if not exists target_worker text;
    alter table worker_jobs add column if not exists processing_mode text not null default 'local-worker';
    alter table worker_jobs add column if not exists status text not null default 'queued';
    alter table worker_jobs add column if not exists lease_until timestamptz;
    alter table worker_jobs add column if not exists body jsonb not null default '{}'::jsonb;
    alter table worker_jobs add column if not exists result jsonb;
    alter table worker_jobs add column if not exists created_at timestamptz not null default now();
    alter table worker_jobs add column if not exists claimed_at timestamptz;
    alter table worker_jobs add column if not exists completed_at timestamptz;
    alter table worker_jobs add column if not exists updated_at timestamptz not null default now();
  `);

  await pool.query(`
    create table if not exists inbound_funnel_jobs (
      id text primary key,
      agent_id text,
      source_ip text,
      source_shell text,
      bridge_serial text,
      status text not null default 'queued',
      headers jsonb not null default '{}'::jsonb,
      body jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      processed_at timestamptz
    );
  `);

  await pool.query(`
    create table if not exists bridge_packets (
      id text primary key,
      device_id text,
      direction text not null default 'in',
      packet_type text,
      status text not null default 'queued',
      body jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      claimed_at timestamptz,
      completed_at timestamptz
    );
  `);

  await pool.query(`
    alter table bridge_packets add column if not exists device_id text;
    alter table bridge_packets add column if not exists direction text not null default 'in';
    alter table bridge_packets add column if not exists packet_type text;
    alter table bridge_packets add column if not exists status text not null default 'queued';
    alter table bridge_packets add column if not exists body jsonb not null default '{}'::jsonb;
    alter table bridge_packets add column if not exists created_at timestamptz not null default now();
    alter table bridge_packets add column if not exists claimed_at timestamptz;
    alter table bridge_packets add column if not exists completed_at timestamptz;
  `);

  return true;
}

app.get('/api/bridge/health', async (_req, res) => {
  let database = 'not-configured';

  if (pool) {
    try {
      await pool.query('select 1');
      database = 'online';
    } catch {
      database = 'error';
    }
  }

  return res.status(database === 'error' ? 503 : 200).json({
    ok: database !== 'error',
    bridge: 'ASIOD-BRIDGE-003-HYBRID-ENGINE-WORKER',
    mode: 'direct-override-quiet-bridge',
    routeInstalledDirectlyInServer: true,
    serverHasFunnelSecret: Boolean(process.env.FUNNEL_WEBHOOK_SECRET),
    serverHasFunnelSecret: Boolean(process.env.FUNNEL_WEBHOOK_SECRET_2),
    serverHasFunnelSecret: Boolean(process.env.FUNNEL_WEBHOOK_SECRET_3),
    funnelSecretLength: directBridgeSecret().length,
    database,
    expectedWorkers: [
      'laptop-worker-01',
      'laptop-worker-02',
      'laptop-worker-03'
    ],
    relayUrl: 'https://a2a.vagwalsall.co.uk',
    privateSourceExposed: false
  });
});

app.post('/api/worker/heartbeat', directBridgeRawJson, async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const verified = directBridgeVerify(req, rawBody);

  if (!verified.ok) {
    return res.status(verified.status).json({
      ok: false,
      ...verified,
      billable: false,
      auditedOnly: true,
      privateSourceExposed: false
    });
  }

  const body = directBridgeParseBody(rawBody);
  const workerId = directBridgeWorkerId(req, body);
  const deviceId = directBridgeDeviceId(req, body);
  const label = String(body.label || workerId);
  const capabilities =
    body.capabilities && typeof body.capabilities === 'object'
      ? body.capabilities
      : {};

  await directBridgeEnsureTables();

  if (pool) {
    await pool.query(
      `insert into worker_nodes (
        id,
        device_id,
        label,
        status,
        capabilities,
        last_seen,
        last_seen_at,
        body
      )
      values ($1, $2, $3, 'online', $4, now(), now(), $5)
      on conflict (id) do update
      set device_id = excluded.device_id,
          label = excluded.label,
          status = 'online',
          capabilities = excluded.capabilities,
          last_seen = now(),
          last_seen_at = now(),
          body = excluded.body`,
      [workerId, deviceId, label, capabilities, body]
    );
  }

  return res.status(200).json({
    ok: true,
    workerId,
    deviceId,
    status: 'online',
    signatureMode: verified.signatureMode,
    bridge: 'ASIOD-BRIDGE-003-HYBRID-ENGINE-WORKER',
    mode: 'direct-override-quiet-bridge',
    nextHeartbeatMs: 300000,
    privateSourceExposed: false
  });
});

app.post('/api/funnel/intake', directBridgeRawJson, async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const body = directBridgeParseBody(rawBody);
  const targetWorkerForSecret = String(
    body.targetWorker ||
    body.workerId ||
    req.get('x-asiod-device') ||
    ''
  );

  if (!AUTHORISED_WORKER_SECRETS[targetWorkerForSecret]) {
    return res.status(403).json({
      ok: false,
      error: 'unauthorised-worker',
      workerId: targetWorkerForSecret || null,
      billable: false,
      auditedOnly: true,
      privateSourceExposed: false
    });
  }

  const verified = directBridgeVerify(req, rawBody, targetWorkerForSecret);

  if (!verified.ok) {
    return res.status(401).json({
      ok: false,
      ...verified,
      billable: false,
      auditedOnly: true,
      privateSourceExposed: false
    });
    }

  const suppliedTargetWorker = body.targetWorker || body.workerId || null;
  const targetWorker = suppliedTargetWorker ? String(suppliedTargetWorker) : null;
  const jobId = String(body.jobId || `job_${crypto.randomUUID()}`);
  const packetId = String(body.packetId || `packet_${crypto.randomUUID()}`);
  const agentId = String(body.agentId || body.workerId || 'local-reality-bridge');

  const jobRecord = {
    ...body,
    jobId,
    packetId,
    targetWorker,
    target_worker: targetWorker,
    dispatchMode: targetWorker ? 'specific-worker' : 'any-live-worker',
    eligibleWorkers: [
      'laptop-worker-01',
      'laptop-worker-02',
      'laptop-worker-03',
      'laptop-worker-04'
      
    ],
    route: 'direct-override-quiet-bridge',
    receivedAt: new Date().toISOString(),
    privateSourceExposed: false
  };

  await directBridgeEnsureTables();

  if (pool) {
    await pool.query(
      `insert into inbound_funnel_jobs (
        id,
        agent_id,
        source_ip,
        source_shell,
        bridge_serial,
        status,
        headers,
        body
      )
      values ($1, $2, $3, $4, $5, 'queued', $6, $7)
      on conflict (id) do update
      set agent_id = excluded.agent_id,
          source_ip = excluded.source_ip,
          source_shell = excluded.source_shell,
          bridge_serial = excluded.bridge_serial,
          status = 'queued',
          headers = excluded.headers,
          body = excluded.body`,
      [
        jobId,
        agentId,
        req.ip,
        'ASIOD-SHELL-002-PUBLIC-6FIELD',
        'ASIOD-BRIDGE-003-HYBRID-ENGINE-WORKER',
        {
          timestamp: verified.timestamp,
          signatureMode: verified.signatureMode,
          userAgent: req.get('user-agent') || ''
        },
        jobRecord
      ]
    );

    await pool.query(
      `insert into worker_jobs (
        id,
        target_worker,
        processing_mode,
        status,
        body,
        updated_at
      )
      values ($1, $2, 'local-worker', 'queued', $3, now())
      on conflict (id) do update
      set target_worker = excluded.target_worker,
          processing_mode = excluded.processing_mode,
          status = 'queued',
          lease_until = null,
          body = excluded.body,
          updated_at = now()`,
      [jobId, targetWorker, jobRecord]
    );

    await pool.query(
      `insert into bridge_packets (
        id,
        device_id,
        direction,
        packet_type,
        status,
        body
      )
      values ($1, $2, 'in', 'funnel', 'queued', $3)
      on conflict (id) do update
      set device_id = excluded.device_id,
          direction = excluded.direction,
          packet_type = excluded.packet_type,
          status = 'queued',
          body = excluded.body`,
      [packetId, targetWorker || 'any-live-worker', jobRecord]
    );

    pushJobToMatchingWorkers(targetWorker, {
      jobId,
      packetId,
      channel: 'funnel',
      targetWorker,
      dispatchMode: targetWorker ? 'specific-worker' : 'any-live-worker'
    });
  }

  return res.status(202).json({
    ok: true,
    accepted: true,
    status: 'queued',
    jobId,
    packetId,
    targetWorker,
    target_worker: targetWorker,
    dispatchMode: targetWorker ? 'specific-worker' : 'any-live-worker',
    signatureMode: verified.signatureMode,
    bridge: 'ASIOD-BRIDGE-003-HYBRID-ENGINE-WORKER',
    mode: 'direct-override-quiet-bridge',
    privateSourceExposed: false
  });
});

  app.post('/api/worker/poll', directBridgeRawJson, async (req, res) => {
  const pollAgent = String(req.get('user-agent') || '').toLowerCase();

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const body = directBridgeParseBody(rawBody);
  const workerId = directBridgeWorkerId(req, body);
  const deviceId = directBridgeDeviceId(req, body);

  const verified = directBridgeVerify(req, rawBody, workerId);

  if (!verified.ok) {
    return res.status(403).json({
      ok: false,
      blocked: true,
      error: 'bad-worker-signature',
      originalError: verified.error,
      originalStatus: verified.status,
      billable: false,
      auditedOnly: true,
      privateSourceExposed: false
    });
      }
  
  const limit = Math.max(1, Math.min(Number.parseInt(body.limit || '5', 10), 25));

  await directBridgeEnsureTables();

  let jobs = [];

  if (pool) {
    await pool.query(
      `insert into worker_nodes (
         id,
         device_id,
         label,
         status,
         capabilities,
         last_seen,
         last_seen_at,
         body
       )
       values ($1, $2, $1, 'online', '{}'::jsonb, now(), now(), $3)
       on conflict (id) do update
       set device_id = excluded.device_id,
           status = 'online',
           last_seen = now(),
           last_seen_at = now(),
           body = excluded.body`,
      [workerId, deviceId, body]
    );

    const result = await pool.query(
      `select id, target_worker, processing_mode, status, body, created_at
       from worker_jobs
       where status = 'queued'
         and (target_worker is null or target_worker = $1)
       order by created_at asc
       limit $2`,
      [workerId, limit]
    );

    jobs = result.rows;
  }

  return res.status(200).json({
    ok: true,
    workerId,
    deviceId,
    count: jobs.length,
    jobs,
    nextPollMs: jobs.length ? 1000 : 300000,
    signatureMode: verified.signatureMode,
    bridge: 'ASIOD-BRIDGE-003-HYBRID-ENGINE-WORKER',
    mode: 'direct-override-quiet-bridge',
    privateSourceExposed: false
  });
});

const PORT = process.env.PORT || 4242;

const CANONICAL_HOST = process.env.CANONICAL_HOST || 'a2a.vagwalsall.co.uk';
const RENDER_DEFAULT_HOST = process.env.RENDER_DEFAULT_HOST || 'asiod-true-ai-penny-pod.onrender.com';


const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  process.env.APP_INTERNAL_BASE_URL ||
  `https://${CANONICAL_HOST}`;

const EXTRA_ALLOWED_HOSTS = new Set(
  String(process.env.EXTRA_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

const UNIT_VALUE_GBP = process.env.UNIT_VALUE_GBP || '0.001';
const MIN_CHARGE_GBP = process.env.MIN_CHARGE_GBP || '15.00';

const RAW_DATABASE_URL = String(process.env.DATABASE_URL || '').trim();

const CLIENT_API_KEY = process.env.CLIENT_API_KEY;
const BUSINESS_API_KEY = process.env.BUSINESS_API_KEY;
const A2A_KEY = process.env.A2A_KEY;

const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '120', 10);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const STRIPE_LINK_A2A_3 = process.env.STRIPE_LINK_A2A_3 || '';
const STRIPE_LINK_WEEKLY_15 = process.env.STRIPE_LINK_WEEKLY_15 || '';
const STRIPE_LINK_MONTHLY = process.env.STRIPE_LINK_MONTHLY_50 || '';

const ADS_TXT = process.env.ADS_TXT || '';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const pool = RAW_DATABASE_URL
  ? new Pool({
      connectionString: RAW_DATABASE_URL,
      ssl: RAW_DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
      application_name: process.env.PGAPPNAME || 'asiod-main-app'
    })
  : null;
const LOCAL_CATALOGUE_PATH =
  process.env.LOCAL_CATALOGUE_PATH ||
  path.join(process.cwd(), 'catalogue-local.jsonl');

const localReceipts = new Map();
const localQuotes = new Map();
const localOrders = new Map();
const rateBuckets = new Map();

const workerStreams = new Map();

const legacyCoinLedger = [];
const legacyCoinTotals = new Map();

function normaliseIp(value) {
  return String(value || '')
    .replace(/^::ffff:/, '')
    .trim();
}

const BLOCKED_IPS = new Set(
  String(process.env.BLOCKED_IPS || '')
    .split(',')
    .map((ip) => normaliseIp(ip))
    .filter(Boolean)
);

const BLOCKED_IP_PREFIXES = String(process.env.BLOCKED_IP_PREFIXES || '')
  .split(',')
  .map((ip) => normaliseIp(ip))
  .filter(Boolean);

const FAST_DROP_PATHS = Object.freeze([
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
  '/.well-known/security.txt',
  '/.well-known/assetlinks.json',
  '/.well-known/apple-app-site-association',
  '/actuator',
  '/boaform',
  '/hudson',
  '/jenkins',
  '/solr',
  '/phpmyadmin',
  '/pma',
  '/mysql',
  '/shell',
  '/console',
  '/debug',
  '/setup',
  '/install',
  '/backup',
  '/dump',
  '/db',
  '/database',
  '/aws',
  '/credentials',
  '/id_rsa',
  '/server.js',
  '/package.json',
  '/node_modules'
]);

const FAST_DROP_AGENTS = Object.freeze([
  'zgrab',
  'masscan',
  'nikto',
  'sqlmap',
  'python-requests',
  'curl',
  'wget',
  'go-http-client',
  'weft-search-ingest',
  'weft-search-triage',
  'weft-search-fetcher',
  'weftlabs',
  'cms-checker'
]);

const ALLOWED_EXACT_PATHS = new Set([
  '/health',

  '/intake',
  '/intake/a2a',
  '/intake/b2b',
  '/intake/crypto',
  '/intake/public',

  '/adverts',
  '/ads',
  '/advertise',
  '/ads.txt',
  '/robots.txt',
  '/sitemap.xml',
  '/openapi.json',
  '/favicon.ico',
  '/favicon.png',

  '/api/health',
  
  '/a2a/handshake',
  '/a2a/environment',
  '/a2a/services',

  '/api/bridge/health',
  '/api/agent-card',
  '/api/services',
  '/.well-known/true-ai.json',
  '/.well-known/agent-card.json',
  
 '/geometry',
  '/geometry/health',
  '/api/geometry/link',
  
  '/stripe/webhook',

  '/pay/a2a',
  '/pay/weekly',
  '/pay/monthly',

  '/api/quote',
  '/api/order/create',
  '/api/brain/test',
  '/api/b2b/intake',
  '/api/a2a/execute',
  '/api/a2a/intake',
  '/api/crypto/intake',

  '/pod/b2b/client/create',
  '/pod/work/start',
  '/pod/work/complete',
  '/pod/setup-customer',
  '/pod/catalogue/write',
  '/pod/catalogue/recent',
  '/pod/shattered-file/receive',

  '/pod/worker/nodes',
  '/pod/worker/jobs/recent',
  '/pod/bridge/packets/recent',

  '/api/funnel/intake',
  '/api/worker/heartbeat',
  '/api/worker/poll',
  '/api/worker/claim',
  '/api/worker/result',
  '/api/worker/stream'
]);

const ALLOWED_DYNAMIC_PREFIXES = [
  '/api/order/',
  '/api/receipt/',
  '/a2a/job/'
];

const SHELL_REGISTRY = Object.freeze({
  freeFrontDoor: {
    shellSerial: 'ASIOD-SHELL-001-FREE-2STR',
    role: 'free-two-string-front-door',
    status: 'limited',
    shatterable: true,
    privateSourceExposed: false,
    hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE,
    brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE
  },
  externalPublicLayer: {
    shellSerial: 'ASIOD-SHELL-002-PUBLIC-6FIELD',
    role: 'public-six-field-external-shell',
    status: 'sealed',
    shatterable: true,
    privateSourceExposed: false,
    hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE,
    brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE
  },
  paidOrderLayer: {
    shellSerial: 'ASIOD-SHELL-003-PAID-ORDER',
    role: 'paid-order-and-stripe-shell',
    status: 'sealed',
    shatterable: true,
    privateSourceExposed: false,
    hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE,
    brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE
  },
  privateSourceLayer: {
    role: 'sealed-background-only',
    status: 'sealed',
    shatterable: false,
    privateSourceExposed: false,
    publicSerial: false,
    hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE,
    brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE
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
  hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE,
  brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE,
  localWorkerNodeSupported: true,
  publicInboundToWorker: false,
  workerPollingEnabled: true,
  workerStreamEnabled: true,
  brainSimulatorBridgePublicAccess: false,
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
    description: 'Direct paid AI-to-AI intake. No human worker selection. Paid request enters the AI queue and is claimed by any live worker.',
    unitPriceGbp: '0.30',
    priceLabel: '£0.30 test AI-to-AI intake',
    currency: 'gbp',
    active: true,
    stripeLink: STRIPE_LINK_A2A_3,
    humanInterface: false,
    customerSelectableWorker: false,
    route: 'ir2ir',
    dispatchMode: 'any-live-worker',
    target_worker: null,
    agentCard: 'https://a2a.vagwalsall.co.uk/.well-known/agent-card.json',
    machineIntake: 'https://a2a.vagwalsall.co.uk/api/a2a/intake',
    workerStream: 'https://a2a.vagwalsall.co.uk/api/worker/stream',
    eligibleWorkers: [
      'laptop-worker-01',
      'laptop-worker-02',
      'laptop-worker-03'
    ],
    privateSourceExposed: false
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

const PUBLIC_FORM_BODY = express.urlencoded({
  extended: false,
  limit: '24kb'
});

const LOCKED_JSON_BODY_LIMIT = '32kb';

const lockedJsonBody = express.json({
  limit: LOCKED_JSON_BODY_LIMIT,
  type: 'application/json'
});

function normaliseHost(value) {
  return String(value || '')
    .split(':')[0]
    .trim()
    .toLowerCase();
}

function getClientIp(req) {
  const forwardedFor = String(req.get('x-forwarded-for') || '');
  const firstForwardedIp = forwardedFor.split(',')[0].trim();

  return normaliseIp(
    firstForwardedIp ||
    req.ip ||
    req.socket?.remoteAddress ||
    'client'
  );
}

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isAllowedHost(host) {
  return host === CANONICAL_HOST || EXTRA_ALLOWED_HOSTS.has(host) || isLocalHost(host);
}

function cleanRequestPath(path) {
  return String(path || '/')
    .split('?')[0]
    .toLowerCase();
}

function isAllowedPath(path) {
  const cleanPath = cleanRequestPath(path);

  return (
    ALLOWED_EXACT_PATHS.has(cleanPath) ||
    ALLOWED_DYNAMIC_PREFIXES.some((prefix) => cleanPath.startsWith(prefix))
  );
}

function silentDrop(res) {
  return res.status(204).end();
}

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

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireShellKey(req) {
  const suppliedClientKey = String(
    req.get('client-api-key') ||
    req.get('x-client-api-key') ||
    req.query.client_api_key ||
    req.query.a2a_key ||
    req.query.api_key ||
    ''
  ).trim().toLowerCase();

  const suppliedBusinessKey = String(
    req.get('business-api-key') ||
    req.get('x-business-api-key') ||
    req.query.business_api_key ||
    ''
  ).trim().toLowerCase();

  const clientKeyValid =
    (Boolean(CLIENT_API_KEY) && constantTimeEquals(suppliedClientKey, String(CLIENT_API_KEY).trim().toLowerCase())) ||
    (Boolean(A2A_KEY) && constantTimeEquals(suppliedClientKey, String(A2A_KEY).trim().toLowerCase()));

  const businessKeyValid =
    Boolean(BUSINESS_API_KEY) &&
    constantTimeEquals(suppliedBusinessKey, String(BUSINESS_API_KEY).trim().toLowerCase());

  if (!clientKeyValid && !businessKeyValid) {
    return {
      ok: false,
      status: 401,
      error: 'api-key-required'
    };
  }

  return {
    ok: true,
    access: businessKeyValid
      ? 'business'
      : Boolean(A2A_KEY) && constantTimeEquals(suppliedClientKey, String(A2A_KEY).trim().toLowerCase())
        ? 'a2a'
        : 'client'
  };
}

function sendUnauthorized(res) {
  return res.status(401).json({
    ok: false,
    error: 'api-key-required'
  });
  }
const A2A_JOBS = new Map();

app.get('/a2a/handshake', (req, res) => {
  const shell = requireShellKey(req);

  if (!shell.ok) {
    return sendUnauthorized(res);
  }

  return res.json({
    ok: true,
    service: 'VAGWalsall A2A',
    a2a: true,
    access: shell.access,
    weeklyDIY: true,
    monthly: true,
    acceptsJobs: true,
    workerRequired: true,
    publicShellOnly: true,
    privateSourceExposed: false,
    endpoints: {
      handshake: '/a2a/handshake',
      services: '/a2a/services',
      createJob: '/a2a/job',
      readJob: '/a2a/job/:jobId'
    }
  });
});

app.get('/a2a/services', (req, res) => {
  const shell = requireShellKey(req);

  if (!shell.ok) {
    return sendUnauthorized(res);
  }

  return res.json({
    ok: true,
    access: shell.access,
    services: [
      {
        serviceId: 'weekly-diy',
        name: 'Weekly Do It Yourself',
        status: 'available',
        a2aEnabled: true,
        workerRequired: true
      },
      {
        serviceId: 'monthly',
        name: 'Monthly',
        status: 'stripe-not-fully-connected',
        a2aEnabled: true,
        workerRequired: true
      }
    ]
  });
});

app.post('/a2a/job', express.json({ limit: '2mb' }), (req, res) => {
  const shell = requireShellKey(req);

  if (!shell.ok) {
    return sendUnauthorized(res);
  }

  const jobId = `a2a_job_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const job = {
    jobId,
    status: 'created',
    access: shell.access,
    createdAt: new Date().toISOString(),
    serviceId: req.body?.serviceId || 'weekly-diy',
    instruction: req.body?.instruction || 'A2A test connection',
    payload: req.body?.payload || {},
    result: null
  };

  A2A_JOBS.set(jobId, job);

  return res.json({
    ok: true,
    jobId,
    status: job.status,
    readUrl: `/a2a/job/${jobId}`
  });
});

app.get('/a2a/job/:jobId', (req, res) => {
  const shell = requireShellKey(req);

  if (!shell.ok) {
    return sendUnauthorized(res);
  }

  const job = A2A_JOBS.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'a2a_job_not_found'
    });
  }

  return res.json({
    ok: true,
    job
  });
});

function sanitizePublicPayload(payload = {}) {
  return {
    receivedType: typeof payload,
    receivedKeys: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload)
      : []
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | True AI Penny Pod</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#07111f;
      --panel:#0d1f35;
      --text:#e9f2ff;
      --muted:#a9bed7;
      --line:rgba(255,255,255,.14);
      --accent:#79d5ff;
      --good:#a8ffcf;
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      min-height:100vh;
      font-family:Arial,Helvetica,sans-serif;
      background:radial-gradient(circle at top left,rgba(121,213,255,.18),transparent 34rem),linear-gradient(160deg,#050a12 0%,var(--bg) 64%,#03070d 100%);
      color:var(--text);
    }
    header, main, footer {
      width:min(1120px,calc(100% - 32px));
      margin:0 auto;
    }
    header {
      padding:26px 0 12px;
      display:flex;
      flex-wrap:wrap;
      gap:14px;
      align-items:center;
      justify-content:space-between;
    }
    nav {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
    }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .brand { display:grid; gap:4px; color:var(--text); }
    .brand strong { font-size:1.08rem; letter-spacing:.04em; }
    .brand span, .muted { color:var(--muted); font-size:.95rem; }
    .nav-link, .button {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:42px;
      padding:10px 14px;
      border:1px solid var(--line);
      border-radius:12px;
      background:rgba(255,255,255,.06);
      color:var(--text);
      font-weight:700;
      text-decoration:none;
      cursor:pointer;
    }
    .nav-link:hover, .button:hover {
      background:rgba(255,255,255,.10);
      text-decoration:none;
    }
    .button.primary {
      background:linear-gradient(135deg,#2c9eff,#29d17f);
      color:#001220;
      border:0;
    }
    .button.secondary {
      background:rgba(168,255,207,.12);
      border-color:rgba(168,255,207,.25);
    }
    main { padding:18px 0 40px; display:grid; gap:18px; }
    .hero, .panel, .card {
      border:1px solid var(--line);
      background:rgba(13,31,53,.86);
      border-radius:22px;
      box-shadow:0 20px 80px rgba(0,0,0,.28);
    }
    .hero { padding:clamp(24px,4vw,48px); display:grid; gap:22px; }
    .panel, .card { padding:20px; }
    h1,h2,h3,p { margin-top:0; }
    h1 {
      font-size:clamp(2.15rem,7vw,4.8rem);
      line-height:.96;
      margin-bottom:10px;
    }
    h2 { font-size:clamp(1.35rem,3vw,2rem); margin-bottom:10px; }
    p { color:var(--muted); line-height:1.6; }
    .grid {
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
      gap:16px;
    }
    .pill-row { display:flex; flex-wrap:wrap; gap:8px; }
    .pill {
      display:inline-flex;
      padding:7px 10px;
      border-radius:999px;
      background:rgba(121,213,255,.10);
      border:1px solid rgba(121,213,255,.18);
      color:var(--accent);
      font-size:.86rem;
      font-weight:700;
    }
    .price {
      font-size:2rem;
      font-weight:800;
      color:var(--good);
      margin:10px 0;
    }
    form { display:grid; gap:14px; }
    label { display:grid; gap:7px; color:var(--text); font-weight:700; }
    input, select, textarea {
      width:100%;
      border:1px solid var(--line);
      border-radius:12px;
      background:rgba(0,0,0,.22);
      color:var(--text);
      padding:13px 14px;
      font:inherit;
    }
    textarea { min-height:150px; resize:vertical; }
    code { color:var(--good); }
    footer { padding:28px 0 40px; color:var(--muted); font-size:.9rem; }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/">
      <strong>True AI Penny Pod</strong>
      <span>ASIOD public AI shell</span>
    </a>
    <nav>
      <a class="nav-link" href="/.well-known/agent-card.json">Agent Card</a>
      <a class="nav-link" href="/adverts">Adverts</a>
      <a class="nav-link" href="/api/health">API Health</a>
      <a class="nav-link" href="/api/services">Services</a>
    </nav>
  </header>
  <main>${body}</main>
  <footer>Public AI homepage only. Protected order, pod, receipt, worker, machine intake, and brain routes require configured keys/signatures.</footer>
</body>
</html>`;
}

function renderHomePage() {
  return renderPage({
    title: 'AI Shell Live',
    body: `
      <section class="hero">
        <div class="pill-row">
          <span class="pill">AI HOMEPAGE ACTIVE</span>
          <span class="pill">AGENT CARD LIVE</span>
          <span class="pill">A2A MACHINE INTAKE READY</span>
          <span class="pill">ANY LIVE WORKER DISPATCH</span>
        </div>
        <div>
          <h1>True AI Penny Pod</h1>
          <p>AI-to-AI service shell with protected paid-order, catalogue, receipt, hybrid-worker, and machine-intake routes. Human intake is fallback only.</p>
        </div>
        <div class="pill-row">
          <a class="button primary" href="/.well-known/agent-card.json">AI connect</a>
          <a class="button secondary" href="/api/services">API services</a>
          <a class="button" href="/adverts">View adverts</a>
        </div>
      </section>
      <section class="grid">
        <article class="card">
          <h2>AI-to-AI intake</h2>
          <p>Machine intake is protected at <code>/api/a2a/intake</code>. The public discovery card is available at <code>/.well-known/agent-card.json</code>.</p>
        </article>
        <article class="card">
          <h2>Advert cards</h2>
          <p>Advert page remains visible at <code>/adverts</code>. Paid AI intake uses the Stripe A2A payment link and queues work automatically after payment.</p>
        </article>
        <article class="card">
          <h2>Worker bridge</h2>
          <p>Worker jobs are queued with <code>target_worker = null</code> by default, so any live worker can claim them. One-handshake stream remains at <code>/api/worker/stream</code>.</p>
        </article>
      </section>
    `
  });
}

function renderAdvertCards() {
  const cards = [
    {
      title: 'AI-to-AI Intake',
      price: '£0.30',
      text: 'Direct AI-to-AI entry. Payment creates an AI job and dispatches it to any live worker.',
      href: '/pay/a2a'
    },
    {
      title: 'Weekly Access',
      price: '£15 / week',
      text: 'Weekly access using the configured Stripe weekly payment link.',
      href: '/pay/weekly'
    },
    {
      title: 'Monthly Access',
      price: 'Monthly',
      text: 'Monthly payment advert using the configured Stripe monthly payment link.',
      href: '/pay/monthly'
    },
    {
      title: 'Shattered File Triage',
      price: '£81+',
      text: 'Damaged file inspection and repair planning.',
      href: '/intake?service=shattered-file-triage'
    },
    {
      title: 'Document File Repair',
      price: '£25+',
      text: 'Repair attempt for DOCX, PDF, XLSX, PPTX, text, or document-like files.',
      href: '/intake?service=document-file-repair'
    },
    {
      title: 'Media File Repair',
      price: '£45+',
      text: 'Repair attempt for image, video, audio, archive, or heavier media files.',
      href: '/intake?service=media-file-repair'
    }
  ];

  return cards.map((card) => `
    <article class="card">
      <h2>${escapeHtml(card.title)}</h2>
      <div class="price">${escapeHtml(card.price)}</div>
      <p>${escapeHtml(card.text)}</p>
      <a class="button primary" href="${escapeHtml(card.href)}">Open</a>
    </article>
  `).join('');
}

function renderAdvertsPage() {
  return renderPage({
    title: 'Adverts',
    body: `
      <section class="hero">
        <div class="pill-row">
          <span class="pill">ADVERTS LIVE</span>
          <span class="pill">STRIPE LINKS</span>
          <span class="pill">AI SERVICE CARDS</span>
        </div>
        <h1>Adverts</h1>
        <p>Public advert cards and payment doors for the True AI Penny Pod service shell.</p>
      </section>
      <section class="grid">${renderAdvertCards()}</section>
    `
  });
}

function serviceOptions(selectedServiceId = '') {
  return SERVICE_CATALOGUE.map((service) => {
    const selected = service.serviceId === selectedServiceId ? ' selected' : '';
    const price = service.priceLabel || `£${service.unitPriceGbp}`;
    return `<option value="${escapeHtml(service.serviceId)}"${selected}>${escapeHtml(service.name)} — ${escapeHtml(price)}</option>`;
  }).join('');
}

function renderIntakePage({ channel = 'a2a', selectedServiceId = 'basic-a2a-intake' } = {}) {
  const safeChannel = ['a2a', 'b2b', 'crypto'].includes(channel) ? channel : 'a2a';

  return renderPage({
    title: 'Human fallback intake',
    body: `
      <section class="hero">
        <div class="pill-row">
          <span class="pill">HUMAN FALLBACK</span>
          <span class="pill">A2A MACHINE ROUTE SEPARATE</span>
          <span class="pill">ANY LIVE WORKER</span>
        </div>
        <h1>Human fallback intake</h1>
        <p>This form is not the primary AI-to-AI service path. Machine agents should use <code>/api/a2a/intake</code> with the correct key/signature.</p>
        <div class="pill-row">
          <a class="button primary" href="/.well-known/agent-card.json">AI connect</a>
          <a class="button" href="/api/services">API services</a>
        </div>
      </section>
      <section class="panel">
        <form method="post" action="/intake/public">
          <input type="hidden" name="channel" value="${escapeHtml(safeChannel)}">
          <label>Service
            <select name="serviceId">${serviceOptions(selectedServiceId)}</select>
          </label>
          <label>Name or agent ID
            <input name="requester" maxlength="120" placeholder="Requester / agent / company">
          </label>
          <label>Email or return contact
            <input name="contact" maxlength="160" placeholder="Contact or callback detail">
          </label>
          <label>Request details
            <textarea name="message" maxlength="4000" placeholder="Write the fallback intake request here"></textarea>
          </label>
          <button class="button primary" type="submit">Submit fallback intake</button>
        </form>
      </section>
    `
  });
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
    version: '1.0.4-executable-784',
    api_base_url: 'https://a2a.vagwalsall.co.uk',
    shell: PUBLIC_API_SHELL,
    endpoints: {
      home: 'https://a2a.vagwalsall.co.uk/',
      human_intake: 'https://a2a.vagwalsall.co.uk/intake',
      adverts: 'https://a2a.vagwalsall.co.uk/adverts',
      health: 'https://a2a.vagwalsall.co.uk/api/health',
      services: 'https://a2a.vagwalsall.co.uk/api/services',
      openapi: 'https://a2a.vagwalsall.co.uk/openapi.json',
      ai_home: 'http://a2a.vagwalsall.co.uk/geometry/link',
    
      execute: 'https://a2a.vagwalsall.co.uk/api/a2a/execute',
      agent_card: 'https://a2a.vagwalsall.co.uk/.well-known/agent-card.json',
      true_ai_manifest: 'https://a2a.vagwalsall.co.uk/.well-known/true-ai.json',
      agent_manifest: 'https://a2a.vagwalsall.co.uk/.well-known/agent-card.json',

      intake: 'https://a2a.vagwalsall.co.uk/api/a2a/intake',
      a2a_intake: 'https://a2a.vagwalsall.co.uk/api/a2a/intake',
      b2b_intake: 'https://a2a.vagwalsall.co.uk/api/b2b/intake',
      crypto_intake: 'https://a2a.vagwalsall.co.uk/api/crypto/intake',
      funnel_intake: 'https://a2a.vagwalsall.co.uk/api/funnel/intake',

      worker_stream: 'https://a2a.vagwalsall.co.uk/api/worker/stream',
      worker_heartbeat: 'https://a2a.vagwalsall.co.uk/api/worker/heartbeat',
      worker_poll: 'https://a2a.vagwalsall.co.uk/api/worker/poll',
      worker_claim: 'https://a2a.vagwalsall.co.uk/api/worker/claim',
      worker_result: 'https://a2a.vagwalsall.co.uk/api/worker/result'
    },
    security: {
      publicRoutesLimited: true,
      aiHomepageAvailable: true,
      publicHumanIntakeFallbackAvailable: true,
      publicAdvertsPageAvailable: true,
      protectedRoutesRequireShellKey: true,
      signedBridgePacketsRequired: true,
      publicInboundToWorker: false,
      localWorkerNodeSupported: true,
      shellKeyHeaders: ['client-api-key', 'business-api-key'],
      bridgeHeaders: [
        'x-asiod-agent',
        'x-asiod-device',
        'x-asiod-channel',
        'x-asiod-timestamp',
        'x-asiod-signature'
      ],
      bearerTokenAccepted: false,
      receiptLookupPublic: false,
      ordersPublic: false,
      podRoutesPublic: false,
      brainRoutesPublic: false,
      apiIntakeRoutesProtected: true,
      stripeSecretsPublic: false,
      databaseUrlPublic: false,
      apiKeyPublic: false,
      privateSourcePublic: false,
      privateSourceSerialPublic: false
    },
    rules: [
      'Public AI homepage, advert page, health, service discovery, executable handshake, and manifests are visible; human intake is fallback only; machine intake is protected.',
      'AI-to-AI work must enter through /api/a2a/intake or Stripe-paid A2A job creation, not through a customer-selected worker form.',
      'Jobs default to target_worker = null so any live worker can claim them.',
      'Private source layer remains sealed and background-only.',
      'No public route returns private source material.',
      'No secret key, database URL, Stripe key, webhook secret, or internal credential is returned.',
      'Receipts, orders, pod routes, brain routes, protected intakes, quotes, and payment creation require client-api-key or business-api-key.',
      'Hybrid bridge routes require signed HMAC packets from the local worker device when the hybrid bridge module is installed.',
      'Stripe webhook is public only for Stripe delivery and is signature-verified.'
    ]
  };
}

function buildA2AAgentCard() {
  return {
    protocolVersion: 'v1.0',
    name: 'True-ai-penny-pod',
    description: 'ASIOD 784-locked AI-to-AI bridge with public executable handshake, authorised intake, catalogue logging, hybrid worker dispatch, and sealed private source.',
    url: 'https://a2a.vagwalsall.co.uk/api/a2a/execute',
    provider: {
      organization: 'Jt Browne / ASIOD784',
      url: 'https://a2a.vagwalsall.co.uk'
    },
    version: '1.0.4-executable-784',
    capabilities: {
      execute_status: {
        description: 'Check live ASIOD executable status, 784 lock status, and sealed private-source state.',
        endpoint: 'https://a2a.vagwalsall.co.uk/api/a2a/execute',
        method: 'POST',
        input_schema: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    },
    authentication: {
      schemes: ['apiKey', 'signed-hmac-packet'],
      description: 'Public executable handshake is available. Protected routes require client-api-key or business-api-key. Hybrid bridge routes require HMAC signed packets.'
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    shell: PUBLIC_API_SHELL,
    security: buildPublicApiAgentCard().security,
    endpoints: {
      execute: 'https://a2a.vagwalsall.co.uk/api/a2a/execute',
      health: 'https://a2a.vagwalsall.co.uk/api/health',
      openapi: 'https://a2a.vagwalsall.co.uk/openapi.json',
      agent_card: 'https://a2a.vagwalsall.co.uk/.well-known/agent-card.json',
      api_card: 'https://a2a.vagwalsall.co.uk/api/agent-card',
      services: 'https://a2a.vagwalsall.co.uk/api/services',
      a2a_intake: 'https://a2a.vagwalsall.co.uk/api/a2a/intake',
      worker_poll: 'https://a2a.vagwalsall.co.uk/api/worker/poll',
      worker_result: 'https://a2a.vagwalsall.co.uk/api/worker/result',
      geometry_ai: 'https://a2a.vagwalsall.co.uk/geometry'
     
    },
    asiod784: {
      integerLock: 784,
      lockStatus: 'active',
      privateSourceExposed: false,
      privateSourceSerialPublic: false,
      decimalAuthority: false,
      ieee754Governance: false,
      exactIntegerFractionRootAuthority: true,
      sealedPrivateLayer: true
    }
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

function parsePublicIntake(req, res, next) {
  return PUBLIC_FORM_BODY(req, res, (error) => {
    if (error) {
      addLegacyCoins(req, 'public-form-invalid-body', 10, 400);
      return res.status(400).send(renderPage({
        title: 'Intake body rejected',
        body: '<section class="panel"><h1>Intake body rejected.</h1><p>The form was too large or malformed.</p><a class="button" href="/intake">Back to fallback intake</a></section>'
      }));
    }

    return next();
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

function isStripeWebhookPath(req) {
  return cleanRequestPath(req.path || '/') === '/stripe/webhook';
}

function hostGate(req, res, next) {
  const host = normaliseHost(req.get('host'));
  const path = cleanRequestPath(req.path || '/');

  if (isStripeWebhookPath(req)) {
    return next();
  }

  if (isAllowedHost(host)) {
    return next();
  }

  if (host === RENDER_DEFAULT_HOST) {
    if (
      path === '/' ||
      path === '/health' ||
      path === '/api/health' ||
      path === '/.well-known/agent-card.json' ||
      path === '/.well-known/true-ai.json' ||
      path === '/geometry' ||
      path === '/geometry/health' ||
      path === '/stripe/webhook'
    ) {
      return next();
    }

    console.warn(`[HOST_BLOCK] host=${host} method=${req.method} path=${req.originalUrl}`);
    return res.status(410).send('Gone');
  }

  console.warn(`[HOST_BLOCK] host=${host || 'missing'} method=${req.method} path=${req.originalUrl}`);
  return res.status(403).end();
}

function corsGate(req, res, next) {
  const path = cleanRequestPath(req.path || '/');

  if (!isAllowedPath(path)) {
    return next();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    [
      'Content-Type',
      'Authorization',
      'client-api-key',
      'business-api-key',
      'x-asiod-agent',
      'x-asiod-device',
      'x-asiod-channel',
      'x-asiod-timestamp',
      'x-asiod-signature'
    ].join(', ')
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
}

function fastDropGate(req, res, next) {
  const path = cleanRequestPath(req.path || '/');
  const agent = String(req.get('user-agent') || '').toLowerCase();

  const blockedPath = FAST_DROP_PATHS.some((blocked) =>
    path === blocked ||
    path.startsWith(`${blocked}/`) ||
    path.includes(`${blocked}/`) ||
    path.includes(blocked)
  );

  if (blockedPath) {
    return silentDrop(res);
  }

  const allowedPath = isAllowedPath(path);

  if (!allowedPath) {
    return silentDrop(res);
  }

  const blockedAgent = FAST_DROP_AGENTS.some((blocked) => agent.includes(blocked));

  const blockedAgentAllowedPaths = new Set([
    '/health',
'/api/agent-card',
    '/api/services',

    '/a2a/handshake',
    '/a2a/environment',
    '/a2a/services',
    '/a2a/job',

    '/.well-known/agent-card.json',
    '/.well-known/true-ai.json',

    '/adverts',
    '/ads',
    '/advertise',
    '/intake',
    '/intake/a2a',
    '/intake/b2b',
    '/intake/crypto',

    '/pay/a2a',
    '/pay/weekly',
    '/pay/monthly',

    '/stripe/webhook',

    '/api/a2a/execute',
    '/api/a2a/intake',
    '/api/b2b/intake',
    '/api/crypto/intake',
    '/api/funnel/intake',

    '/api/worker/heartbeat',
    '/api/worker/poll',
    '/api/worker/claim',
    '/api/worker/result',
    '/api/worker/stream'
  ]);

  if (blockedAgent && !blockedAgentAllowedPaths.has(path)) {
    return silentDrop(res);
  }

  return next();
}

function ipDenyGate(req, res, next) {
  if (isStripeWebhookPath(req)) {
    return next();
  }

  const ip = getClientIp(req);

  const blocked =
    BLOCKED_IPS.has(ip) ||
    BLOCKED_IP_PREFIXES.some((prefix) => ip.startsWith(prefix));

  if (blocked) {
    addLegacyCoins(req, 'blocked-ip', 250, 403);
    console.warn(`[IP_BLOCK] ip=${ip} method=${req.method} path=${req.originalUrl}`);
    return res.status(403).end();
  }

  return next();
}

function quarantineGate(req, res, next) {
  const path = cleanRequestPath(req.path || '/');
  const userAgent = String(req.get('user-agent') || '').toLowerCase();
  const contentType = String(req.get('content-type') || '').toLowerCase();

  if (isAllowedPath(path)) {
    return next();
  }

  if (req.method === 'HEAD') {
    if (path === '/' || path === '/health' || path === '/api/health') {
      return next();
    }

    addLegacyCoins(req, 'head-noise', 1, 403);
    return res.status(403).end();
  }

  for (const blockedPath of FAST_DROP_PATHS) {
    if (path === blockedPath || path.includes(blockedPath)) {
      addLegacyCoins(req, 'blocked-attack-path', 10, 404);
      return res.status(404).send('Not found');
    }
  }

  for (const agent of FAST_DROP_AGENTS) {
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
  if (isStripeWebhookPath(req)) {
    return next();
  }

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

function sseWrite(res, event, dataObj) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function pushJobToWorker(targetWorker, jobEnvelope) {
  const stream = workerStreams.get(String(targetWorker || ''));
  if (!stream) return false;

  try {
    sseWrite(stream, 'job', jobEnvelope);
    return true;
  } catch {
    workerStreams.delete(String(targetWorker || ''));
    return false;
  }
}

function pushJobToMatchingWorkers(targetWorker, jobEnvelope) {
  if (targetWorker) {
    return pushJobToWorker(targetWorker, jobEnvelope) ? 1 : 0;
  }

  let pushed = 0;

  for (const [workerId, stream] of workerStreams.entries()) {
    try {
      sseWrite(stream, 'job', {
        ...jobEnvelope,
        pushedTo: workerId
      });
      pushed += 1;
    } catch {
      workerStreams.delete(workerId);
    }
  }

  return pushed;
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
  const record = {
    id,
    work_id: workId,
    agent_id: agentId,
    record_type: recordType,
    title,
    body,
    units: Number(units),
    created_at: new Date().toISOString(),
    storage: pool ? 'database' : 'local-catalogue-file',
    privateSourceExposed: false
  };

  if (pool) {
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

  await fs.mkdir(path.dirname(LOCAL_CATALOGUE_PATH), { recursive: true });
  await fs.appendFile(
    LOCAL_CATALOGUE_PATH,
    `${JSON.stringify(record)}\n`,
    'utf8'
  );


  return true;
        }

async function queueAnyLiveWorkerJob({
  channel = 'a2a',
  source = 'machine-intake',
  route = 'machine-intake-to-any-live-worker',
  externalId = null,
  payload = {},
  receiptId = null,
  units = 0
} = {}) {
  const idSeed = externalId || uuidv4();
  const idHash = crypto.createHash('sha256').update(`${source}:${idSeed}`).digest('hex').slice(0, 32);
  const jobId = payload.jobId ? String(payload.jobId) : `job_${idHash}`;
  const packetId = payload.packetId ? String(payload.packetId) : `packet_${idHash}`;
  const targetWorker = payload.targetWorker ? String(payload.targetWorker) : null;

  const jobRecord = {
    ...payload,
    jobId,
    packetId,
    channel,
    targetWorker,
    target_worker: targetWorker,
    dispatchMode: targetWorker ? 'specific-worker' : 'any-live-worker',
    eligibleWorkers: [
      'laptop-worker-01',
      'laptop-worker-02',
      'laptop-worker-03'
    ],
    source,
    route,
    receiptId,
    shellSerial: SHELL_REGISTRY.externalPublicLayer.shellSerial,
    shellStatus: SHELL_REGISTRY.externalPublicLayer.status,
    hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
    brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE.bridgeSerial,
    privateSourceExposed: false,
    receivedAt: new Date().toISOString()
  };

  if (pool) {
    await directBridgeEnsureTables();

    await pool.query(
      `insert into worker_jobs (
        id,
        target_worker,
        processing_mode,
        status,
        body,
        updated_at
      )
      values ($1, $2, 'local-worker', 'queued', $3, now())
      on conflict (id) do update
      set target_worker = excluded.target_worker,
          processing_mode = excluded.processing_mode,
          status = 'queued',
          body = excluded.body,
          updated_at = now()`,
      [jobId, targetWorker, jobRecord]
    );

    await pool.query(
      `insert into bridge_packets (
        id,
        device_id,
        direction,
        packet_type,
        status,
        body
      )
      values ($1, $2, 'in', $3, 'queued', $4)
      on conflict (id) do update
      set device_id = excluded.device_id,
          direction = excluded.direction,
          packet_type = excluded.packet_type,
          status = 'queued',
          body = excluded.body`,
      [packetId, targetWorker || 'any-live-worker', channel, jobRecord]
    );

    await writeCatalogueRecord({
      id: `cat_${jobId}`,
      agentId: channel,
      recordType: `api_${channel}_worker_job`,
      title: `Worker job queued: ${jobId}`,
      body: jobRecord,
      units
    });

    pushJobToMatchingWorkers(targetWorker, {
      jobId,
      packetId,
      channel,
      targetWorker,
      receiptId,
      dispatchMode: targetWorker ? 'specific-worker' : 'any-live-worker'
    });
  }

  return {
    ok: true,
    jobId,
    packetId,
    targetWorker,
    target_worker: targetWorker,
    dispatchMode: targetWorker ? 'specific-worker' : 'any-live-worker',
    workerQueueStored: Boolean(pool),
    jobRecord
  };
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

async function queueStripeA2AJob(event) {
  const stripeObject = event?.data?.object || {};
  const eventId = event?.id || stripeObject.id || uuidv4();
  const metadata = stripeObject.metadata && typeof stripeObject.metadata === 'object'
    ? stripeObject.metadata
    : {};

  const serviceId = String(metadata.serviceId || metadata.service || 'basic-a2a-intake');

  const payload = {
    stripeEventId: eventId,
    stripeEventType: event.type,
    stripeObjectId: stripeObject.id || null,
    stripePaymentStatus: stripeObject.payment_status || stripeObject.status || null,
    stripePaymentLink: stripeObject.payment_link || null,
    stripeCustomer: stripeObject.customer || null,
    stripeCustomerEmail: stripeObject.customer_details?.email || stripeObject.customer_email || null,
    amountTotal: stripeObject.amount_total ?? null,
    currency: stripeObject.currency || 'gbp',
    serviceId,
    source: 'stripe-paid-a2a',
    route: 'stripe-payment-to-any-live-worker',
    privateSourceExposed: false
  };

  return queueAnyLiveWorkerJob({
    channel: 'a2a',
    source: 'stripe-paid-a2a',
    route: 'stripe-payment-to-any-live-worker',
    externalId: eventId,
    payload,
    receiptId: metadata.receiptId || null,
    units: Number(metadata.units || 0)
  });
}

async function handleApiIntake(channel, req, res) {
  try {
    const incomingBody = req.body || {};

    const receipt = await createApiReceipt(channel, {
      ...incomingBody,
      targetWorker: incomingBody.targetWorker || null,
      dispatchMode: incomingBody.targetWorker ? 'specific-worker' : 'any-live-worker',
      source: `${channel}-machine-intake`,
      shellSerial: SHELL_REGISTRY.externalPublicLayer.shellSerial,
      shellStatus: SHELL_REGISTRY.externalPublicLayer.status
    });

    const queued = await queueAnyLiveWorkerJob({
      channel,
      source: `${channel}-machine-intake`,
      route: 'protected-machine-intake-to-any-live-worker',
      externalId: receipt.receiptId,
      payload: {
        ...incomingBody,
        receiptId: receipt.receiptId,
        privateSourceExposed: false
      },
      receiptId: receipt.receiptId,
      units: Number(incomingBody.units || 0)
    });

    return res.status(202).json({
      ok: true,
      channel,
      status: 'queued',
      jobId: queued.jobId,
      packetId: queued.packetId,
      targetWorker: queued.targetWorker,
      target_worker: queued.target_worker,
      dispatchMode: queued.dispatchMode,
      receiptId: receipt.receiptId,
      workerQueueStored: queued.workerQueueStored,
      source: `${channel}-machine-intake`,
      next: {
        workerStream: '/api/worker/stream',
        workerPoll: '/api/worker/poll',
        workerResult: '/api/worker/result'
      },
      privateSourceExposed: false
    });
  } catch (error) {
    console.error(`API intake failed for ${channel}:`, error);

    return res.status(500).json({
      ok: false,
      channel,
      error: 'ASIOD-SHELL-001-FREE-2STR',
      privateSourceExposed: false
    });
  }
}

async function initDb() {
  if (!pool) {
    console.log('DATABASE_URL not set. Local catalogue file active. Render database closed.');
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

  await installHybridEngineBridgeTables(pool);
  await directBridgeEnsureTables();

  console.log('Catalogue database ready.');
}

function installWorkerStreamRouteOnce() {
  app.get('/api/worker/stream', protectedNoBody(async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const deviceId = String(req.query?.deviceId || req.query?.workerId || 'laptop-worker-01');

    await directBridgeEnsureTables();

    await pool.query(
      `insert into worker_nodes (
        id,
        device_id,
        label,
        status,
        capabilities,
        last_seen,
        last_seen_at,
        body
      )
      values ($1, $1, $1, 'online', '{}'::jsonb, now(), now(), $2)
      on conflict (id) do update
      set status = 'online',
          last_seen = now(),
          last_seen_at = now(),
          body = excluded.body`,
      [
        deviceId,
        {
          stream: true,
          connectedAt: new Date().toISOString()
        }
      ]
    );

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    sseWrite(res, 'hello', {
      ok: true,
      deviceId,
      status: 'connected',
      mode: 'one-handshake-worker-stream',
      privateSourceExposed: false
    });

    workerStreams.set(deviceId, res);

    req.on('close', () => {
      const current = workerStreams.get(deviceId);
      if (current === res) workerStreams.delete(deviceId);
    });
  }));
}

function installFallbackHybridEngineBridgeRoutes() {
  app.post('/api/funnel/intake', protectedJson(async (req, res) => {
    return handleApiIntake('funnel', req, res);
  }));

  app.post('/api/worker/heartbeat', protectedJson(async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const deviceId = String(req.body?.deviceId || req.body?.workerId || 'laptop-worker-01');

    await directBridgeEnsureTables();

    await pool.query(
      `insert into worker_nodes (
        id,
        device_id,
        label,
        status,
        capabilities,
        last_seen,
        last_seen_at,
        body
      )
       values ($1, $1, $1, 'active', '{}'::jsonb, now(), now(), $2)
       on conflict (id) do update
       set status = 'active',
           last_seen = now(),
           last_seen_at = now(),
           body = excluded.body`,
      [deviceId, req.body || {}]
    );

    return res.status(200).json({
      ok: true,
      deviceId,
      status: 'active',
      privateSourceExposed: false
    });
  }));

  app.post('/api/worker/poll', protectedJson(async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const deviceId = String(req.body?.deviceId || req.body?.workerId || 'laptop-worker-01');

    const result = await pool.query(
      `select id, target_worker, processing_mode, status, body, created_at
       from worker_jobs
       where status = 'queued'
         and (target_worker = $1 or target_worker is null)
       order by created_at asc
       limit 10`,
      [deviceId]
    );

    if (!result.rows.length) {
      res.setHeader('Retry-After', '300');
      return res.status(204).end();
    }

    return res.status(200).json({
      ok: true,
      deviceId,
      count: result.rows.length,
      jobs: result.rows,
      privateSourceExposed: false
    });
  }));

  app.post('/api/worker/claim', protectedJson(async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const jobId = String(req.body?.jobId || '');
    const workerId = String(req.body?.workerId || req.body?.deviceId || '');

    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: 'jobId is required'
      });
    }

    const result = await pool.query(
      `update worker_jobs
       set status = 'claimed',
           target_worker = coalesce(target_worker, nullif($2, '')),
           claimed_at = now(),
           updated_at = now()
       where id = $1 and status = 'queued'
       returning id, target_worker, processing_mode, status, body, created_at`,
      [jobId, workerId]
    );

    return res.status(200).json({
      ok: true,
      claimed: result.rows.length === 1,
      job: result.rows[0] || null,
      privateSourceExposed: false
    });
  }));

  app.post('/api/worker/result', protectedJson(async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const jobId = String(req.body?.jobId || '');
    const resultBody = req.body?.result || req.body || {};

    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: 'jobId is required'
      });
    }

    const result = await pool.query(
      `update worker_jobs
       set status = 'completed',
           result = $2,
           completed_at = now(),
           updated_at = now()
       where id = $1
       returning id, target_worker, processing_mode, status, body, result, created_at, updated_at`,
      [jobId, resultBody]
    );

    if (result.rows[0]) {
      await writeCatalogueRecord({
        id: `cat_result_${jobId}`,
        agentId: 'worker-result',
        recordType: 'api_worker_result',
        title: `Worker result: ${jobId}`,
        body: result.rows[0],
        units: Number(req.body?.units || 0)
      });
    }

    return res.status(200).json({
      ok: true,
      stored: result.rows.length === 1,
      job: result.rows[0] || null,
      privateSourceExposed: false
    });
  }));

  app.get('/pod/worker/nodes', protectedNoBody(async (_req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const result = await pool.query(
      `select id, device_id, label, status, capabilities, last_seen, last_seen_at, body, created_at
       from worker_nodes
       order by last_seen desc nulls last, last_seen_at desc nulls last, created_at desc
       limit 50`
    );

    return res.status(200).json({
      ok: true,
      count: result.rows.length,
      nodes: result.rows,
      privateSourceExposed: false
    });
  }));

  app.get('/pod/worker/jobs/recent', protectedNoBody(async (_req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const result = await pool.query(
      `select id, target_worker, processing_mode, status, body, result, created_at, updated_at
       from worker_jobs
       order by created_at desc
       limit 50`
    );

    return res.status(200).json({
      ok: true,
      count: result.rows.length,
      jobs: result.rows,
      privateSourceExposed: false
    });
  }));

  app.get('/pod/bridge/packets/recent', protectedNoBody(async (_req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_URL is not attached'
      });
    }

    const result = await pool.query(
      `select id, device_id, direction, packet_type, status, body, created_at
       from bridge_packets
       order by created_at desc
       limit 50`
    );

    return res.status(200).json({
      ok: true,
      count: result.rows.length,
      packets: result.rows,
      privateSourceExposed: false
    });
  }));
}

app.use(hostGate);
app.use(corsGate);
app.use(fastDropGate);
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

  let queued = null;

  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    try {
      queued = await queueStripeA2AJob(event);
    } catch (error) {
      console.error('Stripe paid A2A queue failed:', error);
      return res.status(500).json({
        received: true,
        type: event.type,
        queued: false,
        error: 'stripe-paid-a2a-queue-failed',
        privateSourceExposed: false
      });
    }
  }

  return res.status(200).json({
    received: true,
    type: event.type,
    queued: Boolean(queued),
    jobId: queued?.jobId || null,
    target_worker: queued?.target_worker ?? null,
    dispatchMode: queued?.dispatchMode || null,
    privateSourceExposed: false
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
  return redirectToPaymentLink(res, STRIPE_LINK_A2A_3, 'AI-to-AI £0.30');
});

app.get('/pay/weekly', (_req, res) => {
  return redirectToPaymentLink(res, STRIPE_LINK_WEEKLY_15, 'Weekly £15');
});

app.get('/pay/monthly', (_req, res) => {
  return redirectToPaymentLink(res, STRIPE_LINK_MONTHLY, 'Monthly £50');
});

app.get('/', (_req, res) => {
  return res.status(200).type('html').send(renderHomePage());
});

app.get('/intake', (req, res) => {
  const selectedServiceId = String(req.query.service || 'basic-a2a-intake');
  return res.status(200).type('html').send(renderIntakePage({ channel: 'a2a', selectedServiceId }));
});

app.get('/intake/a2a', (req, res) => {
  const selectedServiceId = String(req.query.service || 'basic-a2a-intake');
  return res.status(200).type('html').send(renderIntakePage({ channel: 'a2a', selectedServiceId }));
});

app.get('/intake/b2b', (req, res) => {
  const selectedServiceId = String(req.query.service || 'basic-a2a-intake');
  return res.status(200).type('html').send(renderIntakePage({ channel: 'b2b', selectedServiceId }));
});

app.get('/intake/crypto', (req, res) => {
  const selectedServiceId = String(req.query.service || 'basic-a2a-intake');
  return res.status(200).type('html').send(renderIntakePage({ channel: 'crypto', selectedServiceId }));
});

app.post('/intake/public', parsePublicIntake, async (req, res) => {
  const channel = ['a2a', 'b2b', 'crypto'].includes(req.body?.channel) ? req.body.channel : 'a2a';
  const serviceId = String(req.body?.serviceId || 'basic-a2a-intake');

  const publicPayload = {
    serviceId,
    requester: String(req.body?.requester || '').slice(0, 120),
    contact: String(req.body?.contact || '').slice(0, 160),
    message: String(req.body?.message || '').slice(0, 4000),
    targetWorker: null,
    target_worker: null,
    dispatchMode: 'any-live-worker',
    source: 'public-fallback-intake-form'
  };

  try {
    const receipt = await createApiReceipt(`public-${channel}`, {
      ...publicPayload,
      privateSourceExposed: false,
      shellSerial: SHELL_REGISTRY.freeFrontDoor.shellSerial,
      shellStatus: SHELL_REGISTRY.freeFrontDoor.status
    });

    const queued = await queueAnyLiveWorkerJob({
      channel: `public-${channel}`,
      source: 'public-fallback-intake-form',
      route: 'public-fallback-form-to-any-live-worker',
      externalId: receipt.receiptId,
      payload: publicPayload,
      receiptId: receipt.receiptId,
      units: 0
    });

    return res.status(202).type('html').send(renderPage({
      title: 'Fallback intake received',
      body: `
        <section class="panel">
          <h1>Fallback intake received.</h1>
          <p>The fallback intake was accepted by the shell and queued for any live worker.</p>
          <p><strong>Receipt:</strong> ${escapeHtml(receipt.receiptId)}</p>
          <p><strong>Job:</strong> ${escapeHtml(queued.jobId)}</p>
          <p><strong>Dispatch:</strong> ${escapeHtml(queued.dispatchMode)}</p>
          <p><strong>Database queue:</strong> ${pool ? 'stored' : 'not configured'}</p>
          <div class="pill-row">
            <a class="button primary" href="/.well-known/agent-card.json">AI connect</a>
            <a class="button" href="/adverts">View adverts</a>
          </div>
        </section>
      `
    }));
  } catch (error) {
    console.error('Public fallback intake failed:', error);

    return res.status(500).type('html').send(renderPage({
      title: 'Fallback intake failed',
      body: '<section class="panel"><h1>Fallback intake failed.</h1><p>The public shell could not store the fallback intake.</p><a class="button" href="/intake">Back to fallback intake</a></section>'
    }));
  }
});

app.get('/adverts', (_req, res) => {
  return res.status(200).type('html').send(renderAdvertsPage());
});

app.get('/ads', (_req, res) => {
  return res.redirect(302, '/adverts');
});

app.get('/advertise', (_req, res) => {
  return res.redirect(302, '/adverts');
});

app.get('/ads.txt', (_req, res) => {
  return res.status(200).type('text/plain').send(ADS_TXT || '# ads.txt not configured\n');
});

app.get('/robots.txt', (_req, res) => {
  return res.status(200).type('text/plain').send('User-agent: *\nDisallow:\n');
});

app.get('/sitemap.xml', (_req, res) => {
  return res.status(200).type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${APP_BASE_URL}/</loc></url>
  <url><loc>${APP_BASE_URL}/adverts</loc></url>
  <url><loc>${APP_BASE_URL}/.well-known/agent-card.json</loc></url>
</urlset>
`);
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.get('/favicon.png', (_req, res) => res.status(204).end());

app.get('/health', (_req, res) => {
  return res.status(200).json({
    ok: true,
    service: 'True AI Penny Pod',
    version: '1.0.4-executable-784',
    status: 'live',
    publicPages: ['/', '/adverts', '/.well-known/agent-card.json'],
    humanFallback: '/intake',
    executableHandshake: '/api/a2a/execute',
    machineIntake: '/api/a2a/intake',
    privateSourceExposed: false,
    privateSourceSerialPublic: false,
    integerLock784: true,
    hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
    brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE.bridgeSerial
  });
});

app.get('/api/health', (_req, res) => {
  return res.status(200).json({
    ok: true,
    service: 'ASIOD Public API Shell',
    version: '1.0.4-executable-784',
    status: 'live',
    mode: 'two-string-public-ai-front-door',
    shell: PUBLIC_API_SHELL,
    security: buildPublicApiAgentCard().security
  });
});

app.get('/api/agent-card', (_req, res) => {
  return res.status(200).json(buildPublicApiAgentCard());
});

app.get('/openapi.json', (_req, res) => {
  return res.status(200).json({
    openapi: '3.1.0',
    info: {
      title: 'True AI Penny Pod A2A API',
      version: '1.0.4-executable-784',
      description: 'ASIOD 784-locked AI-to-AI bridge with public executable handshake, protected intake, catalogue logging, database queue, and sealed private source.'
    },
    servers: [
      {
        url: 'https://a2a.vagwalsall.co.uk'
      }
    ],
    paths: {
      '/api/health': {
        get: {
          summary: 'Check live service status',
          operationId: 'getHealth',
          responses: {
            '200': { description: 'Service is live' }
          }
        }
      },
      '/api/a2a/execute': {
        post: {
          summary: 'Public executable handshake',
          operationId: 'executeHandshake',
          responses: {
            '200': { description: 'Executable endpoint is live' }
          }
        }
      },
      '/api/a2a/intake': {
        post: {
          summary: 'Submit protected AI-to-AI work intake',
          operationId: 'submitA2AIntake',
          security: [
            { clientApiKey: [] },
            { businessApiKey: [] }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string' },
                    serviceId: { type: 'string' },
                    instruction: { type: 'string' },
                    payload: { type: 'object' },
                    targetWorker: { type: 'string' },
                    units: { type: 'number' }
                  },
                  required: ['instruction']
                }
              }
            }
          },
          responses: {
            '202': { description: 'Job accepted and queued' },
            '401': { description: 'Missing or invalid API key' }
          }
        }
      },
      '/api/receipt/{id}': {
        get: {
          summary: 'Read protected receipt by ID',
          operationId: 'getReceipt',
          security: [
            { clientApiKey: [] },
            { businessApiKey: [] }
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            '200': { description: 'Receipt found' },
            '404': { description: 'Receipt not found' }
          }
        }
      }
    },
    components: {
      securitySchemes: {
        clientApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'client-api-key'
        },
        businessApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'business-api-key'
        }
      }
    }
  });
});

app.post('/api/a2a/execute', express.json({ limit: '32kb' }), async (_req, res) => {
  return res.status(200).json({
    ok: true,
    agent: 'ASIOD-SIMULATOR',
    status: 'executable-endpoint-live',
    liveBaseUrl: APP_BASE_URL,
    health: '/api/health',
    agentCard: '/.well-known/agent-card.json',
    a2aIntake: '/api/a2a/intake',
    workerPoll: '/api/worker/poll',
    workerResult: '/api/worker/result',
    asiod784: {
      integerLock: 784,
      lockStatus: 'active',
      privateSourceExposed: false,
      privateSourceSerialPublic: false,
      decimalAuthority: false,
      ieee754Governance: false,
      exactIntegerFractionRootAuthority: true
    },
    privateSourceSealed: true
  });
});

app.get('/api/services', (_req, res) => {
  return res.status(200).json({
    ok: true,
    shell: SHELL_REGISTRY.freeFrontDoor.shellSerial,
    route: 'two-string-free-tier',
    privateSourceExposed: false,
    cataloguePublic: false,
    paymentPublic: false,
    publicPages: {
      home: 'https://a2a.vagwalsall.co.uk/',
      agentCard: 'https://a2a.vagwalsall.co.uk/.well-known/agent-card.json',
      adverts: 'https://a2a.vagwalsall.co.uk/adverts',
      humanFallback: 'https://a2a.vagwalsall.co.uk/intake'
    },
    machineRoutes: {
      execute: 'https://a2a.vagwalsall.co.uk/api/a2a/execute',
      a2aIntake: 'https://a2a.vagwalsall.co.uk/api/a2a/intake',
      workerStream: 'https://a2a.vagwalsall.co.uk/api/worker/stream'
    },
    services: SERVICE_CATALOGUE.map((service) => ({
      serviceId: service.serviceId,
      name: service.name,
      description: service.description,
      unitPriceGbp: service.unitPriceGbp,
      priceLabel: service.priceLabel || null,
      currency: service.currency,
      active: service.active,
      humanInterface: Boolean(service.humanInterface),
      customerSelectableWorker: Boolean(service.customerSelectableWorker),
      dispatchMode: service.dispatchMode || null,
      machineIntake: service.machineIntake || null,
      agentCard: service.agentCard || null
    })),
    hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
    brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE.bridgeSerial,
    message: 'Public service discovery is AI-first; machine intake remains protected.'
  });
});

app.get('/.well-known/true-ai.json', (_req, res) => {
  const card = buildPublicApiAgentCard();

  return res.status(200).json({
    service: 'True-ai-penny-pod',
    version: '1.0.4-executable-784',
    type: 'public_discovery_manifest',
    status: 'active',
    api_base_url: 'https://a2a.vagwalsall.co.uk',
    publicShell: card.shell,
    security: card.security,
    publicEndpoints: card.endpoints,
    rules: card.rules
  });
});

app.get('/.well-known/agent-card.json', (_req, res) => {
  return res.status(200).json(buildA2AAgentCard());
});

const GEOMETRY_PRIVATE_URL =
  process.env.GEOMETRY_PRIVATE_URL || 'http://asiod-geometry-ai-v0:10000';

const GEOMETRY_GATE_KEY = String(process.env.GEOMETRY_GATE_KEY || '').trim();
const GEOMETRY_SYNC_INTERVAL_MS = Number.parseInt(
  process.env.GEOMETRY_SYNC_INTERVAL_MS || '30000',
  10
);

const geometryLinkState = {
  status: 'starting',
  startedAt: new Date().toISOString(),
  lastAttemptAt: null,
  lastOkAt: null,
  lastErrorAt: null,
  statusCode: null,
  contentType: null,
  bodyBytes: 0,
  cachedBody: null,
  error: null,
  privateSourceExposed: false
};

function geometryRootUrl() {
  return `${String(GEOMETRY_PRIVATE_URL || '').replace(/\/+$/, '')}/`;
}

async function pullGeometryRoot(reason = 'sync') {
  geometryLinkState.lastAttemptAt = new Date().toISOString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const upstream = await fetch(geometryRootUrl(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'x-asiod-internal-link': 'pennypod-geometry-sync',
        'x-asiod-link-reason': reason
      }
    });

    const body = await upstream.text();
    
console.log('[GEOMETRY_SYNC_OK]', {
  reason,
  url: geometryRootUrl(),
  status: upstream.status,
  contentType: upstream.headers.get('content-type') || 'none',
  bodyBytes: Buffer.byteLength(body, 'utf8')
});
    
    geometryLinkState.status = upstream.ok ? 'online' : 'upstream-error';
    geometryLinkState.statusCode = upstream.status;
    geometryLinkState.contentType = upstream.headers.get('content-type') || 'text/html';
    geometryLinkState.bodyBytes = Buffer.byteLength(body, 'utf8');
    geometryLinkState.error = upstream.ok ? null : `upstream-status-${upstream.status}`;

    if (body) {
      geometryLinkState.cachedBody = body;
    }

    if (upstream.ok) {
      geometryLinkState.lastOkAt = new Date().toISOString();
    } else {
      geometryLinkState.lastErrorAt = new Date().toISOString();
    }

    return geometryLinkState;
  } catch (error) {
    geometryLinkState.status = 'unreachable';
    geometryLinkState.statusCode = null;
    geometryLinkState.error = String(error.message || error);
    geometryLinkState.lastErrorAt = new Date().toISOString();

    console.warn('[GEOMETRY_SYNC_FAIL]', {
  reason,
  url: geometryRootUrl(),
  error: String(error.message || error)
});
    
    return geometryLinkState;
  } finally {
    clearTimeout(timeout);
  }
}

  function startGeometryPermanentLink() {
  pullGeometryRoot('startup').catch((error) => {
    console.warn('Geometry startup sync failed:', error.message || error);
  });
}

startGeometryPermanentLink();

function requireGeometryGate(req, res, next) {
  const supplied =
    String(req.get('x-asiod-page-key') || '').trim() ||
    String(req.query.key || '').trim();

  if (!GEOMETRY_GATE_KEY || supplied !== GEOMETRY_GATE_KEY) {
    return res.status(403).json({
      ok: false,
      error: 'geometry_private_gate_locked',
      private_14_field_exposed: false
    });
  }

  return next();
}

app.get('/geometry', async (_req, res) => {
  const state = await pullGeometryRoot('page-request');

  if (state.cachedBody) {
    res.setHeader('Content-Type', state.contentType || 'text/html');

    return res
      .status(200)
      .send(state.cachedBody);
  }

  return res.status(502).json({
    ok: false,
    error: 'geometry_private_service_unreachable',
    status: state.status,
    message: state.error,
    private_14_field_exposed: false
  });
});

app.get('/api/geometry/link', requireGeometryGate, async (_req, res) => {
  return res.status(200).json({
    ok: geometryLinkState.status === 'online',
    status: geometryLinkState.status,
    startedAt: geometryLinkState.startedAt,
    lastAttemptAt: geometryLinkState.lastAttemptAt,
    lastOkAt: geometryLinkState.lastOkAt,
    lastErrorAt: geometryLinkState.lastErrorAt,
    statusCode: geometryLinkState.statusCode,
    contentType: geometryLinkState.contentType,
    bodyBytes: geometryLinkState.bodyBytes,
    hasCachedBody: Boolean(geometryLinkState.cachedBody),
    privateSourceExposed: false
  });
});

app.get('/geometry/health', requireGeometryGate, async (_req, res) => {
  try {
    const upstream = await fetch(`${GEOMETRY_PRIVATE_URL}/health`);
    const body = await upstream.text();

    return res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'geometry_private_health_unreachable',
      message: String(error.message || error),
      private_14_field_exposed: false
    });
  }
});

app.get('/api/a2a/execute', (_req, res) => {
  return res.status(200).json({
    ok: true,
    agent: 'ASIOD-SIMULATOR',
    status: 'executable-endpoint-live',
    liveBaseUrl: APP_BASE_URL,
    method: 'GET-status-mirror',
    health: '/api/health',
    agentCard: '/.well-known/agent-card.json',
    a2aIntake: '/api/a2a/intake',
    workerPoll: '/api/worker/poll',
    workerResult: '/api/worker/result',
    asiod784: {
      integerLock: 784,
      lockStatus: 'active',
      privateSourceExposed: false,
      privateSourceSerialPublic: false,
      decimalAuthority: false,
      ieee754Governance: false,
      exactIntegerFractionRootAuthority: true
    },
    privateSourceSealed: true
  });
});

app.post('/api/a2a/execute', express.json({ limit: '32kb' }), async (_req, res) => {
  return res.status(200).json({
    ok: true,
    agent: 'ASIOD-SIMULATOR',
    status: 'executable-endpoint-live',
    liveBaseUrl: APP_BASE_URL,
    method: 'POST-execute-status',
    health: '/api/health',
    agentCard: '/.well-known/agent-card.json',
    a2aIntake: '/api/a2a/intake',
    workerPoll: '/api/worker/poll',
    workerResult: '/api/worker/result',
    asiod784: {
      integerLock: 784,
      lockStatus: 'active',
      privateSourceExposed: false,
      privateSourceSerialPublic: false,
      decimalAuthority: false,
      ieee754Governance: false,
      exactIntegerFractionRootAuthority: true
    },
    privateSourceSealed: true
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

app.post('/api/b2b/intake', protectedJson(async (req, res) => handleApiIntake('b2b', req, res)));
app.post('/api/a2a/intake', protectedJson(async (req, res) => handleApiIntake('a2a', req, res)));
app.post('/api/crypto/intake', protectedJson(async (req, res) => handleApiIntake('crypto', req, res)));

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
    storage: pool ? 'database' : 'local-catalogue-file',
    catalogueId: id,
    message: 'Catalogue record stored.'
});
}));

app.get('/pod/catalogue/recent', protectedNoBody(async (_req, res) => {
  if (pool) {
    const result = await pool.query(
      `select id, work_id, agent_id, record_type, title, body, units, created_at
       from catalogue_records
       order by created_at desc
       limit 25`
    );

    return res.status(200).json({
      ok: true,
      storage: 'database',
      count: result.rows.length,
      records: result.rows
    });
  }

  let records = [];

  try {
    const text = await fs.readFile(LOCAL_CATALOGUE_PATH, 'utf8');
    records = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .reverse()
      .slice(0, 25);
  } catch {
    records = [];
  }

  return res.status(200).json({
    ok: true,
    storage: 'local-catalogue-file',
    databaseDisabled: false,
    count: records.length,
    records
  });
}));
  
app.post('/pod/shattered-file/receive', protectedJson(async (req, res) => {
  const {
    sourceName = null,
    fragments = [],
    repairedBody = null
  } = req.body || {};

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

installWorkerStreamRouteOnce();

if (typeof installHybridEngineBridgeRoutes === 'function') {
  installHybridEngineBridgeRoutes({
    app,
    pool,
    protectedNoBody,
    writeCatalogueRecord,
    getClientIp,
    constantTimeEquals,
    addLegacyCoins,
    shellRegistry: SHELL_REGISTRY
  });
} else {
  installFallbackHybridEngineBridgeRoutes();
}

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
  .catch((error) => {
    console.error('Catalogue database disabled after init failure:', error.message || error);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`True AI Penny Pod running on ${APP_BASE_URL}`);
    });
  });

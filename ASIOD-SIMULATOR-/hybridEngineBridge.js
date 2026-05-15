import crypto from 'crypto';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

export const HYBRID_ENGINE_WORKER_BRIDGE = Object.freeze({
  bridgeSerial: 'ASIOD-BRIDGE-003-HYBRID-ENGINE-WORKER',
  mode: 'local-worker-node',
  relayDomain: 'https://a2a.vagwalsall.co.uk',
  publicInboundToDevice: false,
  laptopInitiatesConnection: true,
  serverDispatchesPackets: true,
  localProcessingAllowed: true,
  remoteProcessingAllowed: true,
  resultReturnRequired: true,
  signedPacketsRequired: true,
  heartbeatRequired: true,
  routes: {
    heartbeat: '/api/worker/heartbeat',
    poll: '/api/worker/poll',
    claim: '/api/worker/claim',
    result: '/api/worker/result'
  },
  privateSourceExposed: false,
  status: 'active'
});

export const BRAIN_SIMULATOR_BRIDGE = Object.freeze({
  bridgeSerial: 'ASIOD-BRIDGE-004-BRAIN-SIMULATOR-CHANNEL',
  mode: 'signed-internal-channel-router',
  publicBrainAccess: false,
  publicSimulatorAccess: false,
  localDeviceAuthority: true,
  bluetoothSourceAllowed: true,
  signedPacketsRequired: true,
  channels: ['job', 'brain', 'simulator', 'result'],
  routes: {
    intake: '/api/funnel/intake',
    workerPoll: '/api/worker/poll',
    workerResult: '/api/worker/result'
  },
  privateSourceExposed: false,
  status: 'active'
});

const DEFAULT_FUNNEL_MAX_AGE_MS = 300000;
const DEFAULT_FUNNEL_BODY_LIMIT = '64kb';

function getFunnelSecret() {
  return String(process.env.FUNNEL_WEBHOOK_SECRET || '');
}

function getFunnelMaxAgeMs() {
  const parsed = Number.parseInt(
    process.env.FUNNEL_MAX_AGE_MS || String(DEFAULT_FUNNEL_MAX_AGE_MS),
    10
  );

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FUNNEL_MAX_AGE_MS;
}

function getFunnelBodyLimit() {
  return process.env.FUNNEL_BODY_LIMIT || DEFAULT_FUNNEL_BODY_LIMIT;
}

function safeJsonParseBuffer(buffer) {
  try {
    return {
      ok: true,
      value: JSON.parse(buffer.toString('utf8') || '{}')
    };
  } catch {
    return {
      ok: false,
      value: null
    };
  }
}

function fallbackConstantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildFunnelSignature({ timestamp, rawBody, secret }) {
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    rawBody
  ]);

  return crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
}

function verifySignedPacket({ req, rawBody, constantTimeEquals }) {
  const secret = getFunnelSecret();

  if (!secret) {
    return {
      ok: false,
      status: 503,
      reason: 'funnel-not-configured'
    };
  }

  const timestamp = String(req.get('x-asiod-timestamp') || '');
  const suppliedSignature = String(req.get('x-asiod-signature') || '');

  if (!timestamp || !suppliedSignature) {
    return {
      ok: false,
      status: 401,
      reason: 'signature-required'
    };
  }

  const timestampNumber = Number(timestamp);
  const ageMs = Math.abs(Date.now() - timestampNumber);

  if (!Number.isFinite(timestampNumber) || !Number.isFinite(ageMs) || ageMs > getFunnelMaxAgeMs()) {
    return {
      ok: false,
      status: 401,
      reason: 'stale-timestamp'
    };
  }

  const expectedSignature = buildFunnelSignature({
    timestamp,
    rawBody,
    secret
  });

  const equals = constantTimeEquals || fallbackConstantTimeEquals;

  if (!equals(suppliedSignature, expectedSignature)) {
    return {
      ok: false,
      status: 401,
      reason: 'bad-signature'
    };
  }

  return {
    ok: true,
    timestamp
  };
}

function getSignedPacket(req, constantTimeEquals) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  const signatureCheck = verifySignedPacket({
    req,
    rawBody,
    constantTimeEquals
  });

  if (!signatureCheck.ok) {
    return {
      ok: false,
      status: signatureCheck.status,
      reason: signatureCheck.reason,
      rawBody,
      body: null,
      timestamp: null
    };
  }

  const parsed = safeJsonParseBuffer(rawBody);

  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {
      ok: false,
      status: 400,
      reason: 'invalid-json',
      rawBody,
      body: null,
      timestamp: signatureCheck.timestamp
    };
  }

  return {
    ok: true,
    status: 200,
    reason: null,
    rawBody,
    body: parsed.value,
    timestamp: signatureCheck.timestamp
  };
}

function getAllowedChannel(req, body) {
  const channel = String(
    req.get('x-asiod-channel') ||
    body?.channel ||
    'job'
  ).toLowerCase();

  if (!BRAIN_SIMULATOR_BRIDGE.channels.includes(channel)) {
    return null;
  }

  return channel;
}

function getAgentId(req, body) {
  return String(
    req.get('x-asiod-agent') ||
    body?.agentId ||
    body?.workerId ||
    'local-reality-bridge'
  );
}

function getDeviceId(req, body) {
  return String(
    req.get('x-asiod-device') ||
    body?.deviceId ||
    body?.workerId ||
    'local-device-01'
  );
}

function sanitizeInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

async function writeCatalogueIfAvailable(writeCatalogueRecord, record) {
  if (typeof writeCatalogueRecord !== 'function') return false;

  await writeCatalogueRecord(record);
  return true;
}

export async function installHybridEngineBridgeTables(pool) {
  if (!pool) return false;

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
      device_id text not null,
      direction text not null,
      packet_type text not null default 'job',
      status text not null default 'queued',
      body jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      claimed_at timestamptz,
      completed_at timestamptz
    );
  `);

  await pool.query(`
    create table if not exists worker_nodes (
      id text primary key,
      label text,
      status text not null default 'offline',
      capabilities jsonb not null default '{}'::jsonb,
      last_seen timestamptz not null default now(),
      created_at timestamptz not null default now()
    );
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
      completed_at timestamptz
    );
  `);

  return true;
}

export function installHybridEngineBridgeRoutes({
  app,
  pool,
  protectedNoBody,
  writeCatalogueRecord,
  getClientIp,
  constantTimeEquals,
  addLegacyCoins,
  shellRegistry = null
}) {
  const signedRawJson = express.raw({
    type: 'application/json',
    limit: getFunnelBodyLimit()
  });

  function rejectSignedPacket(req, res, packet) {
    if (typeof addLegacyCoins === 'function') {
      addLegacyCoins(req, `hybrid-bridge-${packet.reason}`, 250, packet.status);
    }

    return res.status(packet.status).json({
      ok: false,
      error: packet.reason,
      hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
      brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE.bridgeSerial,
      privateSourceExposed: false
    });
  }

  app.post('/api/funnel/intake', signedRawJson, async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'database-not-configured',
        bridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial
      });
    }

    const packet = getSignedPacket(req, constantTimeEquals);

    if (!packet.ok) {
      return rejectSignedPacket(req, res, packet);
    }

    const body = packet.body;
    const channel = getAllowedChannel(req, body);

    if (!channel) {
      if (typeof addLegacyCoins === 'function') {
        addLegacyCoins(req, 'hybrid-bridge-invalid-channel', 100, 400);
      }

      return res.status(400).json({
        ok: false,
        error: 'invalid-channel',
        allowedChannels: BRAIN_SIMULATOR_BRIDGE.channels,
        privateSourceExposed: false
      });
    }

    const agentId = getAgentId(req, body);
    const deviceId = getDeviceId(req, body);
    const packetId = body.packetId ? String(body.packetId) : `packet_${uuidv4()}`;
    const jobId = body.jobId ? String(body.jobId) : `job_${uuidv4()}`;
    const targetWorker = body.targetWorker ? String(body.targetWorker) : 'laptop-worker-01';

    const sourceShell =
      shellRegistry?.externalPublicLayer?.shellSerial ||
      body.sourceShell ||
      'ASIOD-SHELL-002-PUBLIC-6FIELD';

    const jobRecord = {
      ...body,
      packetId,
      jobId,
      channel,
      agentId,
      deviceId,
      targetWorker,
      source: body.source || 'local-outbound-device',
      route: 'outbound-controlled-two-way',
      hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
      brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE.bridgeSerial,
      privateSourceExposed: false,
      receivedAt: new Date().toISOString()
    };

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
        typeof getClientIp === 'function' ? getClientIp(req) : req.ip,
        sourceShell,
        HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
        {
          channel,
          deviceId,
          userAgent: req.get('user-agent') || '',
          contentType: req.get('content-type') || '',
          timestamp: packet.timestamp,
          requestId: req.get('x-request-id') || null
        },
        jobRecord
      ]
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
      [packetId, deviceId, channel, jobRecord]
    );

    if (channel === 'job' || channel === 'brain' || channel === 'simulator') {
      await pool.query(
        `insert into worker_jobs (
          id,
          target_worker,
          processing_mode,
          status,
          body
        )
        values ($1, $2, $3, 'queued', $4)
        on conflict (id) do update
        set target_worker = excluded.target_worker,
            processing_mode = excluded.processing_mode,
            status = 'queued',
            body = excluded.body`,
        [
          jobId,
          targetWorker,
          channel === 'job' ? 'local-worker' : `${channel}-channel`,
          jobRecord
        ]
      );
    }

    await writeCatalogueIfAvailable(writeCatalogueRecord, {
      id: `cat_${jobId}`,
      agentId,
      recordType: 'hybrid_engine_bridge_intake',
      title: `Hybrid bridge intake: ${channel} / ${jobId}`,
      body: jobRecord,
      units: 0
    });

    return res.status(202).json({
      ok: true,
      accepted: true,
      status: 'queued',
      channel,
      jobId,
      packetId,
      targetWorker,
      stored: true,
      hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE,
      brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE,
      privateSourceExposed: false
    });
  });

  app.post('/api/worker/heartbeat', signedRawJson, async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'database-not-configured'
      });
    }

    const packet = getSignedPacket(req, constantTimeEquals);

    if (!packet.ok) {
      return rejectSignedPacket(req, res, packet);
    }

    const body = packet.body;
    const workerId = String(body.workerId || body.deviceId || req.get('x-asiod-device') || 'laptop-worker-01');
    const label = String(body.label || workerId);
    const capabilities = body.capabilities && typeof body.capabilities === 'object'
      ? body.capabilities
      : {};

    await pool.query(
      `insert into worker_nodes (
        id,
        label,
        status,
        capabilities,
        last_seen
      )
      values ($1, $2, 'online', $3, now())
      on conflict (id) do update
      set label = excluded.label,
          status = 'online',
          capabilities = excluded.capabilities,
          last_seen = now()`,
      [workerId, label, capabilities]
    );

    return res.status(200).json({
      ok: true,
      workerId,
      status: 'online',
      bridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
      privateSourceExposed: false
    });
  });

  app.post('/api/worker/poll', signedRawJson, async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'database-not-configured'
      });
    }

    const packet = getSignedPacket(req, constantTimeEquals);

    if (!packet.ok) {
      return rejectSignedPacket(req, res, packet);
    }

    const body = packet.body;
    const workerId = String(body.workerId || body.deviceId || req.get('x-asiod-device') || 'laptop-worker-01');
    const limit = sanitizeInt(body.limit, 5, 1, 25);

    await pool.query(
      `update worker_nodes
       set status = 'online',
           last_seen = now()
       where id = $1`,
      [workerId]
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

    return res.status(200).json({
      ok: true,
      workerId,
      count: result.rows.length,
      jobs: result.rows,
      bridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
      privateSourceExposed: false
    });
  });

  app.post('/api/worker/claim', signedRawJson, async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'database-not-configured'
      });
    }

    const packet = getSignedPacket(req, constantTimeEquals);

    if (!packet.ok) {
      return rejectSignedPacket(req, res, packet);
    }

    const body = packet.body;
    const workerId = String(body.workerId || body.deviceId || req.get('x-asiod-device') || 'laptop-worker-01');
    const jobId = String(body.jobId || '');
    const leaseMs = sanitizeInt(body.leaseMs, 300000, 30000, 3600000);

    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: 'jobId-required'
      });
    }

    const result = await pool.query(
      `update worker_jobs
       set status = 'claimed',
           target_worker = $1,
           claimed_at = now(),
           lease_until = now() + ($3::text || ' milliseconds')::interval
       where id = $2
         and (
           status = 'queued'
           or lease_until is null
           or lease_until < now()
         )
       returning id, target_worker, processing_mode, status, body, claimed_at, lease_until`,
      [workerId, jobId, leaseMs]
    );

    if (!result.rows.length) {
      return res.status(409).json({
        ok: false,
        error: 'job-not-available',
        jobId
      });
    }

    return res.status(200).json({
      ok: true,
      claimed: true,
      workerId,
      job: result.rows[0],
      privateSourceExposed: false
    });
  });

  app.post('/api/worker/result', signedRawJson, async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        ok: false,
        error: 'database-not-configured'
      });
    }

    const packet = getSignedPacket(req, constantTimeEquals);

    if (!packet.ok) {
      return rejectSignedPacket(req, res, packet);
    }

    const body = packet.body;
    const workerId = String(body.workerId || body.deviceId || req.get('x-asiod-device') || 'laptop-worker-01');
    const jobId = String(body.jobId || '');
    const resultBody = body.result && typeof body.result === 'object'
      ? body.result
      : { value: body.result ?? null };

    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: 'jobId-required'
      });
    }

    const result = await pool.query(
      `update worker_jobs
       set status = 'completed',
           result = $3,
           completed_at = now()
       where id = $1
         and (target_worker = $2 or target_worker is null)
       returning id, target_worker, processing_mode, status, result, completed_at`,
      [jobId, workerId, resultBody]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: 'job-not-found-or-worker-mismatch',
        jobId
      });
    }

    await writeCatalogueIfAvailable(writeCatalogueRecord, {
      id: `result_${jobId}`,
      agentId: workerId,
      recordType: 'hybrid_engine_worker_result',
      title: `Hybrid worker result: ${jobId}`,
      body: {
        jobId,
        workerId,
        result: resultBody,
        hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE.bridgeSerial,
        privateSourceExposed: false
      },
      units: 0
    });

    return res.status(200).json({
      ok: true,
      completed: true,
      workerId,
      job: result.rows[0],
      privateSourceExposed: false
    });
  });

  if (typeof protectedNoBody === 'function') {
    app.get('/pod/worker/nodes', protectedNoBody(async (_req, res) => {
      if (!pool) {
        return res.status(503).json({
          ok: false,
          error: 'DATABASE_URL is not attached'
        });
      }

      const result = await pool.query(
        `select id, label, status, capabilities, last_seen, created_at
         from worker_nodes
         order by last_seen desc
         limit 50`
      );

      return res.status(200).json({
        ok: true,
        bridge: HYBRID_ENGINE_WORKER_BRIDGE,
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
        `select id, target_worker, processing_mode, status, lease_until, body, result, created_at, claimed_at, completed_at
         from worker_jobs
         order by created_at desc
         limit 50`
      );

      return res.status(200).json({
        ok: true,
        bridge: HYBRID_ENGINE_WORKER_BRIDGE,
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
        `select id, device_id, direction, packet_type, status, body, created_at, claimed_at, completed_at
         from bridge_packets
         order by created_at desc
         limit 50`
      );

      return res.status(200).json({
        ok: true,
        hybridEngineWorkerBridge: HYBRID_ENGINE_WORKER_BRIDGE,
        brainSimulatorBridge: BRAIN_SIMULATOR_BRIDGE,
        count: result.rows.length,
        packets: result.rows,
        privateSourceExposed: false
      });
    }));
  }
}

import crypto from 'crypto';

function hashRequest(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body || {}))
    .digest('hex');
}

function makeReceipt({ route, body, classification, decision }) {
  return {
    receipt_id: `b2b_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
    timestamp: new Date().toISOString(),
    route,
    request_hash: hashRequest(body),
    classification,
    decision,
    private_engine_exposed: false,
    redaction_applied: false
  };
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      accepted: false,
      error: 'Method not allowed',
      private_engine_exposed: false
    });
  }

  const {
    company = null,
    contact_name = null,
    email = null,
    request_type = 'general',
    message = '',
    source = 'unknown'
  } = req.body || {};

  if (!company || !email || !message) {
    return res.status(400).json({
      accepted: false,
      error: 'company, email, and message are required',
      private_engine_exposed: false
    });
  }

  const classification = `b2b_${String(request_type).toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`;

  const receipt = makeReceipt({
    route: '/api/b2b/intake',
    body: { company, contact_name, email, request_type, message, source },
    classification,
    decision: 'accepted_for_review'
  });

  return res.status(202).json({
    accepted: true,
    receipt_id: receipt.receipt_id,
    classification,
    next_step: 'Request received by public six-field relay. Private engine remains sealed.',
    private_engine_exposed: false,
    receipt
  });
    }

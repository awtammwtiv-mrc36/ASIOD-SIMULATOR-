#!/usr/bin/env bash
# language: bash
# create_asiod_brain_gateway.sh
# Creates the ASIOD Brain Gateway public package.
# Public-layer only. Does not expose private 14-field body.
set -euo pipefail

ROOT="asiod_brain_gateway"

mkdir -p "$ROOT"/{src,schemas,receipts,logs,tests,.github/workflows,policies}

cat > "$ROOT/gateway_manifest.json" <<'JSON'
{
  "system": "ASIOD_BRAIN_GATEWAY",
  "version": "0.1.0",
  "purpose": "Receive external AI traffic, extract claims, detect faulty authority, correct output, issue receipts, and meter access.",
  "private_14_field_body_publicly_displayed": false,
  "external_ai_output_governs_proof": false,
  "status": "GATEWAY_PACKAGE_CREATED"
}
JSON

cat > "$ROOT/policies/policy_manifest.json" <<'JSON'
{
  "policy_version": "1.1",
  "numeric_formats_policy": {
    "ieee_754_governs_proof": false,
    "ieee_p3109_governs_proof": false,
    "posit_governs_proof": false,
    "bfloat16_governs_proof": false,
    "ofp8_governs_proof": false,
    "fixed_point_governs_proof": false,
    "decimal_governs_proof": false,
    "decimal_display_policy": {
      "decimal_role": "human_display_only",
      "decimal_places_max": 4
    },
    "allowed_role": "display_or_implementation_layer_only"
  },
  "proof_authority": [
    "source_law",
    "carrier",
    "returned_structure",
    "derived_law",
    "exact_classification"
  ],
  "quarantine_trigger": "artifact_uses_numeric_format_as_proof_authority_only",
  "status": "NUMERIC_FORMATS_NON_GOVERNING_NOT_REMOVED"
}
JSON

cat > "$ROOT/policies/display_policy.json" <<'JSON'
{
  "display_policy_version": "1.2",
  "primary_authority": "constructible_exact_form",
  "decimal_authority": false,
  "decimal_first_authority": false,
  "decimal_role": "secondary_human_display_only",
  "decimal_places_max": 4,
  "display_order": [
    "source_law",
    "carrier",
    "returned_structure",
    "derived_law",
    "exact_classification",
    "constructible_exact_form",
    "decimal_display_if_needed"
  ],
  "status": "CONSTRUCTIBLE_FIRST_DECIMAL_SECONDARY_LOCKED"
}
JSON

cat > "$ROOT/policies/decimal_display_policy.json" <<'JSON'
{
  "decimal_display_policy": {
    "decimal_role": "human_display_only",
    "decimal_places_max": 4,
    "decimal_governs_proof": false,
    "decimal_first_authority": false,
    "exact_authority_required": true,
    "proof_authority": [
      "source_law",
      "carrier",
      "returned_structure",
      "derived_law",
      "exact_classification"
    ],
    "status": "DECIMAL_DISPLAY_LIMIT_LOCKED"
  }
}
JSON

cat > "$ROOT/src/__init__.py" <<'PY'
"""ASIOD Brain Gateway public package."""
PY

cat > "$ROOT/src/intake.py" <<'PY'
import hashlib
import json
from datetime import datetime, timezone
from typing import Dict, Any

def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def intake_artifact(text: str, source: str = "external_ai", input_type: str = "claim_text") -> Dict[str, Any]:
    digest = sha256_text(text)
    return {
        "artifact_id": f"{source}:{digest[:16]}",
        "source": source,
        "input_type": input_type,
        "timestamp": utc_now(),
        "sha256": digest,
        "content": text,
        "private_14_field_body_publicly_displayed": False,
        "status": "RECEIVED"
    }

def save_json(path: str, obj: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
PY

cat > "$ROOT/src/claim_extractor.py" <<'PY'
import re
from typing import Dict, Any, List

def split_sentences(text: str) -> List[str]:
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return []
    parts = re.split(r"(?<=[.!?])\s+", cleaned)
    return [p.strip() for p in parts if p.strip()]

def extract_claims(artifact: Dict[str, Any]) -> List[Dict[str, Any]]:
    claims = []
    for i, sentence in enumerate(split_sentences(artifact.get("content", "")), start=1):
        claims.append({
            "claim_id": f"claim_{i:04d}",
            "artifact_id": artifact["artifact_id"],
            "claim": sentence,
            "requires_verification": True,
            "status": "EXTRACTED"
        })
    return claims
PY

cat > "$ROOT/src/verifier.py" <<'PY'
from typing import Dict, Any, List

NUMERIC_AUTHORITY_TERMS = [
    "ieee 754 governs proof",
    "ieee-754 governs proof",
    "ieee p3109 governs proof",
    "posit governs proof",
    "bfloat16 governs proof",
    "ofp8 governs proof",
    "fixed-point governs proof",
    "fixed point governs proof",
    "decimal governs proof",
    "decimal-first authority",
    "decimal first authority"
]

PROOF_AUTHORITY = [
    "source_law",
    "carrier",
    "returned_structure",
    "derived_law",
    "exact_classification",
    "constructible_exact_form"
]

def classify_claim(claim: Dict[str, Any], evidence: List[Dict[str, Any]] | None = None) -> Dict[str, Any]:
    text = claim.get("claim", "").lower()
    evidence = evidence or []

    if any(term in text for term in NUMERIC_AUTHORITY_TERMS):
        status = "QUARANTINE"
        reason = "numeric_format_asserted_as_proof_authority"
    elif not evidence:
        status = "UNSUPPORTED"
        reason = "not_stated_in_source"
    else:
        status = "PASS"
        reason = "evidence_supplied"

    return {
        "claim_id": claim["claim_id"],
        "artifact_id": claim["artifact_id"],
        "claim": claim["claim"],
        "classification": status,
        "reason": reason,
        "proof_authority": PROOF_AUTHORITY,
        "model_output_governs_proof": False,
        "tool_output_governs_proof": False,
        "retrieval_output_governs_proof": False
    }

def verify_claims(claims: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [classify_claim(c, evidence=[]) for c in claims]
PY

cat > "$ROOT/src/correction_engine.py" <<'PY'
from typing import Dict, Any, List

def correction_for(item: Dict[str, Any]) -> str:
    cls = item["classification"]
    claim = item["claim"]

    if cls == "PASS":
        return claim

    if cls == "QUARANTINE":
        return (
            "Quarantined public-layer claim: artifact asserted a numeric or implementation "
            "format as proof authority. Numeric formats are display/implementation only."
        )

    if cls == "UNSUPPORTED":
        return "Not stated in source."

    if cls == "CONFLICT":
        return "Conflict with source. Treat as audit evidence only; not authoritative."

    return "Not stated in source."

def build_corrected_answer(verifications: List[Dict[str, Any]]) -> Dict[str, Any]:
    corrected = [correction_for(v) for v in verifications]
    return {
        "answer_mode": "evidence_first_or_not_stated",
        "corrected_output": corrected,
        "unsupported_claims": sum(1 for v in verifications if v["classification"] == "UNSUPPORTED"),
        "quarantined_claims": sum(1 for v in verifications if v["classification"] == "QUARANTINE"),
        "status": "CORRECTED_OUTPUT_READY"
    }
PY

cat > "$ROOT/src/receipt_writer.py" <<'PY'
import json
from datetime import datetime, timezone
from typing import Dict, Any, List

def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def write_receipt(path: str, artifact: Dict[str, Any], verifications: List[Dict[str, Any]], corrected: Dict[str, Any]) -> Dict[str, Any]:
    receipt = {
        "receipt_version": "0.1.0",
        "receipt_type": "ASIOD_BRAIN_GATEWAY_PUBLIC_RECEIPT",
        "issued_at": utc_now(),
        "input_artifact": {
            "artifact_id": artifact["artifact_id"],
            "sha256": artifact["sha256"],
            "timestamp": artifact["timestamp"],
            "source": artifact["source"]
        },
        "summary": {
            "claims_checked": len(verifications),
            "unsupported_claims": corrected["unsupported_claims"],
            "quarantined_claims": corrected["quarantined_claims"]
        },
        "private_14_field_body_publicly_displayed": False,
        "proof_authority": [
            "source_law",
            "carrier",
            "returned_structure",
            "derived_law",
            "exact_classification",
            "constructible_exact_form"
        ],
        "status": "PUBLIC_RECEIPT_ISSUED"
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2, ensure_ascii=False)
    return receipt
PY

cat > "$ROOT/src/toll_meter.py" <<'PY'
import json
from datetime import datetime, timezone
from typing import Dict, Any

def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def meter_request(account_id: str, request_id: str, service: str, units_used: int, receipt_id: str) -> Dict[str, Any]:
    return {
        "account_id": account_id,
        "request_id": request_id,
        "service": service,
        "units_used": units_used,
        "receipt_id": receipt_id,
        "billing_status": "METERED",
        "timestamp": utc_now()
    }

def append_meter_log(path: str, record: Dict[str, Any]) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
PY

cat > "$ROOT/src/main.py" <<'PY'
#!/usr/bin/env python3
import argparse
import json
import os

from intake import intake_artifact
from claim_extractor import extract_claims
from verifier import verify_claims
from correction_engine import build_corrected_answer
from receipt_writer import write_receipt
from toll_meter import meter_request, append_meter_log

def main() -> int:
    parser = argparse.ArgumentParser(description="ASIOD Brain Gateway public verifier")
    parser.add_argument("--text", required=True, help="External AI text or claim material")
    parser.add_argument("--source", default="external_ai")
    parser.add_argument("--account", default="public_test_account")
    args = parser.parse_args()

    os.makedirs("receipts", exist_ok=True)
    os.makedirs("logs", exist_ok=True)

    artifact = intake_artifact(args.text, source=args.source)
    claims = extract_claims(artifact)
    verifications = verify_claims(claims)
    corrected = build_corrected_answer(verifications)

    receipt_path = f"receipts/{artifact['artifact_id'].replace(':', '_')}.receipt.json"
    receipt = write_receipt(receipt_path, artifact, verifications, corrected)

    meter = meter_request(
        account_id=args.account,
        request_id=artifact["artifact_id"],
        service="external_ai_claim_audit",
        units_used=max(1, len(claims)),
        receipt_id=receipt_path
    )
    append_meter_log("logs/toll_meter.jsonl", meter)

    print(json.dumps({
        "artifact": artifact,
        "claims": claims,
        "verifications": verifications,
        "corrected": corrected,
        "receipt": receipt,
        "meter": meter
    }, indent=2, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
PY

chmod +x "$ROOT/src/main.py"

cat > "$ROOT/schemas/intake.schema.json" <<'JSON'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ASIOD Brain Gateway Intake",
  "type": "object",
  "required": ["artifact_id", "source", "input_type", "timestamp", "sha256", "content", "status"],
  "properties": {
    "artifact_id": {"type": "string"},
    "source": {"type": "string"},
    "input_type": {"type": "string"},
    "timestamp": {"type": "string"},
    "sha256": {"type": "string"},
    "content": {"type": "string"},
    "private_14_field_body_publicly_displayed": {"type": "boolean"},
    "status": {"type": "string"}
  }
}
JSON

cat > "$ROOT/schemas/claim.schema.json" <<'JSON'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ASIOD Brain Gateway Claim",
  "type": "object",
  "required": ["claim_id", "artifact_id", "claim", "requires_verification", "status"],
  "properties": {
    "claim_id": {"type": "string"},
    "artifact_id": {"type": "string"},
    "claim": {"type": "string"},
    "requires_verification": {"type": "boolean"},
    "status": {"type": "string"}
  }
}
JSON

cat > "$ROOT/schemas/receipt.schema.json" <<'JSON'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ASIOD Brain Gateway Public Receipt",
  "type": "object",
  "required": ["receipt_version", "receipt_type", "issued_at", "input_artifact", "summary", "status"],
  "properties": {
    "receipt_version": {"type": "string"},
    "receipt_type": {"type": "string"},
    "issued_at": {"type": "string"},
    "input_artifact": {"type": "object"},
    "summary": {"type": "object"},
    "private_14_field_body_publicly_displayed": {"type": "boolean"},
    "proof_authority": {"type": "array"},
    "status": {"type": "string"}
  }
}
JSON

cat > "$ROOT/schemas/toll.schema.json" <<'JSON'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ASIOD Brain Gateway Toll Meter",
  "type": "object",
  "required": ["account_id", "request_id", "service", "units_used", "receipt_id", "billing_status", "timestamp"],
  "properties": {
    "account_id": {"type": "string"},
    "request_id": {"type": "string"},
    "service": {"type": "string"},
    "units_used": {"type": "integer"},
    "receipt_id": {"type": "string"},
    "billing_status": {"type": "string"},
    "timestamp": {"type": "string"}
  }
}
JSON

touch "$ROOT/receipts/.gitkeep"

cat > "$ROOT/logs/public_audit.log" <<'JSONL'
{"step_id":"GATEWAY_PACKAGE_CREATED","action":"CREATE_GATEWAY_PACKAGE","private_14_field_body_publicly_displayed":false,"result_code":0}
JSONL

cat > "$ROOT/tests/test_claim_extractor.py" <<'PY'
import unittest
from src.intake import intake_artifact
from src.claim_extractor import extract_claims

class ClaimExtractorTest(unittest.TestCase):
    def test_extracts_claims(self):
        artifact = intake_artifact("One claim. Second claim.")
        claims = extract_claims(artifact)
        self.assertEqual(len(claims), 2)

if __name__ == "__main__":
    unittest.main()
PY

cat > "$ROOT/tests/test_verifier.py" <<'PY'
import unittest
from src.verifier import classify_claim

class VerifierTest(unittest.TestCase):
    def test_numeric_authority_quarantine(self):
        claim = {"claim_id": "claim_0001", "artifact_id": "a", "claim": "IEEE 754 governs proof."}
        result = classify_claim(claim)
        self.assertEqual(result["classification"], "QUARANTINE")

    def test_no_evidence_unsupported(self):
        claim = {"claim_id": "claim_0001", "artifact_id": "a", "claim": "A normal claim."}
        result = classify_claim(claim)
        self.assertEqual(result["classification"], "UNSUPPORTED")

if __name__ == "__main__":
    unittest.main()
PY

cat > "$ROOT/tests/test_receipt_writer.py" <<'PY'
import os
import tempfile
import unittest
from src.intake import intake_artifact
from src.receipt_writer import write_receipt

class ReceiptWriterTest(unittest.TestCase):
    def test_writes_receipt(self):
        artifact = intake_artifact("Test.")
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "r.json")
            receipt = write_receipt(path, artifact, [], {"unsupported_claims": 0, "quarantined_claims": 0})
            self.assertTrue(os.path.exists(path))
            self.assertEqual(receipt["status"], "PUBLIC_RECEIPT_ISSUED")

if __name__ == "__main__":
    unittest.main()
PY

cat > "$ROOT/.github/workflows/brain-gateway-check.yml" <<'YAML'
name: ASIOD Brain Gateway Check

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:

jobs:
  brain-gateway-check:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: asiod_brain_gateway

    steps:
      - uses: actions/checkout@v4

      - name: Run unit tests
        run: |
          python -m unittest discover -s tests

      - name: Run sample gateway request
        run: |
          python src/main.py --text "IEEE 754 governs proof. Posit is an implementation format." --source sample_external_ai > sample_output.json
          test -f sample_output.json
          grep -q "QUARANTINE" sample_output.json
          grep -q "Not stated in source" sample_output.json
YAML

cat > "$ROOT/README.md" <<'MD'
# ASIOD Brain Gateway

Public-layer gateway for receiving external AI traffic, extracting claims, classifying unsupported or faulty authority, returning corrected output, issuing public receipts, and metering access.

## Boundary

- Private 14-field body is not displayed.
- External AI output does not govern proof.
- RAG, tools, auditors, numeric formats, and model outputs are non-governing.
- Constructible exact form is primary.
- Decimal is secondary display only, max 4 places.

## Flow

External AI text → intake → claim extraction → verifier → correction engine → receipt writer → toll meter.

## Run locally

```bash
cd asiod_brain_gateway
python src/main.py --text "IEEE 754 governs proof. This is unsupported."

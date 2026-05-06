#!/usr/bin/env bash
# language: bash
# discover_and_audit_status.sh
# Non-destructive local repo audit. No network calls. No deletion.

set -euo pipefail

python3 - <<'PY'
import json
import os
import re
import subprocess
from pathlib import Path

TOKENS = r"Flocq|Isabelle|Z3|CVC5|SMT-LIB|OneSpin|IEEE-754|IEEE754|IEEE 754|binary128|quadruple|__float128|libquadmath|floating-point|NaN|Infinity|fma"

APPROVED_PREFIXES = [
    "audit/",
    "playground/",
    "docs/",
    "examples/",
    "legacy_playground/",
    "public_results/",
    "legacy_discovery_output/",
    "legacy_archives/",
]

APPROVED_FILES = {
    "public_audit.log",
    "public_audit_entry_templates.json",
    "apply_disable_pr_template.md",
    "discover_and_provenance.sh",
    "create_evidence_archive.sh",
    "discover_and_audit_status.sh",
}

PROTECTED_PREFIXES = [
    "true-ai-penny-pod/",
    ".github/workflows/",
]

MANIFEST = Path("ASIOD-6S-PUBLIC-PRESENT.json")
OUTPUT = Path("legacy_audit_status.json")

def run(cmd):
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

if run(["git", "rev-parse", "--is-inside-work-tree"]).returncode != 0:
    raise SystemExit("ERROR: must run inside a git repo")

# Add approved_display_paths from manifest if present.
if MANIFEST.exists():
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        for p in data.get("approved_display_paths", []):
            p = str(p).lstrip("./").rstrip("/")
            if p:
                APPROVED_PREFIXES.append(p + "/")
    except Exception:
        pass

grep = run([
    "git", "grep", "-nE", TOKENS, "--",
    ":!public_audit.log",
    ":!legacy_discovery_output/**",
    ":!legacy_archives/**",
    ":!node_modules/**",
    ":!dist/**",
    ":!build/**",
    ":!.env",
    ":!.env.*",
])

matches = []
if grep.stdout.strip():
    matches = grep.stdout.splitlines()

blocked = []
for line in matches:
    file_path = line.split(":", 1)[0].lstrip("./")

    allowed = (
        file_path in APPROVED_FILES
        or any(file_path.startswith(prefix) for prefix in APPROVED_PREFIXES)
    )

    if not allowed:
        blocked.append(line)

legacy_governance_active = False
if MANIFEST.exists():
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        legacy_governance_active = bool(data.get("legacy_governance", False))
    except Exception:
        legacy_governance_active = True

legacy_generators_active = False
actions = []

known_generator_names = [
    ".github/workflows/noisy-generator.yml",
    ".github/workflows/legacy-generator.yml",
]

for item in known_generator_names:
    if Path(item).exists():
        legacy_generators_active = True
        actions.append(f"contain_or_disable_generator:{item}")

workflow_dir = Path(".github/workflows")
if workflow_dir.exists():
    for wf in workflow_dir.glob("*.yml"):
        text = wf.read_text(encoding="utf-8", errors="ignore")
        if "schedule:" in text:
            legacy_generators_active = True
            actions.append(f"review_scheduled_workflow:{wf.as_posix()}")
        if re.search(TOKENS, text):
            actions.append(f"inspect_workflow_for_legacy_tokens:{wf.as_posix()}")

for line in blocked:
    file_path = line.split(":", 1)[0].lstrip("./")
    action = f"review_or_move_outside_shell_match:{file_path}"
    if action not in actions:
        actions.append(action)

legacy_material_display_only = (
    len(matches) > 0
    and len(blocked) == 0
    and not legacy_governance_active
    and not legacy_generators_active
)

protected_layer_clean = (
    len(blocked) == 0
    and not legacy_governance_active
    and not legacy_generators_active
)

out = {
    "legacy_governance_active": legacy_governance_active,
    "legacy_generators_active": legacy_generators_active,
    "legacy_material_display_only": legacy_material_display_only,
    "protected_layer_clean": protected_layer_clean,
    "matches_count": len(matches),
    "blocked_matches_count": len(blocked),
    "remaining_actions_required": actions,
}

OUTPUT.write_text(json.dumps(out, indent=2), encoding="utf-8")
print(json.dumps(out, indent=2))
PY

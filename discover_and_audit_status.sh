#!/usr/bin/env bash
# language: bash
# discover_and_audit_status.sh
# Non-destructive. No network calls. Reports legacy/display-only status.

set -euo pipefail

OUTPUT="./legacy_audit_status.json"
TOKENS='Flocq|Isabelle|Z3|CVC5|IEEE-754|IEEE 754|binary128|quadruple|__float128|libquadmath|NaN|Infinity|fma'

MATCHES="./legacy_status_matches.txt"
BLOCKED="./legacy_status_blocked.txt"
ACTIONS="./legacy_status_actions.txt"

: > "$MATCHES"
: > "$BLOCKED"
: > "$ACTIONS"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: must run inside a git repo" >&2
  exit 2
fi

git grep -nE "$TOKENS" -- \
  ':!public_audit.log' \
  ':!legacy_discovery_output/**' \
  ':!legacy_archives/**' \
  ':!node_modules/**' \
  ':!dist/**' \
  ':!build/**' \
  ':!.env' \
  ':!.env.*' \
  > "$MATCHES" || true

while IFS= read -r line; do
  file="${line%%:*}"

  case "$file" in
    legacy_playground/*) continue ;;
    public_results/*) continue ;;
    public_audit.log) continue ;;
    public_audit_entry_templates.json) continue ;;
    apply_disable_pr_template.md) continue ;;
    discover_and_provenance.sh) continue ;;
    create_evidence_archive.sh) continue ;;
    discover_and_audit_status.sh) continue ;;
  esac

  echo "$line" >> "$BLOCKED"
done < "$MATCHES"

legacy_governance_active=false
if [ -f "ASIOD-6S-PUBLIC-PRESENT.json" ]; then
  if grep -qi '"legacy_governance"[[:space:]]*:[[:space:]]*true' ASIOD-6S-PUBLIC-PRESENT.json; then
    legacy_governance_active=true
    echo "clear_legacy_governance_marker:ASIOD-6S-PUBLIC-PRESENT.json" >> "$ACTIONS"
  fi
fi

legacy_generators_active=false

for g in ".github/workflows/noisy-generator.yml" ".github/workflows/legacy-generator.yml"; do
  if [ -f "$g" ]; then
    legacy_generators_active=true
    echo "contain_or_disable_generator:$g" >> "$ACTIONS"
  fi
done

if [ -d ".github/workflows" ]; then
  grep -Rl "schedule:" .github/workflows/*.yml 2>/dev/null | while IFS= read -r wf; do
    echo "review_scheduled_workflow:$wf" >> "$ACTIONS"
  done
fi

if [ -s "$ACTIONS" ]; then
  legacy_generators_active=true
fi

if [ -s "$BLOCKED" ]; then
  cut -d: -f1 "$BLOCKED" | sort -u | while IFS= read -r f; do
    echo "review_or_move_outside_shell_match:$f" >> "$ACTIONS"
  done
fi

legacy_material_display_only=false
protected_layer_clean=false

if [ -s "$MATCHES" ] && [ ! -s "$BLOCKED" ] && [ "$legacy_governance_active" = false ] && [ "$legacy_generators_active" = false ]; then
  legacy_material_display_only=true
fi

if [ ! -s "$BLOCKED" ] && [ "$legacy_governance_active" = false ] && [ "$legacy_generators_active" = false ]; then
  protected_layer_clean=true
fi

python3 - <<PY > "$OUTPUT"
import json

def read_lines(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return [x.strip() for x in f if x.strip()]
    except FileNotFoundError:
        return []

matches = read_lines("$MATCHES")
blocked = read_lines("$BLOCKED")
actions = read_lines("$ACTIONS")

out = {
    "legacy_governance_active": $legacy_governance_active,
    "legacy_generators_active": $legacy_generators_active,
    "legacy_material_display_only": $legacy_material_display_only,
    "protected_layer_clean": $protected_layer_clean,
    "matches_count": len(matches),
    "blocked_matches_count": len(blocked),
    "remaining_actions_required": actions
}

print(json.dumps(out, indent=2))
PY

cat "$OUTPUT"

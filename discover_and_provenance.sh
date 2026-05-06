#!/usr/bin/env bash
# language: bash
# discover_and_provenance.sh
# Non-destructive discovery and provenance collection for legacy tokens.
# Run from the repo root.

set -euo pipefail

TOKENS='Flocq|Isabelle|Z3|CVC5|IEEE-754|IEEE 754|binary128|quadruple|__float128|libquadmath'

OUTPUT_DIR="${OUTPUT_DIR:-./legacy_discovery_output}"
PROVENANCE_TSV="$OUTPUT_DIR/provenance.tsv"
MATCHES_LIST="$OUTPUT_DIR/matches.txt"
MATCH_LINES="$OUTPUT_DIR/match_lines.txt"
STATUS_FILE="$OUTPUT_DIR/status.txt"

mkdir -p "$OUTPUT_DIR"

echo "Discovering legacy-token matches..."

git grep -nE "$TOKENS" -- \
  ':!public_audit.log' \
  ':!legacy_discovery_output/**' \
  ':!node_modules/**' \
  ':!dist/**' \
  ':!build/**' \
  > "$MATCH_LINES" || true

cut -d: -f1 "$MATCH_LINES" | sort -u > "$MATCHES_LIST" || true

if [ ! -s "$MATCHES_LIST" ]; then
  echo "NO_MATCHES" > "$STATUS_FILE"
  echo "No matches found."
  exit 0
fi

printf "token\tfile\tcommit\tauthor\temail\tdate\tsubject\n" > "$PROVENANCE_TSV"

while IFS= read -r file; do
  token=$(grep -Eo "$TOKENS" "$file" | head -n1 || true)

  log_line=$(
    git log -1 \
      --pretty=format:'%H%x1f%an%x1f%ae%x1f%aI%x1f%s' \
      -- "$file" 2>/dev/null || true
  )

  if [ -z "$log_line" ]; then
    commit="UNKNOWN"
    author="UNKNOWN"
    email="UNKNOWN"
    date="UNKNOWN"
    subject="UNKNOWN"
  else
    IFS=$'\x1f' read -r commit author email date subject <<< "$log_line"
  fi

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$token" "$file" "$commit" "$author" "$email" "$date" "$subject" \
    >> "$PROVENANCE_TSV"
done < "$MATCHES_LIST"

echo "MATCHES_FOUND" > "$STATUS_FILE"

echo "Discovery complete."
echo "Output folder: $OUTPUT_DIR"
echo "Matched files: $MATCHES_LIST"
echo "Matched lines: $MATCH_LINES"
echo "Provenance table: $PROVENANCE_TSV"

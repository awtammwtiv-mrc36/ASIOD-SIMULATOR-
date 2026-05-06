#!/usr/bin/env bash
# language: bash
# create_evidence_archive.sh
# Non-destructive evidence archiver.
# Creates a timestamped archive of matched legacy-token files and a SHA-256 checksum.
# Run from the repo root.

set -euo pipefail

TOKENS='Flocq|Isabelle|Z3|CVC5|IEEE-754|IEEE 754|binary128|quadruple|__float128|libquadmath'

ARCHIVE_DIR="${ARCHIVE_DIR:-./legacy_archives}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
ARCHIVE_NAME="legacy_evidence_${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="$ARCHIVE_DIR/$ARCHIVE_NAME"
MATCH_FILES="$ARCHIVE_DIR/matched_files_${TIMESTAMP}.txt"

mkdir -p "$ARCHIVE_DIR"

echo "Finding matched files..."

git grep -lE "$TOKENS" -- \
  ':!public_audit.log' \
  ':!legacy_discovery_output/**' \
  ':!legacy_archives/**' \
  ':!node_modules/**' \
  ':!dist/**' \
  ':!build/**' \
  ':!.env' \
  ':!.env.*' \
  > "$MATCH_FILES" || true

if [ ! -s "$MATCH_FILES" ]; then
  echo "No matches to archive."
  echo "NO_MATCHES" > "$ARCHIVE_DIR/status_${TIMESTAMP}.txt"
  exit 0
fi

echo "Creating archive..."

tar -czf "$ARCHIVE_PATH" -T "$MATCH_FILES"

sha256sum "$ARCHIVE_PATH" > "${ARCHIVE_PATH}.sha256"

if [ -n "${SIGN_KEY:-}" ]; then
  if command -v gpg >/dev/null 2>&1; then
    echo "Signing checksum with GPG key: $SIGN_KEY"
    gpg --default-key "$SIGN_KEY" \
      --output "${ARCHIVE_PATH}.sha256.sig" \
      --detach-sign "${ARCHIVE_PATH}.sha256"
  else
    echo "gpg not found; skipping signature."
  fi
fi

echo "Archive created: $ARCHIVE_PATH"
echo "Checksum created: ${ARCHIVE_PATH}.sha256"

if [ -f "${ARCHIVE_PATH}.sha256.sig" ]; then
  echo "Signature created: ${ARCHIVE_PATH}.sha256.sig"
fi

echo "Matched files list: $MATCH_FILES"

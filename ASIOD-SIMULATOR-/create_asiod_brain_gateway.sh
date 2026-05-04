#!/usr/bin/env bash
# language: bash
# create_asiod_brain_gateway.sh
# Creates the ASIOD Brain Gateway public package.
# Public-layer only. Does not expose private 14-field body.
set -euo pipefail
ROOT="asiod_brain_gateway"

mkdir -p "$ROOT"/{src,schemas,receipts,logs,tests,.github/workflows,policies}

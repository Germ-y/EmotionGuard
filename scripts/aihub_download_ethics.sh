#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${AIHUB_OUT_DIR:-"$ROOT_DIR/data/aihub/text-ethics"}"
TOOL_DIR="${AIHUB_TOOL_DIR:-"$ROOT_DIR/.tools"}"
DATASET_KEY="${AIHUB_DATASET_KEY:-558}"
FILE_KEYS="${AIHUB_FILE_KEYS:-61875,61877}"
API_KEY="${AIHUB_API_KEY:-${AIHUB_APIKEY:-}}"

if [[ -z "$API_KEY" ]]; then
  echo "AIHUB_API_KEY is empty. Export your AI-Hub API key before running this script." >&2
  echo "Example: export AIHUB_API_KEY='...'" >&2
  exit 2
fi

mkdir -p "$OUT_DIR" "$TOOL_DIR"

if command -v aihubshell >/dev/null 2>&1; then
  AIHUBSHELL="$(command -v aihubshell)"
else
  AIHUBSHELL="$TOOL_DIR/aihubshell"
  if [[ ! -x "$AIHUBSHELL" ]]; then
    curl -L -o "$AIHUBSHELL" "https://api.aihub.or.kr/api/aihubshell.do"
    chmod +x "$AIHUBSHELL"
  fi
fi

cd "$OUT_DIR"
"$AIHUBSHELL" -mode d -datasetkey "$DATASET_KEY" -filekey "$FILE_KEYS" -aihubapikey "$API_KEY"

echo "AI-Hub labeling files downloaded under: $OUT_DIR"

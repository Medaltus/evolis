#!/bin/bash
# Uploads a Helium 10 Keyword Tracker snapshot (.xlsx) to the shared dashboard sheet.
# The dashboard's API parses the workbook and writes its tabs into the
# "Helium 10 - Keyword Tracker" Google Sheet (sheetId below). Every brand's
# individual dashboard reads from its own tab in that same sheet, so one
# upload covers all brands.
#
# Usage:
#   ./upload_keyword_tracker.sh                 # uploads today's report
#   ./upload_keyword_tracker.sh 2026-07-14      # uploads a specific date's report
#
# Run this from Terminal whenever the automated scheduled run reports that
# the upload step failed (e.g. due to a network restriction on Claude's side).

set -euo pipefail

DATE="${1:-$(date +%Y-%m-%d)}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILENAME="Helium10_KeywordTracker_AllBrands_${DATE}.xlsx"
FILEPATH="${DIR}/${FILENAME}"

if [ ! -f "$FILEPATH" ]; then
  echo "File not found: $FILEPATH"
  echo "Pass a date matching an existing report, e.g.:"
  echo "  ./upload_keyword_tracker.sh 2026-07-14"
  exit 1
fi

echo "Uploading ${FILENAME} ..."

RESPONSE=$(curl -sS -X POST 'https://evolis-xi.vercel.app/api/upload-keyword-tracker' \
  -H 'Authorization: Bearer r29fu&7S;gq@$bOw' \
  -H 'Content-Type: application/json' \
  -d "{\"sheetId\":\"1geNDQgd_1ensLDyZOuXZBnvQrFT_RC85l9rHHGpgJe4\",\"filename\":\"${FILENAME}\",\"contentBase64\":\"$(base64 -i "$FILEPATH")\"}")

echo "$RESPONSE"

if echo "$RESPONSE" | grep -q '"status":"ok"'; then
  echo "Upload succeeded."
else
  echo "Upload may have failed — check the response above for details."
fi

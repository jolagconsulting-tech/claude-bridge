#!/usr/bin/env bash
# This comment mentions git push and DROP DATABASE but must not trip a rule.
set -euo pipefail
curl -sS -X POST "$URL/rest/v1/$t" -H "apikey: $KEY" --data-binary "@$WORK/$t.json"

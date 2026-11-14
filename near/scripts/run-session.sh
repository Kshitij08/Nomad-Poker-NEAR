#!/usr/bin/env bash
# Plays one agent session on the OutLayer dealer over HTTPS (async + polling), then settles it on the table contract.
#
#   scripts/run-session.sh <session-id> <hands>
#
# Needs: near CLI and outlayer CLI signed in to testnet, and an OutLayer payment key (number 1 by default) that may
# pay for the dealer project. The key is read from `outlayer keys show`, never printed.
set -euo pipefail

ID=${1:?session id}
HANDS=${2:?number of hands}
OWNER=${OWNER:-nomad-poker.testnet}
TABLE=${TABLE:-table.nomad-poker.testnet}
PROJECT=${PROJECT:-nomad-poker.testnet/nomad-dealer}
API=${API:-https://testnet-api.outlayer.ai}
KEY_NONCE=${KEY_NONCE:-1}
PAYMENT_KEY=${PAYMENT_KEY:-$(outlayer keys show "$KEY_NONCE" 2>/dev/null | grep -o "$OWNER:$KEY_NONCE:[^ ]*" | head -1)}
[ -n "$PAYMENT_KEY" ] || { echo "no payment key $KEY_NONCE for $OWNER" >&2; exit 1; }

STACKS='[300,300,300,300]'
PROFILES='[{"tight":10,"aggro":80},{"tight":30,"aggro":60},{"tight":5,"aggro":90},{"tight":40,"aggro":50}]'
now() { date +%s.%N; }
since() { echo "$(now) - $1" | bc; }

# 1. Ask the dealer, without waiting on the connection.
T0=$(now)
INPUT=$(printf '{"action":"session","hand_id":"%s","stacks":%s,"profiles":%s,"button":0,"sb":1,"bb":2,"hands":%s}' "$ID" "$STACKS" "$PROFILES" "$HANDS")
BODY=$(jq -n --argjson input "$INPUT" '{input: $input, async: true}')
CALL=$(curl -s -m 30 -X POST "$API/call/${PROJECT}" -H "X-Payment-Key: $PAYMENT_KEY" -H "Content-Type: application/json" -d "$BODY")
CALL_ID=$(echo "$CALL" | jq -r '.call_id // empty')
[ -n "$CALL_ID" ] || { echo "call refused: $CALL" >&2; exit 1; }

# 2. Poll until the dealer has answered.
while :; do
  R=$(curl -s -m 30 "$API/calls/$CALL_ID" -H "X-Payment-Key: $PAYMENT_KEY")
  S=$(echo "$R" | jq -r '.status')
  [ "$S" = "pending" ] || break
  sleep 2
done
T_DEALER=$(since "$T0")
[ "$S" = "completed" ] || { echo "dealer call $S: $R" >&2; exit 1; }
OUT=$(echo "$R" | jq -c '.output | if type == "string" then fromjson else . end')
echo "$OUT" | jq -e '.ok == true' > /dev/null || { echo "dealer refused: $OUT" >&2; exit 1; }
ACTIONS=$(echo "$OUT" | jq -r '.actions')
echo "dealer answered in ${T_DEALER}s (run $(echo "$R" | jq -r '.time_ms // .execution_time_ms // "?"') ms, cost $(echo "$R" | jq -r '.compute_cost // "?"')); actions ${#ACTIONS} bytes, $(echo "$ACTIONS" | tr ';' '\n' | wc -l) hands"

# 3. Open the session on the table (owner only) and settle it with the dealer's answer.
U64S=$(echo "$STACKS" | jq -c 'map(tostring)')
near contract call-function as-transaction "$TABLE" open_session \
  json-args "$(jq -nc --arg id "$ID" --argjson stacks "$U64S" --argjson profiles "$PROFILES" --argjson hands "$HANDS" \
    '{session_id: $id, stacks: $stacks, profiles: $profiles, button: 0, sb: "1", bb: "2", hands: $hands}')" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$TABLE" network-config testnet sign-with-legacy-keychain send > /tmp/open-$ID.txt 2>&1 \
  || { grep -E 'rror|panicked' /tmp/open-$ID.txt >&2; exit 1; }

T1=$(now)
near contract call-function as-transaction "$TABLE" submit_session \
  json-args "$(echo "$OUT" | jq -c --arg id "$ID" '{session_id: $id, alpha: .alpha, signature_hex: .signature_hex, actions: .actions}')" \
  prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config testnet sign-with-legacy-keychain send > /tmp/submit-$ID.txt 2>&1 \
  || { grep -E 'rror|panicked|Exceeded' /tmp/submit-$ID.txt >&2; exit 1; }
echo "settled in $(since "$T1")s: $(grep -E 'Gas used' /tmp/submit-$ID.txt | sed 's/.*Gas used: //'), $(grep -o 'https://explorer[^ ]*' /tmp/submit-$ID.txt | head -1)"
sed -n '/return value/,/^The /p' /tmp/submit-$ID.txt | sed '1d;$d' | jq -c .

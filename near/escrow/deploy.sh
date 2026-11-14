#!/usr/bin/env bash
# Builds the escrow, deploys it with `new(operator)` and opens the three house tables. Testnet only.
# Run in WSL (cargo-near and the NEAR CLI are installed there), with both accounts' keys in ~/.near-credentials.
#   escrow/deploy.sh [contract] [operator]
# The contract account must exist first, for example a faucet-funded one (10 NEAR):
#   near account create-account sponsor-by-faucet-service nomad-escrow.testnet autogenerate-new-keypair \
#     save-to-legacy-keychain network-config testnet create
set -euo pipefail
cd "$(dirname "$0")"

CONTRACT=${1:-nomad-escrow.testnet}
OPERATOR=${2:-nomad-poker.testnet}
NET="network-config testnet"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/target-escrow}

cargo near build non-reproducible-wasm --no-abi
WASM=$CARGO_TARGET_DIR/near/nomad_escrow.wasm

near contract deploy "$CONTRACT" use-file "$WASM" \
  with-init-call new json-args "{\"operator\":\"$OPERATOR\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  $NET sign-with-legacy-keychain send

# Table ids match the game server's room names. Limits are chips (0.001 NEAR each).
house_table() {
  near contract call-function as-transaction "$CONTRACT" open_table json-args "$2" prepaid-gas '30 Tgas' \
    attached-deposit '0 NEAR' sign-as "$OPERATOR" $NET sign-with-legacy-keychain send
  echo "opened $1"
}
house_table poker-money-st50  '{"table_id":"poker-money-st50","config":{"small_blind":1,"big_blind":2,"min_buy_in":50,"max_buy_in":200,"seats":6}}'
house_table poker-money-st100 '{"table_id":"poker-money-st100","config":{"small_blind":2,"big_blind":5,"min_buy_in":100,"max_buy_in":500,"seats":6}}'
house_table poker-money-st500 '{"table_id":"poker-money-st500","config":{"small_blind":10,"big_blind":25,"min_buy_in":500,"max_buy_in":2500,"seats":6}}'

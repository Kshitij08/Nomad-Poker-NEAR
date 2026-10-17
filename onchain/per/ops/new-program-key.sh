#!/usr/bin/env bash
# Makes a new key (a program id, or a test keeper / auditor; local file only, nothing goes on chain) unless it exists, and prints
# its address and whether anything is deployed there yet.
# Run: wsl.exe -d Ubuntu -- bash <repo>/per/ops/new-program-key.sh [name, default poker_per-program-v3]
SOL=$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin
F=$HOME/.config/solana/poker-per/${1:-poker_per-program-v3}.json
if [ -f "$F" ]; then echo "key exists: $F"; else "$SOL/solana-keygen" new --no-bip39-passphrase --silent -o "$F" >/dev/null && echo "created: $F"; fi
chmod 600 "$F"
A=$("$SOL/solana-keygen" pubkey "$F")
echo "address: $A"
"$SOL/solana" account -u devnet "$A" >/dev/null 2>&1 && echo "WARNING: an account already exists at $A" || echo "nothing on devnet at $A yet"

#!/usr/bin/env bash
# Prints the addresses (and devnet balances) of the poker-per keys: deployer, keepers, program ids. Read-only.
# Run: wsl.exe -d Ubuntu -- bash <repo>/per/ops/deployer-address.sh
SOL=$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin
K=$HOME/.config/solana/poker-per
for f in deployer keeper live-keeper poker_per-program-v2 poker_per-program-v3; do
  [ -f "$K/$f.json" ] || continue
  a=$($SOL/solana-keygen pubkey "$K/$f.json")
  echo "$f $a $($SOL/solana balance -u devnet "$a" 2>/dev/null)"
done

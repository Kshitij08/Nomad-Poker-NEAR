#!/usr/bin/env bash
# Upgrades poker-per in place on devnet (same program id), extending the program account first if the new build
# is larger, and verifies the deployed bytes. Closes leftover buffers from failed runs. Writing the program buffer
# needs about 8 SOL on the deployer (refunded after); stops early if there isn't enough (an upgrade once failed
# silently for that reason). Run: wsl.exe -d Ubuntu -- bash /mnt/c/Kshitij/Work/X2C/web3/GitHub/Poker/per/ops/upgrade-program.sh
set -e
SOL=$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin
export PATH="$SOL:/usr/local/bin:/usr/bin:/bin"
K=~/.config/solana/poker-per
SO=${SO:-$HOME/per-work/m1-target/deploy/poker_per.so}  # another build: SO=<path> (e.g. a pinned release)
# The program must be named: PROGRAM_KEY_FILE=<keypair>. The live program (7q2vxh2…) is refused unless UPGRADE_LIVE=yes
# (only with the user's explicit OK).
PROGKEY=${PROGRAM_KEY_FILE:?set PROGRAM_KEY_FILE to the program keypair to upgrade}
PID=$(solana-keygen pubkey $PROGKEY)
if [ "$PID" = "7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv" ] && [ "${UPGRADE_LIVE:-}" != "yes" ]; then
  echo "REFUSED: $PID is the LIVE program. Set UPGRADE_LIVE=yes only with an explicit OK."; exit 1
fi
DEP=$(solana-keygen pubkey $K/deployer.json)
BAL=$(solana balance -u devnet $DEP | cut -d' ' -f1)
echo "deployer before $BAL SOL"
awk -v b="$BAL" 'BEGIN { exit (b >= 9) ? 0 : 1 }' || { echo "NOT ENOUGH SOL on the deployer for the program buffer (need ~9)"; exit 1; }
BUFS=$(solana program show -u devnet --buffers -k $K/deployer.json 2>/dev/null | awk 'NR>2 && $1 ~ /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ {print $1}')
for b in $BUFS; do echo "closing leftover buffer $b"; solana program close -u devnet -k $K/deployer.json $b --bypass-warning >/dev/null 2>&1 || true; done
CUR=$(solana program show -u devnet $PID 2>/dev/null | awk '/Data Length/ {print $3}')
NEW=$(stat -c%s $SO)
if [ -n "$CUR" ] && [ "$NEW" -gt "$CUR" ]; then
  ADD=$((NEW - CUR + 16384))
  echo "extending program data by $ADD bytes ($CUR -> at least $NEW)"
  solana program extend -u devnet -k $K/deployer.json $PID $ADD 2>&1 | tail -1
fi
solana program deploy -u devnet -k $K/deployer.json --program-id $PROGKEY --upgrade-authority $K/deployer.json $SO 2>&1 | tail -2
solana program show -u devnet $PID | grep -E "Authority|Last Deployed|Data Length"
L=$(sha256sum $SO | cut -d' ' -f1)
solana program dump -u devnet $PID /tmp/poker_per_onchain.so >/dev/null
C=$(head -c $(stat -c%s $SO) /tmp/poker_per_onchain.so | sha256sum | cut -d' ' -f1)
echo "local so sha256 $L"
echo "on-chain prefix  $C"
if [ "$L" = "$C" ]; then echo "DEPLOYED BYTES MATCH"; else echo "MISMATCH: the upgrade didn't land"; exit 1; fi
echo "deployer after $(solana balance -u devnet $DEP)"

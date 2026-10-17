#!/usr/bin/env bash
# Deploys poker-per as a NEW program (the internal test program, default key poker_per-program-v3: 4A3DZW5z…) on devnet.
# Never upgrades an existing program: it refuses the live id (7q2vxh2…) and any id that already has a program. Without
# --go it only prints the plan and the SOL it needs. Build first with build-program.sh and PROGRAM_KEY_FILE set to the
# same key (the .so's declare_id must be this id).
# Run: wsl.exe -d Ubuntu -- env REPO=<repo> bash <repo>/per/ops/deploy-new-program.sh [--go]
set -e
SOL=$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin
export PATH="$SOL:/usr/local/bin:/usr/bin:/bin"
K=$HOME/.config/solana/poker-per
KEY=${PROGRAM_KEY_FILE:-$K/poker_per-program-v3.json}
SO=${SO:-$HOME/per-work/release/poker_per-$(solana-keygen pubkey "${PROGRAM_KEY_FILE:-$HOME/.config/solana/poker-per/poker_per-program-v3.json}").so}
LIVE=7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv
PID=$(solana-keygen pubkey "$KEY")
DEPLOYER=$(solana-keygen pubkey "$K/deployer.json")
[ "$PID" = "$LIVE" ] && { echo "REFUSED: that's the live program id"; exit 1; }
if solana program show -u devnet "$PID" >/dev/null 2>&1; then echo "REFUSED: a program already exists at $PID (this script never upgrades)"; exit 1; fi
SIZE=$(stat -c %s "$SO")
# Room to grow: later upgrades of this test program can be up to 25% bigger without extending it.
MAXLEN=$(( SIZE * 5 / 4 ))
RENT_PROG=$(solana rent -u devnet $(( MAXLEN + 45 )) --lamports | awk '/Rent-exempt minimum/ {print $3}')
RENT_BUF=$(solana rent -u devnet $(( SIZE + 37 )) --lamports | awk '/Rent-exempt minimum/ {print $3}')
BAL=$(solana balance -u devnet "$DEPLOYER" --lamports | awk '{print $1}')
echo "program id:       $PID"
echo "so:               $SO ($SIZE bytes, sha256 $(sha256sum "$SO" | cut -c1-16)…), max len $MAXLEN"
echo "deployer:         $DEPLOYER, $(echo "scale=4; $BAL/1000000000" | bc) SOL"
echo "program data rent (kept): $(echo "scale=4; $RENT_PROG/1000000000" | bc) SOL"
echo "write buffer (refunded after deploy, needed at the same time): $(echo "scale=4; $RENT_BUF/1000000000" | bc) SOL"
echo "peak need: about $(echo "scale=4; ($RENT_PROG+$RENT_BUF)/1000000000 + 0.05" | bc) SOL (plus transaction fees)"
if [ "$1" != "--go" ]; then echo "plan only: nothing sent. Run with --go to deploy."; exit 0; fi
solana program deploy -u devnet --keypair "$K/deployer.json" --upgrade-authority "$K/deployer.json" --program-id "$KEY" --max-len "$MAXLEN" "$SO"
solana program show -u devnet "$PID"

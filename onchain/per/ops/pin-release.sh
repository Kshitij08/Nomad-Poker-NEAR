#!/usr/bin/env bash
# Copies a fresh build (build-program.sh) to ~/per-work/release/poker_per-<program id>.so, after checking the .so was
# built for that id (its declare_id bytes are in it), so deploy-new-program.sh deploys exactly that build.
# Run: wsl.exe -d Ubuntu -- env CARGO_TARGET_DIR=<target> bash <repo>/per/ops/pin-release.sh
set -e
SOL=$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin
KEY=${PROGRAM_KEY_FILE:-$HOME/.config/solana/poker-per/poker_per-program-v3.json}
SRC=${CARGO_TARGET_DIR:-$HOME/per-work/m1-target}/deploy/poker_per.so
PID=$("$SOL/solana-keygen" pubkey "$KEY")
python3 - "$KEY" "$SRC" <<'PY'
import json, sys
pub = bytes(json.load(open(sys.argv[1]))[32:64])  # a keypair file holds the secret key then the public key
so = open(sys.argv[2], "rb").read()
if pub not in so:
    sys.exit("REFUSED: this .so wasn't built for that program id (declare_id differs)")
print("the .so is built for this program id")
PY
mkdir -p "$HOME/per-work/release"
cp "$SRC" "$HOME/per-work/release/poker_per-$PID.so"
sha256sum "$HOME/per-work/release/poker_per-$PID.so"

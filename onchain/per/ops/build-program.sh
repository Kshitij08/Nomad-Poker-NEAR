#!/usr/bin/env bash
# Builds poker-per (WSL): pinned Anchor 1.2.1, SBPF v0, Solana 3.1.10 tools on PATH. Never touches the repo-root
# Anchor workspace or the global Solana/Anchor defaults; verifies that at the end. Copies the IDL to per/idl and
# shared/idl. Run: wsl.exe -d Ubuntu -- bash /mnt/c/Kshitij/Work/X2C/web3/GitHub/Poker/per/ops/build-program.sh
set -e
SOL=$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin
export PATH="$SOL:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
REPO=/mnt/c/Kshitij/Work/X2C/web3/GitHub/Poker
export CARGO_TARGET_DIR=$HOME/per-work/m1-target
BEFORE_SOL=$(readlink ~/.local/share/solana/install/active_release)
BEFORE_AVM=$(~/.avm/bin/avm list 2>/dev/null | grep current || true)
# Program key: v2 since 7 Oct (the TEE stopped loading upgrades of the first id, 6Pzbm2...).
KEY=${PROGRAM_KEY_FILE:-$HOME/.config/solana/poker-per/poker_per-program-v2.json}
PID=$(solana-keygen pubkey $KEY)
cd $REPO/per
# anchor build syncs declare_id to $CARGO_TARGET_DIR/deploy/poker_per-keypair.json, so put our key there first
mkdir -p $CARGO_TARGET_DIR/deploy && cp $KEY $CARGO_TARGET_DIR/deploy/poker_per-keypair.json
sed -i "s/declare_id!(\"[A-Za-z0-9]*\")/declare_id!(\"$PID\")/" programs/poker-per/src/lib.rs
sed -i "s/^poker_per = \".*\"/poker_per = \"$PID\"/" Anchor.toml
echo "program id $PID"
echo "--- unit tests"
cargo test -p poker-per --lib > $HOME/per-work/m-test.log 2>&1 || { grep -E "^error|^test .*FAILED|panicked" -A8 $HOME/per-work/m-test.log | head -60; echo "UNIT TESTS FAILED"; exit 1; }
grep -E "^test |test result" $HOME/per-work/m-test.log
echo "--- anchor build (SBPF v0)"
mkdir -p target/deploy
~/.avm/bin/anchor-1.2.1 build --arch v0 > $HOME/per-work/m-build.log 2>&1 || { grep -E "^error" -A20 $HOME/per-work/m-build.log | head -60; echo "BUILD FAILED"; exit 1; }
grep -E "warning: unused|Finished" $HOME/per-work/m-build.log
if grep -qiE "maximum allowed frame space|stack offset|overwrites values in the frame" $HOME/per-work/m-build.log; then grep -i "maximum allowed frame space" $HOME/per-work/m-build.log | head -5; echo "BUILD FAILED: stack frame overflow"; exit 1; fi
echo "stack frames: OK"
SO=$(ls -t $CARGO_TARGET_DIR/deploy/poker_per.so target/deploy/poker_per.so 2>/dev/null | head -1)
echo "so: $SO"; readelf -h $SO | grep -i flags; ls -la $SO
IDL=$(ls -t target/idl/poker_per.json $CARGO_TARGET_DIR/idl/poker_per.json 2>/dev/null | head -1)
mkdir -p $REPO/shared/idl $REPO/per/idl
cp $IDL $REPO/per/idl/poker_per.json
cp $IDL $REPO/shared/idl/poker_per.json
sha256sum $SO $REPO/per/idl/poker_per.json
AFTER_SOL=$(readlink ~/.local/share/solana/install/active_release)
AFTER_AVM=$(~/.avm/bin/avm list 2>/dev/null | grep current || true)
[ "$BEFORE_SOL" = "$AFTER_SOL" ] && echo "active solana unchanged: $AFTER_SOL" || echo "WARNING solana changed: $BEFORE_SOL -> $AFTER_SOL"
[ "$BEFORE_AVM" = "$AFTER_AVM" ] && echo "avm default unchanged: $AFTER_AVM" || echo "WARNING avm changed: $BEFORE_AVM -> $AFTER_AVM"

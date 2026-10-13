#!/usr/bin/env bash
# Runs poker-per's unit tests only (WSL), with the same pinned toolchain as build-program.sh; touches no global defaults.
# Run: wsl.exe -d Ubuntu -- bash <repo>/per/ops/unit-tests.sh [filter]
set -e
export PATH="$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/per-work/m1-target}
cargo test -p poker-per --lib ${1:-} 2>&1 | grep -E "^test |test result|^error|panicked" || true

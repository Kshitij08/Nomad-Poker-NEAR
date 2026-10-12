#!/bin/bash
# Compares the last built program with what devnet runs (no upgrade). Run: wsl.exe -d Ubuntu -- bash /mnt/c/.../per/ops/check-deployed.sh
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
SO=$HOME/per-work/m1-target/deploy/poker_per.so
PID=7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv
solana program dump -u devnet $PID /tmp/poker_per_check.so >/dev/null
L=$(sha256sum $SO | cut -d' ' -f1)
C=$(head -c $(stat -c%s $SO) /tmp/poker_per_check.so | sha256sum | cut -d' ' -f1)
echo "built   $L ($(stat -c %y $SO | cut -c1-19))"
echo "devnet  $C"
[ "$L" = "$C" ] && echo "DEVNET RUNS THE LATEST BUILD" || echo "DIFFERENT: run upgrade-program.sh"

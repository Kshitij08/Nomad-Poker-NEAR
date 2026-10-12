#!/bin/bash
# Tops up the test backend's keeper on devnet from the deployer (M11: the keeper pays for tournament tables).
# Run: wsl.exe -d Ubuntu -- bash /mnt/c/.../per/ops/topup-keeper.sh [SOL]
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
KEEPER=BNb3zGjZ59bcukW3qVnVo8VoEsDjqij2RpshsvCEahZx
solana transfer -u devnet --keypair $HOME/.config/solana/poker-per/deployer.json --allow-unfunded-recipient $KEEPER ${1:-1} | tail -1
solana balance -u devnet $KEEPER

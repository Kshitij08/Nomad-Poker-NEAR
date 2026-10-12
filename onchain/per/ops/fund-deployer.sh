#!/bin/bash
# Moves devnet SOL from the default devnet wallet to the deployer (program upgrades need >= 9 SOL there).
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
D=$(solana address -k $HOME/.config/solana/poker-per/deployer.json)
solana transfer -u devnet --allow-unfunded-recipient $D ${1:-5} | tail -1
echo "deployer $(solana balance -u devnet $D)"

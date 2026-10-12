#!/bin/bash
# Devnet SOL of the test keys (deployer, p1..p3) and the keeper; tries a 2 SOL airdrop to the deployer if asked.
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
K=$HOME/.config/solana/poker-per
for n in deployer p1 p2 p3; do echo "$n $(solana balance -u devnet $K/$n.json 2>&1)"; done
echo "keeper $(solana balance -u devnet BNb3zGjZ59bcukW3qVnVo8VoEsDjqij2RpshsvCEahZx)"
[ "$1" = "airdrop" ] && solana airdrop -u devnet 2 $K/deployer.json 2>&1 | tail -1
echo "default $(solana balance -u devnet 2>&1) ($(solana address 2>&1))"

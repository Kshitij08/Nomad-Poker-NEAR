#!/bin/bash
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
solana address -k $HOME/.config/solana/poker-per/deployer.json

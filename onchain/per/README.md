# poker-per

On-chain program for private poker tables on a MagicBlock Private Ephemeral Rollup (TEE), dealt with MagicBlock VRF. It sits next to the older `programs/poker-escrow`, which stays deployed and untouched as the rollback path.

- **Program (devnet):** `6Pzbm2QQorrazztVNrXWh2kmCEeukTcsnGDmtPpRjvVR`
- **Upgrade authority:** devnet deployer `4kiqWY1NRf2syDhw7GQSJkbPzGwCibT2E9GdVC9dh3kD`
- **Status:** M1 skeleton. Program-wide config only (admin, dev wallet, rake, per-table stake cap, pause).
- **Versions:** Anchor 1.2.1, `ephemeral-rollups-sdk` 0.17.3, built for SBPF v0 (devnet rejects Anchor 1.2.1's default v3).
- **IDL:** `idl/poker_per.json`, copied to `shared/idl/poker_per.json`.

## Layout

| Path | What |
|---|---|
| `programs/poker-per/src/lib.rs` | Instruction entry points |
| `src/instructions/config.rs` | `initialize_config`, `update_config`, `propose_admin`, `accept_admin` |
| `src/state.rs` | `Config` account and settings validation |
| `src/constants.rs`, `src/errors.rs` | Seeds, limits, TEE validator id, error codes |
| `tests/config.devnet.ts` | Devnet tests; results go to `results/` |
| `scripts/` | Shared helpers and `devnet-per-inspect.ts` |

## Build (WSL)

This is its own Anchor workspace. Run Anchor from this folder, never from the repo root. The root `Anchor.toml` pins Anchor 0.30.1, and that version switches the global Solana CLI as a side effect.

```bash
export PATH=~/.local/share/solana/install/releases/3.1.10/solana-release/bin:$PATH
export CARGO_TARGET_DIR=~/per-work/m1-target
# Anchor syncs declare_id to the keypair in $CARGO_TARGET_DIR/deploy, so put the program key there first
mkdir -p $CARGO_TARGET_DIR/deploy
cp ~/.config/solana/poker-per/poker_per-program.json $CARGO_TARGET_DIR/deploy/poker_per-keypair.json
cargo test -p poker-per --lib
~/.avm/bin/anchor-1.2.1 build --arch v0
```

## Test (Windows or WSL)

```bash
npm install
POKER_PER_KEYS=<folder with deployer.json, p1.json, p2.json> npx tsx tests/config.devnet.ts
npx tsx scripts/devnet-per-inspect.ts
```

The first initialization can only happen once, so later runs report those four cases as SKIPPED.

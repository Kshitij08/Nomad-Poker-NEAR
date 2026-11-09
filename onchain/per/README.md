# poker-per

On-chain program for private poker tables on a MagicBlock Private Ephemeral Rollup (TEE), dealt with MagicBlock VRF. The older escrow program (`poker-escrow`) is no longer used by the new stack (removed 9 Nov 2026); it stays deployed on devnet, untouched.

- **Program (devnet):** `7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv` (since 7 Oct; the first id, `6Pzbm2…RjvVR`, stopped reloading upgrades in the TEE)
- **Upgrade authority:** devnet deployer `4kiqWY1NRf2syDhw7GQSJkbPzGwCibT2E9GdVC9dh3kD`
- **Status:** M0–M9b signed off; M9c (hosting fixes) waiting for its Phantom run; M10 (hardening) in progress. The full handover is `docs/PRIVATE_TABLES_HANDOVER.md`.
- **Versions:** Anchor 1.2.1, `ephemeral-rollups-sdk` 0.17.3, built for SBPF v0 (devnet rejects Anchor 1.2.1's default v3).
- **IDL:** `idl/poker_per.json`, copied to `shared/idl/poker_per.json` and `backend/src/shared` (`npm run sync`); C# bindings via `scripts/gen-csharp.ts`.

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
cp ~/.config/solana/poker-per/poker_per-program-v2.json $CARGO_TARGET_DIR/deploy/poker_per-keypair.json
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

# Solana + Anchor toolchain (Windows)

`anchor` is a separate CLI. It is **not** installed by `npm install`. You need Rust, Solana CLI, and Anchor (via AVM) first.

Project uses **Anchor 0.30.1** (see root `Anchor.toml`).

## Option A — WSL2 (recommended on Windows)

Anchor/Solana tooling is most reliable on Linux. Use this path if native Windows hits Smart App Control (`os error 4551`) or other build issues.

### A1. Install WSL2 + Ubuntu (PowerShell as Administrator)

Open **PowerShell** or **Terminal** **as Administrator** (right-click → Run as administrator), then:

```powershell
wsl --install -d Ubuntu
```

- If prompted, **reboot** when installation finishes.
- On first boot, **Ubuntu** opens and asks you to create a **Linux username** and **password** (remember these — `sudo` will need the password).
- If Ubuntu does not open automatically after reboot: Start menu → **Ubuntu**.

Check WSL version (should be 2):

```powershell
wsl --status
wsl -l -v
```

If Ubuntu shows version 1, convert it:

```powershell
wsl --set-version Ubuntu 2
```

### A2. Linux build dependencies (inside Ubuntu)

Open **Ubuntu** from the Start menu. All commands below run in that terminal.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential pkg-config libssl-dev libudev-dev llvm libclang-dev protobuf-compiler curl git
```

### A3. Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Press `1` for default install when prompted, then load Rust into the current shell:

```bash
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

Add to your shell profile so Rust is available in every new terminal:

```bash
echo 'source "$HOME/.cargo/env"' >> ~/.bashrc
```

### A4. Solana CLI

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
solana --version
```

Configure devnet and create a wallet (skip keygen if you already have `~/.config/solana/id.json`):

```bash
solana config set --url devnet
solana-keygen new
solana address
```

Get devnet SOL (you only need ~1–2 SOL to deploy; deploy uses ~2–3 SOL total):

```bash
# Try smaller amounts first — CLI often rate-limits 2 SOL requests
solana airdrop 1
solana balance
```

If CLI airdrop fails with **rate limit**, use a web faucet instead:

1. Run `solana address` and copy your pubkey.
2. Open [https://faucet.solana.com](https://faucet.solana.com) → select **Devnet** → paste address → request **1 SOL**.
3. Or try [QuickNode devnet faucet](https://faucet.quicknode.com/solana/devnet) or [solfaucet.com](https://solfaucet.com).

Then confirm:

```bash
solana balance
```

Faucet limits are often **per IP** (2 requests per 8 hours). If one faucet fails, wait 5–10 minutes, try another, or connect GitHub on faucet.solana.com for a higher limit.

### A5. Anchor (AVM)

This compiles in Linux and avoids Windows Smart App Control:

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
```

`cargo install` can take **5–15 minutes**. Then:

```bash
avm install 0.30.1
avm use 0.30.1
echo 'export PATH="$HOME/.avm/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.avm/bin:$PATH"
anchor --version
```

You should see Anchor **0.30.1**.

### A6. Open this project from WSL

Your Windows repo is visible inside WSL under `/mnt/<drive>/...`:

```bash
cd /mnt/d/Work/Dev/Github/Poker
pwd
ls
```

You should see `Anchor.toml`, `programs/`, `backend/`, etc.

**Tip:** Building on `/mnt/d/...` is slower than a Linux-native path. For heavy `anchor build` work you can clone into WSL home later (`~/Poker`), but `/mnt/d/...` is fine to start and keeps one copy of the repo for Unity/backend on Windows.

**Important:** Build from the **Linux filesystem** (`~/Poker`), not `/mnt/d/...`. Windows-mounted drives cause `llvm-objcopy: Operation not permitted`. Anchor 0.30.1 IDL generation also needs an older nightly + `proc-macro2` 1.0.94 (handled by the script below).

```bash
# One-time: copy repo into WSL home (fast, reliable builds)
cp -r /mnt/d/Work/Dev/Github/Poker ~/Poker
cd ~/Poker

# Pin BPF deps + build with compatible nightly for IDL
bash scripts/fix-anchor-lockfile.sh
bash scripts/anchor-build.sh
```

Copy artifacts back to your Windows repo when done:

```bash
mkdir -p /mnt/d/Work/Dev/Github/Poker/target/deploy /mnt/d/Work/Dev/Github/Poker/target/idl /mnt/d/Work/Dev/Github/Poker/shared/idl
cp target/deploy/* /mnt/d/Work/Dev/Github/Poker/target/deploy/
cp target/idl/poker_escrow.json /mnt/d/Work/Dev/Github/Poker/target/idl/
cp target/idl/poker_escrow.json /mnt/d/Work/Dev/Github/Poker/shared/idl/
```

Then deploy and test from `~/Poker`:

```bash
bash scripts/anchor-deploy.sh
bash scripts/anchor-test.sh
```

`anchor test` and `anchor deploy` must use the same nightly toolchain as `anchor-build.sh`. Do **not** run bare `anchor test` — use `bash scripts/anchor-test.sh` (or `export RUSTUP_TOOLCHAIN=nightly-2025-04-14` first).

### A8. Settlement key (for backend)

Still in WSL:

```bash
solana-keygen new --outfile settlement.json --no-bip39-passphrase
solana-keygen pubkey settlement.json
```

Put the base58 secret from `settlement.json` into `backend/.env` as `SETTLEMENT_AUTHORITY_SECRET`. Use the pubkey as the on-chain settlement authority when creating tables.

### A9. What stays on Windows vs WSL

| Task | Where |
|------|--------|
| `anchor build` / `deploy` / `test` | **WSL Ubuntu** |
| `npm run backend:dev` | **Windows PowerShell** (Railway Postgres already works) |
| Unity editor / WebGL wallet test | **Windows** |

You can keep using Cursor on Windows and open a **WSL terminal** tab (Terminal → dropdown → Ubuntu) for Anchor commands.

### WSL troubleshooting

| Problem | Fix |
|---------|-----|
| `Error reading manifest from .../programs/.gitignore/Cargo.toml` / `Not a directory (os error 20)` | Workspace glob `programs/*` matched files like `.gitignore`. Repo uses explicit member `programs/poker-escrow` — pull latest `Anchor.toml` / `Cargo.toml`. |
| `lock file version 4 requires -Znext-lockfile-bump` | `Cargo.lock` was generated by newer Windows Cargo. In WSL: `bash scripts/fix-anchor-lockfile.sh` |
| `$'\r': command not found` running a `.sh` script | Windows CRLF line endings. Re-pull the script (fixed in repo) or run: `sed -i 's/\r$//' scripts/fix-anchor-lockfile.sh` |
| `edition2024` / `Application Control` during `cargo install` | Use WSL (this guide) instead of native Windows |
| `source_file` not found on `proc_macro2::Span` during IDL build | Your Rust nightly is too new for Anchor 0.30.1. Use `bash scripts/anchor-build.sh` (sets `RUSTUP_TOOLCHAIN=nightly-2025-04-14` + `proc-macro2` 1.0.94). Do **not** pin `proc-macro2` alone without the older nightly. |
| `SourceFile` not found in `proc_macro` (after pinning 1.0.94) | Same fix — `proc-macro2` 1.0.94 needs `nightly-2025-04-14`, not Rust 1.97 nightly. Run `bash scripts/anchor-build.sh` from `~/Poker`. |
| `llvm-objcopy: Operation not permitted` on `/mnt/d/...` | Build from `~/Poker` (Linux filesystem) or enable WSL `metadata` mount option |
| `wsl --install` fails | Enable **Virtual Machine Platform** and **Windows Subsystem for Linux** in *Turn Windows features on or off*; reboot. On some PCs also enable **Intel VT-x / AMD-V** in BIOS. |
| `anchor: command not found` | `export PATH="$HOME/.avm/bin:$PATH"` or open a new Ubuntu terminal after `~/.bashrc` changes |
| `solana: command not found` | Re-run the Solana PATH line from A4 or open a new terminal |
| Deploy: insufficient funds | `solana airdrop 2` on devnet |
| Very slow `anchor build` on `/mnt/d` | Clone repo to `~/Poker` in WSL for faster builds; sync program id / IDL back to Windows copy |
| Permission errors on `/mnt/d` | Normal for cross-filesystem mounts; avoid `sudo` on files under `/mnt/d` |

### Quick reference (after setup)

```bash
cd /mnt/d/Work/Dev/Github/Poker
anchor build
anchor deploy --provider.cluster devnet
anchor test
```

## Option B — Native Windows (PowerShell)

### 1. Rust

```powershell
winget install Rustlang.Rustup
```

Close and reopen the terminal, then:

```powershell
rustup default stable
rustc --version
cargo --version
```

If `rustup` is still not recognized in the **current** terminal:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
rustup default stable
```

### 2. Solana CLI

Download and run the Windows installer from [Solana install docs](https://solana.com/docs/intro/installation):

```powershell
cmd /c "curl https://release.anza.xyz/stable/solana-install-init-x86_64-pc-windows-msvc.exe -o %TEMP%\solana-install-init.exe && %TEMP%\solana-install-init.exe stable"
```

Restart the terminal, then:

```powershell
solana --version
solana config set --url devnet
solana-keygen new
```

If `solana` is still not recognized in the **current** terminal (PATH not refreshed yet), run:

```powershell
$env:Path = "$env:USERPROFILE\.local\share\solana\install\active_release\bin;" + $env:Path
solana --version
```

### 3. MSVC linker (required for `cargo install` on Windows)

Rust on Windows uses the **MSVC** toolchain. If `cargo install` fails with:

```text
error: linker `link.exe` not found
```

install the C++ build tools (one of the following):

**A — Visual Studio Installer (if you already have VS 2022 Community)**

1. Open **Visual Studio Installer** from the Start menu.
2. Click **Modify** on Visual Studio 2022 Community.
3. Check **Desktop development with C++** (includes MSVC, Windows SDK, `link.exe`).
4. Install, then **restart the terminal**.

**B — Build Tools only (no full IDE)**

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Restart the terminal after installing C++.

`where.exe link.exe` may still return **not found** — that is normal. MSVC is not added to your default PATH. Rust finds `link.exe` automatically via Visual Studio.

Verify the toolchain instead:

```powershell
cargo new --bin _link_test
cd _link_test
cargo build
cd ..
Remove-Item -Recurse -Force _link_test
```

If `cargo build` succeeds, retry the AVM install below. Optional: use **Developer PowerShell for VS 2022** (Start menu) if a build still cannot find `link.exe`.

### 4. Smart App Control (if `cargo install` fails with os error 4551)

If you see:

```text
An Application Control policy has blocked this file. (os error 4551)
```

**Windows Smart App Control** is blocking freshly compiled Rust build scripts (unsigned `.exe` files). This is separate from the MSVC/linker issue. Moving the build out of `%TEMP%` does not fix it.

**Recommended: use WSL2 (Option A above)**

```powershell
wsl --install
```

Reboot when prompted, open **Ubuntu**, and install Rust/Solana/Anchor there. Access the repo at `/mnt/d/Work/Dev/Github/Poker`.

**Alternative: turn off Smart App Control (native Windows only)**

1. Open **Settings** → **Privacy & security** → **Windows Security** → **App & browser control**
2. Open **Smart App Control settings**
3. Set to **Off** and reboot

Microsoft notes SAC may not be re-enableable after you turn it off. Only do this if you accept that tradeoff and prefer native Windows builds.

### 5. Anchor (AVM)

```powershell
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1
anchor --version
```

If `anchor` is not found, add `%USERPROFILE%\.avm\bin` to your PATH.

### 6. Build and deploy this project

From repo root:

```powershell
cd D:\Work\Dev\Github\Poker
anchor build
anchor deploy --provider.cluster devnet
anchor test
```

### 7. Wire up backend + Unity

After deploy, copy the **deployed** program id:

```powershell
solana address -k target\deploy\poker_escrow-keypair.json
```

Update:

- `backend/.env` → `POKER_PROGRAM_ID=...`
- `Anchor.toml` / `programs/poker-escrow/src/lib.rs` if you use `anchor keys sync`

Generate settlement key for backend:

```powershell
solana-keygen new --outfile settlement.json --no-bip39-passphrase
# solana-keygen pubkey settlement.json  → use as on-chain settlement_authority when creating tables
# base58 secret from file → SETTLEMENT_AUTHORITY_SECRET in backend/.env
```

Copy `target/idl/poker_escrow.json` → `shared/idl/` and refresh discriminators in `Assets/Scripts/Chain/PokerEscrowProgram.cs` if needed.

## Verify install

```powershell
rustc --version
solana --version
anchor --version
```

All three must print versions before `anchor build` works.

## Common errors

| Error | Fix |
|-------|-----|
| `'anchor' is not recognized` | Install Anchor via AVM (step 3); restart terminal |
| `'solana' is not recognized` | Install Solana CLI (step 2); restart terminal |
| `'cargo' is not recognized` | Install Rust (step 1); restart terminal |
| Deploy fails: insufficient funds | `solana airdrop 2` on devnet |
| `anchor test` fails on Windows | Prefer WSL2 (Option A) |

## What already works without Anchor

- **Backend** (`npm run backend:dev`) — API + Railway Postgres + indexer (needs valid `POKER_PROGRAM_ID`)
- **Unity WebGL wallet** — `SolanaTest` scene (no on-chain escrow until program is deployed)

On-chain buy-in/settlement requires a deployed program from the steps above.

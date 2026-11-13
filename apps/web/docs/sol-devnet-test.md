# SOL screens on devnet: live test log (13 Nov 2026)

How to run it: `npm run dev`, then open
`http://localhost:5180/?testwallet=1&perprogram=nomad&api=staging&netServer=staging`.

- `?testwallet=1` turns on the **dev-only test wallet** (`src/web3/dev/testWallet.ts`). It runs only in a dev build, on
  localhost / 127.0.0.1, with the flag. Production builds don't contain it (checked: 0 matches in `dist`).
- It generates a devnet keypair in the browser (localStorage key `nomad.dev.testWallet.devnetSecret`), registers
  through the Wallet Standard so the game's wallet picker lists it ("Nomad Test Wallet (devnet)"), signs messages and
  legacy / v0 transactions, refuses anything but devnet, and shows a small DEV panel (address, balance, airdrop).
- `perprogram=nomad` points at the staging PER service (`nomad-poker-per-staging…workers.dev`, CORS `*`);
  `api=staging` / `netServer=staging` use the staging API and game server (both allow `http://localhost:5180`).

## Durable test key (added after a lost key)

The first test wallet (`96Hd7DHaqLowB8MSbTosQHmRbASHhmECAifMCFJ5MTGF`) was funded with 10 devnet SOL, but the
browser pane's site data was reset before the funded run (another review cleared localStorage / the pane restarted),
so its key was gone and a new one was generated. Those 10 devnet SOL can't be recovered (devnet only, no real value).

Now the key can live in a **git-ignored** `apps/web/.env.development.local` as `VITE_DEV_TEST_WALLET_SECRET`
(base58 32-byte seed); `testWallet.ts` prefers it over localStorage, so clearing site data no longer loses a funded
wallet. One has been generated on this machine; its address is
**`GQqdtGR9mcK6wSu44VjYSekMJSTqTF85RaAt4ZAPDtDA`** (devnet). Restart `npm run dev` after creating or changing the file.

## Funding

**Devnet's RPC airdrop is closed** (`requestAirdrop` → HTTP 410 "The RPC faucet is closed on this cluster"). Test SOL
now only comes from <https://faucet.solana.com> (captcha / GitHub sign-in: a person has to do it) or from another
devnet wallet. The DEV panel says so and shows the address to fund. Without funding, every flow that moves SOL
stops at the "not enough devnet SOL" step — which is itself one of the things tested below.

## Results (1280×720 and 390×844)

| Flow | Result |
|---|---|
| Test wallet shows in the v2 wallet picker ("Detected"), connect | Works |
| Switch to On-chain (connects first) | Works |
| Load game balance (play-key signature, PER balance read) | Works — "$0 (0 SOL)" |
| Deposit 0.5 SOL with an empty wallet | Works — "Your wallet has 0 SOL… Add devnet SOL to your wallet and try again." |
| Main-menu room in On-chain mode (Sit down = SOL Quick Play) | Works up to funding — "Your wallet doesn't have enough devnet SOL…" |
| Tables › Private: list from staging PER | Works — empty state "No private SOL tables are open right now." |
| Join by code (unknown code) | Works — clear message (title fixed, see below) |
| Host a SOL table (v2 screen) → Create | Works up to funding — "Couldn't host: … not enough devnet SOL" |
| SOL lobby (`private-tables`) | Works; Escape closes panels one at a time |
| SOL tournaments: list, Host a tournament → Create | List works (empty); create stops at funding with a clear status line |
| SOL tournaments: register | Not reachable — no tournament exists on staging (needs a funded host) |
| SOL Agent: panel, Deploy | Panel works; Deploy stops at funding with a clear status line |
| SOL Agent: Stop | Blocked — needs a deployed agent (funding) |
| Withdraw (empty balance) | Works — "Your game balance is empty." (now said without a pointless confirm) |
| Withdraw start → finish with funds | Blocked — needs a deposit (funding) |
| Play a hand at a private SOL table; leave / close / reclaim | Blocked — needs funding |
| Private table HUD (TEE pill, Verify hand) | Blocked — needs a seated hand (funding) |
| Phone 390×844: picker, lobby, Host a SOL table | No overflow; picker row 62 px; sheet rests at the bottom edge |

## Fixed during the test (src/web3/**)

- SOL panels kept their desktop size after the window shrank / the phone rotated (they only laid out on open):
  `perUi.ts` `PerCanvas` now re-lays out on resize, `orientationchange`, a frame later and via `ResizeObserver`.
- The SOL lobby still showed **Connect wallet** as its main button with a wallet connected: hidden once connected
  (`lobby.ts`).
- The SOL Agent panel said "Connect your wallet to see your Agent." with a wallet connected but no play key yet: now
  "Your Agent is idle. Deploy it to send it to a table." (`lobbyAgent.ts`).
- Join-by-code messages were titled "Party": now "Join a table" (`onchainPartial.ts`).
- Withdraw with a known-empty balance asked to confirm first: now says it's empty straight away (`onchainPartial.ts`).

## Found outside this workstream (not edited)

- `src/ui2/ctx.ts` `coinCap()`: in On-chain mode before the balance is read, the top-bar capsule reads
  "Tap to load balance" — long for a capsule. Suggest "◎ —" (and keep the hint in the profile popover).
- `src/ui2/screens/play.ts` (Tables › Private): "+ Host a table" uses a text "+" (use `ico('plus')`), and the footer
  "Cards are readable only by your own table key (MagicBlock TEE, devnet)." is jargon — suggest "Only you can see
  your cards. Every hand can be verified."
- A page reload (e.g. a dev-server hot reload) forgets the connected wallet; the next SOL action shows the picker
  again. That is by design (nothing on chain at boot), but a silent reconnect of the remembered wallet on the first
  SOL action would save a tap.

## What's needed to finish the funded flows

Fund `GQqdtGR9mcK6wSu44VjYSekMJSTqTF85RaAt4ZAPDtDA` (the durable test wallet, shown in the DEV panel) with ~2 devnet SOL from <https://faucet.solana.com>, or
send devnet SOL to it from the deployer wallet, then rerun the blocked rows above with the same URL.

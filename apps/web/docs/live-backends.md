> **Historical (Unity-era backends).** Superseded by the Nomad Cloudflare stack: accounts, the economy, rewards,
> friends and leaderboards are `apps/api`, tables are `apps/game-server`, and PlayFab was removed from the web app in
> Phase 4. Kept for the on-chain and tournament notes until those phases move.

# Live backends for the web port: how to turn them on, and whether to replace PlayFab

Written 7 Nov 2026 from the code on `web/unity-port`. No live service was called while writing it. Prices come
from vendor pages and trackers checked the same day; they are marked as estimates where they depend on our usage.

Two questions:

- **(b)** The live backends are switched off. How do we get those features back?
- **(h)** Can we replace PlayFab, and with what?

---

## Part B — Getting the live features back

### B.1 What is off, and why

`web/README.md` ("Live backends are OFF by default") and `web/docs/PORTING-RULES.md` ("Backends") require every
live call to sit behind a flag that is off by default. Today the switches are:

| Switch | Where | What it does |
|---|---|---|
| `ALLOW_LIVE_PLAYFAB` (a compile-time `const`, `false`) **and** `?online=1` | `web/src/economy/config.ts` `backendMode()` | Real PlayFab title `6A5AE` over HTTPS, client API only. `?online=local` runs the same code against a title emulated in localStorage (`economy/playfab/localTitle.ts`). The default is offline: `LocalVirtualWallet` and a local guest. |
| `?web3deployed=1` | `web/src/web3/config.ts` `makeConfig()` / `assertAllowedUrl()` | Lets web3 reach the Railway services listed in `DEPLOYED` (game backend `poker-production-5326`, PER backends). Without it, those URLs are refused. |
| `?web3backend=<url>` | same | Game backend: SIWS wallet sign-in and `/api/config`. (Its `/host/*` escrow tables are not used: the web build removed them on 9 Nov 2026.) |
| `?perbackend=<url>` | same | Private-tables (PER) backend: lobby `/tables`, `/quickplay/onchain`, `/agents/*`, `/tournaments`, withdrawals. |
| `?perprogram=live` | same | Uses the live poker-per program `7q2vxh2…`. The default is the internal test program `4A3DZW…`. |
| `?web3rpc=<url>` | same | Solana RPC. The default is public devnet. Anything containing "mainnet" is refused outright. |
| `?web2only=1` | same | No wallet UI; Solana never boots. |
| `?tournaments=live&tournamentBackend=<url>` | `web/src/tournaments/install.ts` | Live tournaments from the Node backend. Needs a PlayFab session ticket, so it also needs `?online=1`. |
| `?agentBackend=<url>` | `web/src/agents/install.ts` | Coins Agents farm on the Node backend. The default is `LocalAgentBackend`. |
| `?net=…&netServer=wss://…` | `web/src/net/netService.ts` | Multiplayer server. The default is `ws://<host>:5181`, i.e. `web/server` on localhost. |
| `?voice=1` | same | WebRTC table voice (the Vivox replacement). |
| `?telemetry=1` | `web/src/economy/install.ts` | Echoes telemetry to the console. It never sends anything anywhere. |

### B.2 Each dependency: what needs it, how to turn it on, what production needs

#### 1. PlayFab title `6A5AE`

**Calls inventoried from the code.** Client API (`economy/playfab/*`, `economy/social/*`):

- Sign-in and recovery: `LoginWithCustomID` (guest/device), `LoginWithEmailAddress`, `LoginWithGoogleAccount`,
  `LinkCustomID`, `LinkGoogleAccount`, `AddUsernamePassword`
- Profile: `UpdateUserTitleDisplayName`, `GetPlayerProfile`, `GetAccountInfo`, `UpdateAvatarUrl`
- Data: `GetUserData`, `GetUserReadOnlyData`, `UpdateUserData`, `GetTime`
- Social and boards: `GetFriendsList`, `UpdatePlayerStatistics`, `GetLeaderboard`, `GetFriendLeaderboard`,
  `GetLeaderboardAroundPlayer`
- Server code: `ExecuteCloudScript`

Entity API: `Catalog/GetItem`, `Inventory/GetInventoryItems`, `Statistic/UpdateStatistics`,
`Leaderboard/GetLeaderboard`, `Leaderboard/GetLeaderboardAroundEntity`,
`Leaderboard/GetFriendLeaderboardForEntity`.

| Web feature | PlayFab pieces | Where |
|---|---|---|
| Guest sign-in, keep-me-signed-in, display name | CustomID login (the device token *is* the account), saved session | `economy/playfab/auth.ts`, `ui/loginPanel.ts` |
| Email/password recovery | `AddUsernamePassword`, `LoginWithEmailAddress` | `auth.ts` |
| Google sign-in/link | Google Identity Services token client (popup) → `LoginWithGoogleAccount` / `LinkGoogleAccount` | `playfab/googleSignIn.ts`, `auth.ts` |
| Coins balance | Economy v2 currency `CH`: entity `GetInventoryItems` (read only — players cannot write their inventory) | `playfab/wallet.ts`, `virtualWallet.ts` |
| FreePlayBank (offline-table P/L when a PlayFab wallet is installed but no ledger settles) | Local overlay in PlayerPrefs. No server. | `virtualEconomy.ts` |
| Progress cloud save (spin/login streak, gems, XP, streak tokens, items, missions, last Agent summary) | `UserData` with the C# keys (`Poker.Engage.*`, `Poker.Wallet.*`, `Poker.Progress.Missions`, `Poker.Agent.LastSummary`) | `playfab/playerProgress.ts` |
| Starting chips and retention payouts (Daily Spin, login track, missions, level-ups) | CloudScript `grantStartingChips` (automation rule on `player_added_title`) and `claimRetentionGrant` | `playfab/economyBridge.ts`, `playfab/cloudscript/economy.js` |
| Leaderboards (global/friends/around me) | Legacy statistics plus Progression entity statistics/leaderboards, with fallback between them | `playfab/leaderboardBridge.ts` |
| Friends, requests, table invites | CloudScript `sendFriendRequest`, `acceptFriendRequest`, `removeFriend`, `sendInvite`, `dismissInvite`; `GetFriendsList`; invites in `UserReadOnlyData["Poker.Social.Invites"]` | `social/playFabFriends.ts`, `social/friendInvites.ts`, `playfab/cloudscript/friends.js` |
| Avatars | `UpdateAvatarUrl` / `GetAccountInfo` | `social/playerAvatar.ts` |
| Chips at multiplayer tables (buy-in, checkpoints, cash-out, reconcile) | **Server only**: `Server/AuthenticateSessionTicket`, Economy `Add/SubtractInventoryItems`, `GetInventoryItems`, `GetItem`, Data `GetObjects/SetObjects` (`SeatLock`, `ChipGrants`, compare-and-set), `Authentication/GetEntityToken` (secret key), `Profiles/GetTitlePlayersFromMasterPlayerAccountIds` | Unity: `Assets/Scripts/Economy/Server/PlayFabChipLedger.cs`. Web: `economy/server/chipLedger.ts` only runs against an **emulated** title. |
| Tournament fees/prizes, Agent bankrolls, strategy payouts | Server only, via the Node backend (`backend/src/services/playfab.ts`, secret key) | backend |

**Turning it on for development:** set `ALLOW_LIVE_PLAYFAB = true` and open the page with `?online=1`.

**Gaps to close before production:**

1. **Make the title configurable.** `TitleId` is hard-coded in `economy/config.ts`, so there is no way to point the
   web build at a staging title. Move it to `import.meta.env.VITE_PLAYFAB_TITLE_ID` (default `6A5AE`). The Unity
   server already supports `PLAYFAB_TITLE_ID`, and so do `playfab/cloudscript/deploy.mjs` and
   `scripts/playfab-economy-v2.py`.
2. **Replace the query flag with build config.** Players should never need `?online=1`. Turn `ALLOW_LIVE_PLAYFAB`
   into `VITE_BACKEND_MODE=live`, set per build (staging and production). Keep the query flags for dev builds only.
3. **Give `web/server` a real ledger.** Today it trusts the client's `local:<id>:<coins>` ticket
   (`web/server/src/economy.ts` — "never expose this server"). It needs:
   - a PlayFab-backed `TitleStateHandle` or `ChipLedger`: the Node twin of `PlayFabChipLedger.cs`, which is the same
     protocol `TitleChipLedger` already implements;
   - hello verification through `Server/AuthenticateSessionTicket`;
   - `PLAYFAB_SECRET_KEY` read from the server's environment.

   This is the biggest missing piece for real Coins at multiplayer tables.

**PlayFab Game Manager settings for a web origin:**

- **Google add-on:** Add-ons → Google takes the web client id and secret. In Google Cloud Console, the OAuth client
  `917260482660-…` needs every web origin under **Authorized JavaScript origins**: `http://localhost:5180`, the
  staging origin and the production origin. The web uses the GIS *token* (popup) flow, so redirect URIs are not
  used. Add them only if you switch to a redirect or code flow — PlayFab cannot exchange `postmessage` codes
  (comment in `googleSignIn.ts`). Publish the OAuth consent screen for production; with an unverified app, only
  test users can sign in.
- **Client Profile Options:** allow Display name, Last login time and Avatar URL. The friends list depends on them
  (`friends.js` header).
- **API features:** "Allow client to post player statistics" must be on for leaderboards, which is a cheat vector
  (see the security section). Player creation through the client must stay enabled for guest accounts.
- **Automation rule:** `player_added_title` → `grantStartingChips`. Rules have no API, so set this by hand on each
  new title.
- **Economy v2:** create the `CH` currency (`scripts/playfab-economy-v2.py setup`) and keep player inventory
  writes disabled for clients. Then run `probe` to confirm.
- **CORS:** PlayFab's API answers any origin. The Unity WebGL build already depends on that, so no setting is
  needed. Confirm it on staging.
- **Plan and mode:** a new title starts in Development Mode, which allows **1,000 lifetime players**. That is fine
  for a staging title. Check that `6A5AE` is in Live mode on a plan before launch.

#### 2. The Node backend (`backend/`, Railway, `railway.toml`: nixpacks, `npm start` runs migrations, health check `/api/health`)

What it serves, and which web features use it:

| Route group | Web feature | How to turn it on in the web |
|---|---|---|
| `POST /api/auth/nonce`, `/api/auth/verify`, `GET /api/me`, `PUT /api/me/email` (SIWS → JWT) | Wallet sign-in and email capture (`web3/solana/auth.ts`, `web3/ui/walletLogin.ts`) | `?web3backend=<url>` or `?web3deployed=1` |
| `GET /api/config`, `/api/auth/introspect` | Wallet session checks | same |
| `/host/tables…` (escrow money tables, requires a player JWT) | None: the web build has no escrow tables (removed 9 Nov 2026; SOL play is private tables only) | — |
| `POST /api/auth/playfab` (PlayFab ticket → 1-hour JWT), `/api/tournaments…`, `/api/me/tournaments` | Live tournaments (`tournaments/api/apiClient.ts`) | `?tournaments=live&tournamentBackend=<url>` plus `?online=1` |
| `/internal/tournaments/*` (internal API key) | Tournament table runner in `web/server/tournament` (`POKER_TOURNAMENT_BACKEND_URL`, `POKER_INTERNAL_API_KEY`) | server-side environment only |
| `/api/agent/start, stop, progress, result, active, history, hands` | Coins Agents (`agents/agentBackend.ts`) | `?agentBackend=<url>` |
| `/api/strategies…`, `/api/style/twin`, `/api/style/coach` | Market (`menu/screens/market.ts`) | through a `backendApi` service |
| `/api/party/*`, `/api/quickplay/overflow`, `/internal/*` | Unity dedicated server (VPS) | not used by the web client |

**Gaps found in the code:**

- **Agents send no token.** `agents/install.ts` creates `new HttpAgentBackend(remote, async () => null)`, so
  authenticated agent routes return 401. Wire the token provider to the tournaments client's
  `/api/auth/playfab` token.
- **Nothing registers the Market's `backendApi` service.** `menu/deps.ts` declares it, but no module sets it, so the
  Market is always local. Register a service backed by the tournaments API client.

**Backend environment** (`backend/README.md`):

- `DATABASE_URL`, `JWT_SECRET`, `INTERNAL_API_KEY`
- `AUTH_DOMAIN` / `AUTH_URI` — the SIWS message
- `PLAYFAB_TITLE_ID` / `PLAYFAB_SECRET_KEY`, or `PLAYFAB_FAKE=1` for an in-memory title
- `SETTLEMENT_AUTHORITY_SECRET`, `SOLANA_RPC_URL`, `POKER_PROGRAM_ID`
- `TOURNAMENTS_SCHEDULER`

**What production needs:**

- **CORS.** `backend/src/index.ts` sends `Access-Control-Allow-Origin: *`. That works only because auth is a bearer
  header, never a cookie. Replace it with an allow-list per environment (`CORS_ORIGINS`) and add `Vary: Origin`.
  Allow `GET, POST, PUT, OPTIONS` and the headers `Content-Type, Authorization`. Do **not** expose `X-API-Key` to
  browsers — `/internal/*` is server-to-server only.
- **SIWS domain.** Set `AUTH_DOMAIN`/`AUTH_URI` to the host the page is served from, per environment (for example
  `staging.<domain>`). Wallets such as Phantom parse SIWS-shaped messages and warn when the domain does not match
  the requesting origin. Today it defaults to `nomadpoker.fun`.
- **Sessions.** The wallet JWT is kept in localStorage (`Poker.SessionJwt`, the same key as Unity), and so are the
  PlayFab saved session and the backend tournament token. Any XSS can steal them. Two options:
  - *Keep bearer tokens* (simplest, matches Unity). Then the CSP must be strict and token lifetimes short. `JWT_TTL`
    defaults to 7 days; consider 1 day plus re-sign.
  - *Move the web to HttpOnly, Secure, SameSite cookies.* This needs CORS with credentials (no `*`), CSRF
    protection, and the API on the same site as the page.
- **Rate limits** already exist (`middleware/rateLimit.ts`). Behind Railway's proxy, check `trust proxy` so limits
  key on the real client IP.

#### 3. The PER backend (`per/backend`, Railway; health check `/health`)

- **Web features:** the private-tables lobby, Quick Play on chain, hosted tables, SOL Agents
  (`/agents/me|prepare|start|stop`), the PER tourney list, verify/hand archive, withdrawals.
  Files: `web3/per/*`, `web3/nomad/onchainPartial.ts`, `web3/ui/lobbyAgent.ts`, `lobbyTourney.ts`.
- **Turning it on:** `?perbackend=<url>`. With `?web3deployed=1` it uses `per-api-v3-production` for the test
  program, or `poker-per-api-production` with `?perprogram=live`.
- **CORS:** `per/backend/src/api.ts` allows `*` on public routes with `content-type` only. The admin `/audit/*`
  routes use a bearer admin token and must never be called from the browser. An allow-list is optional here,
  because these reads are public.

#### 4. Solana and MagicBlock PER/TEE (`per/README.md`)

- **Web features:** wallet connect (Wallet Standard plus injected Phantom), PER deposit/withdraw,
  play keys (an AES key in IndexedDB), table play over `https://devnet-tee.magicblock.app`. Unlike Unity, the web
  build has no TEE attestation badge (removed 9 Nov 2026).
- **Devnet only.** Mainnet is blocked in code (`Cluster = 'devnet'`, `assertAllowedUrl` refuses "mainnet"). Going
  to mainnet is a deliberate code change, not a flag:
  - cluster type and program ids;
  - a mainnet RPC behind a small proxy, so no RPC API key ships in the bundle (`config.ts` already avoids the keyed
    devnet RPC for that reason);
  - the mainnet TEE URL;
  - `explorerTx`.
- **Production:** keep the client-side rule that nothing is signed without a click. Watch the open devnet issues
  first: the TEE reload pitfall and the keeper (see the per handover).

#### 5. Photon → `web/server`

- **Web features:** Quick Play, parties, private rooms, chat, reactions, reconnect, overflow tables,
  server-run tournaments, server Agents.
- **Turning it on:** deploy `web/server` (Node + `tsx`, or a compiled build) behind TLS and open the page with
  `?netServer=wss://<host>`. Server environment: `POKER_SERVER_PORT`, `POKER_SERVER_HOST`,
  `POKER_TOURNAMENT_BACKEND_URL`, `POKER_INTERNAL_API_KEY`.
- **Before it may face the internet:**
  - the real ledger and ticket verification (§1, gap 3);
  - an `Origin` check on the WebSocket upgrade;
  - per-IP connection limits;
  - one process per room or a sticky router — rooms live in memory, as with the Fusion VPS spawner.

#### 6. Vivox → WebRTC

- **Web feature:** table voice (`?voice=1`), signalled through `web/server`.
- **Production:** `net/voice/tableVoice.ts` creates `RTCPeerConnection({ iceServers: [] })`, so voice works only
  where host candidates connect (LAN or localhost). Add STUN plus TURN: self-hosted coturn, Cloudflare Realtime
  TURN, or Twilio. Mint short-lived TURN credentials server-side and deliver them in the room hello. A TURN secret
  must never go in the bundle.

#### 7. Telemetry

Local only. Unity Analytics is not ported. For production, add a sink: our own `/api/events` endpoint, or PlayFab
`WritePlayerEvent`. Optional.

### B.3 Content Security Policy for the production page

`index.html` has no CSP today. Set a CSP header at the host. Start from this and trim to what each build enables:

```
default-src 'self';
script-src 'self' https://accounts.google.com/gsi/client;
frame-src https://accounts.google.com;
connect-src 'self'
  https://<TITLE>.playfabapi.com
  https://<game-backend> https://<per-backend>
  wss://<table-server>
  https://<solana-rpc-or-proxy> wss://<solana-rpc-or-proxy>
  https://devnet-tee.magicblock.app wss://devnet-tee.magicblock.app
  https://accounts.google.com https://oauth2.googleapis.com;
img-src 'self' data: blob: https:;          /* avatar URLs */
style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style;
media-src 'self' blob:; worker-src 'self' blob:;
frame-ancestors 'none'; base-uri 'self'; form-action 'self';
```

Wallet extensions inject their own scripts, which CSP does not block.

### B.4 Security concerns of a browser client

1. **No secrets in the bundle.** The PlayFab title id, the Google client id and the program ids are public. These
   must never ship:
   - `PLAYFAB_SECRET_KEY`
   - `INTERNAL_API_KEY` / `POKER_INTERNAL_API_KEY`
   - `JWT_SECRET`
   - `SETTLEMENT_AUTHORITY_SECRET`
   - keeper and deployer keys
   - the PER admin token
   - TURN secrets
   - keyed RPC URLs

   Add a CI check that greps `web/dist` for them. The rule matches the Unity setup: `Poker.Economy.Server` is
   excluded from WebGL builds.
2. **What was server-side in Unity must stay server-side:**
   - `Server/AuthenticateSessionTicket`
   - every Economy v2 currency write (`Add/SubtractInventoryItems`) and its title entity token
     (`GetEntityToken` with the secret)
   - `SeatLock` and `ChipGrants` entity objects
   - `GetTitlePlayersFromMasterPlayerAccountIds`
   - cross-player social writes (CloudScript `friends.js`)
   - grant validation (`claimRetentionGrant`)
   - tournament, Agent and strategy money (Node backend)
   - CloudScript deploy (Admin API)
   - escrow settlement and PER keeper (backends)
3. **Endpoint overrides are a phishing vector.** `?tournamentBackend=` receives the player's **PlayFab session
   ticket**, and `?web3backend=` receives SIWS signatures. In production, a crafted link could point the page at an
   attacker's server and take over the session. Production builds must ignore these query parameters or check
   them against a compiled-in allow-list. The same applies to `?netServer=`, `?perbackend=`, `?agentBackend=` and
   `?web3rpc=`.
4. **Client-writable PlayFab data can be cheated.** This was true in Unity too:
   - `UserData` holds gems, XP, streak tokens, items and missions, so a player can edit them with their own ticket;
   - leaderboards rely on client `UpdatePlayerStatistics`.

   Coins are safe, because only the server and CloudScript can write them. To harden, move leaderboard statistics
   to the server ledger (it knows each player's real P/L), and move gems and items to `UserReadOnlyData`, written
   by CloudScript.
5. **XSS is the main web-specific risk**, because the tokens sit in localStorage. Apply the CSP above. Keep
   `unityUi.ts` rendering text with `textContent`, not `innerHTML`, for player-supplied strings such as display
   names, chat and invites.
6. **Play keys.** The PER play key is AES-wrapped in IndexedDB. A browser profile is weaker storage than the Unity
   desktop keystore, so keep the stake caps that the program enforces.

### B.5 Enablement plan (staging first; nothing deployed is touched without an explicit OK)

Ordered by dependency. Each step lists what it needs before it starts and the check that ends it.

| # | Step | Touches live? | Done when |
|---|---|---|---|
| 0 | Code prep, no deploys: configurable title id and backend URLs through `VITE_*`; a production build that ignores URL overrides (§B.4.3); CSP header; agents token provider; `backendApi` service; bundle-secret CI check | No | typecheck, tests and the secrets grep are green |
| 1 | Create a **staging PlayFab title**, a new title in the same studio. Development Mode (1,000 lifetime players) is free. Run `PLAYFAB_TITLE_ID=<staging> scripts/playfab-economy-v2.py setup`, then `probe`. Deploy CloudScript with `PLAYFAB_TITLE_ID=<staging> node playfab/cloudscript/deploy.mjs --deploy`, then add the automation rule, profile options, statistics and leaderboards by hand. Add the Google add-on with a **separate staging OAuth client**, with origins `localhost:5180` and the staging host. | New staging title only | Web on `?online=1` signs in as guest, email and Google; the balance shows 10,000; Daily Spin pays; friends and invites work between two browsers |
| 2 | **Staging Node backend:** a new Railway service and a new Postgres. Never the production one. Set `PLAYFAB_TITLE_ID=<staging>` with its secret, a new `JWT_SECRET` and `INTERNAL_API_KEY`, `AUTH_DOMAIN=<staging host>`, a devnet settlement key that is a **test key**, and the CORS allow-list. | New service | Tournaments, Agents and Market work from the staging web against it, and wallet SIWS signs in |
| 3 | **`web/server` with a real ledger** (§B.2.1, gap 3) on a staging host behind `wss://`, with the staging PlayFab secret and the staging backend URL and key. Add TURN for voice. | New service | Two players buy in, play, disconnect, reconnect and cash out; the PlayFab balance reconciles; the conservation check passes; voice works across networks |
| 4 | **Web3 on test infrastructure:** default test program `4A3D…`, the internal test PER backend, devnet RPC (or a proxy). Ask before using any existing Railway service, even the test one. | Devnet / test services — **ask first** | PER lobby, deposit, play, withdraw and verify pass with a test wallet |
| 5 | **Staging web host:** static `web/dist` on Vercel or Cloudflare Pages with CSP and HSTS, origin `staging.<domain>`. Run the full regression on phone and desktop browsers. | No | Sign-off on staging |
| 6 | **Production, after an explicit OK from the user:** add the production web origin to the Google OAuth client and to the CORS lists of the production backend and PER backend; set `AUTH_DOMAIN`; deploy `web/server` production with title `6A5AE`; flip the production build to `VITE_BACKEND_MODE=live`. | **Yes** | A canary to a small player group, then full rollout |
| 7 | Mainnet (separate project): code change for cluster and program ids, RPC proxy, audit | Yes | — |

**Choices to make along the way**

- **Staging title vs. testing on `6A5AE` with throwaway accounts.**
  - *Staging title* — pros: no risk to real balances or boards, and setup scripts and CloudScript can be tried
    freely. Cons: about half a day of manual setup (rules and settings have no API), plus a second OAuth client.
  - *`6A5AE` with throwaway accounts* — pros: no setup. Cons: it writes to live leaderboards and the live economy,
    and it breaks the "never touch deployed" rule.

  **Recommendation: the staging title.**
- **Bearer tokens vs. cookies for the web.**
  - *Bearer tokens* — pros: no backend change, the same as Unity. Cons: XSS can steal them.
  - *Cookies* — pros: XSS cannot read them. Cons: CORS with credentials, CSRF handling and same-site hosting, and
    it diverges from Unity.

  **Recommendation: bearer tokens plus strict CSP now; revisit at mainnet.**
- **Where to host `web/server`.**
  - *Same VPS as the Fusion server* — pros: existing ops, and the secret key already lives in a systemd
    `EnvironmentFile`. Cons: shared failure domain.
  - *Railway or Fly.io* — pros: easy TLS and regions. Cons: in-memory rooms need sticky routing, and WebSocket
    egress costs.

---

## Part H — Replacing PlayFab

### H.1 What the game uses PlayFab for

From the web client, the Unity client (`Assets/Scripts`, about 35 distinct API calls), CloudScript and the server
ledger:

| # | Capability | How heavily | Notes |
|---|---|---|---|
| 1 | Accounts: device/guest (CustomID), email+password, Google, display name, avatar URL, saved session | Core | Wallet (SIWS) identity already lives in our backend (`players.pubkey`) |
| 2 | Server-authoritative currency `CH` (Economy v2 inventory), idempotent add/subtract, overdraft refusal | Core | One currency, no catalog store, no in-app purchases |
| 3 | Compare-and-set per-player documents (`SeatLock`, `ChipGrants`, via `ExpectedProfileVersion`) | Core | Underpins the ledger's safety |
| 4 | Server code: CloudScript (welcome grant, retention grants with daily caps, friends and invites) and an automation rule | Medium | About 400 lines of JS |
| 5 | Key/value player data (`UserData`, `UserReadOnlyData`) | Medium | About 10 keys |
| 6 | Statistics and leaderboards (global, friends, around me) | Medium | One free-play board |
| 7 | Friend list with tags (one-way lists, emulated two-way by CloudScript) | Medium | |
| 8 | Session-ticket verification for our servers (Unity dedicated server, Node backend) | Core | |
| 9 | **Not used:** matchmaking, multiplayer servers, catalog/store, IAP receipt validation, PlayStream analytics, segmentation, A/B tests, UGC, CDN, title news | — | We pay for a big platform and use a thin slice |

In other words, the game needs **auth + a ledger + a few tables + server functions**. That is a small, standard
backend, and our Node backend already does the hardest part (idempotent money moves with retry workers:
`money_moves`, `agent_money`) — it just executes them against PlayFab.

### H.2 PlayFab's status (Nov 2026)

- **Plans:** Pay-as-you-go $0/month, Standard $99/month, Premium $1,999/month.
- **Development Mode** is now **10 titles × 1,000 lifetime players** each.
- **Foundation Mode** (announced March 2026) is free, but only for titles shipping on **Xbox**, so it is not
  available to us.
- **Meters that matter for us:**
  - profile writes $7.15/M;
  - **Economy v2 inventory writes $40/M** (first 15k free) and reads $3/M;
  - CloudScript executions $0.22/M;
  - leaderboard writes $0.50/M.
- **Rough cost estimate.** Assumptions per monthly active player: about 300 entity-object writes (table
  checkpoints), about 40 inventory writes (buy-ins, cash-outs, grants), about 50 inventory reads. That gives about
  **$40–60/month at 10k MAU** (inside Standard's included meters) and **about $400–600/month at 100k MAU**. Check
  against Game Manager → Billing for real usage.
- **Risks:** Microsoft has moved the free tier twice in a year, and the platform is clearly steered toward Xbox
  titles. The JS SDK is thin. The ledger's safety depends on entity-object compare-and-set semantics.

### H.3 The options

Ratings: ●●● strong, ●● partial, ● weak.

| Option | Coverage of H.1 | Migration effort (web + servers; Unity extra) | Cost 10k / 100k MAU (estimate) | Lock-in | Web | Server-authoritative economy | Solana wallet identity |
|---|---|---|---|---|---|---|---|
| **Stay on PlayFab** | ●●● (it is what we use) | 0; 2–3 wks to finish the web live path (B.5) | ~$50–100 / ~$400–600 | High (proprietary data, CloudScript) | ●● REST works, no official modern JS SDK | ●●● Economy v2 + server key | ● only through our backend (or PlayFab OpenID Connect with our backend as the OIDC issuer) |
| **Own Node backend + Postgres** (extend `backend/` on Railway) | ●●● everything is just tables and routes; friends, leaderboards, auth to write | **6–9 eng-weeks** web/servers + 2–3 Unity + 1–2 migration | ~$30–80 / ~$150–400 (Railway Pro $20/seat + usage, Postgres, a replica) | None (our code, standard Postgres) | ●●● we own the API | ●●● ACID transactions replace compare-and-set; `money_moves` pattern exists | ●●● SIWS → JWT already in production code |
| **Supabase** (Postgres + Auth + Edge Functions) | ●●● auth (email, Google, anonymous, **Web3/Solana sign-in**), Postgres for ledger/friends/boards, Edge Functions or our Node for logic | 5–8 wks + 2–3 Unity + 1–2 migration | Pro $25 incl. 100k MAU + compute: ~$25–60 / ~$110–250 | Low–medium (Postgres is portable; Auth and RLS less so) | ●●● supabase-js | ●●● only if writes go through `security definer` RPC or our server; never client table writes under RLS for money | ●●● native Solana sign-in, or keep our SIWS and mint Supabase JWTs |
| **Firebase** (Auth + Firestore + Functions) | ●● auth good; ledger, leaderboards and friends are all DIY on a document store | 6–9 wks + Unity + migration | ~$10–40 / ~$300–450 (Auth free to 50k MAU, then about $0.0055/MAU) | High (Firestore data model, Google) | ●●● | ●● Firestore transactions work but double-entry ledgers and aggregates are awkward; must use Functions | ●● custom tokens minted by our SIWS backend |
| **Nakama** (Heroic Labs; self-host Apache-2.0 or Heroic Cloud) | ●●● device, email, Google and custom auth; **built-in wallet with ledger**; storage with permissions and version compare-and-set; leaderboards; two-way friends; groups; notifications; TS/Go runtime | 6–10 wks + Unity (official Unity SDK) + migration | Self-host ~$50–150 / ~$200–500 plus ops time; Heroic Cloud is resource-priced, by quote (trackers cite about $600/month entry, unverified) | Medium (open source, but its APIs and schema) | ●●● official JS client | ●●● server-side wallet updates, runtime RPCs | ●●● custom auth (verify the SIWS signature in a before-hook) |
| **Unity Gaming Services** | ●●● Auth (free), Cloud Save, Economy, Leaderboards, Friends, Cloud Code | 6–9 wks; Unity client easy, **web hard** | ~$0–30 / ~$250–400 (Economy $0.35/10k writes over 100k, Friends by quote over 50k MAU) | High (Unity) | ● C#-first; REST only for the browser — awkward now that the web client dropped Unity | ●●● Economy plus Cloud Code | ●● custom ID provider through Cloud Code / token exchange |
| **AccelByte (AGS)** | ●●● IAM, wallet, stats/leaderboards, friends, cloud save, Extend | 8–12 wks (large surface) | Billed per daily peak CCU (~$0.08–0.11/PCCU/day, 30 free): roughly ~$200–330 / ~$2–3k at a 1% peak-to-MAU ratio | High | ●● REST + JS SDK | ●●● | ●● custom IAM platform / Extend |
| **Beamable** | ●●● (Unity-centric live-ops suite) | 7–10 wks | ~$10/M API calls on demand: ~$100 / ~$1k (rough) | High | ● Unity-first | ●●● microservices | ●● (web3 add-ons exist; not Solana-native) |
| **Colyseus** | ● rooms only — replaces Photon, **not** PlayFab | n/a; `web/server` already covers rooms | Cloud from $15/month | Low (open source) | ●●● | n/a | n/a |

### H.4 Pros and cons per option

- **Stay on PlayFab**
  - Pros: zero migration; existing players keep everything; it works today in Unity; low cost at our scale.
  - Cons: we pay for and are bound to a platform we use a slice of; free-tier and pricing churn; Xbox-centric
    roadmap; wallet identity stays bolted on; two systems of record (PlayFab plus our Postgres for tournaments,
    Agents and strategies) with cross-system money retries.
- **Own Node backend + Postgres** — *recommended destination*
  - Pros: no lock-in; one system of record (balances live next to `money_moves`, `agent_money`, `tournaments`, so
    retries become plain SQL transactions); the wallet is a first-class identity; the cheapest at 100k; the team
    already runs it (Railway, migrations, rate limits, JWT).
  - Cons: we must build and own auth (password hashing, email reset, Google ID-token verification, abuse controls),
    friends and leaderboards; on-call is ours; about 2 months of work including Unity.
- **Supabase**
  - Pros: removes the auth build (including Solana sign-in); managed Postgres with backups and point-in-time
    recovery; cheap to 100k MAU; it can *be* the database under our Node backend.
  - Cons: a second vendor next to Railway (or move the backend's Postgres there); RLS mistakes can expose money
    tables; Edge Functions are a second runtime.
- **Firebase**
  - Pros: mature web auth, generous free tier.
  - Cons: a ledger on a document database is the wrong shape; auth gets costly past 50k MAU; high lock-in; it
    duplicates what our Postgres already does.
- **Nakama**
  - Pros: the closest drop-in for *game* features (wallet ledger, friends, leaderboards, storage compare-and-set) with
    web and Unity SDKs; open source, so self-hosting avoids vendor pricing.
  - Cons: a new server to operate (Go plus CockroachDB or Postgres), or a pricey managed plan; another runtime next
    to the Node backend, which would still own tournaments, Agents and chain; the team has no Nakama experience.
- **Unity Gaming Services**
  - Pros: cheap, complete, easy for the Unity client.
  - Cons: the web port's whole point is no Unity, and UGS has no browser SDK; Unity lock-in.
- **AccelByte**
  - Pros: enterprise-grade, complete.
  - Cons: CCU billing makes it the most expensive at 100k; heavy to adopt; overkill for our feature set.
- **Beamable**
  - Pros: polished live-ops.
  - Cons: Unity-first, web weak; usage cost; lock-in.
- **Colyseus**
  - Pros: good room framework.
  - Cons: it does not replace PlayFab, and `web/server` already does its job (keep it in mind only if we want
    managed room hosting).

### H.5 Recommendation

**Yes, there is a good replacement: extend our own Node backend + Postgres.** Optionally use **Supabase** as the
managed Postgres and the auth provider (Google, email, anonymous and Solana sign-in) so we don't write auth
ourselves. **Nakama** is the runner-up if we would rather adopt a game-backend product than write friends and
leaderboards. Do not pick UGS, AccelByte or Beamable (web support, cost, lock-in) or Firebase (wrong data shape).

**Timing:** launch the web port on PlayFab first (Part B), then migrate. A migration and a web launch at the same
time doubles the risk. Migrate sooner only if PlayFab costs or plan rules bite, or if Unity is retired, since that
removes the Unity client work.

Decision pros and cons:

- **Migrate after the web launch** — pros: one big change at a time, and real cost and usage data to decide with.
  Cons: two months longer on two systems of record.
- **Migrate before the web launch** — pros: the web ships on the final stack, with no live-PlayFab web work to
  throw away (B.5 steps 1 and 3 get rewritten). Cons: a later launch, and migration risk lands on launch.

### H.6 Migration path that keeps every existing PlayFab player

The guiding rule: **a coin exists in exactly one system at any moment.** Move a balance by debiting PlayFab
(idempotent, to zero) and crediting Postgres in the same retry-safe `money_moves` style the backend already uses.

1. **Schema (new migrations `008_*`):**
   - `accounts` (uuid, `playfab_id` unique, `wallet_pubkey` unique, `google_sub` unique, `email` + password hash,
     display name, avatar URL);
   - `device_ids` (CustomID tokens);
   - `chip_ledger` (double-entry, idempotency key unique) and `balances`;
   - `player_data` (key/value JSON with the existing `Poker.*` keys);
   - `stats`, `friendships` (two-way, with pending states), `invites`;
   - `migration_state` per player.
2. **Ledger behind the existing seam.** Implement `PlayFabEconomy` (`backend/src/services/playfab.ts`, already an
   interface with a fake) as `PostgresEconomy`, and give `web/server` and Unity's `IChipLedger` an HTTP
   implementation against `/internal/ledger/*`. Seat lock and grant log become rows under `SELECT … FOR UPDATE`.
   Keep the PlayFab implementation, chosen **per player** by `migration_state`.
3. **Read-only export, rehearsed on the staging title.** Use the Admin and Server APIs with the secret key, from the
   backend only:
   - players and linked accounts (CustomID, Google id, email), display names and avatars;
   - `UserData` and `UserReadOnlyData`;
   - statistics;
   - friend lists with tags;
   - Economy v2 balances, using the title entity token.

   Load into staging Postgres and diff the counts.
4. **Lazy bridge at sign-in (players notice nothing).** The client still signs in to PlayFab (all current methods),
   then calls the existing `POST /api/auth/playfab`. On first sight, the backend:
   - imports that player's data;
   - **moves the balance**: subtract from PlayFab with idempotency id `migrate:<playfabId>`, then credit Postgres;
   - sets `migrated`.

   From then on, every money path for that player goes to Postgres. A seated player migrates at the next cash-out,
   never mid-table.
5. **Native sign-in for new and returning players.**
   - *Guests:* the device token (`PokerClientIdentity.token`) is sent once and matched to the exported CustomID.
   - *Google:* verify the GIS ID token on the backend and match `google_sub` to the exported Google id.
   - *Wallet:* already native.
   - *Email/password:* PlayFab does not export password hashes. Keep calling `LoginWithEmailAddress` as a verifier
     during the bridge, then set the new hash from the same submitted password on success (or send a reset email).
6. **Switch new accounts** to backend-only (no PlayFab account created). Move CloudScript logic (welcome,
   retention caps, friends, invites) into backend routes, the same rules ported line for line. Move leaderboards to
   server-written stats, which also fixes the client-stat cheat.
7. **Unity client.** Point its `IChipLedger`, progress, friends and leaderboard adapters at the backend in the same
   release, or keep Unity on PlayFab with the bridge. **Do not let both clients write both systems for one player.**
8. **Sweep dormant players** (the export from step 3): credit their balances in Postgres and zero them in
   PlayFab, or leave them for on-demand import. Keep the PlayFab title **read-only** for 6–12 months for stragglers,
   then retire it.
9. **Rollback at every step:** money moves are idempotent and logged in both directions, so a player can be moved
   back by reversing their `migrate:` move and clearing the flag.

---

### Sources (checked 7 Nov 2026)

- PlayFab pricing: <https://developer.microsoft.com/en-us/games/products/playfab/pricing/>
- PlayFab Foundation Mode and Development Mode change (AccelByte, 2 Jul 2026; vendor blog):
  <https://accelbyte.io/blog/playfab-just-cut-its-free-tier-by-99.-heres-what-that-means-for-your-game>
- Supabase pricing summaries: <https://designrevision.com/blog/supabase-pricing.md>,
  <https://toolradar.com/blog/supabase-pricing-2026>
- Firebase pricing: <https://www.activepieces.com/blog/firebase-pricing-2026-plans-costs-and-free-limits>,
  <https://magora-systems.com/firebase-pricing/>
- Heroic Cloud: <https://heroiclabs.com/pricing>, <https://toolradar.com/tools/nakama/pricing>
- Unity Gaming Services: <https://unity.com/products/gaming-services/pricing>
- AccelByte: <https://accelbyte.io/ags-pricing>, <https://pricingsaas.com/companies/accelbyte>
- Beamable: <https://beamable.com/blog/beamable-pricing-overview>
- Colyseus: <https://www.colyseus.io/pricing>

All dollar figures for our usage are estimates built on the stated assumptions. Confirm them against real
PlayFab billing data and vendor calculators before deciding.

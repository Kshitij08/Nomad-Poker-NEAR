# Hosting the multiplayer table server (`web/server`)

What it is: a Node 22 process (`ws` + `tsx`) that keeps every table in memory, runs the shared TypeScript engine
with PokerServerGame's rules, and drives turn timers / bot think time / disconnect grace with real timers. It needs
a **long-lived process with WebSockets**, low latency to players, and each room on one instance.

That rules out **Vercel** (and other request/response serverless): no long-lived WebSocket servers. Vercel hosts the
static web app; the app connects to the table server's `wss://` URL.

## Options (prices: public sources, Nov 2026 — verify before budgeting)

| Option | Pros | Cons | Rough cost (small → medium) |
|---|---|---|---|
| **Railway** (recommended to start) | The team's backend already runs there (`backend/railway.toml`), so one platform, one dashboard, private networking to the backend/Postgres for the real chip ledger; deploy from the repo (nixpacks); WebSockets work out of the box; staging/prod environments. | Usage-billed (~$10/GB RAM, ~$20/vCPU per month); one region per service (no built-in global edge); in-memory tables drop on redeploy unless we drain. | One 0.5 vCPU / 0.5 GB service ≈ $10–15/mo; Pro plan $20/seat incl. $20 usage. |
| **Fly.io** | Cheap small machines (~$2–6/mo shared-cpu), many regions, can pin a room to an instance and route by room code (`fly-replay`) → multi-region later. | Another platform to run; RAM price rose in 2026; more ops (machines, volumes, scaling) than Railway. | ~$5–30/mo for 1–3 small machines. |
| **Cloudflare Durable Objects** | One object per table is a perfect fit; global, scales to zero, WebSocket hibernation, no servers to manage. | Requires porting `web/server` from Node `ws` to the Workers/DO runtime (the engine is pure TS, so it ports; the room/timer/ledger glue must be rewritten); turn timers keep objects awake during hands, so hibernation saves less; billing per message + duration. | Cheap at low scale; grows with messages. Medium rewrite. |
| **VPS (Hetzner etc.)** | Lowest raw cost, full control, no per-message billing. | You run TLS, restarts, deploys, monitoring, scaling yourself. | ~€5–10/mo per box. |
| Game-server platforms (Edgegap, Colyseus Cloud…) | Matchmaking/scaling features. | Overkill: we already have rooms and matchmaking; adds vendor coupling. | Varies. |

## Recommendation

1. **Now: Railway**, a new **staging** service next to the existing backend (never the production project without an
   explicit OK). Add a health route, `wss://` behind Railway's TLS, CORS/Origin check for the web origins, and a
   graceful drain (stop seating new players, finish hands, then exit) so redeploys don't drop live tables. Point the
   web app at it with `?netServer=wss://…` in staging, then a build-time env var for production.
2. **Before real money / launch:** replace the browser-claimed `local:` chip tickets with the real server-side ledger
   (PlayFab server API or our own Postgres ledger — see `live-backends.md`), and verify the player's sign-in on connect.
3. **When players span continents or one instance isn't enough:** shard rooms by code across instances (Railway
   replicas + a small room→instance map in Redis/Postgres), or move to Fly multi-region or Durable Objects. The
   engine/codec stay as they are; only the room hosting layer changes.

Sources: [fly.io pricing](https://fly.io/pricing.md), [Fly.io pricing 2026 (RAM increase)](https://www.buildmvpfast.com/blog/fly-io-pricing-2026-ram-increase-vs-hetzner),
[Railway pricing explained 2026](https://livemy.app/blog/railway-pricing), [Railway vs Render vs Fly.io 2026](https://sota.io/blog/railway-vs-render-vs-fly-pricing-2026),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing), [Durable Objects WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/index.md).

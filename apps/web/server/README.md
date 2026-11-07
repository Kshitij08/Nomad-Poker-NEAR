# Local table server (web port of the Fusion dedicated server)

`npm run server` in `web/` (installs this folder's deps, then `tsx watch src/main.ts`) starts the authoritative table
server on **ws://127.0.0.1:5181** (`POKER_SERVER_PORT`, `POKER_SERVER_SPEED` = time scale, `POKER_SERVER_HOST`).
Local only: it trusts the browser's local chip tickets. Nothing here talks to Photon, PlayFab or any deployed server.

| File | Port of |
|---|---|
| `src/pokerServerGame.ts` | `Net/PokerServerGame.cs` (seating, roster, Quick Play filler bots + free chair, owner lobby, timers, drop grace, leave, bust, buy-in / cash-out, settle + conservation check, catch-up, per-recipient hole cards / turn / lobby, reactions, voice state, avatars, agents seam) and `RemoteActionProvider` |
| `src/rooms.ts` | the Fusion session layer + VPS spawner: rooms (8 connections), PlayerRefs, Quick Play pools + overflow, party rooms (`PokerDedicatedPartySpawner`), idle quit, chat relay (Photon Chat), WebRTC signalling (Vivox) |
| `src/economy.ts` | `Net/Economy/ChipTableSession.cs` over the economy module's `TitleChipLedger` (src/economy/server) |
| `src/tableNet.ts` | `PokerTableNet` (server half) and `IPokerTableServer` |
| `../src/core/events/pokerEventCodec.ts` | `PokerEventCodec.cs`, byte-identical (golden test against the real C#) |
| `../src/net/shared/*` | protocol, `PokerChatText` / rate limiter, `StakeSessionNames`, `ChainTableMode`, party codes |

Wire: binary frames are C# codec payloads; text frames are JSON (`src/net/shared/protocol.ts`).

## Hooks for other modules

- **Tournaments** (`tournament/`, tournaments porter): `registerServer(match, create)` hosts sessions whose name
  matches with your own `IPokerTableServer` (rooms opened this way allow 32 connections); `openTable(spec, factory)`
  opens a room directly; `server.clock` is the shared clock; `TableNet.disconnect?(player)` turns a connection away.
  `main.ts` calls `registerTournaments(server, { clock: server.clock })`.
- **Agents** (`src/agents/server/`, agents porter): `startPokerServer({ agentHooks })` gets `observe` / `handComplete` /
  `evaluateAfterHand` / `stopped` callbacks; a table's `PokerServerGame.trySeatSharedAgent(config)`,
  `cancelPendingSharedAgent(id)`, `requestAgentStop(id)` and `canAcceptSharedAgent` port the C# seating rules (empty
  chair or bump a filler bot, never with the owner, keeps a table alive with no humans). Find a table's server via
  `server.registry.rooms.get(session)?.server`.

## Tests

`server/__tests__/multiclient.test.ts` runs the real server in-process at 25× speed with headless `ClientGame`s
(the browser client minus the 3D view) over real WebSockets: Quick Play with bots, private hole cards, perspective,
ledger debit + balance push, reactions, chat, reconnect inside the grace, cash-out on leave, overflow, party create /
join / owner start. Part of `npx vitest run`.

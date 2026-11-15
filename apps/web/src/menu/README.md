# Menu host (`src/menu`)

The menu scene's plumbing. The screens themselves are the Redesign v2 layer (`src/ui2`); the Unity-port menu
(`Assets/Scenes/PokerUI.unity` rebuilt from `menu-ui.json`, and the `?ui=unity` switch that kept it) was removed.

- Router screen: `'menu'` (the menu scene). Mounting it shows `Login` when `ctx.services.account.signedIn` is false,
  else `MainMenu`, and starts the once-a-second refresh.
- Service: `ctx.services.nomad` (`NomadHost`, `host.ts`), also `window.__nomad` for debugging.
- Table chrome (`table/nomadTableHud.ts`, via `addTableChrome`): Leave, Settings (with Leave table) and Hand rankings;
  `tableLeaveHooks` lets the tournaments module word the Leave confirm.

## Screen names

`host.show(name)` takes the old Unity screen names, kept as the app's screen ids: `Login`, `MainMenu`,
`TableSelect_TownLobby`, `Friends`, `PartyMenu`, `Tournaments_Browse`, `Tournaments_MyTournaments`, `Tournaments_Host`,
`Tournaments_JoinByCode`, `Leaderboard`, `Agents_Overview`, `Agents_Strategy`, `Agents_SessionHistory`, `LevelRewards`,
`LuckySlot_Win`, `LuckySlot_Lost`. `ui2/install.ts` wraps `show` / `isShowing` / `goBack` / `attach` / `detach`: each v2
screen lists the names it answers to in `replaces`, and `show(name)` opens it.

## NomadHost API

| | |
|---|---|
| `host.show(name)` / `host.isShowing(name)` / `host.onScreenShown(name, fn)` | Navigation by screen name. |
| `host.refreshSoon()` / `host.onRefresh(fn)` | The per-second refresh while the menu is up. |
| `host.dialogs` | The v2 dialog layer (`ui2/globalDialogs.ts`): `message`, `form`, `busyNote`, `closeBusy`, `settings`, `close`, `isOpen`. |
| `host.message(...)` / `host.busy(title, text)` / `host.closeMessage()` / `host.run(op, onOk?)` | Message box helpers (`run`: an op that returns an error or null; errors go to the message box). |
| `host.showConnecting(onCancel)` / `host.closeConnecting()` | The "Finding a table…" cover (ui2 draws it). |
| `host.stakes` | `StakeSelection` (`stakes.ts`; delegates to `ctx.services.retention.stakes` when installed). |
| `host.actions.openDailySpin / openWeeklyRewards / openMissions` | Menu actions ui2 sets. |
| `NomadHost.until(unix)` | "Starts in 2h 5m". |

Other modules hook in with `registerNomadPartial((host, ctx) => …)` from their `install()` (the agents module uses it
for its message box, the way back to Session History after a replay, and "editing the sliders stops copying").

## Other files

- `play.ts`: `openDailySpin`, `joinFreePlay` (Coins Quick Play / Join through the net module, with the offline table as
  the fallback) and `offlineTable`.
- `market.ts`: the Agents marketplace state and strategy-profile helpers the v2 Agents pages use.
- `stakes.ts`, `playMode.ts` (Demo / On-chain), `audio.ts` (persisted volumes, room music), `funnel.ts` (telemetry),
  `deps.ts` (optional services read by name).

# Porting rules for the web port (shared by everyone working in web/)

Goal: the browser game must look and behave exactly like the Unity client. Read the C# and the serialized scene /
prefab / asset data and reproduce them; when Unity data drives something (layouts, clips, values), extract it with a
script in `web/tools/` instead of hand-copying numbers.

## Ownership and concurrency
- Several people/agents work in this checkout at the same time. You own only the folders your brief names.
- Never edit: `src/app/*`, `src/main.ts`, `src/modules.ts`, `src/table/*`, `src/three/*` (unless your brief allows
  it), `packages/engine/src/*` (`@nomad/engine`) outside a subfolder your brief gives you, or another module's folder. If you need a change
  there, put the exact diff in your report.
- Never run git commands that change the index or the working tree (no add/commit/stash/checkout/reset/clean).
- Use only the built-in browser tools (`mcp__Claude_Browser__*`), never Claude in Chrome (the user's own browser).
- Don't start another dev server. One runs at http://localhost:5180 (`npm run dev` in web/). If the browser pane is
  hidden, animation frames are throttled: load with `?paused=1` and drive time with `__poker.step(seconds)` in small
  chunks with `await new Promise(r => setTimeout(r, 0))` between them.
- Checks: `cd web && npx tsc --noEmit` and `npx vitest run` must stay green for the whole project.

## App shell (read these first)
- `src/app/app.ts`: `Screen`, `Router` (navigate / push overlays / back), `Services` (extend it with
  `declare module '../app/app' { interface Services { myThing?: MyThing } }` — ALWAYS optional (`?`): main.ts
  creates the registry with only `account`, and modules fill theirs in at install), `EventBus` (`ctx.events`).
- `src/app/services.ts`: `PlayerPrefs` (localStorage, use the SAME keys as the C#), `VirtualWallet`, `RewardGrant`,
  `AccountService`, `LocalAccount`.
- `src/<module>/install.ts`: your module's entry point. `src/modules.ts` installs modules in this order: theming,
  economy, web3, retention, agents, tournaments, net, menu. Install may be async.
- `src/table/tableScreen.ts`: the table screen. `router.navigate('table', { session, settings, onLeave })`.
  A `TableSession` drives the table's `TableViewPort` (`offlineSession()` = the single-player engine).
  `addTableChrome()` adds UI to every table visit (leave button, chat, reactions…).
- `src/hud/unityUi.ts` + `uiClips.ts`: render Unity uGUI canvases extracted to JSON as DOM (`buildNode`, `UNode`)
  and play UI clips. `tools/extract-unity-hud.mjs` (with `tools/lib/unity-yaml.mjs` `UnityProject`, which resolves
  prefabs/variants/overrides) is the reference extractor. Reuse them; don't hand-build UI the extractor can supply.
- `packages/engine/src/` (`@nomad/engine`): the ported C# core (engine, bots, events, controller). `src/anim/tween.ts` `ticker` is the one clock.

## Data and assets
- Extracted data: `src/data/<module>-*.json`. Assets: `public/assets/<module>/`. Keep them lean: resize oversized
  textures (`tools/lib/png.mjs`), copy only what the screens use, and write a MANIFEST.md mapping files to sources.

## Backends — IMPORTANT
- Do NOT call the live PlayFab title, any deployed server (Railway etc.), Photon, or Solana mainnet. Port the client
  code faithfully against the real APIs, but default to an offline/local implementation; any live call must be behind
  an explicit config flag that is OFF by default. Solana devnet *read-only* RPC is acceptable for checks; no signing,
  no transactions, no test-key use.
- Secrets never go in the client (PlayFab secret keys, server keys).

## Report
Under 350 words: files, what is faithful, what is approximated or missing, the router screen ids and services you
registered, exact diffs you need outside your folders, how to see it in the browser.

# Nomad Poker — web port (no Unity)

A browser rebuild of the whole Unity client: Vite + TypeScript + three.js. The aim is the same game, with the same
look and the same animations — the spline card deal, showdown reveal and return to the deck, the Nomad menu, retention,
themes, Agents, tournaments, multiplayer and the on-chain tables.

```bash
cd web
npm install
npm run dev        # http://localhost:5180 — guest sign-in → Nomad menu → tables
npm run server     # optional: the local multiplayer table server, ws://127.0.0.1:5181
npm test           # vitest: parity with the C# (golden values), spline maths, tweens, every module
npm run typecheck
```

Without `npm run server`, Quick Play offers the offline table against bots instead.

Debug URL flags:
- `?table=1`: skip the menu and sit at the offline table.
- `?speed=3`: run the whole game, animations included, 3× faster.
- `?paused=1`: freeze the game. Then call `__poker.step(seconds)` in the console to advance in fixed 1/60 s frames.
- `?demo=1`: a scripted hand that plays every card animation without the engine.
- `?online=local&seed=1`: run the PlayFab code against an emulated title in localStorage, with demo friends and rivals.
- `?practice=8`: jump into an offline practice tournament. `?agents=1`: open the Agents screens.
- `?net=create&netPlayer=Alice` / `?net=<CODE>&netPlayer=Bob`: two-tab multiplayer against the local server.

### Live backends are OFF by default

Nothing calls the live PlayFab title, the deployed (Railway) servers, Photon or Solana mainnet unless you opt in:
`?online=1` also needs `ALLOW_LIVE_PLAYFAB` set in `src/economy/config.ts`; `?web3deployed=1` / `?web3backend=` /
`?perbackend=` point web3 at a backend; `?tournaments=live&tournamentBackend=<url>`; `?agentBackend=<url>`. Web3 uses
devnet and never signs or sends without an explicit user action. Photon Fusion has no browser client, so multiplayer
runs on `web/server` (the ported engine with PokerServerGame's rules, byte-identical event codec) — local only until
it is deployed somewhere.

## Layout

| Path | What it is |
|---|---|
| `src/core/` | Port of the C# core: cards, evaluator, `PokerEngine`, bots, `PokerGameController`. It has no DOM and no three.js. `__tests__/parity.test.ts` checks it bit-exact against the real C#, compiled with .NET (`__tests__/golden/gen`). |
| `src/anim/unitySpline.ts` | Port of `com.unity.splines` 2.8.4: Bezier knots, arc-length t, rotation-minimising up vectors, `SplineAnimate` timing and easing. |
| `src/anim/tween.ts` | DOTween stand-in (eases, delayed calls, sequences, `SetLink`). The one clock (`ticker`) everything runs on. |
| `src/anim/animCurve.ts`, `clipPlayer.ts` | Unity AnimationCurve evaluation, and an Animator-style clip player (Write Defaults). It drives the community slots. |
| `src/table/cardView.ts`, `splineCardDealer.ts`, `tableView.ts` | Ports of `CardView`, `SplineCardDealer` and `TableView`. |
| `src/three/` | Scene built from the extracted Unity data: the Z-mirrored Unity-space root, camera, light, felt, the card mesh, the slots, and the pot token piles (`potTokens.ts`, the 3D half of `PotView`). |
| `src/hud/` | HTML/CSS HUD over the canvas (seats, pot, betting panel) and `unityUi.ts`, the uGUI → DOM renderer every screen uses. |
| `src/app/`, `src/modules.ts`, `src/main.ts` | App shell: screens, router, services registry, event bus; module install order; boot. |
| `src/table/tableStage.ts`, `tableScreen.ts` | The persistent 3D table and the table screen; a `TableSession` (offline, network, tournament, PER, replay) drives it. |
| `src/menu/` | The Nomad menu (PokerUI.unity) and NomadUiHost's binding model; other modules add their partials (`src/menu/README.md`). |
| `src/theming/`, `src/economy/`, `src/retention/`, `src/agents/`, `src/tournaments/`, `src/net/`, `src/web3/` | One module per Unity feature area, each with its services, screens and Nomad partial. |
| `server/` | Local WebSocket table server (Node + tsx) running the shared engine; tournament runner in `server/tournament/` (`server/README.md`). |
| `src/data/*.json` | Data extracted from `Assets/Test/Test.unity` and its prefabs, clips and FBX. Regenerate it with the tools below. |
| `docs/` | Behaviour and HUD specs read from the Unity code and scene. |

## Coordinate space

Unity is left-handed. The whole table sits under a root scaled `(1, 1, -1)`, so positions, quaternions and Euler
angles inside it (order `'YXZ'`, which is Unity's ZXY) are Unity's raw values. The ported code can then read like the
C#. Only the camera is converted, once (`src/three/unitySpace.ts`).

## Regenerating data from the Unity project

```bash
node web/tools/extract-unity-scene.mjs --copy   # splines, slots, camera, dealer, card, table → src/data/unity-scene.json, slot-anims.json, public/assets/3d
node web/tools/export-card-mesh.mjs             # card mesh from Card Deck.FBX → src/data/card-mesh.json
node web/tools/extract-unity-hud.mjs            # HUD canvases, UI clips, sprites, fonts → src/data/unity-hud.json, ui-anims.json, public/assets/ui
node web/tools/extract-unity-tokens.mjs         # pot token piles (PotView + Token_N prefabs) → src/data/pot-tokens.json, public/assets/tokens (run after the HUD and scene extractors)
node web/tools/extract-unity-menu.mjs           # Nomad menu screens (PokerUI.unity) → src/data/menu-ui.json, public/assets/menu
node web/tools/extract-unity-themes.mjs         # themes → src/data/theming-themes.json, public/assets/theming
node web/tools/extract-unity-retention.mjs      # retention UI → src/data/retention-ui.json, public/assets/retention
node web/tools/extract-economy-ui.mjs           # Friends sheet, login panel → src/data/economy-ui.json, public/assets/economy
node web/tools/extract-web3-ui.mjs              # wallet / cash-out / private-table panels → public/assets/web3
node web/tools/extract-web3-idl.mjs             # slimmed PER IDL for instruction encoding
```

Each module's `MANIFEST.md` under `public/assets/` maps every copied file back to its Unity source.

## Scope and known gaps

Ported: the table (3D deal/reveal/return, river slam, pot chips, HUD, sound), the offline engine and bots, the Nomad
menu and every screen it shows (table select, stakes, settings, market, friends, party, leaderboard, tournaments,
Agents, level rewards, Lucky Slot, weekly rewards), themes, PlayFab economy/progress/social (offline by default),
multiplayer (quick play, parties, chat, reactions, voice over WebRTC, reconnect), tournaments (offline practice and
server-run), Coins Agents with replays, and Solana wallet / escrow / PER private tables.

Known gaps and deliberate differences are listed in each module's report notes and code comments; the main ones:
the HUD always draws over 3D cards (Unity depth-sorts); particle VFX (turn ring, win burst, smoke) are approximations;
the offline "Play offline" table is a web addition and does not take the buy-in from the wallet; a copied marketplace
SOL strategy (`CopiedSol`) is not ported; and the art assets (~84 MB, mostly PNG) are not yet compressed.

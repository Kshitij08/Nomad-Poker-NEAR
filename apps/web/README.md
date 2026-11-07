# Nomad Poker — web port (no Unity)

A browser rebuild of the Unity poker table: Vite + TypeScript + three.js. The aim is the same game, with the same
look and the same animations. That applies most of all to the spline card deal, the showdown reveal and the return
to the deck.

```bash
cd web
npm install
npm run dev        # http://localhost:5180
npm test           # vitest: engine parity with the C#, spline maths, tweens
npm run typecheck
```

Debug URL flags:
- `?speed=3`: run the whole game, animations included, 3× faster.
- `?paused=1`: freeze the game. Then call `__poker.step(seconds)` in the console to advance in fixed 1/60 s frames.
- `?demo=1`: a scripted hand that plays every card animation without the engine.

## Layout

| Path | What it is |
|---|---|
| `src/core/` | Port of the C# core: cards, evaluator, `PokerEngine`, bots, `PokerGameController`. It has no DOM and no three.js. `__tests__/parity.test.ts` checks it bit-exact against the real C#, compiled with .NET (`__tests__/golden/gen`). |
| `src/anim/unitySpline.ts` | Port of `com.unity.splines` 2.8.4: Bezier knots, arc-length t, rotation-minimising up vectors, `SplineAnimate` timing and easing. |
| `src/anim/tween.ts` | DOTween stand-in (eases, delayed calls, sequences, `SetLink`). The one clock (`ticker`) everything runs on. |
| `src/anim/animCurve.ts`, `clipPlayer.ts` | Unity AnimationCurve evaluation, and an Animator-style clip player (Write Defaults). It drives the community slots. |
| `src/table/cardView.ts`, `splineCardDealer.ts`, `tableView.ts` | Ports of `CardView`, `SplineCardDealer` and `TableView`. |
| `src/three/` | Scene built from the extracted Unity data: the Z-mirrored Unity-space root, camera, light, felt, the card mesh, and the slots. |
| `src/hud/` | HTML/CSS HUD over the canvas: seats, pot, betting panel. |
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
```

## Scope so far

This covers single-player at the table against bots, using the `Test.unity` settings: 7 seats, 25/50 blinds and a
5,000 stack. Not ported yet: menus, lobby and table select, multiplayer (Photon Fusion), PlayFab, Solana and PER,
retention screens, tournaments, chat, voice, and audio.

# Web port vs Unity: frame-by-frame parity (seed 55)

The offline single-player table (Test.unity's `PokerGameController`, no NetworkRunner) next to the web port's
`offlineSession`, both at 1280×720 on fixed 1/60 s frames. Settings were the scene's own (7 seats, 6 bots, settle 5 s,
turn timer 15 s) with `useFixedSeed: true, seed: 55, botThinkMin = botThinkMax = 1`. Theme: **Town** in both (Unity's
editor PlayerPrefs `Poker.ActiveTheme` = 4; the web harness applied it with `theme.applyTableSkin`, which doesn't save it).
In hand 1 the human times out and folds, and three bots go all-in. Board J♣ 3♥ 4♦ J♦ 6♥. Bot 6 wins 15,000 with two pair.

Each shot is anchored to a presenter event (Unity: the frame the controller dequeues the event; web: the frame the
`TableView` method runs) plus an offset in frames, so the animations are compared on the same clock even where the
two event timelines drift (see Timing below).

Files: `<shot>-unity.webp`, `<shot>-web.webp`, `<shot>-diff.webp`. The diff image is Unity in dim greyscale with
|Δ| shown as red→yellow. `strip-flop.webp`, `strip-river.webp` and `strip-return.webp` are filmstrips (Unity on top, web
below, every 6th frame of the sweep). `data/` holds both presenter timelines, the shot frames and `metrics.json`
(mean |Δ| per pixel, % of pixels with |Δ| > 40, over all 29 shots).

| shot | anchor + offset | mean \|Δ\| |
|---|---|---|
| 01-deal-a / 03-deal-c / 04-cards-landed | hole card 1 +0.2 s / card 7 +0.25 s / card 7 +2 s | 5.5 / 5.4 / 5.6 |
| 05-fold-grey | first fold +0.5 s | 5.6 |
| 07-flop-b / 08-flop-c / 10-turn-a | flop +0.35 s / +0.7 s, turn +0.35 s | 5.6 / 6.3 / 5.4 |
| 14 / 15 / 16 river slam | river +1.2 / +1.3 / +1.5 s | 6.9 / **16.7** / **27.9** |
| 19-showdown-b | showdown +0.4 s | 5.2 |
| 22-award-b | pot award +0.35 s (chip flight) | 5.4 |
| 26-return-b / 28-return-d | hand end +0.35 / +1.5 s (return, withdrawal) | 6.2 / 5.7 |

The baseline of about 5 comes from items 1, 2 and 6 below plus text antialiasing. Geometry matches almost exactly:
camera and projection, felt, background, deal splines, fold grey-out, showdown reveal, pot chip flight, and the
return and withdrawal flights. The return sweep is frame-for-frame identical over 60 frames.

## Differences, most visible first

1. **Every dark TMP text is too light on the web.** This covers the betting buttons (CALL / CHECK/FOLD / CALL ANY),
   LEAVE, the pot amount, seat stacks and seat names. Measured darkest pixels: Unity `#2A1801`, web `#6E5714`;
   Bot 4's name: Unity 5,5,5, web 22,20,21. Unity's value is exactly the authored colour (Town `buttonLabelColor`
   `#6d5711`) put through sRGB→linear. The project is Linear (`m_ActiveColorSpace: 1`), and TMP's SDF shader uses the
   vertex colour without gamma correction, while uGUI `Image` colours come out as authored (the button plate matches:
   97,90,67 against 97,91,70). On the dark-plate buttons the labels are almost unreadable on the web.
   *Fix:* in `src/hud/unityUi.ts`, apply `c ↦ ((c+0.055)/1.055)^2.4` to TMP text colours only, not to Image or
   RawImage colours. Do it wherever the themed label colour reaches text too.
2. **Offline table chrome is missing.** Unity's offline Test.unity also draws the room-code pill ("123456789" plus a
   copy icon), **Add Bot**, the **?** help button, the chat bubble (bottom left) and an empty dark pot-message pill above
   the pot. The web adds the lobby chrome only in net sessions (`src/net/chrome/netChrome.ts`), and hides the pot
   message when it is empty. "123456789" looks like the prefab's placeholder, so decide whether to copy it or call it a
   Unity bug. The empty pill shows in every Unity frame.
3. **Winner burst VFX.** In 26-return-b Unity shows a large yellow radial glow around the winner's avatar. The web has
   only the crown. This is a known particle approximation; port the CFXR burst or fake it with an additive sprite.
4. **River slam: smoke and camera shake** (15 and 16, the largest diffs).
   - Smoke: Unity's `VFX_Impact_Smoke` is a ring of crisp white puffs reaching about 130 px from slot 5. The web's
     (`three/impactSmoke.ts`) is a tighter grey cluster of about 70 px. Check the start speed and size, the emission
     shape radius and the colour-over-lifetime alpha.
   - Camera: from +1.3 s to +1.6 s Unity's camera is displaced further, right and up. Frames 80–98 have no matching web
     frame in the sweep, while everything before +1.3 s matches to the frame, zoom push-in included. Check the
     MMCameraShaker / MMWiggle Perlin seed and phase, and the #18 to #20 rotation-shake hand-off in `table/riverSlam.ts`.
5. **Flop slot clip, mid-animation.** The start and end match. The slide-in trails by about 2 frames (0.03 s), and in
   the spin from +0.55 s to +0.9 s the web runs about 4 frames ahead (web +40 ≈ Unity +44, web +44 ≈ Unity +48). While
   in flight the cards sit 5–13 px further right on the web. `strip-flop.webp` shows it. This is likely rotation
   interpolation: Unity clips with `m_EulerCurves` interpolate each Euler axis, which slerp doesn't reproduce. It could
   also be the Animator evaluating t=0 on the activation frame. Check `anim/clipPlayer.ts` against the clip's curve type.
6. **Seat HUD details.** Unity's name panel is about 2 px wider on its left edge. On the web the avatar art is slightly
   lighter, and the "BOT" band is darker than Unity's brown band. Unity also tints the winner's "BOT" band at showdown,
   and the web doesn't.
7. **Card materials.** Web card faces are slightly warm (255,255,246 against pure white). The card-back pattern is
   blurrier on the web (compare `07-flop-b`): Unity samples it with anisotropic or trilinear filtering. Set
   `texture.anisotropy = renderer.capabilities.getMaxAnisotropy()` and check the light intensity or tone mapping on faces.
8. **Timing (barely visible).** The presenter timelines match to the frame through the deal (frames 0–64). After that:
   - Each bot turn is 86 frames in Unity and 85 on the web. Unity's `while (!submitted) yield return null` notices the
     submit one frame late. Over 11 actions the web ends up 9 frames (0.15 s) early by the flop.
   - The web's 5 s and 2 s waits take 301 and 121 frames, against 300 and 120 in Unity. The float sum of 1/60 s steps
     lands just under the target, so `delayedCall` fires one frame late. By HandEnded the web is 4 frames early in total.
   - Fixes: in `ValueTween`, compare `elapsed >= duration - 1e-6`. If frame-exact parity matters, wait one frame after a
     provider submits in `onActionRequested`.
9. **Not a port issue:** `00-hand-start` isn't included. The web booted with the Default theme from the shared
   localStorage, and the Town background texture arrived after frame 3.

## How it was made (and how to rerun)

- **Unity (no live services):** run `Assets/WebParity/` (a PlayMode test with its own test-only asmdef, inert unless Unity is launched with `-webParity`) like this:
  `Unity.exe -batchmode -projectPath <repo> -runTests -testPlatform PlayMode -testFilter Poker.WebParity -testResults r.xml
  -logFile u.log -webParity [-webParitySweep] -webParityOut <dir>`. It needs graphics, so don't pass `-nographics`.
  - It takes about 25 s after import.
  - The Main Camera renders into a 1280×720 RenderTexture for the whole run.
  - At each shot, the scene's Screen Space Overlay canvas is given to a depth-only camera for that frame, then put back.
  - Menu overlays that boot themselves (RetentionHud, Friends and Tournaments canvases) are skipped because they aren't
    part of the table.
  - `-webParity` also stops `PokerAnalytics` and `UnityServicesGate` from initialising UGS. The log confirms UGS stayed
    `Uninitialized`.
  - No NetworkRunner is created, and PlayFab is never signed in. Tournaments showed only their local demo data.
- **Web:** `tools/webDriver.js` is pasted into a dev-server tab.
  - It loads the app into a same-origin 1280×720 `srcdoc` iframe with the Vite client stripped, so other people's edits
    can't hot-reload it mid-run.
  - It pauses the app, applies the theme, navigates to `table` with the same settings, wraps the TableView methods to
    get anchor frames, and steps `stage.advance(1/60)` with a macrotask between frames.
  - Captures: `#table3d` through `toDataURL`, taken in the same task as `render()`, and `#hud` and `#screens` through
    html-to-image (SVG foreignObject).
  - Each capture is POSTed to `tools/receiver.mjs` on 127.0.0.1:5199.
  - `tools/compose.cjs` makes the composites and diffs; `tools/strips.cjs` makes the filmstrips and lag estimates.
  - The HUD is rasterised by html-to-image, so small differences in text edges may come from that rasteriser, not the port.

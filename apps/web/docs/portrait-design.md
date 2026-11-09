# Portrait layout (web port)

The Unity client is landscape-only. The web port adds a portrait layout so orientation-locked phones and in-app
webviews (360–430 × 740–932 CSS px) are fully playable. Same art, colours, fonts, components and behaviour: every
portrait surface is the Unity node tree with different RectTransforms (or a different view of the same 3D scene),
never hand-built DOM. Landscape is byte-for-byte the old layout (checked at 800×360, 1280×720 and 2400×1080: action row,
seat discs and world projection match `unity-hud-notes.md` §1).

All code is in `src/layout/`; the other files only call into it with one line each (listed at the end).

## Orientation handling (`orientation.ts`)

- Portrait = viewport taller than 1.05 × its width (square tablets keep the Unity layout). `?orient=portrait|landscape`
  forces one for debugging.
- `<html data-orient>` mirrors it for CSS (`portrait.css`). Listeners run on `resize` (capture phase, so they run before
  the table/menu resize handlers), `orientationchange` (re-checked at +120/+400 ms for iOS Safari, which reports the new
  size late) and `visualViewport.resize`.
- Switching is live and keeps all state: the same table session, the dealt cards (re-homed onto the new spline ends),
  the open screen and dialogs. Verified mid-hand both ways.
- Safe areas: measured from `env(safe-area-inset-*)` (index.html already has `viewport-fit=cover`); the table's top/bottom
  rows, the framed menu screens' Frame169 and MainMenu's full-screen containers are inset; backgrounds and the 3D scene
  stay full-bleed. index.html also gained the home-screen web-app metas; `portrait.css` disables double-tap zoom,
  pull-to-refresh and iOS text inflation.
- Module is safe to import under node (vitest): every browser global is guarded.

## Table (`portraitTable.ts`, `portraitSeats.ts`, `portraitHud.ts`)

Options considered for the 8-seat oval:

| Option | Pros | Cons |
|---|---|---|
| A. Keep landscape, fit the whole table to the width | zero risk | the table becomes ~40 % of the screen, text ~5 px |
| B. Roll the camera 90° | one transform | the river slam rewrites the camera pose every frame; cards and board read sideways |
| **C. Turn the Unity root a quarter turn + re-seat (chosen)** | long axis down the screen, camera/slam untouched, animations exact | needs seat, board and card counter-rotation |

What C does:

- **World**: the Unity-space root gets a 90° yaw plus a scale/offset that fits the table between the top chrome row
  and the action row (safe areas included). The camera, FOV, lens distortion and every river-slam feedback are
  unchanged. The theme backdrop gets the inverse transform, so the arena art stays upright and full-bleed.
- **Seats**: slot *i* takes the place of landscape slot *i+2*, so the local player (slot 0) is at the bottom with the same
  clockwise order: bottom = you, three seats on each side, one at the top. Because only the *drawing* moves, the seat
  mapping of every session type (offline identity, `NetTableView`/`SetLocalPerspective`, tournaments' seat map, PER's
  rotated view) is untouched.
- **Layout** (`portraitLayout.ts`): every seat, card pair, the board, the pot pill and the chip piles have a spot in
  portrait coords, and `__tests__/portraitLayout.test.ts` checks their footprints never overlap, each pair sits nearer
  its own seat than any other, and no pair shares the board's row (a showdown must not read as one long row of cards).
  Side seats' cards sit on the avatar's inner side; the top corners' under their own status pill; the top seat's under
  its stack; the board crosses the middle with the pot above it.
- **Deal splines**: each slot's two splines are the landscape splines of slot *i+2*, each with its own similarity
  (turn + uniform scale) about its start, the deck, that lands that card on its spot: the pair side by side, card 0 on
  the left. The UnitySpline *contents* are swapped in place, so every holder of the spline objects follows; the paths'
  shape, `SplineAnimate` timing and easing are Unity's.
- **Cards**: dealt cards turn upright in their own plane as they leave the deck and back as they return: a yaw on the
  card's deck node, solved each frame from the card's live pose so its long side stands up the screen, leaning 4° out
  from the pair's middle (5° for yours). It holds for every seat's path and through the showdown flip; it uses the
  resting camera's axes, so the river-slam camera roll still moves the cards with the table. Your own two grow to 1.7×
  and fan 0.8 apart, so both are readable at phone size.
- **Board**: the five Animator slots get anchors that put them in a left-to-right row (1.05×) and undo the quarter turn,
  so reveal, withdrawal, smoke and the river-slam bounces play exactly as in landscape.
- **Pot**: the pill (0.85×) and the 3D chip piles move above the board.
- **Seat HUD**: world canvases are drawn upright and 1.55× the 3D zoom (avatar ~70 px, stack ~16 px on a 390-px phone),
  and stacked: avatar, the same `Name_bar` art centred under it (840 wide), status pill peeking out below, D/S/B token on
  the bar's end, hand-strength panel under your stack. The on-enable clips still pop the seat in; the bar's slide-out
  becomes part of the pop (rects are re-asserted each frame).
- **Depth sorting** (`three/hudDepth.ts`): the occluder quads use the same moved/upright/scaled canvas planes
  (`canvasSpace.ts` is shared by `WorldCanvas` and the compositor), so cards above/below a seat plane sort as in landscape.
- **Overlay canvases** (`portraitRects.ts`): Unity's area-based scaler gives 32-px buttons on a phone, so portrait uses a
  720×1280 reference (an 81-unit Unity button ≈ 44 px). Placements:
  - Action row: CALL / CHECK-FOLD / RAISE as three equal full-width thumb buttons above the home bar.
  - Raise (Confirm) panel: three rows over the action row: presets, slider + amount, a full-width CONFIRM.
  - Top row: LEAVE (moved up from the action row: rarely used and it has a confirm) · room code · reactions · chat ·
    settings. Add Bot under the room code. The chat window and reaction tray hang down from their toggles.
  - Tournament banner: full width under the top row; the table refits to make room while it shows. The PER status strip
    does the same (`PerTableHud` rule).

## Menu (`portraitMenu.ts`)

Every menu-style canvas switches to a 1080×1920 reference (Expand), so the canvas is 1080 units wide on a phone; then a
per-screen **rule** (data: `pins` and `stacks`) re-anchors the screen's existing nodes into one column. Stacks lay blocks
top to bottom, scaling each to the column ('fit') or to the height left ('fill'); `row` blocks keep their authored x
spread. Framed screens get their Frame169 stretched over the safe area first. Landscape restores every authored rect.
Dialog-style canvases without a rule (web3 `UCanvas`, retention and economy overlays, NomadDialogs) get the generic
rule: centred panels scale up to fill the column.

| Screen | Portrait arrangement | State |
|---|---|---|
| Login | the Account panel at 1.24× centred | done |
| MainMenu | stats + profile + settings in one top row; logo and TABLES / QUICK PLAY / PARTY MENU stacked at 1.6× (57-px buttons); side tabs stay on the edges | done |
| TableSelect | title row; theme preview; the five theme cards; the Selected table panel filling the rest (JOIN TABLE at thumb height) | done |
| Settings / message / form dialogs, Connecting | window scaled to the column (messages 1.25×, Settings 0.88×) | done |
| Friends | tabs + count; the list full width; your profile card under it at 0.75× | done |
| PartyMenu | title, art, Create and Join cards stacked | done |
| Leaderboard | the frame becomes a tall column: title/coins, 4 tabs, table, your rank, paging | done |
| Tournaments_* | 2×2 tabs; the list panel full width, the details / summary panel under it | done |
| LuckySlot_Win / Lost | machine at full size centred (empty sides overflow) | done |
| LevelRewards | level panel, track, missions title + tabs, the mission list | done (list kept at 0.73×) |
| Agents_* | header, tabs, panels stacked | first pass: the 1,776-wide panels (header, tabs, Strategy parameters, history table) are only scaled to ~0.57× — text ~8 px |
| Web3 panels, retention overlays, economy sheets | generic centred-panel fit | first pass, not reviewed screen by screen |

## Screenshot notes (390×844 and 360×800)

- Offline table: 7 seats around the tall felt; your cards large above your avatar; board row upright; action row and
  raise panel thumb-sized; turn ring, fold grey, hand strength and D/S/B tokens all show. 360×800: same layout, CHECK/FOLD
  label just fits.
- Network table (local server): top row with room code, reactions, chat, settings; Add Bot below; desert theme backdrop
  upright; private buy-in panel scaled up.
- Practice tournament: banner under the top row, table refitted beneath it.
- Live rotation mid-hand portrait → landscape → portrait: no reload, cards and board follow.
- Landscape 800×360 / 1280×720 / 2400×1080: identical to before (numbers match unity-hud-notes §1).
- 10 Nov card re-layout, measured in the browser (every seat part, card, board card, pot pill and chip pile projected
  to screen px): 375×640 had 17 overlaps before (top seats' cards on their own bars, the pot on the top seat's cards,
  your two cards almost exactly on top of each other); after, 0 at 360×740, 375×812, 390×664, 390×844 and 412×915,
  every hole card upright (90° ± the lean), the same after landscape → portrait mid-hand, and revealed cards read the
  right way up. Measure with the pane visible: a hidden pane draws no frames, so the per-frame portrait re-layout does
  not run and the numbers are stale.

## Left / follow-ups

- Agents screens and the Strategy parameter rows need a real portrait re-layout (rows narrowed to 1,040 with their
  sliders), not a scale.
- LevelRewards mission list: resize the scroll view instead of scaling (rows need their layout group re-run).
- Chat window and reaction tray overlap when both are open in portrait (Unity docks one above the other); close one when
  the other opens.
- Seat name text is ~10 px on a 390-px phone (stack ~16 px); raising Name_txt's TMP max in portrait would help.
- Web3 wallet / cash-out panels and retention overlays only have the generic fit; review each on device.
- Device checks (iOS Safari URL-bar resize, Android Chrome keyboard, notch insets) are unverified: the emulator has no
  safe-area insets.

## Hooks outside `src/layout/` (one line each)

`table/tableStage.ts` (construct `PortraitTable`, call `apply`/`frame`), `hud/worldCanvas.ts` and `three/hudDepth.ts`
(read `canvasSpace.ts`), `hud/bettingPanel.ts`, `menu/table/nomadTableHud.ts`, `net/chrome/netChrome.ts`,
`tournaments/ui/retentionDom.ts` (portrait scaler + rects), `menu/ui/canvas.ts`, `web3/ui/ugui.ts`,
`retention/ui/retentionUi.ts`, `economy/ui/canvas.ts` (portrait reference + `portraitMenuLayout`), `index.html` (metas).

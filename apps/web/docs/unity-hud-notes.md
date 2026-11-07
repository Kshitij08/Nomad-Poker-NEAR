# Table HUD — what Unity does, for the web port

Source: `Assets/Test/Test.unity` (the table scene) plus the prefabs it instances, read by
`web/tools/extract-unity-hud.mjs`. The machine-readable twin of this document is
`web/src/data/unity-hud.json` (layout, colours, sprites, fonts, theme overrides) and
`web/src/data/ui-anims.json` (clips + animator controllers). Art is in `web/public/assets/ui/`
(see `MANIFEST.md` there) and fonts in `web/public/assets/fonts/`.

Re-run `node web/tools/extract-unity-hud.mjs` after any Unity-side change; `--no-copy` skips the asset copy.

---

## 1. Canvases and how they map to the screen

| Canvas | Render mode | Scaler | Role |
|---|---|---|---|
| `Name_Canvas_Player`, `Name_Canvas (2/3/5/6)`, `Name_Canvas_Right`, `Name_Canvas_Right (1/2)` | **World Space** | (ignored in world space) | 8 seat HUDs (`SeatView`) |
| `Pot_UI` | **World Space** | — | pot pill (`PotView`) |
| `Background/Table_Canvas` | **World Space**, sort −1 | — | felt image + 2 unused voice labels; its `SeatView` is not wired into `TableView` |
| `Canvas` | **Screen Space Overlay**, sort 0 | Scale With Screen Size, **1920×1080**, match **0.5** (width/height), ref PPU 100 | action buttons (`BettingPanel`), raise panel, lobby buttons, chat, reactions, settings / how-to-play |
| `RetentionHud` (prefab) | Overlay, sort 500 | 1920×1080 / 0.5 | **not shown at the table**: `RetentionMenuHud.Update` hides its bar every frame. Not exported. |

### 1.1 Screen canvas (`Canvas`) and aspect ratios

Unity's scale factor is `s = 2^(0.5·log2(W/1920) + 0.5·log2(H/1080))` (geometric mean of the two ratios).

| Screen | scale factor | canvas size (units) |
|---|---|---|
| 16:9, 1920×1080 | 1.000 | 1920 × 1080 |
| 20:9, 2400×1080 | 1.118 | 2146.6 × 966.0 |

So for the same screen height, a 20:9 screen draws the overlay ~11.8 % **larger** than 16:9 (canvas is only 966
units tall) and the canvas gains ~227 units of width. Meanwhile the world-space seats do not grow (§1.2), so
overlay buttons sit relatively bigger over the table on phones. Elements keep their anchors, so:

* **Action row** (`Rebuy`, `Call`, `Check/fold`, `Callany or raise`, `Cashout`) is anchored **bottom-centre**
  (anchor 0.5,0), each 327.95 × 81.35 at y = 97, x = −705 / −354 / 0 / +354 / +705. On 16:9 that is
  CSS boxes `[91,942]`, `[442,942]`, `[796,942]`, `[1150,942]`, `[1501,942]`. NomadTableHud adds a
  **LEAVE** copy of `Check/fold` at the left edge (anchor x 0, x = 40, width 0.8×) at runtime.
* **Raise panel** `Confirm_Panel` (1362.8 × 138.3) is bottom-centre at y = 102, i.e. on top of the action row.
* **Top-right**: `How_to_play` (?) and `Setting` (gear) — 70.85 circles anchored (1,1) at x −233 / −126, y −167.6.
* **Top-left**: `InviteButton` (room code pill, 286.8 × 74.2, anchor (0,1) at 187, −167.6) and `AddBotButton`
  (156.7 × 52.7 at 456, −194, pivot bottom-centre).
* **Bottom-left**: `Chat_Panel` (440 × 400, anchor (0,0) at 24, −16) and `Reaction_Panel` (184 × 214 at 58, 334).
  Chat's inner rows (`Header`, `Log_Scroll`, `Presets_Row`, `Input_Row`) are laid out by layout groups at
  runtime and serialise as 0×0 — their exported boxes are not meaningful; `PokerChatPanel` also collapses the
  window when the canvas is narrower than its `narrowWidthThreshold` or the screen is portrait.
* `HowToPlay_OutsideCatcher` — a full-screen transparent catcher (CanvasGroup toggled by its own animator).

`unity-hud.json → canvases[role=screen-hud] → node.css["16:9" | "20:9"]` gives every node's
`[left, top, width, height]` in canvas units from the top-left; multiply by `canvasSizes[k].scaleFactor`
for device pixels.

**SafeAreaFitter** exists (`UI/SafeAreaFitter.cs`) but is **not used anywhere in Test.unity** — the table
does not inset for notches. If the web wants it, wrap the overlay in a box padded by `env(safe-area-inset-*)`.

### 1.2 World-space canvases (seats, pot) — how to place them in HTML

Every seat canvas is a 500 × 500-unit RectTransform lying **flat on the table** (rotation 90° about X,
`m_LocalScale` 0.0022457757 → 1 canvas unit = 0.0022458 world units; the 500-unit avatar disc is 1.123 m).
The main camera (`Main Camera`: position (0, 11.03, 0.15), rotation 90° about X, **perspective, vertical FOV
60°**, no aspect-fitting script) looks straight down, so each canvas is **parallel to the image plane**:
the projection is a pure translate + uniform scale (no skew). Canvas +x = screen right, canvas +y = screen up
(world +z).

```
depth = 11.03 − Y                     // camera height minus canvas height
f     = (H/2) / (depth · tan 30°)     // pixels per world unit at that depth (H = viewport height in px)
sx    = W/2 + X · f                   // canvas pivot on screen
sy    = H/2 − (Z − 0.15) · f
k     = f · 0.0022457757              // CSS px per canvas unit
```

`k` = **0.2035 · H/1080** for the seats (Y ≈ 0.921) and **0.1938 · H/1080** for the pot (Y = 0.41). Because the
FOV is vertical and fixed, the table is height-fitted: a 20:9 screen just shows more horizontal margin.
`unity-hud.json → canvases[i].world` has the full matrix, position, quaternion and scale; the HUD node
`layout.box` values are in canvas-root units (y up, origin = canvas centre), so a node's CSS position is
`sx + x·k`, `sy − y·k`.

### 1.3 Seat slots (engine order = `TableView.seatViews`)

`TableView.SetLocalPerspective` rotates seats so the local player is always drawn at **slot 0**
(`Name_Canvas_Player`, bottom-centre); other seats go clockwise: `slot = (localSlot + seat − localSeat) mod 8`.

| Slot | Canvas | Prefab | World (x, y, z) | Screen @1920×1080 | Name bar side |
|---|---|---|---|---|---|
| 0 | Name_Canvas_Player | Name_Canvas | (−1.14, 0.92, −2.83) | (855, 816) | right of avatar |
| 1 | Name_Canvas (2) | Name_Canvas | (−6.36, 0.921, −1.727) | (372, 714) | right |
| 2 | Name_Canvas (3) | Name_Canvas | (−7.11, 0.921, 0.31) | (302, 525) | right |
| 3 | Name_Canvas (5) | Name_Canvas | (−6.18, 0.921, 2.38) | (388, 334) | right |
| 4 | Name_Canvas (6) | Name_Canvas | (−1.14, 0.921, 3.48) | (855, 232) | right |
| 5 | Name_Canvas_Right | Name_Canvas_Right | (6.173, 0.921, 2.38) | (1531, 334) | **left** (mirrored) |
| 6 | Name_Canvas_Right (2) | Name_Canvas_Right | (7.263, 0.921, 0.31) | (1632, 525) | left |
| 7 | Name_Canvas_Right (1) | Name_Canvas_Right | (6.423, 0.921, −1.727) | (1554, 714) | left |
| — | Pot_UI | Pot_UI | (0, 0.41, 1.437) | (960, 427) | — |

(at 2400×1080 add 240 px to every x.) The `*_Right` prefab mirrors the layout: `Name_bar`, `Bottom_bar`
anchor to the canvas' right edge with negative x, the D token sits at the bar's far (left) end.

---

## 2. Seat HUD anatomy (`Name_Canvas.prefab`, canvas units, y up, origin = avatar centre)

Fields wired on every `SeatView`: name → `Name_bar/Name_txt`, stack → `Name_bar/Amount_txt`,
status → `Bottom_bar/Text (TMP)`, dealer badge → `Name_bar/D_Token` (+ label), bot → `bg_circle/U_Icon/Bot_indcator`,
winner → `Win_Medal`, turn highlight → `VFX_Turn_Highlight`, timer → `bg_circle/Timer`, voice →
`Name_bar/Mic/{Sound_Graph, mute, Unmute}`. `betText`, `cardsText`, `turnTimerText`, `avatarImage`,
`reactionBubble` are empty (avatar is found at `Graphics/bg_circle/U_Icon`; the bubble is built at runtime).

Draw order (first = back): `Hand`, `Bottom_bar`, `Name_bar`, `Win_Medal`, `VFX_Turn_Highlight`, `bg_circle`.
The avatar disc is drawn **over** the name bar and the medal.

| Element | Box (x, y, w, h) — left-side seat | Art / colour (authored → runtime default theme) | Text |
|---|---|---|---|
| `bg_circle` avatar disc | (−250, −250, 500, 500) | `Circle` sprite, #000000 → **#1F75AA** (theme accent) | — |
| `U_Icon` avatar | (−199.5, −199.5, 399, 399), Mask (shows graphic) | avatar sprite (`pro_pic_*`), white | — |
| `Timer` radial | 399 Ø over the avatar | `Circle`, **Filled Radial360, origin Top, counter-clockwise**, #90F8B4 @ 59 % | — |
| `Bot_indcator` band | under U_Icon, masked to the circle; ends as a band over the avatar's bottom | `Circle` sliced, #000000 @ 63 % | "BOT" 70, white, NotoSans-Bold |
| `Name_bar` | (−1.5, −147.6, 1135.1, 295.2) — pivot at x 566 | `pot` 9-slice, PPU×3.24 (SOLANA pot) | `Name_txt` "NAME" auto 18–72, #BE9D9D → **#03174A**; `Amount_txt` stack, auto 18.1–122.1, white → **#03174A** |
| `D_Token` | (1048, −65.6, 131.2) circle at the bar's outer end | `Circle` #DC3132 + inner white circle 98.9 Ø | "D" / "S" / "B", 86.4, ink **#1F1F24** (`SeatView.RoleInk`) |
| `Bottom_bar` (status pill) | (179.25, −336.6, 845.4, 295.2) | `pot` 9-slice, PPU×5.36 | status "CHECK", auto 18–89.4, white → **#03174A** |
| `Hand` (strength) | moved at runtime (see §4.6) | `pot` sliced, **#000000**, PPU×14.97 | "PAIR" auto 18–89.4 white, left; "100%" 60 bold **#FF8F8F** with black underlay-stroke; bar track `Circle` white 640.9×35.4, fill colour from strength |
| `Win_Medal` | 613.2 Ø ring centred on the avatar + `Crown` 417.5×326.4 at the top-left, rotated 48° | `golden_ring`, `golden_crown` | — |
| `Mic` (inactive in prefab) | 189 Ø left of D token | `Circle` white @ 10 %, black inner, `unmute`/`mute` icons, 6 `Sound_bar` bars | — |
| `Circle_Num`, `Remove_Player` | inactive | — | — |

Fonts: every seat/pot/action-button label is **NotoSans-Bold** (`assets/fonts/Test/Font/NotoSans-Bold.ttf`,
TMP asset "NotoSans-Bold SDF": point size 90, line height 122.58, ascent 96.21, descent −26.37, atlas padding 9).
TMP `fontSize` equals CSS `font-size` in canvas units (multiply by `k` for px); TMP's line height is
`1.362 × fontSize`. "Auto size" = shrink between min and max until it fits the rect (TMP also wraps first when
wrapping is on). `"100%"` uses the `NotoSans-Bold SDF_Stroke` material: underlay ON, colour #000000, dilate 1,
offset 0 → a ~1 px black outline. Chat uses Lato-Black and LiberationSans.

9-slice sizes (Unity draws a border of `b` source px as `b · refPPU / (spritePPU · pixelsPerUnitMultiplier)`
canvas units; refPPU = spritePPU = 100 here). SOLANA `pot.png` borders (L, B, R, T) = 500, 406, 406, 415 px:

| Image | multiplier | border in canvas units (L, B, R, T) |
|---|---|---|
| `Name_bar` | 3.24 | 154.3, 125.3, 125.3, 128.1 |
| `Bottom_bar` | 5.36 | 93.3, 75.7, 75.7, 77.4 |
| `Pot_UI/…/bar` | 3.05 | 163.9, 133.1, 133.1, 136.1 |
| action buttons (`xxx_3.png`, 835/864/835/864) | 21 | 39.8, 41.1, 39.8, 41.1 |

For CSS `border-image-slice` use `sprites[key].borderExported` (the PNG is exported smaller than the source).

---

## 3. Pot (`Pot_UI.prefab`)

* `bar`: 1341.1 × 295.2 `pot` pill (PPU×3.05), centred on the canvas. It is a `Button` with **Animation**
  transition (`Pot_Bar.controller`).
* `bar/Text (TMP)`: the pot amount, 132.4, white → **#03174A**, centre. Text is `TableMoney.Pot(v)` =
  `v.ToString("N0")` ("1,250"), or "$1.25" on a SOL table. The authored "$0" is a placeholder.
* `HoverPanel` (POT / MINE breakdown, `-+` sprite plate) — **always hidden at the table**:
  `NomadTableHud.HidePotHoverPanel` switches it off every second.
* `PotView.messageText` and `TableView.boardView` are **not wired** → "Hand #N" / winner messages and the text
  board are not shown anywhere. The 3D chip piles (`Token_1..6` prefabs under `Token Parents`, 12 tokens max,
  0.09 spacing) and the win fly (`AwardTokensTo`: DOTween move+scale to 0.4×, 0.6 s, Ease.InQuad, 0.05 s
  stagger) belong to the 3D scene.

---

## 4. Behaviour and animations (methods → visuals)

All clips are 60 fps; keyframes are in `ui-anims.json`. Every Animator restarts at its default state when its
GameObject is (re)enabled, so "plays on enable" below means "plays every time `SetActive(true)` is called".

### 4.1 Seat appears — `TableView.BindSeat` / `ResetSeatForHand` → `gameObject.SetActive(true)`
`Name_Canvas.controller` → **`Name_Graphics_In`** (0.333 s, once). Right-side seats use
`New Animator Override Controller` which swaps in **`Name_Graphics_In_Right`** (same timing, mirrored x).
* `Graphics/bg_circle` scale 0 → **1.1414 at 0.25 s → 1 at 0.333 s** (pop with overshoot, ClampedAuto tangents).
* `Graphics/Name_bar` scale 0 until 0.233 s, 1 at 0.25 s; then it **slides out from behind the avatar**: width
  91.2 → 1135.1 and x 294.3 → 816.3 between 0.25 and 0.333 s (right seats: x −309.1 → −816.3, width 120.7 → 1135.1).
* `Pot_UI` and `Table_Canvas` carry the same controller but have no `Graphics/bg_circle` / `Graphics/Name_bar`
  paths → no visible effect.

`Bottom_bar` (`Bottom_bar.controller`) → **`Botton_name_Bar`** (0.433 s, once, on enable): scale 0 → 1 by
0.267 s while y drops −5 → −173 (0.417 s) → −189 (its rest position). The seat starts with every HUD hidden
(`TableView.Initialize → HideAllSeats`) so this plays when a player is first bound.

`Bot_indcator` (`Image.controller`) → **`Bot_Name`** (0.733 s, once, on enable / `SeatView.SetBot(true)`):
the band rises from the avatar's bottom edge — size 298×328 → 555×610 (0.5 s) → 522×574, y −327.9 → −469 → −451.

### 4.2 Turn — `TableView.SetTurn` → `SeatView.SetActiveTurn` + `StartTurnTimer(seconds, elapsed)`
* `VFX_Turn_Highlight` (particle ring ×2 + point light) is enabled — **particle VFX, not extractable**;
  imitate with a glowing ring around the avatar.
* `Timer` object is enabled. **Correction:** its Animator is *disabled* in `Name_Canvas.prefab` (`m_Enabled: 0`)
  and Test.unity does not override that, so `Timer.anim` (12 s colour ramp + blink) never plays. What Unity shows is
  `SeatView.RunTurnTimer` alone: `fillAmount = remaining / seconds`, a plain drain over the turn time (15 s single
  player) in constant #90F8B4 at 59 % alpha, resuming from `elapsed`. The web HUD implements exactly that.
* `StopTurnTimer` / `ClearTurn` hides `Timer`.

### 4.3 Action / status / chips
* `ShowAction`, `ShowBlind` → `SetStack` (`Amount_txt`, "N0"), `SetStatus` (Bottom_bar text, e.g. "Check",
  "Call 200", "Raise", "Fold", "Busted"; cleared at a new hand). No animation.
* **Fold** → `SetFolded(true)`: every Graphic under the seat (except the reaction bubble and the Hand panel) is
  re-coloured to `lum = .299r + .587g + .114b`, then × **0.242** (`foldedBrightness` in this scene), alpha kept.
  E.g. the themed name text #03174A → #060606, accent disc #1F75AA → #181818, white plate → #3E3E3E. Reset next hand.
* `SetRole` → `D_Token` visible with **"D"**, **"S"** (small blind), **"B"** (big blind); heads-up dealer+SB shows "D".
  Hidden for other seats.

### 4.4 Win — `ShowPotAward` → `SetWinner(true)`
`Win_Medal` enabled → `WinMedal.controller` → **`WinMedal_PopIn`** (0.38 s once): scale 0 → 1 by 0.133 s
(held to 0.183 s) and a z-wobble −12° → +8° (0.18 s) → −4° (0.3 s) → 0° (0.38 s). Child `VFX_Win`
(CFX3 rays + star burst particles) is not extractable. Hidden at the next `ResetForNewHand`.

### 4.5 River slam (5th board card, `SplineCardDealer` → `RiverSlamFeedback` MMF_Player)
Seat canvases have MoreMountains `MMPositionShaker` / `MMRotationShaker` on **channel 1**. The river feedback
fires "Name tag shake" (position, range 1.5, after 1.2 s, 2 s) and "Rotation Shake name tag" (rotation range 20°,
random direction, speed 1, after 1 s, 2 s) on channel 1 — every seat HUD wobbles for ~2 s, ~1 s after the river
lands. (Shaker defaults in `unity-hud.json → canvases[i].root.components.other`; feedback values read from the
scene's MMF_Player, approximate.)

### 4.6 Hand-strength panel (local seat only, `ShowHoleCards(faceUp)` → `ShowHandStrength`)
`Hand` is activated after its animator is destroyed, then parked under the name plate:
`x = Bottom_bar.anchoredPosition.x`, `y = min(Name_bar.y − 147.6, Bottom_bar.y − 147.6) − 73.8 − 8` (= −418.4).
Category text: "HIGH CARD" / "PAIR" pre-flop, then the evaluated hand ("TWO PAIR", "FLUSH", …). Percent =
`round(strength·100)%`. Fill width `max(12, track·strength)` grown from the left; colour lerps
**#DB2929 (0) → #FF941A (0.5) → #2EC747 (1)**. Updates on every board change; hidden with the hole cards.

### 4.7 Reactions — `TableView.ShowReaction(seat, id)` → `SeatView.ShowReaction(sprite, 3 s)`
A runtime-built `Reaction_Bubble` Image (360 × 360, preserveAspect, at (0, 415) above the avatar centre, drawn
last) shows `ReactionLibrary` sprite `id` (22 emotes, `unity-hud.json → reactions`). Pop: scale 0.6 → 1 over
**0.18 s** with ease-out-quad (`1 − (1 − k)²`, unscaled time), hold **3 s**, then hide. A new reaction
replaces the current one. Not greyed when folded.

### 4.8 Voice — `SetVoiceState(talking, muted)`
`Mic` (and its `PokerSeatMic`) is inactive in the prefab. When enabled: `mute` icon when muted, `Unmute` when not,
`Sound_Graph` while talking & not muted → `Sound_Graph_Anim` (0.5 s loop: six bars' heights bounce, e.g.
bar(1) 142 → 71 → 16 → 142). Local mic circle tint: live #339959 @ .95, muted #993838 @ .95, offline #595959 @ .8,
remote #FFFFFF @ .55.

### 4.9 Avatars
`AvatarLibrary` (19 sprites, `pro_pic_08 … pro_pic_026`): wire value N → sprite N−1. Unset (0) → FNV-1a-64 of the
player name (UTF-16 code units, offset 14695981039346656037, prime 1099511628211, as signed long, 0 → 1),
`(ulong)h % 19 + 1`. Exported at 512² (Unity imports them at 256²).

### 4.10 Screen buttons (`UI_Button.controller`, Button transition = Animation)
States are triggered by the Button's Normal/Highlighted/Pressed/Selected/Disabled triggers, cross-fading
0.08 s (Pressed 0.03 s, Disabled 0.10 s). Clips only set the plate `Image.m_Color` rgb:
**Normal 1.0, Highlighted 0.698 (#B2B2B2 multiply), Pressed: empty clip (write-defaults → authored white),
Selected = Normal clip, Disabled 0.396 (#656565)**. `BettingPanel` has no `root`, so the action buttons stay
visible and are only made non-interactable between turns — i.e. they sit in the **Disabled grey** until it is the
player's turn. Labels: `checkCall` = `Call` ("Check" / "Call 200"), `fold` = `Check/fold` ("Fold"),
`betRaise` = `Callany or raise` ("Bet" / "Raise"); TMP style **UPPERCASE**, NotoSans-Bold 34.27 auto (18–34.27).
Keyboard: F fold, C check/call, R bet/raise, Enter / keypad Enter confirm, Esc close, ↑ / = / keypad + step up,
↓ / − / keypad − step down (hold repeats after 0.4 s every 0.08 s), A all-in.

`Pot_Bar.controller` on the pot pill: Highlighted scale 1.04 (+ hover panel), Pressed scale 0.98 and tint
rgb(0.30, 0.78, 0.35), Disabled/Selected tint rgb(0.32, 0.40, 0.62); same trigger scheme (0.08/0.15/0.03/0.08/0.1 s).

### 4.11 Raise panel — `OnBetRaise` → `Confirm_Panel.SetActive(true)`
`ConfirmPanel.controller` → **`ConfirmPanel_In`** (0.24 s): scale 0.82 → 1.03 (0.16 s) → 1.0, CanvasGroup alpha
0 → 1 by 0.15 s. Contents: MIN / 1/4 / 1/2 / 3/4 / ALL IN preset buttons (150 × 45, label 22), slider (750.8 wide),
value box with −/+ steppers (`07.png` / `05.png`) and the amount, CONFIRM (235 × 86) and a round close (×).
Closed by Confirm/close/Esc or any action.

### 4.12 Other screen clips
`How_to_play.controller` (embedded clips): Open → `Selected` (window drops and grows: scale 0 → 0.85 in 0.033 s,
height 83.7 → 581.1 and y −110.9 → −322.3 over 0.167 s, alpha 0 → 1 in 0.033 s); Close → `Normal` (alpha 0).
`SettingsPanel.controller` (used by `CashOut_Panel`): Open/Close triggers cross-fade 0.28 s / 0.20 s between
"alpha 0, window scale 0.85, not interactable" and "alpha 1, scale 1".

### 4.13 Clips that are empty or not HUD
`Name_Graphics_Shake.anim`, `Card_Scale.anim`, `UI_Btn_Pressed.anim` have **no curves**.
`Card_Shake_Left/Right`, `Left_Rotate`, `Card_Scale` (`Card (1).controller`) animate the 3D card mesh.
`Face/*.anim` (`FaceExpressions.controller`, int `Expression`) drive the inactive 3D `Background/Smiley_Face`
SpriteRenderers (mouth/eyes/blush position+scale), **not** the seat avatars. All are still converted.

---

## 5. Runtime theme (ThemeManager, default pack)

`ThemeManager` is bootstrapped at runtime and applies the saved pack (default **Theme.Default = "SOLANA"**,
`Assets/Resources/ThemeLibrary.asset`) to the whole scene on load. Default pack values:

| | value |
|---|---|
| `buttonLabelColor` | **#03174A** |
| `accentColor` | **#1F75AA** |
| `pot` (capsule plate) | `SOLANA/pot.png` (sliced, 500/406/406/415) |
| `menuButton` (frame) | `SOLANA/xxx_3.png` (sliced, 835/864/835/864) |

What it changes on the table HUD (each node's merged result is in `unity-hud.json → node.themeDefault`):
* **Seats + pot (ApplyPotChrome, world space too):** `Name_bar`, `Bottom_bar`, `Pot_UI/…/bar` → pot sprite, white,
  sliced (multiplier kept); every label under them → #03174A (except the D token, which `SeatView` paints
  #1F1F24); `bg_circle` → #1F75AA.
* **Screen buttons (ApplyGameplayUi):** action buttons, raise-panel buttons, `Confirm_Panel` window, cash-out
  buttons, `AddBotButton` → `xxx_3` frame, white; their labels → #03174A; glyphs (× icon, + icon) → #03174A.
  −/+ steppers and slider fill/handle → accent #1F75AA (alpha kept). `Confirm_Panel/Value` rim → #03174A.
  `How_to_play` / `Setting` plates and `Ring` → `xxx_3`; their `icon` → #03174A; how-to-play window → pot plate.
* **Chat / reactions (ApplyChatAndReactionChrome):** toggles + unread badge → accent; chat window → frame;
  header/rows/presets/send → pot plate; chrome labels + typed text → #03174A, placeholder #03174A @ 55 %.
* World-space seat canvases are skipped by the generic button/frame passes (`ShouldSkipTheming`).
Other packs (NEON CITY, FOREST, DESERT, TOWN) are listed in `unity-hud.json → theme.packs` with their HUD sprites
copied (pot + frame) and their 3D art recorded as Unity paths only. A stake-skinned table can switch pack via
`ApplyTableSkin`.

---

## 6. What could not be extracted / caveats

* **Particle VFX** (`VFX_Turn_Highlight`, `VFX_Win`) and MoreMountains feedback players — listed, not converted.
* **Layout groups / content size fitters** are not re-run; the serialized (last editor) rects are used. This is
  exact for the seats, pot and action row, but chat inner rows serialise as 0×0.
* Theme overrides are a faithful re-implementation of `ThemeManager.cs` name/sprite rules, not a run of it.
* Missing art: sprite GUID `9d5675fa…` (inactive `How_to_play` duplicate + its `Ring`) and `4ef8107c…`
  (reaction tray icons 9–13, which `PokerReactionPanel` overwrites at runtime from the ReactionLibrary) are not in
  the project; Unity's built-in `Background` sprite (raise-panel slider track) can't be copied — use a 32×32
  white rounded rect with 10-px 9-slice borders (or CSS `border-radius`).
* PNGs are re-encoded at **2× Unity's import size** (Unity imports most HUD art at 256 px, a few at 2048), capped
  at 1024 px (512 px for emotes); rect/border data for both the source and the exported file are in `sprites{}`.
* `Name_Canvas_*` prefab placeholder texts ("NAME", "200$", "CHECK", "BOT") are never shown — seats stay hidden
  until bound.

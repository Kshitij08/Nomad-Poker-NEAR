# Particle effects in the shipped Unity game, and how to recreate them on the web

Research notes from 8 Nov 2026 (branch `web/unity-port`). Sources: the build scenes in
`ProjectSettings/EditorBuildSettings.asset` (`FusionSampleMenu_Game.unity`, `Test/Test.unity`, `Scenes/PokerUI.unity`),
resolved with `web/tools/lib/unity-yaml.mjs` `UnityProject` (prefab instances, variants and overrides expanded), plus
the C# that toggles them. World sizes are computed from the transform chain and the scaling mode. They have not been
checked against a Unity capture yet; get one before tuning.

## 1. What the player actually sees

**Summary:** the shipped game plays only **7 Shuriken ParticleSystems, in 3 effects**, all in `Test.unity` (the table):

| # | Effect | Systems | Trigger |
|---|---|---|---|
| A | Turn highlight (`VFX_Turn_Highlight`, per seat) | 3 (+ a point light that CFXR_Effect animates) | `TableView.SetTurn` → `SeatView.SetActiveTurn` |
| B | Win burst (`Win_Medal/VFX_Win`, per seat) | 3 | `TableView.ShowPotAward` → `SeatView.SetWinner(true)` |
| C | Impact smoke (`VFX_Impact_Smoke`) | 1 prefab, 2 live instances (Slot_4 turn card, Slot_5 river) | Slot_04 clip's `m_IsActive` key / the river-slam `MMF_Particles` |

There is also one C# "particle" effect without a ParticleSystem:

| # | Effect | Where | Trigger |
|---|---|---|---|
| D | `NomadSparkles` (pooled uGUI Images) | `LuckySlot_Win` / `LuckySlot_Lost` (PokerUI.unity) | `NomadSlotSpin` OnEnable / Spin / reel landings |

**Things that are not particles, or never play:**

- `FusionSampleMenu_Game.unity`: no ParticleSystem. The `Glow` objects there are static Images.
- `PokerUI.unity`: no ParticleSystem. `Fx_Sparkle_*`, `Fx_XpSparkle_*`, `Img_*Glow`, `Sparkle_0..5`, `Burst`,
  `CoinPile` and `FloorGlow` are **static Images** that get shown or hidden. For example, `NomadUiHost.PaintSlot` turns
  `WinBanner`/`CoinPile`/`Burst`/`Sparkle_*` on only after a spin that paid. The "Lucky Slot coins" are the static
  `CoinPile` image.
- Level-up celebration (`Resources/Retention/LevelUp panel ui.prefab`, `LevelUpPanel.cs`): coroutine tweens only
  (flash, ring, shake, letter drop). No ParticleSystem. It is already ported in `web/src/retention/screens/levelUpScreen.ts`.
- No UIParticle / Coffee package (`Packages/manifest.json` has only `com.unity.modules.particlesystem`), no VFX Graph,
  and no custom project shaders. Every `.shader`/`.shadergraph` belongs to JMO, TopDownEngine, TMP or the SDKs.
- `Slot5Feedback` (an MMF_Player in Test.unity, which also has an `MMF_Particles` on Slot_5's smoke): **unreachable**.
  No C# or scene reference plays it, and AutoPlayOnStart and AutoPlayOnEnable are both 0.
- Project-wide, the only prefabs with classId 198 outside JMO and TopDownEngine are `Test/Name_Canvas.prefab`
  (which nests `VFX_Turn_Highlight.prefab`), `Test/Prefabs/VFX_Turn_Highlight.prefab` and
  `Test/VFX/VFX_Impact_Smoke.prefab`. None of the 232 particle prefabs in JMO or TopDownEngine is referenced by a
  build scene, a project prefab, a `.asset` or `Resources.Load`. `FeedbackDemoSparks.prefab` is referenced only by
  `Test 4 Feel.unity`, which is not in the build. No C# creates a ParticleSystem at runtime.
- **Seat slot 5 (`Name_Canvas_Right`) never shows A or B.** Its scene SeatView has `winnerBadge: {fileID: 0}` and
  `turnHighlight: {fileID: 0}` (Test.unity, line ~27618). `Name_Canvas_Right (1)` and `(2)` are wired. The web
  `seatHud.ts` builds a highlight and a medal for every seat, so it differs from Unity there.

Render context: built-in pipeline, linear colour space, camera HDR on, PostProcessing v2 with LensDistortion only (no
bloom). Shipped quality: WebGL and Standalone default to "Fast", Android to "Fastest". Both have soft particles off
and `pixelLightCount 0`. CFXR "HDR" multipliers therefore only saturate (they clip at 1), and CFXR soft-particle fades
do nothing.

---

## 2. Effect A: turn highlight (`Name_Canvas*/Graphics/VFX_Turn_Highlight`)

- **Source:** `Assets/Test/Prefabs/VFX_Turn_Highlight.prefab`, nested in `Name_Canvas.prefab` /
  `Name_Canvas_Right.prefab`. The GameObject is inactive in the prefab.
- **Trigger:** `TableView.SetTurn(seat)` calls `SeatView.SetActiveTurn(i == slot)` for every seat, which calls
  `turnHighlight.SetActive(active)`. `ClearTurn` turns it off. Every system has `playOnAwake = 1`, so each turn
  start restarts the effect.
- **Transform:** the root has local scale 445.28 under the world-space canvas (scale 0.0022458), so its world scale is
  about 1.0. It is rotated −90° about X. Scaling mode is Hierarchy and the simulation space is Local for all three.
  For scale: the avatar disc (`bg_circle`, 500 canvas units) is **1.12 world units across**.
- **Sorting:** the renderers use order 0, and the seat canvas uses sort order 1, so the canvas draws on top. Only
  the parts outside the opaque avatar disc are visible.
- **CFXR_Effect** on the root: `clearBehavior = Disable`. It never fires, because the looping Rings keep
  `IsAlive(true)` true. `animatedLights` animates the `Point Light` child: type Point, colour #C344FF, range 10,
  render mode Auto. Intensity goes 1 → 4.57 linearly over 1 s and then snaps back, on a loop. Cards and chips use the
  Standard shader (lit). With `pixelLightCount 0` this is a per-vertex purple pulse on cards and chips near the active
  seat (not verified in a capture). `fadeOutReference` points to a missing object.

| System | Look and modules |
|---|---|
| `VFX_Turn_Highlight` (root): "orbiting glow dots" | Duration 1 s, **not looping**. Max 50. Emission: **burst of 50 at t0**, plus 2/s. Shape: Cone with angle 0, radius 0.14, thickness 1, rotation −90 X (a flat disc). Start: lifetime 1, speed 0, size 0.09, rotation random 0..2π, colour random #D555BC..#FF65E1. Velocity over lifetime: **orbital (1, 5, 0)**, speedModifier curve 0.2 → 1. Rotation over lifetime: random 0..0.873 rad/s. Size over lifetime: (0,0) → (0.776,0.962) → (1,0). Colour over lifetime: alpha 0 → 1 at 8% → 0. Renderer: Billboard, **pivot (10,0,0)**, which offsets each quad by 10× its size along its own rotated X axis. Rotation therefore spreads the 50 dots on a ring of radius ~0.87 × size curve, just outside the avatar edge (0.56). Material `cfxr proc glow soft hdr ab`: CFXR Particle Glow shader, procedural, no texture. Alpha = clamp(lerp(0, 2.19, 1 − 4r²), 0, 2). That gives a near-solid dot with a soft rim. Alpha blended (SrcAlpha / OneMinusSrcAlpha), HdrMultiply 6. **Looks like:** a ring of ~50 magenta dots that blooms out, swirls slightly and collapses within 1 s of the turn starting. |
| `Ring`: "expanding ripple" | Duration 0.4 s, **looping**. Max 5. Burst of 1 at t0 (one ring every 0.4 s, so 2–3 alive at once). Shape off. Start: lifetime 1, speed 0, size 0.8, colour white with alpha 0.8. Size over lifetime: (0,0.3) → (0.75,1). Colour over lifetime: rgb #5656FF at 0.15 → #FF65E1 at 0.7, alpha 0 → 1 at 0.5 → 0. Renderer: **Mesh** `cfxr ring mesh.asset` (26 verts, extent ±1, so the ring radius is 0.8 × size), View aligned, sortingFudge 1.5, custom vertex streams (Position, Normal, Color, UV, UV2, Custom1XYZW, Custom2XYZ, SizeX). **Custom Data 2** (vector): Ring Width = 2 × (1 → 0), Ring Smooth 0.1, Rotation 0. Material `cfxr proc ring hdr ab`: CFXR Procedural Ring shader. ringWidth = min(size, width). The inner edge is at (1 − w/size)², the outer edge at 1 − 0.07 (RingTopOffset), smoothed by smooth/size. HdrMultiply 4, alpha blended. **Looks like:** a blue disc that grows from radius 0.24 to 0.8 (it shows from behind the avatar once its radius passes 0.56), turns pink, hollows into a thinning ring and fades out, every 0.4 s. |
| `Ring (1)`: "steady halo" | Same as `Ring`, except: no size over lifetime (radius stays 0.8). Colour over lifetime: #FF65E1, alpha 0 → 1 (rising, then the particle dies). Ring Width = 2 (constant), so ringWidth = size and the ring is a **filled disc** with RingTopOffset 0.01 and HdrMultiply 1. **Looks like:** three overlapping pink discs, each fading in, sawtooth-pulsing at 2.5 Hz. Outside the avatar this reads as a pink halo band from radius 0.56 to 0.8. |

Textures: none. Both shaders are procedural. The ring mesh is
`Assets/JMO Assets/Cartoon FX Remaster/CFXR Assets/Meshes/cfxr ring mesh.asset`, a 13-segment strip with the inner
vertices pushed in by ringWidth in view space.

**Web today:** `web/src/hud/seatHud.ts` `buildHighlight()` draws three CSS `.u-turn-ring` divs in the DOM HUD. They are
500 canvas units across with a 16 px border and box-shadow glow, age `(t + i·0.4) % 1.2`, colours lerp
#5656FF → #FF65E1 → #C344FF (#C344FF is the light's colour), and they scale 1 → 1.28. There is no burst of orbiting
dots, no filled-disc halo, no shrink-then-hollow ring profile and no light pulse. The rings start at the avatar edge
(radius 0.56) instead of growing out from behind it, and they draw on every seat, including slot 5.

---

## 3. Effect B: win burst (`Name_Canvas*/Graphics/Win_Medal/VFX_Win`)

- **Source:** `Assets/Test/Name_Canvas.prefab` / `Name_Canvas_Right.prefab`. `Win_Medal` is an inactive Image
  (`Test/UI/Common_UI/golden_ring.png`, 613 canvas units = 1.38 world) with a `Crown` child and an Animator
  (`WinMedal_PopIn`).
- **Trigger:** `TableView.ShowPotAward` calls `SeatView.SetWinner(true)`, which calls `winnerBadge.SetActive(true)`.
  It is cleared at the next hand's `ResetSeatForHand`, so the looping parts **run for the whole showdown**. On a split
  pot, every winner lights up.
- **Transform:** `VFX_Win` sits at local (−2.65, 1, 0.63) canvas units (about 0 world) with scale 1.46. The children
  have scales 4.11 and 3.74. The world scale is 0.0033, but **scaling mode is Shape (2)** on all three, so the scale only
  affects emitter shapes. Sizes and speeds below are **world units**, unscaled. Simulation space is Local.
  Renderer order is 0, so the effect draws under the seat canvas (canvas order 1).
- **Materials:** Cartoon FX *legacy* materials on the built-in shader `{fileID: 200}`, which is Legacy Shaders/Particles
  (Additive). Colour is 2 × _TintColor × vertex colour × texture, added to the frame.

| System | Look and modules |
|---|---|
| `VFX_Win` (root): "golden halo pulse" | Duration 0.5 s, **looping**. Max 12. Culling: Always Simulate. Bursts: 1 at t0 and 1 at t0.12. Shape off. Start: lifetime 1, speed 0, **size 3**, colour #FFC400. Size over lifetime: 0 → 1 (linear). Colour over lifetime: alpha 1 → 0.977 at 0.63 → 0. A Sub Emitters module is enabled but its emitter is null, so it does nothing. Renderer: Billboard. Material `CFX3_CircleSoft ADDSOFT` (tint 1, .97, .97, .44). **Looks like:** soft golden discs swelling to 3 world units (about 2.2× the medal) and fading, 4 per second, so the glow pulses constantly. |
| `CFX3 Stars Burst`: "star spray" | Duration 0.6 s, **not looping** (plays once when the medal turns on). Max 45. Culling: Pause & Catch-up. Burst of 35 at t0. Shape: Sphere, radius 0.01. Start: lifetime random 0.2..0.6, speed random 3..6, size random 0.1..0.3, rotation random 0..2π, colour #FFC400, **gravity 0.4**. Velocity over lifetime: y = +1 in world space. Size over lifetime: 1 → 0. Colour over lifetime: alpha 0 → 1 at 0.2 → 0. Renderer: Billboard. Material `CFX3_GlowStar ADD` (tint alpha 0.5). **Looks like:** 35 golden star glints shooting out about 1–3 units in every direction, arcing slightly, shrinking. |
| `CFX3 Rays`: "spinning light rays" | Duration 0.6 s, **looping**. Max 40. Rate 50/s. Shape: Sphere, radius 0.01, thickness 1. Start: lifetime random 0.4..0.6, speed 0.01, size random 0.5..0.7, colour #FFC400. Size over lifetime: 0.5 → 1. Colour over lifetime: alpha 0 → 1 at 0.5 → 0. Renderer: **Stretched Billboard**, lengthScale 4, velocityScale 0. Each ray is about 4× its size long (1–2.8 units), pointing along a random direction from the centre. Material `CFX3_GlowSpike ADD` (tint ≈1, .996, .976, .5). **Looks like:** ~25 golden spikes radiating from the medal, flickering in and out. |

Textures (effective size is the importer `maxTextureSize`):

| Texture | Source size | Effective |
|---|---|---|
| `Assets/JMO Assets/Cartoon FX (legacy)/Textures/CFX3_T_CircleSoft.png` | 256×256 | **64×64** |
| `Assets/JMO Assets/Cartoon FX (legacy)/Textures/CFX3_T_GlowStar.png` | 128×128 | 128×128 |
| `Assets/JMO Assets/Cartoon FX (legacy)/Textures/CFX3_T_GlowSpike.png` | 256×128 | 256×128 |

**Web today:** not ported. `seatHud.ts` shows `Win_Medal` with the `WinMedal_PopIn` clip. The `VFX_Win` nodes exist in
`src/data/unity-hud.json`, but nothing renders them. Of the three effects, this is the largest gap in what players see.

---

## 4. Effect C: impact smoke (`Slot_4/VFX_Impact_Smoke`, `Slot_5/VFX_Impact_Smoke`)

- **Source:** `Assets/Test/VFX/VFX_Impact_Smoke.prefab`. Test.unity overrides `ShapeModule.type = 10` (Circle) and
  `radiusThickness = 1`. Each instance is rotated −90° about X, so it emits in the felt plane.
- **Slot_4 (turn card):** the GameObject is inactive and `playOnAwake = 1`. `Slot_04.anim` keys
  `VFX_Impact_Smoke:m_IsActive` 0 → 1 at 1.75 s (the card landing), so the smoke bursts when the clip turns it on.
- **Slot_5 (river):** `playOnAwake = 0`. `SplineCardDealer` turns Slot_5 on and calls
  `riverSlamFeedback.PlayFeedbacks()`. The `MMF_Particles` "Particles Play" feedback (Mode Play, InitialDelay 1.1,
  bound to Slot_5's system, StopSystemOnReset) bursts it.
- **Modules:** duration 2, not looping, Max 1000. Burst of 20 at t0. Shape: Circle, radius 0.0001, arc 360. Start:
  lifetime 0.3, speed 20, size random 0.2..0.5, rotation random 0..2π, white, gravity 0. Simulation space World.
  Limit Velocity: limit 1, dampen 0.3, drag 0.05 × size × velocity. Size over lifetime: (0,0) → (0.631,0.993) → (1,0).
  A Collision module is enabled, but all its planes are null, so it does nothing. Renderer: Billboard, order 6,
  maxParticleSize 0.5.
- **Material:** `cfxr ww smoke bright hdr ab` (CFXR Ubershader, `_ALPHABLEND_ON`, HdrMultiply 2, soft particles off at
  the shipped quality).
- **Texture:** `Assets/JMO Assets/Cartoon FX Remaster/CFXR Assets/Graphics/cfxr ww smoke bright.png`. Source 512×512,
  imported at **128** (WebGL override 256).

**Web today:** faithfully hand-ported. `web/src/three/impactSmoke.ts` covers the burst, the circle shape, limit
velocity and the size curve. `table/tableStage.ts` `watchActivationSmoke` handles Slot_4's activation edge, and
`table/riverSlam.ts` step 15 handles the river feedback. It uses one SpriteMaterial per puff, which is fine for 20
puffs. Small gaps:

- no maxParticleSize 0.5 screen clamp;
- HDR ×2 is not applied (it would clip anyway);
- the copied texture is the 512 px source, where Unity uses 128–256. It is 13 KB, so this does not matter.

---

## 5. Effect D: NomadSparkles (Lucky Slot)

`Assets/Scripts/Game/NomadUI/NomadSparkles.cs` is a pool of 80 uGUI Images using
`Assets/Art/common ui assets/Export/PNG/Decor_Sparkle.png` (136×136), palette gold, amber, white and ice blue.
Each sparkle:

- pops in to 1.15× in the first 20% of its life, then shrinks to 0.2×;
- fades in over the first 15% and smoothstep-fades out after 50%;
- spins at ±220°/s;
- loses speed with drag ×0.18 per second, under gravity of 60 px/s².

`NomadSlotSpin` drives it:

- **Win screen OnEnable:** a burst of 40, then a 2.2 s ambient twinkle. This runs every time `LuckySlot_Win` opens,
  including before a spin.
- **During a spin:** an ambient twinkle at 20/s.
- **Reel landing:** a burst of 10 per reel.
- **Jackpot:** bursts of 18, 34 and 18.

Unity binds `Btn_Spin` twice (to the host's `Spin` and to `NomadSlotSpin`'s own listener).

**Web today:** ported 1:1 as DOM in `web/src/retention/nomad/nomadSparkles.ts` and `nomadSlotSpin.ts`. `luckySlot.ts`
documents the double binding and deliberately runs a single spin. Nothing to do here.

---

## 6. How to recreate A and B (C and D are already done)

### Where to render

Render in the **three.js scene, parented to each seat's world-canvas transform**. Do not render in the DOM.

- The base WebGL canvas already sits under the DOM HUD. `three/hudDepth.ts` re-draws only opaque objects over the HUD,
  so transparent particles land *under* the seat canvas, which matches Unity's order 0 < canvas order 1.
- Perspective, billboarding and world-unit sizes then come out right without extra work.
- A DOM version would need `mix-blend-mode: plus-lighter` for the additive layers and gets expensive on phones
  (large composited layers).

### Option 1: generic "Shuriken-lite" (extractor + runtime)

**Extractor** (`web/tools/extract-vfx.mjs`, built on `UnityProject` and `buildHierarchy`): dump each listed
ParticleSystem and its renderer, material and custom-data settings to `src/data/vfx.json`. Keep MinMaxCurve and
MinMaxGradient raw (modes 0–3/4, keys). Copy and downscale the textures to `public/assets/vfx/`. This takes about
**1 day**, and it meets PORTING-RULES' "extract, don't hand-copy".

**Runtime:** CPU simulation (fewer than 200 particles in total) feeding **one InstancedBufferGeometry per system**.
Per-instance attributes: offset, size, rotation, colour, and a custom vec4. One draw call per system. The modules
these 7 systems actually use:

- **Main:** duration, looping, playOnAwake on enable, startDelay, lifetime/speed/size/rotation/colour MinMax, gravity,
  max particles, simulation space Local/World, scaling mode Hierarchy/Shape.
- **Emission:** rate over time and bursts.
- **Shape:** Circle, Cone (as a disc), Sphere, off.
- **Velocity over Lifetime:** linear (world), orbital, speedModifier curve.
- **Limit Velocity:** dampen, drag, multiply by size and velocity.
- **Size, Rotation and Colour over Lifetime.**
- **Custom Data:** vector 2.
- **Renderer:** Billboard with pivot, Stretched Billboard (lengthScale), Mesh (ring strip, View aligned).
  maxParticleSize is optional.
- **Materials (3 small ShaderMaterials):** textured additive (legacy ×2 tint), CFXR procedural glow, CFXR procedural
  ring (the vertex push and the two-smoothstep fragment from `CFXR_PASSES.cginc` lines 1010–1100). Optionally the
  textured alpha-blend for the smoke.

Not needed: noise, texture-sheet animation, trails, collision, sub-emitters, lights module, inherit velocity, and any
by-speed modules. The runtime should warn when an extracted system enables an unsupported module.

**Effort:** about 4–6 days in total (extractor 1, runtime and shaders 2–3, tuning against Unity captures 1–2).

- **Fidelity:** high. Unity's random streams are not reproduced, but the distributions match.
- **Phones:** cheap. About 7 draw calls at worst and fewer than 200 instances. The real cost is overdraw from B's
  3-unit halo and long rays, as in Unity.

### Option 2: per-effect hand recreations (as `impactSmoke.ts` did)

About 1–1.5 days each for A and B, so ~3 days, with numbers copied by hand. Fidelity is high if done carefully. It
cannot absorb new effects, and it goes against the "extract, don't hand-copy" rule. It makes sense only if A and B are
the last effects ever added.

### Option 3: libraries

| Library | Status (npm, Nov 2026) | Unity import | Fit |
|---|---|---|---|
| **three.quarks** | 0.17.1 (21 May 2026), active, MIT, ~1.2k★. **peer `three >= 0.182`**, while the port pins **0.170**. | The README claims Shuriken import. In practice the route is the babylon.quarks Unity Editor exporter to Quarks JSON (same format). Coverage is partial and not verified for CFXR custom data or procedural shaders. | It has the right model (Shuriken-like behaviours, BatchedRenderer, billboard / stretched / mesh / trail). Costs: a three.js upgrade with risk to cards, hudDepth and the lens pass; ~150 KB; the two CFXR procedural shaders still have to be written as custom materials. |
| **three-nebula** | 13.3.0 (19 Sep 2026), active again, MIT, three ≥ 0.122 | None (own JSON schema) | Generic initializer and behaviour model, not Shuriken. Every effect would need re-authoring by hand. |
| **@newkrok/three-particles** | 3.0.0 (Apr 2026), peer `three ^0.182` | "Unity-like" config, no importer | Same upgrade issue, and a smaller project. |
| Babylon NPE exporter (unity-npe-exporter, Mar 2026) | Babylon only | Shuriken → NPE, partial | Not applicable to three.js. |

**Verdict:** none of them removes the real work, which is the CFXR ring and glow shaders plus the Shape-scaling and
pivot quirks. three.quarks would also force a three.js major bump. Not recommended for 7 small systems.

### Option 4: bake in Unity (sprite sheets or video)

Record each effect with the Unity Recorder in an empty scene on black:

- **B** is purely additive, so it can be baked to an RGB sheet on black and blended additively. That needs no alpha
  video at all.
- **A**'s ring and glow are alpha blended, so they need RGBA frames.

Sheets of 32–48 frames at 256² come to roughly 1–3 MB each as PNG (less as KTX2/Basis). Video is worse: alpha WebM
works in Chrome and Firefox, Safari needs HEVC-alpha, and it brings decode cost.

- **Fidelity:** exact for the looping parts, but no randomness (visible repetition) and a fixed resolution.
- **Placement:** a camera-facing quad per seat, so the perspective stays right.
- **Effort:** ~1–2 days, plus someone with the Unity editor.
- **Phones:** one quad, but large textures in memory.

It is a reasonable fallback for B only if option 1 slips.

### Recommendation

**Option 1, scoped to the module list above.**

1. Write the extractor so all 7 systems come from data.
2. Build the runtime and the three shaders.
3. Ship **B** first, since it is not ported at all and is the most visible.
4. Then replace the CSS turn rings with **A**: dots, ripple ring, halo, and optionally a `PointLight` #C344FF pulsing
   1 → 4.57 over 1 s, because the web cards are MeshStandardMaterial.
5. Keep `impactSmoke.ts`. It is already faithful, and moving it onto the runtime later is optional.
6. Also match Unity's slot-5 gap (no A or B on `Name_Canvas_Right`), or record it as a deliberate deviation.

| Effect | Recommended approach | Fidelity | Effort | Perf on phones |
|---|---|---|---|---|
| A. Turn highlight: glow dots (burst 50, orbital, pivot ring) | Shuriken-lite + CFXR glow shader | High | Included in ~4–6 d (marginal ~0.5 d) | 1 draw, 50 instances, 1 s per turn: negligible |
| A. Turn highlight: Ring (expanding ripple) | Shuriken-lite Mesh mode + CFXR ring shader | High | Ring shader ~0.5–1 d | 1 draw, ≤3 instances: negligible |
| A. Turn highlight: Ring (1) (halo) | Shuriken-lite (same shader) | High | Free once Ring works | Negligible |
| A. Point light pulse | three.js PointLight driven by the same curve | Medium (Unity uses per-vertex lighting) | 0.25 d | One extra light on lit materials. Gate it to desktop if needed. |
| B. VFX_Win halo pulse | Shuriken-lite additive billboard (or bake, option 4) | High | Included (~0.5 d marginal) | Low count, but big additive quads: moderate overdraw |
| B. Stars Burst | Shuriken-lite additive billboard + gravity + world velocity | High | Included | Negligible (35, once) |
| B. Rays | Shuriken-lite stretched billboard | High | Included (~0.5 d for stretched mode) | ~25 long additive quads: moderate overdraw |
| C. Impact smoke (Slot_4, Slot_5) | Keep `impactSmoke.ts` (optionally migrate) | High (done) | 0 | 20 sprites: negligible |
| D. NomadSparkles | Keep DOM port | Exact (done) | 0 | ≤80 DOM nodes during the slot screen: fine |

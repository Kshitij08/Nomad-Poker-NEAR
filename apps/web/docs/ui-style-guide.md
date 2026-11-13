# Nomad Poker UI style guide (Redesign v2)

One look for the whole game: menus, dialogs and the table HUD. Tokens live on `:root` in `src/ui2/ui2.css`;
screen and HUD CSS uses them instead of literal colours. The room / table background art and the 3D table scene
(felt, cards, chips, deal animations) are kept as they are; everything drawn over them follows this guide.

## Tokens

| Group | Tokens |
|---|---|
| Background | `--v2-bg-top` #1a0f4a → `--v2-bg-mid` #2a1678 → `--v2-bg-bot` #160c42 (the galaxy, `.v2-bg`) |
| Surfaces | `--v2-panel` (panels), `--v2-deep` (chips, bars, fields), `--v2-dlg` (dialogs, sheets) |
| Lines | `--v2-line` (borders), `--v2-line2` (soft card borders), `--v2-accent` #7c6bff (focus, dialog border) |
| Text | `--v2-ink` #fff, `--v2-mut` (secondary), `--v2-mut2` (captions) |
| Meaning | `--v2-gold` (primary, currency), `--v2-good` (wins, success), `--v2-bad` (losses, errors) |
| Fills | `--v2-grad-gold / blue / violet / red / green / hot / sol`, text on gold `--v2-on-gold` |
| Radius | `--v2-r-sm` 0.5em (inner pills), `--v2-r-md` 0.8em (cards, tabs, fields), `--v2-r-lg` 1.2em (panels, dialogs), `--v2-r-pill` (buttons) |
| Spacing | `--v2-s1` 0.35em, `--v2-s2` 0.6em, `--v2-s3` 1em, `--v2-s4` 1.4em |

## Type

- **Fredoka** (700) for display only: screen title, dialog title, section title, the one primary CTA (`.v2-b.lg`), big numbers (stacks, pot).
- **Nunito** for everything else: body 700, labels 800, numbers 900 with `font-variant-numeric: tabular-nums`, captions 0.72em 900 caps with 0.1em tracking (`.v2-cap`).
- Phones: nothing renders under 11 px; body text at least 12 px.
- Sentence case everywhere, Title Case only on `.lg` primary buttons. Never all caps except `.v2-cap` captions and the logo.

## Buttons

| Role | Class | Use |
|---|---|---|
| Primary | `.v2-b.gold` (`.lg` for the one main CTA per view) | Sit down, Join, Claim, Save, Raise |
| Secondary | `.v2-b.blue` | Call/Check, Find, Copy |
| Social / agents | `.v2-b.violet` | With friends, Invite, Publish |
| Destructive | `.v2-b.red` | Fold, Leave, Sign out, Stop |
| Tertiary | `.v2-b.ghost` | Cancel, Close, Hide |
| Reward | `.v2-b.green` | Reward claims and "Get Coins" only |
| All-in | `.v2-b.hot` | All-in only |

Disabled: `opacity: .45`, no glow. Phones: every control at least 3.1em (~40 px) tall.

## Components

- **Page**: `.v2-page` → `topBar(title)` (Back left, title centred, coins right). The title matches the label of what opened it (dock label = screen title).
- **Mode**: the Demo / On-chain switch lives on the main menu header and in the profile popover; sub-screens show the mode as a pill, not a second switch.
- **Tabs vs segments vs chips**: `.v2-tab` for page sections, `.v2-seg` (`seg()` in `core.ts`) for 2–3 view modes, `.v2-chip` only for filters and options. No tabs inside tabs.
- **Tab icons**: screen-level tab bars that switch between sections (Shop, Agents, Tournaments) carry a colour art icon on every tab; tabs that filter or pick a period (Leaderboard, Missions, Friends) are labels only. Never mix colour art and one-colour glyphs in one row.
- **Dialog**: one system. v2 screens use `ui.openDialog / ui.message`; everything else (host dialogs, net, wallet, table Settings / Leave) goes through `globalDialogs` (`src/ui2/globalDialogs.ts`). `.v2-dim > .v2-dlg` with `.v2-dh` title, `.v2-db` body, `.v2-df` buttons (primary right). Bottom sheet in portrait.
- **Busy**: global dialog with a spinner and a ghost "Hide"; never blocks a dialog in use.
- **Toast**: `.v2-toast` top-centre, ~1.8 s, for confirmations (Copied, Registered, Saved).
- **Icons**: SVG from `src/ui2/icons.ts` only (no emoji, no text glyphs like ✎ ✕ ▾). Raster art only for currency, rewards, rooms, avatars and cards.
- **Empty / loading / error**: every list has all three; errors say what happened and what to do, never configuration or developer strings.

## Navigation

Back / Escape closes, in order: the dialog, the sheet or popover, then the screen (to where you came from). Overlays and router screens follow the same rule.

## Table HUD

Positions stay as the Unity layout (world-space seats and pot follow the camera; portrait rects keep their tests); the skin is v2: one purple skin on every table (no per-room tinting of HUD plates), dark seat plates with Fredoka stacks, a white-and-violet avatar border and a timer ring outside it, status chips (fold grey, call blue, raise gold, all-in hot), gold pot pill hidden at 0, action bar ordered Fold · Check/Call · Bet/Raise with LEAVE and settings never in that row. The action bar is a row of plates in the game's colours on every table (Fold red, Call blue, Raise gold, All-in hot; rooms don't tint it) and is shown only on your turn. In your last 5 seconds your plate and the row glow red and a beep sounds each second.

## Font and button style (decided)

Galaxy is the only theme, in a lighter version (lavender sky, violet glass panels; reference image in Art-Factory `art-out/nomad-poker/reference/`). The display font is **Fredoka** (700). Every button is a **plate**, like the table's name plates: a dark fill with a faint tint of its colour, a ring in that colour and a matching label (gold label on the primary). That covers menu buttons (`.v2-b`), table chrome (`.v2t-b`), the SOL panels (`.per-btn`), the Back chip and the table's action row; the rules are at the end of `src/ui2/ui2.css` and in `src/hud/v2hud.css`. The old "Design options" screenshots are in `docs/ui-options/` for reference.

## Menu art

The main menu shows the Unity loading-screen art with its logo painted out (`public/assets/menu/galaxy/menu_bg.webp`), darker on sub-pages; the home screen shows the real Nomad Poker logo (`nomad_poker_logo.webp`).

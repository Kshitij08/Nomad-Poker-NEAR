# Nomad Poker soft-2D art (review round 2, plus five round-3 icons)

Copied on 2026-11-13 from Art Factory, `D:\Work\Git\Art-Factory\art-out\nomad-poker\export` (source column is relative
to that folder). Colour art is the 512 px PNG export re-encoded as WebP (quality 90); the 1024 px PNG masters stay in
that export folder. Made with Codex image generation in the `soft-icon` style, then cut out, with saturation lowered
(8% overall, 20% in yellow-gold). Glyphs and the rotate icon are hand-written SVG.

Round 3 (2026-11-13): `ico_tourn_browse`, `ico_tourn_host`, `ico_tourn_code`, `ico_agent_history` and `ico_chips`, made the
same way (Codex, `soft-icon` style, `approved/ref/coin_raw.png` as the style reference), framed to 80% of the canvas and
toned like the rest (HSV saturation ×0.92, ×0.80 for yellow-gold hues).

## Where the code uses it

- **Colour icons and the reward chest**: `ART` in `src/ui2/icons.ts` maps icon keys to these files, and `ico(key)`
  draws them as an `<img class="v2-ico">`. Keys with no file here (`hex`, `sol`, `xlogo`, `crown`, and the one-colour
  glyphs) stay inline SVG. Mission rows pick their icon by mission kind (`src/ui2/screens/rewards.ts`), the agent
  playstyle picker uses the four `ico_style_*` icons, level badges use `ico_level_badge`, Gems use `ico_gem`, and
  the streak shield uses `ico_streak_shield`. `ico_crown` is not used: both crowns in the game are tinted in code.
  `src/ui2/screens/lobby.ts` preloads the dock icons.
- **Glyphs and `ico_rotate.svg`**: their bodies are copied into `ICO` in `src/ui2/icons.ts` (wrapped in a `<g>` with
  the file's stroke attributes) so they stay inline and take their element's colour. Edit both places together.
- **Shop art**: `SHOP_ART` in `src/ui2/screens/shop.ts`, by shop item id.
- **App icon and share image**: `index.html` (favicon 32/16, apple-touch-icon 180, `og:image` / `twitter:image`).
  There is no web manifest, so the 192/512/1024 files aren't referenced yet.
- **Card backs**: they replace the stand-in files that `src/theming/cardBack.ts` already loads. The old stand-ins are
  kept in Art Factory under `art-out/nomad-poker/replaced`.

The menu background was not replaced: the game keeps `assets/menu/galaxy/menu_bg.webp`.

| File (under public/) | Source | Size | What |
|---|---|---|---|
| `assets/ui2/icons/ico_agent.webp` | `icons/512/ico_agent.png` | 19 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_boost.webp` | `icons/512/ico_boost.png` | 18 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_cards.webp` | `icons/512/ico_cards.png` | 19 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_check.webp` | `icons/512/ico_check.png` | 20 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_coach.webp` | `icons/512/ico_coach.png` | 24 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_coin.webp` | `icons/512/ico_coin.png` | 21 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_crown.webp` | `icons/512/ico_crown.png` | 23 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_friends.webp` | `icons/512/ico_friends.png` | 18 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_gem.webp` | `icons/512/ico_gem.png` | 16 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_home.webp` | `icons/512/ico_home.png` | 18 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_leaderboard.webp` | `icons/512/ico_leaderboard.png` | 18 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_level_badge.webp` | `icons/512/ico_level_badge.png` | 17 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_lock.webp` | `icons/512/ico_lock.png` | 17 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_market.webp` | `icons/512/ico_market.png` | 22 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_mission_hothand.webp` | `icons/512/ico_mission_hothand.png` | 19 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_mission_pair.webp` | `icons/512/ico_mission_pair.png` | 19 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_mission_shuffle.webp` | `icons/512/ico_mission_shuffle.png` | 22 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_mission_tables.webp` | `icons/512/ico_mission_tables.png` | 22 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_missions.webp` | `icons/512/ico_missions.png` | 33 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_settings.webp` | `icons/512/ico_settings.png` | 24 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_shop.webp` | `icons/512/ico_shop.png` | 23 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_spin.webp` | `icons/512/ico_spin.png` | 25 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_streak.webp` | `icons/512/ico_streak.png` | 17 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_streak_shield.webp` | `icons/512/ico_streak_shield.png` | 22 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_style_autopilot.webp` | `icons/512/ico_style_autopilot.png` | 21 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_style_daredevil.webp` | `icons/512/ico_style_daredevil.png` | 26 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_style_guardian.webp` | `icons/512/ico_style_guardian.png` | 17 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_style_trapper.webp` | `icons/512/ico_style_trapper.png` | 21 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_themes.webp` | `icons/512/ico_themes.png` | 22 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_tournaments.webp` | `icons/512/ico_tournaments.png` | 27 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_twin.webp` | `icons/512/ico_twin.png` | 22 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_weekly.webp` | `icons/512/ico_weekly.png` | 24 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_xp.webp` | `icons/512/ico_xp.png` | 23 KB (512×512) | colour icon |
| `assets/ui2/icons/ico_tourn_browse.webp` | `icons/512/ico_tourn_browse.png` | 21 KB (512×512) | colour icon (round 3): Tournaments › Browse tab; not wired yet |
| `assets/ui2/icons/ico_tourn_host.webp` | `icons/512/ico_tourn_host.png` | 19 KB (512×512) | colour icon (round 3): Tournaments › Host tab; not wired yet |
| `assets/ui2/icons/ico_tourn_code.webp` | `icons/512/ico_tourn_code.png` | 23 KB (512×512) | colour icon (round 3): Tournaments › Join by code tab; not wired yet |
| `assets/ui2/icons/ico_agent_history.webp` | `icons/512/ico_agent_history.png` | 24 KB (512×512) | colour icon (round 3): Agents › History tab; not wired yet |
| `assets/ui2/icons/ico_chips.webp` | `icons/512/ico_chips.png` | 25 KB (512×512) | colour icon (round 3): pot chip stack at the table; not wired yet |
| `assets/ui2/shop/shop_coins_150k.webp` | `shop/512/shop_coins_150k.png` | 31 KB (512×512) | shop item art |
| `assets/ui2/shop/shop_coins_25k.webp` | `shop/512/shop_coins_25k.png` | 28 KB (512×512) | shop item art |
| `assets/ui2/shop/shop_coins_5k.webp` | `shop/512/shop_coins_5k.png` | 22 KB (512×512) | shop item art |
| `assets/ui2/shop/shop_coins_60k.webp` | `shop/512/shop_coins_60k.png` | 28 KB (512×512) | shop item art |
| `assets/ui2/shop/shop_level_up.webp` | `shop/512/shop_level_up.png` | 22 KB (512×512) | shop item art |
| `assets/ui2/shop/shop_xp_boost_1h.webp` | `shop/512/shop_xp_boost_1h.png` | 27 KB (512×512) | shop item art |
| `assets/ui2/shop/shop_xp_boost_24h.webp` | `shop/512/shop_xp_boost_24h.png` | 28 KB (512×512) | shop item art |
| `assets/ui2/shop/shop_xp_pack.webp` | `shop/512/shop_xp_pack.png` | 28 KB (512×512) | shop item art |
| `assets/ui2/rewards/slot_machine.webp` | `rewards/slot_machine.png` | 47 KB (880×937) | Daily spin machine (round 4): the reels sit in its three windows (entry.css `.v2-slot`); cut out by hand from the raw so the windows stay solid |
| `assets/ui2/icons/ico_slot.webp` | `icons/512/ico_slot.png` | 23 KB (512×512) | colour icon (round 4): the Daily spin dock icon (key `spin`) |
| `assets/ui2/rewards/reward_chest.webp` | `rewards/512/reward_chest.png` | 24 KB (512×512) | reward art |
| `assets/ui2/icons/ico_rotate.svg` | `icons/ico_rotate.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_back.svg` | `glyphs/glyph_back.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_calendar.svg` | `glyphs/glyph_calendar.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_chevron_down.svg` | `glyphs/glyph_chevron_down.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_chevron_up.svg` | `glyphs/glyph_chevron_up.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_close.svg` | `glyphs/glyph_close.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_code.svg` | `glyphs/glyph_code.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_dot.svg` | `glyphs/glyph_dot.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_edit.svg` | `glyphs/glyph_edit.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_eye.svg` | `glyphs/glyph_eye.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_minus.svg` | `glyphs/glyph_minus.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_more.svg` | `glyphs/glyph_more.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_next.svg` | `glyphs/glyph_next.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_phone.svg` | `glyphs/glyph_phone.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_plus.svg` | `glyphs/glyph_plus.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_share.svg` | `glyphs/glyph_share.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_spade.svg` | `glyphs/glyph_spade.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/glyphs/glyph_star.svg` | `glyphs/glyph_star.svg` | 1 KB | one-colour SVG, takes `currentColor` |
| `assets/ui2/app/app_icon_1024.png` | `app/app_icon_1024.png` | 822 KB (1024×1024) | app icon / favicon |
| `assets/ui2/app/app_icon_512.png` | `app/app_icon_512.png` | 238 KB (512×512) | app icon / favicon |
| `assets/ui2/app/app_icon_192.png` | `app/app_icon_192.png` | 43 KB (192×192) | app icon / favicon |
| `assets/ui2/app/app_icon_180.png` | `app/app_icon_180.png` | 39 KB (180×180) | app icon / favicon |
| `assets/ui2/app/app_icon_32.png` | `app/app_icon_32.png` | 2 KB (32×32) | app icon / favicon |
| `assets/ui2/app/app_icon_16.png` | `app/app_icon_16.png` | 1 KB (16×16) | app icon / favicon |
| `assets/ui2/app/og_share_1200x630.png` | `share/og_share_1200x630.png` | 840 KB (1200×630) | link share image |
| `assets/theming/cardbacks/nomad_free_back.webp` | `cards/nomad_free_back.png` | 12 KB (732×1024) | replaces the stand-in card back |
| `assets/theming/cardbacks/nomad_free_back_folded.webp` | `cards/nomad_free_back_folded.png` | 6 KB (732×1024) | replaces the stand-in card back |

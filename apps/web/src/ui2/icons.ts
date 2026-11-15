import { assetUrl } from '../hud/unityUi';

/** Redesign v2 icons (48 × 48 SVG bodies), from the Screen Atlas. `ico(name, sizeEm)` returns the icon markup. */
export const ICO: Record<string, string> = {
  spin: '<circle cx="24" cy="24" r="21" fill="#ffc21f"/><path d="M24 24V3a21 21 0 0 1 21 21z" fill="#ff4f7a"/><path d="M24 24v21A21 21 0 0 1 3 24z" fill="#4f8bff"/><circle cx="24" cy="24" r="21" fill="none" stroke="#fff" stroke-width="2"/><circle cx="24" cy="24" r="5" fill="#fff"/><path d="M20 0h8l-4 8z" fill="#fff"/>',
  cal: '<rect x="5" y="9" width="38" height="34" rx="6" fill="#fff"/><rect x="5" y="9" width="38" height="11" rx="5" fill="#ff4f7a"/><rect x="13" y="4" width="4" height="10" rx="2" fill="#5b2bd1"/><rect x="31" y="4" width="4" height="10" rx="2" fill="#5b2bd1"/><path d="M24 23l3 6 6.5.9-4.7 4.5 1.1 6.4L24 37.8l-5.9 3 1.1-6.4-4.7-4.5 6.5-.9z" fill="#ffc21f"/>',
  clip: '<rect x="8" y="7" width="32" height="38" rx="5" fill="#ffb547"/><rect x="12" y="12" width="24" height="29" rx="3" fill="#fff"/><rect x="17" y="3" width="14" height="8" rx="3" fill="#7b4fe0"/><path d="M16 21l3 3 5-6M16 32l3 3 5-6" stroke="#22c468" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="27" y="20" width="6" height="3" rx="1.5" fill="#c3bef0"/><rect x="27" y="31" width="6" height="3" rx="1.5" fill="#c3bef0"/>',
  friends: '<path d="M21 43c0-8.5 5.4-13.6 12.5-13.6S46 34.5 46 43z" fill="#1f4fd1"/><path d="M22.5 43c.4-7.4 5-11.8 11-11.8s10.6 4.4 11 11.8z" fill="#3d7bff"/><circle cx="33.5" cy="19" r="7.6" fill="#1f4fd1"/><circle cx="33.5" cy="18.4" r="6.4" fill="#5ea0ff"/><ellipse cx="31.3" cy="15.8" rx="2.4" ry="1.5" fill="#fff" opacity=".55"/><path d="M2 43c0-9.6 6.2-15.6 14.5-15.6S31 33.4 31 43z" fill="#5a2bc4"/><path d="M3.7 43c.5-8.4 5.8-13.4 12.8-13.4s12.3 5 12.8 13.4z" fill="#8a52f5"/><path d="M8 34c2-2.6 5-4 8.5-4" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".45" fill="none"/><circle cx="16.5" cy="16.5" r="8.8" fill="#5a2bc4"/><circle cx="16.5" cy="15.9" r="7.5" fill="#b88cff"/><ellipse cx="14" cy="12.8" rx="2.8" ry="1.7" fill="#fff" opacity=".6"/>',
  robot: '<circle cx="24" cy="6" r="4" fill="#ffc21f"/><rect x="22.5" y="9" width="3" height="6" fill="#c3bef0"/><rect x="6" y="14" width="36" height="28" rx="10" fill="#d8ccff"/><rect x="11" y="20" width="26" height="15" rx="7" fill="#2a1a6e"/><circle cx="18" cy="27.5" r="3.5" fill="#14f1c5"/><circle cx="30" cy="27.5" r="3.5" fill="#14f1c5"/><rect x="2" y="24" width="4" height="9" rx="2" fill="#b78cff"/><rect x="42" y="24" width="4" height="9" rx="2" fill="#b78cff"/>',
  podium: '<rect x="17" y="14" width="14" height="30" rx="2" fill="#ffc21f"/><rect x="3" y="24" width="14" height="20" rx="2" fill="#c9d3e6"/><rect x="31" y="29" width="14" height="15" rx="2" fill="#e09a5a"/><path d="M24 3.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L24 13.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#ffe27a" stroke="#e8890c" stroke-width="1" stroke-linejoin="round"/>',
  trophy: '<path d="M13 5h22v11a11 11 0 0 1-22 0z" fill="#ffc21f"/><path d="M13 9H6a7 7 0 0 0 9 9M35 9h7a7 7 0 0 1-9 9" stroke="#ffc21f" stroke-width="3" fill="none"/><rect x="21" y="26" width="6" height="8" fill="#e8890c"/><rect x="14" y="34" width="20" height="8" rx="2" fill="#8048f5"/>',
  bag: '<path d="M8 16h32l-3 27H11z" fill="#ff4fa3"/><path d="M17 18v-5a7 7 0 0 1 14 0v5" stroke="#ffc21f" stroke-width="3.5" fill="none"/><path d="M8 16h32l-1 7H9z" fill="#ff9ae0"/><path d="M24 26l2.4 4.8 5.3.8-3.8 3.7.9 5.3-4.8-2.5-4.8 2.5.9-5.3-3.8-3.7 5.3-.8z" fill="#ffe27a"/>',
  gear: '<path d="M38.2 17.8 L43.2 18.5 L43.2 29.5 L38.2 30.2 L38.4 29.6 L41.5 33.7 L33.7 41.5 L29.6 38.4 L30.2 38.2 L29.5 43.2 L18.5 43.2 L17.8 38.2 L18.4 38.4 L14.3 41.5 L6.5 33.7 L9.6 29.6 L9.8 30.2 L4.8 29.5 L4.8 18.5 L9.8 17.8 L9.6 18.4 L6.5 14.3 L14.3 6.5 L18.4 9.6 L17.8 9.8 L18.5 4.8 L29.5 4.8 L30.2 9.8 L29.6 9.6 L33.7 6.5 L41.5 14.3 L38.4 18.4Z" fill="#d8ccff" fill-rule="evenodd"/><circle cx="24" cy="24" r="6" fill="#271c6b"/><circle cx="24" cy="24" r="2.6" fill="#d8ccff"/>',
  coin: '<circle cx="24" cy="26" r="19" fill="#c06d00"/><circle cx="24" cy="23" r="19" fill="#ffc21f"/><circle cx="24" cy="23" r="14.5" fill="#ffd54a" stroke="#ffe9a0" stroke-width="2"/><path transform="translate(24 22.5) scale(1.25)" d="M0-6C-1.6-3.2-6-1.2-6 2a3.2 3.2 0 0 0 5.2 2.4L-1.8 7h3.6L.8 4.4A3.2 3.2 0 0 0 6 2C6-1.2 1.6-3.2 0-6z" fill="#c47a00"/>',
  near: '<circle cx="24" cy="24" r="21" fill="#0b0f14" stroke="#00ec97" stroke-width="2.5"/><path d="M15 34V14h3.5L30 28.5V14h3.5v20H30L18.5 19.5V34z" fill="#fff"/>',
  share: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 24 35 11M12 24l23 13"/><circle cx="36" cy="10.5" r="6" fill="currentColor" stroke="none"/><circle cx="12" cy="24" r="6" fill="currentColor" stroke="none"/><circle cx="36" cy="37.5" r="6" fill="currentColor" stroke="none"/></g>',
  bolt: '<path d="M28 2L8 27h13l-4 19 23-27H27z" fill="#ffe27a" stroke="#e8890c" stroke-width="2" stroke-linejoin="round"/>',
  xp: '<path d="M24 3l18 10.5v21L24 45 6 34.5v-21z" fill="#8a5cff"/><path d="M24 9l13 7.5v15L24 39l-13-7.5v-15z" fill="#d38cff"/><path d="M16 27l8-8 8 8M16 33l8-8 8 8" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>',
  cards: '<g transform="rotate(-14 16 26)"><rect x="6" y="11" width="20" height="28" rx="3" fill="#fff" stroke="#c3bef0"/><path transform="translate(16 25) scale(1)" d="M0-6C-1.6-3.2-6-1.2-6 2a3.2 3.2 0 0 0 5.2 2.4L-1.8 7h3.6L.8 4.4A3.2 3.2 0 0 0 6 2C6-1.2 1.6-3.2 0-6z" fill="#141414"/></g><g transform="rotate(12 31 24)"><rect x="21" y="9" width="20" height="28" rx="3" fill="#fff" stroke="#c3bef0"/><path transform="translate(31 23) scale(1.05)" d="M0 5.5C-3.5 2.6-6 .4-6-2.2A3.2 3.2 0 0 1 0-3.6 3.2 3.2 0 0 1 6-2.2C6 .4 3.5 2.6 0 5.5z" fill="#d3263a"/></g>',
  cal2: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="10" width="34" height="30" rx="6"/><path d="M7 20h34M16 5v8M32 5v8"/></g>',
  chev: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 18l13 13 13-13"/></g>',
  chevup: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 30l13-13 13 13"/></g>',
  code: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="9" width="36" height="30" rx="7"/><path d="M15 19.5h.01M24 19.5h.01M33 19.5h.01M15 28.5h.01M24 28.5h.01M33 28.5h.01"/></g>',
  spade: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 6C20 13.5 8 19 8 28a8 8 0 0 0 13.5 5.5L19 42h10l-2.5-8.5A8 8 0 0 0 40 28C40 19 28 13.5 24 6z" fill="currentColor" stroke-width="3"/></g>',
  crown: '<path d="M5 16l9 8 10-14 10 14 9-8-4 22H9z" fill="currentColor"/><rect x="9" y="38" width="30" height="5" rx="2" fill="currentColor"/>',
  shield: '<path d="M24 3l18 6v14c0 11-8 19-18 22C14 42 6 34 6 23V9z" fill="#5bb8ff"/><path d="M24 9l12 4v10c0 7-5 13-12 15-7-2-12-8-12-15V13z" fill="#2f6bff"/>',
  chest: '<rect x="5" y="20" width="38" height="22" rx="3" fill="#b5651d"/><path d="M5 20c0-9 8-14 19-14s19 5 19 14z" fill="#d9822b"/><rect x="5" y="20" width="38" height="4" fill="#ffc21f"/><rect x="20" y="18" width="8" height="10" rx="2" fill="#ffc21f"/><rect x="22.5" y="22" width="3" height="4" fill="#7a3d00"/>',
  eye: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 24s7-12 19-12 19 12 19 12-7 12-19 12S5 24 5 24z"/><circle cx="24" cy="24" r="5.5" fill="currentColor" stroke="none"/></g>',
  plus: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 9v30M9 24h30"/></g>',
  minus: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 24h30"/></g>',
  lock: '<rect x="9" y="21" width="30" height="22" rx="5" fill="#c3bef0"/><path d="M15 21v-6a9 9 0 0 1 18 0v6" stroke="#c3bef0" stroke-width="4.5" fill="none"/><circle cx="24" cy="31" r="3.5" fill="#271c6b"/>',
  check: '<circle cx="24" cy="24" r="20" fill="#22c468"/><path d="M14 24l7 7 13-14" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  twin: '<circle cx="17" cy="20" r="11" fill="#b78cff"/><circle cx="31" cy="20" r="11" fill="#14f1c5" opacity=".85"/><path d="M4 44c0-9 6-14 13-14s13 5 13 14z" fill="#8048f5"/><path d="M18 44c0-9 6-14 13-14s13 5 13 14z" fill="#0fbf9a" opacity=".85"/>',
  store: '<path d="M6 18l4-11h28l4 11z" fill="#ff4f7a"/><path d="M6 18h36v4a6 6 0 0 1-12 0 6 6 0 0 1-12 0 6 6 0 0 1-12 0z" fill="#ff9ae0"/><rect x="9" y="26" width="30" height="17" rx="2" fill="#fff"/><rect x="20" y="31" width="8" height="12" fill="#8048f5"/>',
  coach: '<circle cx="24" cy="15" r="9" fill="#ffb547"/><path d="M8 44c0-10 7-16 16-16s16 6 16 16z" fill="#2f6bff"/><rect x="15" y="9" width="18" height="4" rx="2" fill="#7b4fe0"/><circle cx="36" cy="34" r="6" fill="#ffc21f"/><path d="M36 30v4h3" stroke="#7a4a00" stroke-width="2" fill="none"/>',
  hex: '<path d="M24 3l18 10.5v21L24 45 6 34.5v-21z" fill="#6a35e0"/><path d="M24 7l15 8.7v16.6L24 41 9 32.3V15.7z" fill="#a77bff"/><path d="M24 7l15 8.7v5L24 12 9 20.7v-5z" fill="#fff" opacity=".3"/>',
  palette: '<path d="M24 4C12 4 4 13 4 23c0 9 7 15 13 15 3 0 3-3 2-5s0-5 4-5h6c8 0 15-5 15-12C44 9 35 4 24 4z" fill="#ffd27a"/><circle cx="14" cy="19" r="3.5" fill="#ff4f7a"/><circle cx="22" cy="12" r="3.5" fill="#4f8bff"/><circle cx="32" cy="13" r="3.5" fill="#22c468"/><circle cx="37" cy="21" r="3.5" fill="#8048f5"/>',
  edit: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M31 8l9 9-22 22H9v-9z"/><path d="M25 14l9 9"/></g>',
  next: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9l15 15-15 15"/></g>',
  more: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="24" r="4.5" fill="currentColor" stroke="none"/><circle cx="24" cy="24" r="4.5" fill="currentColor" stroke="none"/><circle cx="38" cy="24" r="4.5" fill="currentColor" stroke="none"/></g>',
  flame: '<path d="M24 3c3 9 14 13 14 26a14 14 0 0 1-28 0c0-7 4-11 7-14 0 5 2 8 5 9-2-8 0-15 2-21z" fill="#ff8a3d"/><path d="M24 24c2 4 7 6 7 12a7 7 0 0 1-14 0c0-4 3-7 7-12z" fill="#ffd54a"/>',
  star: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M24.0 8.5L28.7 19.0L40.2 20.2L31.6 28.0L34.0 39.3L24.0 33.5L14.0 39.3L16.4 28.0L7.8 20.2L19.3 19.0z" fill="currentColor" stroke-width="4"/></g>',
  dot: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="10" fill="currentColor" stroke="none"/></g>',
  back: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M30 9 15 24l15 15"/></g>',
  close: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12l24 24M36 12 12 36"/></g>',
  home: '<path d="M6 22L24 7l18 15v19a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" fill="#a77bff"/><rect x="19" y="29" width="10" height="15" rx="2" fill="#2a1678"/>',
  xlogo: '<path d="M7 6h10.5L41 42H30.5z" fill="currentColor"/><path d="M37.5 6h4.5L12 42H7.5z" fill="currentColor"/>',
  phone: '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="5" width="20" height="38" rx="5"/><path d="M24 35.5h.01"/></g>',
  rotate: '<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="18" y="13" width="12" height="22" rx="3.5" transform="rotate(-30 24 24)"/><path d="M30.0 5.5A19.5 19.5 0 0 1 43.3 21.3M43.3 21.3l-5.8 -3.0M43.3 21.3l2.6 -6.0"/><path d="M18.0 42.5A19.5 19.5 0 0 1 4.7 26.7M4.7 26.7l5.8 3.0M4.7 26.7l-2.6 6.0"/></g>',
};

/**
 * Soft-2D colour art (public/assets/ui2/, see its MANIFEST.md), keyed like ICO: these keys draw as an <img> instead
 * of inline SVG. The art fills about 80% of its square canvas. Keys left in ICO only (hex, sol, xlogo, crown and the
 * currentColor glyphs) stay inline SVG so they keep taking their element's colour.
 */
export const ART: Record<string, string> = {
  spin: 'icons/ico_slot', // the Daily spin is a slot machine (was the wheel, icons/ico_spin)
  cal: 'icons/ico_weekly',
  clip: 'icons/ico_missions',
  friends: 'icons/ico_friends',
  robot: 'icons/ico_agent',
  podium: 'icons/ico_leaderboard',
  trophy: 'icons/ico_tournaments',
  bag: 'icons/ico_shop',
  gear: 'icons/ico_settings',
  store: 'icons/ico_market',
  home: 'icons/ico_home',
  coin: 'icons/ico_coin',
  xp: 'icons/ico_xp',
  bolt: 'icons/ico_boost',
  cards: 'icons/ico_cards',
  shield: 'icons/ico_streak_shield',
  flame: 'icons/ico_streak',
  lock: 'icons/ico_lock',
  check: 'icons/ico_check',
  twin: 'icons/ico_twin',
  coach: 'icons/ico_coach',
  palette: 'icons/ico_themes',
  chest: 'rewards/reward_chest',
  // Keys with no SVG stand-in.
  gem: 'icons/ico_gem',
  level: 'icons/ico_level_badge',
  'mission-shuffle': 'icons/ico_mission_shuffle',
  'mission-hothand': 'icons/ico_mission_hothand',
  'mission-tables': 'icons/ico_mission_tables',
  'mission-pair': 'icons/ico_mission_pair',
  'style-autopilot': 'icons/ico_style_autopilot',
  'style-guardian': 'icons/ico_style_guardian',
  'style-trapper': 'icons/ico_style_trapper',
  'style-daredevil': 'icons/ico_style_daredevil',
  // Round 3 (tab icons and the pot).
  'tourn-browse': 'icons/ico_tourn_browse',
  'tourn-host': 'icons/ico_tourn_host',
  'tourn-code': 'icons/ico_tourn_code',
  'agent-history': 'icons/ico_agent_history',
  chips: 'icons/ico_chips',
};

/** URL of a soft-2D art file under assets/ui2/ (path without extension). */
export const ui2Art = (path: string): string => assetUrl(`assets/ui2/${path}.webp`);

/** Starts loading and decoding art icons ahead of first use (the main menu's dock would otherwise pop in). */
export function preloadArt(keys: readonly string[]): void {
  if (typeof Image === 'undefined') return;
  for (const k of keys) {
    const art = ART[k];
    if (!art) continue;
    const img = new Image();
    img.src = ui2Art(art);
    img.decode?.().catch(() => {});
  }
}

/**
 * An icon: an <img> for keys with soft-2D art, else inline SVG. `size` in em; `style` is extra inline CSS (e.g. a
 * colour for currentColor icons; colour does nothing on the art).
 */
export function ico(name: string, size = 2.4, style = ''): string {
  const art = ART[name];
  if (art) return `<img class="v2-ico" src="${ui2Art(art)}" alt="" draggable="false" decoding="async" style="width:${size}em;height:${size}em;${style}">`;
  return `<svg class="v2-ico" viewBox="0 0 48 48" aria-hidden="true" style="width:${size}em;height:${size}em;${style}">${ICO[name] ?? ''}</svg>`;
}

/** A small stack of coins (shop and reward art). */
export function coinStack(n = 3, s = 2.4): string {
  const w = s + (n - 1) * s * 0.38;
  const h = s + (n - 1) * 0.35;
  let out = '';
  for (let i = 0; i < n; i++) out += `<span style="position:absolute;left:${i * s * 0.38}em;top:${(n - 1 - i) * 0.35}em">${ico('coin', s)}</span>`;
  return `<span class="v2-coins" style="width:${w}em;height:${h}em">${out}</span>`;
}

/** A decorative poker chip (main-menu tile art). */
export function chipArt(color: string, x: number, y: number, s = 3.2, r = 0): string {
  return `<i class="v2-gchip" style="--c:${color};left:${x}em;top:${y}em;width:${s}em;height:${s}em;transform:rotate(${r}deg)"></i>`;
}

/** A playing card face ("A♠"), back (''), or empty slot ('_'). */
export function card(s: string, cls = ''): string {
  if (!s) return `<i class="v2-cd bk ${cls}"></i>`;
  if (s === '_') return `<i class="v2-cd sl ${cls}"></i>`;
  return `<i class="v2-cd ${/[♥♦]/.test(s) ? 'r' : ''} ${cls}">${s}</i>`;
}

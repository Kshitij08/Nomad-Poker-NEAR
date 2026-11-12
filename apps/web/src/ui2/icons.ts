/** Redesign v2 icons (48 × 48 SVG bodies), from the Screen Atlas. `ico(name, sizeEm)` returns inline SVG markup. */
export const ICO: Record<string, string> = {
  spin: '<circle cx="24" cy="24" r="21" fill="#ffc21f"/><path d="M24 24V3a21 21 0 0 1 21 21z" fill="#ff4f7a"/><path d="M24 24v21A21 21 0 0 1 3 24z" fill="#4f8bff"/><circle cx="24" cy="24" r="21" fill="none" stroke="#fff" stroke-width="2"/><circle cx="24" cy="24" r="5" fill="#fff"/><path d="M20 0h8l-4 8z" fill="#fff"/>',
  cal: '<rect x="5" y="9" width="38" height="34" rx="6" fill="#fff"/><rect x="5" y="9" width="38" height="11" rx="5" fill="#ff4f7a"/><rect x="13" y="4" width="4" height="10" rx="2" fill="#5b2bd1"/><rect x="31" y="4" width="4" height="10" rx="2" fill="#5b2bd1"/><path d="M24 23l3 6 6.5.9-4.7 4.5 1.1 6.4L24 37.8l-5.9 3 1.1-6.4-4.7-4.5 6.5-.9z" fill="#ffc21f"/>',
  clip: '<rect x="8" y="7" width="32" height="38" rx="5" fill="#ffb547"/><rect x="12" y="12" width="24" height="29" rx="3" fill="#fff"/><rect x="17" y="3" width="14" height="8" rx="3" fill="#7b4fe0"/><path d="M16 21l3 3 5-6M16 32l3 3 5-6" stroke="#22c468" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="27" y="20" width="6" height="3" rx="1.5" fill="#c3bef0"/><rect x="27" y="31" width="6" height="3" rx="1.5" fill="#c3bef0"/>',
  friends: '<circle cx="17" cy="16" r="8" fill="#b78cff"/><circle cx="33" cy="18" r="7" fill="#5bb8ff"/><path d="M3 42c0-9 6-15 14-15s14 6 14 15z" fill="#8048f5"/><path d="M22 42c1-8 5-13 11-13s11 5 11 13z" fill="#2f6bff"/>',
  robot: '<circle cx="24" cy="6" r="4" fill="#ffc21f"/><rect x="22.5" y="9" width="3" height="6" fill="#c3bef0"/><rect x="6" y="14" width="36" height="28" rx="10" fill="#d8ccff"/><rect x="11" y="20" width="26" height="15" rx="7" fill="#2a1a6e"/><circle cx="18" cy="27.5" r="3.5" fill="#14f1c5"/><circle cx="30" cy="27.5" r="3.5" fill="#14f1c5"/><rect x="2" y="24" width="4" height="9" rx="2" fill="#b78cff"/><rect x="42" y="24" width="4" height="9" rx="2" fill="#b78cff"/>',
  podium: '<rect x="17" y="12" width="14" height="32" rx="2" fill="#ffc21f"/><rect x="3" y="22" width="14" height="22" rx="2" fill="#c9d3e6"/><rect x="31" y="28" width="14" height="16" rx="2" fill="#e09a5a"/><text x="24" y="27" font-size="11" font-weight="900" text-anchor="middle" fill="#7a4a00">1</text>',
  trophy: '<path d="M13 5h22v11a11 11 0 0 1-22 0z" fill="#ffc21f"/><path d="M13 9H6a7 7 0 0 0 9 9M35 9h7a7 7 0 0 1-9 9" stroke="#ffc21f" stroke-width="3" fill="none"/><rect x="21" y="26" width="6" height="8" fill="#e8890c"/><rect x="14" y="34" width="20" height="8" rx="2" fill="#8048f5"/>',
  bag: '<path d="M8 16h32l-3 27H11z" fill="#ff4fa3"/><path d="M17 18v-5a7 7 0 0 1 14 0v5" stroke="#ffc21f" stroke-width="3.5" fill="none"/><path d="M8 16h32l-1 7H9z" fill="#ff9ae0"/><path d="M24 26l2.4 4.8 5.3.8-3.8 3.7.9 5.3-4.8-2.5-4.8 2.5.9-5.3-3.8-3.7 5.3-.8z" fill="#ffe27a"/>',
  gear: '<circle cx="24" cy="24" r="14" fill="none" stroke="#d8ccff" stroke-width="8" stroke-dasharray="6.5 4.5"/><circle cx="24" cy="24" r="10" fill="#d8ccff"/><circle cx="24" cy="24" r="4.5" fill="#271c6b"/>',
  coin: '<circle cx="24" cy="26" r="19" fill="#c06d00"/><circle cx="24" cy="23" r="19" fill="#ffc21f"/><circle cx="24" cy="23" r="14" fill="none" stroke="#ffe27a" stroke-width="2"/><path d="M24 13l3 6h-6zM20 21h8l-4 11z" fill="#c47a00"/>',
  sol: '<circle cx="24" cy="24" r="21" fill="#140b35"/><path d="M15 14h22l-4 4H11z" fill="#14f195"/><path d="M15 22h22l4 4H19z" fill="#7ad7c0"/><path d="M15 30h22l-4 4H11z" fill="#9945ff"/>',
  share: '<circle cx="36" cy="10" r="6" fill="currentColor"/><circle cx="12" cy="24" r="6" fill="currentColor"/><circle cx="36" cy="38" r="6" fill="currentColor"/><path d="M12 24L36 10M12 24l24 14" stroke="currentColor" stroke-width="4"/>',
  bolt: '<path d="M28 2L8 27h13l-4 19 23-27H27z" fill="#ffe27a" stroke="#e8890c" stroke-width="2" stroke-linejoin="round"/>',
  xp: '<path d="M24 3l18 10.5v21L24 45 6 34.5v-21z" fill="#8a5cff"/><path d="M24 9l13 7.5v15L24 39l-13-7.5v-15z" fill="#d38cff"/><text x="24" y="28.5" font-size="11" font-weight="900" text-anchor="middle" fill="#fff">XP</text>',
  cards: '<g transform="rotate(-14 16 26)"><rect x="6" y="11" width="20" height="28" rx="3" fill="#fff" stroke="#c3bef0"/><text x="16" y="30" font-size="11" font-weight="900" fill="#141414" text-anchor="middle">A♠</text></g><g transform="rotate(12 31 24)"><rect x="21" y="9" width="20" height="28" rx="3" fill="#fff" stroke="#c3bef0"/><text x="31" y="28" font-size="11" font-weight="900" fill="#d3263a" text-anchor="middle">A♥</text></g>',
  cal2: '<rect x="6" y="9" width="36" height="33" rx="5" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M6 18h36M15 4v9M33 4v9" stroke="currentColor" stroke-width="3.5"/>',
  chev: '<path d="M12 18l12 12 12-12" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  chevup: '<path d="M12 30l12-12 12 12" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  code: '<rect x="5" y="8" width="38" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M13 20h4M13 28h4M22 20h4M22 28h4M31 20h4M31 28h4" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>',
  spade: '<path d="M24 4C20 12 6 18 6 28a9 9 0 0 0 15 6l-3 10h12l-3-10a9 9 0 0 0 15-6C42 18 28 12 24 4z" fill="currentColor"/>',
  crown: '<path d="M5 16l9 8 10-14 10 14 9-8-4 22H9z" fill="currentColor"/><rect x="9" y="38" width="30" height="5" rx="2" fill="currentColor"/>',
  shield: '<path d="M24 3l18 6v14c0 11-8 19-18 22C14 42 6 34 6 23V9z" fill="#5bb8ff"/><path d="M24 9l12 4v10c0 7-5 13-12 15-7-2-12-8-12-15V13z" fill="#2f6bff"/>',
  chest: '<rect x="5" y="20" width="38" height="22" rx="3" fill="#b5651d"/><path d="M5 20c0-9 8-14 19-14s19 5 19 14z" fill="#d9822b"/><rect x="5" y="20" width="38" height="4" fill="#ffc21f"/><rect x="20" y="18" width="8" height="10" rx="2" fill="#ffc21f"/><rect x="22.5" y="22" width="3" height="4" fill="#7a3d00"/>',
  eye: '<path d="M3 24s8-13 21-13 21 13 21 13-8 13-21 13S3 24 3 24z" fill="none" stroke="currentColor" stroke-width="3.5"/><circle cx="24" cy="24" r="6" fill="currentColor"/>',
  plus: '<path d="M24 8v32M8 24h32" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>',
  lock: '<rect x="9" y="21" width="30" height="22" rx="5" fill="#c3bef0"/><path d="M15 21v-6a9 9 0 0 1 18 0v6" stroke="#c3bef0" stroke-width="4.5" fill="none"/><circle cx="24" cy="31" r="3.5" fill="#271c6b"/>',
  check: '<circle cx="24" cy="24" r="20" fill="#22c468"/><path d="M14 24l7 7 13-14" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  twin: '<circle cx="17" cy="20" r="11" fill="#b78cff"/><circle cx="31" cy="20" r="11" fill="#14f1c5" opacity=".85"/><path d="M4 44c0-9 6-14 13-14s13 5 13 14z" fill="#8048f5"/><path d="M18 44c0-9 6-14 13-14s13 5 13 14z" fill="#0fbf9a" opacity=".85"/>',
  store: '<path d="M6 18l4-11h28l4 11z" fill="#ff4f7a"/><path d="M6 18h36v4a6 6 0 0 1-12 0 6 6 0 0 1-12 0 6 6 0 0 1-12 0z" fill="#ff9ae0"/><rect x="9" y="26" width="30" height="17" rx="2" fill="#fff"/><rect x="20" y="31" width="8" height="12" fill="#8048f5"/>',
  coach: '<circle cx="24" cy="15" r="9" fill="#ffb547"/><path d="M8 44c0-10 7-16 16-16s16 6 16 16z" fill="#2f6bff"/><rect x="15" y="9" width="18" height="4" rx="2" fill="#7b4fe0"/><circle cx="36" cy="34" r="6" fill="#ffc21f"/><path d="M36 30v4h3" stroke="#7a4a00" stroke-width="2" fill="none"/>',
  hex: '<path d="M24 3l18 10.5v21L24 45 6 34.5v-21z" fill="#6a35e0"/><path d="M24 7l15 8.7v16.6L24 41 9 32.3V15.7z" fill="#a77bff"/><path d="M24 7l15 8.7v5L24 12 9 20.7v-5z" fill="#fff" opacity=".3"/>',
  palette: '<path d="M24 4C12 4 4 13 4 23c0 9 7 15 13 15 3 0 3-3 2-5s0-5 4-5h6c8 0 15-5 15-12C44 9 35 4 24 4z" fill="#ffd27a"/><circle cx="14" cy="19" r="3.5" fill="#ff4f7a"/><circle cx="22" cy="12" r="3.5" fill="#4f8bff"/><circle cx="32" cy="13" r="3.5" fill="#22c468"/><circle cx="37" cy="21" r="3.5" fill="#8048f5"/>',
  back: '<path d="M30 8L14 24l16 16" stroke="currentColor" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M12 12l24 24M36 12L12 36" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>',
  home: '<path d="M6 22L24 7l18 15v19a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" fill="#a77bff"/><rect x="19" y="29" width="10" height="15" rx="2" fill="#2a1678"/>',
  phone: '<rect x="14" y="3" width="20" height="42" rx="4" fill="none" stroke="currentColor" stroke-width="3.5"/><circle cx="24" cy="39" r="2" fill="currentColor"/>',
};

/** Inline SVG icon. `size` in em; `style` is extra inline CSS (e.g. a colour for currentColor icons). */
export function ico(name: string, size = 2.4, style = ''): string {
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

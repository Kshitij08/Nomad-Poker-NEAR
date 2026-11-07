// filmstrips: unity row over web row for each sweep; plus best-match lag per unity frame
const sharp = require('sharp'); const fs = require('fs'); const path = require('path');
const OUT = process.argv[2];
const R = { flop: { left: 380, top: 170, width: 520, height: 260 }, river: { left: 0, top: 0, width: 1280, height: 720 }, ret: { left: 300, top: 60, width: 680, height: 560 } };
const kinds = [['flop', 'flop', 0, 60, 6, 0.42], ['river', 'river', 50, 110, 6, 0.2], ['return', 'ret', 0, 60, 6, 0.3]];
const get = async (p, r, sc) => sharp(p).extract(r).resize(Math.round(r.width * sc), Math.round(r.height * sc)).png().toBuffer();
const raw = async (p, r) => sharp(p).removeAlpha().extract(r).resize(Math.round(r.width / 2), Math.round(r.height / 2)).raw().toBuffer();
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
(async () => {
  for (const [name, rk, a, b, step, sc] of kinds) {
    const r = R[rk]; const w = Math.round(r.width * sc), h = Math.round(r.height * sc);
    const frames = []; for (let f = a; f <= b; f += step) frames.push(f);
    const comps = [];
    for (let i = 0; i < frames.length; i++) {
      const f = String(frames[i]).padStart(3, '0');
      comps.push({ input: await get(`../unity3/sweep-${name}-${f}.png`, r, sc), left: i * (w + 4), top: 0 });
      comps.push({ input: await get(`../web/sweep-${name}-${f}.png`, r, sc), left: i * (w + 4), top: h + 4 });
    }
    await sharp({ create: { width: frames.length * (w + 4), height: 2 * h + 4, channels: 3, background: '#ff00ff' } }).composite(comps).png({ palette: true }).toFile(path.join(OUT, `strip-${name}.png`));
    // lag: compare unity frame f against web frames f-10..f+20 (2-frame grid), on the 3D region only (unity has HUD; bias is constant)
    const lags = [];
    for (let f = a; f <= b; f += 2) {
      const u = await raw(`../unity3/sweep-${name}-${String(f).padStart(3, '0')}.png`, r);
      let best = null;
      for (let g = Math.max(a, f - 12); g <= Math.min(b, f + 24); g += 2) {
        const d = diff(u, await raw(`../web/sweep-${name}-${String(g).padStart(3, '0')}.png`, r));
        if (!best || d < best[1]) best = [g, d];
      }
      lags.push(`${f}->${best[0]}(${best[0] - f >= 0 ? '+' : ''}${best[0] - f})`);
    }
    console.log(name, lags.join(' '));
  }
})();

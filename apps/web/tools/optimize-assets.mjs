// Shrinks the art under web/public/assets for the web build, reproducibly, and keeps every reference in step.
//
//   node web/tools/optimize-assets.mjs                 # every folder under public/assets
//   node web/tools/optimize-assets.mjs menu 3d         # only these folders (references are always synced everywhere)
//   node web/tools/optimize-assets.mjs --dry           # decide and measure, write nothing
//   node web/tools/optimize-assets.mjs --check         # only verify that every referenced asset exists
//   node web/tools/optimize-assets.mjs --report r.json # per-file decisions + pixel differences
//
// Every extractor calls optimizeAssets() for its folder after copying, so re-extracting never brings the PNGs back.
//
// What it does, per PNG/JPEG under public/assets:
// 1. Right-size (RULES below): only where the extractors keep more pixels than the screen can show — the 3D card
//    textures (~2928×4096 sources; a card is never drawn taller than ~512 px on a 1080p screen, ×2 for DPR → 1024)
//    and the pot tokens (507 px coins drawn a few dozen px tall → 256). UI sprites were already sized by their
//    extractors (2× the size the canvases draw them at), so they keep their pixels.
// 2. Encode as WebP. Candidates: lossy (q88 cards / q90 other art, alpha kept lossless, sharp-YUV), near-lossless,
//    lossless. Lossy is kept only when it is visibly identical to the source (GATE / PHOTO_GATE below) and clearly
//    smaller; hard-edged UI art with flat colour falls back to (near-)lossless. JPEG sources (card faces) are always
//    lossy. The 3D/WebGL textures keep RGB under transparent pixels (`exact`).
// 3. Sync every reference, then delete the originals (stateless — reruns are no-ops):
//    - src/data/*.json: "assets/….png|jpg" strings whose file is gone but whose .webp exists → .webp; the pot-token
//      `file` names (relative to assets/tokens); and each sprite record's exportSize / borderExported / rectExported /
//      exportScale (pot tokens: exportedPixels) rescaled to the actual pixel size of its file, so 9-slice borders stay
//      put. rect / border / texture stay the Unity source values.
//    - src/**/*.ts|css string literals and public/assets/*/MANIFEST.md (+ a generated "Web build" section).
//    - unity-scene.json keeps the Unity texture paths; the 3D loaders map their basenames to .webp.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const PUBLIC = path.join(WEB, 'public');
const ASSETS = path.join(PUBLIC, 'assets');
const DATA = path.join(WEB, 'src/data');
const SRC = path.join(WEB, 'src');

sharp.cache(false);

/**
 * Right-sizing and encoding rules, first match wins (path relative to public/assets).
 * max: longest side cap in px. quality: lossy WebP quality. forceLossy: skip the lossless candidates (JPEG sources).
 * exact: keep RGB under fully transparent pixels — the WebGL textures (three.js filters straight alpha, so zeroed
 * RGB there would show as dark fringes; CSS images are premultiplied by the browser and do not care).
 */
const RULES = [
  { test: /^3d\/.*\.jpe?g$/i, max: 1024, quality: 88, forceLossy: true, exact: true, why: '3D card face/edge: <=512 px tall on a 1080p screen, x2 DPR' },
  { test: /^3d\/card_back_side/i, max: 1024, quality: 88, exact: true, why: '3D card back: same size as the faces' },
  { test: /^3d\//i, quality: 88, exact: true, why: '3D felt / backdrop (drawn at screen size)' },
  { test: /^tokens\//i, max: 256, quality: 90, exact: true, why: 'pot token sprites: drawn a few dozen px tall' },
  { test: /^vfx\//i, quality: 90, exact: true, why: 'WebGL sprite' },
  { test: /./, quality: 90, why: 'UI sprite (already sized by its extractor)' },
];

// Lossy acceptance: premultiplied RGBA PSNR (dB) and worst 8×8 block mean abs error (/255). UI art (alpha, text, flat
// colour) must clear GATE. Large opaque painted backdrops (PHOTO: >= 1280 px, no alpha) clear PHOTO_GATE: their worst
// blocks are WebP's 4:2:0 chroma on saturated neon edges (the same trade every JPEG makes), which raising the
// quality does not change (q90..q96 all ~8/255) and which is not visible at display size.
const GATE = { psnr: 40, block: 6 };
const PHOTO_GATE = { psnr: 38, block: 10, minSide: 1280 };
// Near-lossless (libwebp near_lossless 60: pixels nudged by a few levels, never blurred) replaces lossless when it is
// >= 10% smaller and within these bounds.
const NEAR_GATE = { psnr: 44, block: 3 };
const LOSSY_WIN = 0.8; // lossy must be <= 80% of the best (near-)lossless size to be worth it
const NEAR_LOSSLESS_WIN = 0.9;
const IMG_RE = /\.(png|jpe?g)$/i;

// Originals are deleted only after every reference points at the WebP (the dev server never serves a dangling path).
const pendingDelete = new Set();
const exists = (abs) => fs.existsSync(abs) && !pendingDelete.has(path.resolve(abs));

const rel = (abs) => path.relative(ASSETS, abs).split(path.sep).join('/');
const toWebp = (p) => p.replace(IMG_RE, '.webp');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ pixel maths

/** Differences between two RGBA8 buffers, alpha-premultiplied (what ends up on screen over any background). */
export function diffRgba(a, b, w, h) {
  let se = 0, sae = 0, max = 0;
  const bw = Math.ceil(w / 8), bh = Math.ceil(h / 8);
  const blockSum = new Float64Array(bw * bh), blockN = new Uint32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const aa = a[i + 3], ab = b[i + 3];
      let s = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs((a[i + c] * aa - b[i + c] * ab) / 255);
        se += d * d; s += d; if (d > max) max = d;
      }
      const da = Math.abs(aa - ab);
      se += da * da; s += da; if (da > max) max = da;
      sae += s;
      const k = (y >> 3) * bw + (x >> 3);
      blockSum[k] += s / 4; blockN[k]++;
    }
  }
  const n = w * h * 4;
  const mse = se / n;
  let block = 0;
  for (let k = 0; k < blockSum.length; k++) if (blockN[k]) block = Math.max(block, blockSum[k] / blockN[k]);
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), mean: sae / n, max: Math.round(max), block };
}

async function rawOf(input, w, h) {
  let p = sharp(input, { failOn: 'none', limitInputPixels: false });
  if (w && h) p = p.resize(w, h, { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await p.ensureAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function encode(raw, opaque, opts) {
  let p = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });
  if (opaque) p = p.removeAlpha();
  return p.webp({ effort: 6, ...opts }).toBuffer();
}

// ------------------------------------------------------------------------------------------ conversion

async function convertOne(abs, { dry }) {
  const r = rel(abs);
  const rule = RULES.find((x) => x.test.test(r));
  const meta = await sharp(abs, { failOn: 'none', limitInputPixels: false }).metadata();
  const W = meta.width, H = meta.height;
  const k = rule.max ? Math.min(1, rule.max / Math.max(W, H)) : 1;
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const ref = await rawOf(abs, k < 1 ? w : 0, k < 1 ? h : 0);
  let opaque = true;
  for (let i = 3; i < ref.data.length; i += 4) if (ref.data[i] !== 255) { opaque = false; break; }

  const exact = !!rule.exact;
  const cands = [];
  const lossy = await encode(ref, opaque, { quality: rule.quality, alphaQuality: 100, smartSubsample: true, exact });
  cands.push({ mode: `lossy q${rule.quality}`, buf: lossy, lossy: true });
  if (!rule.forceLossy) {
    cands.push({ mode: 'lossless', buf: await encode(ref, opaque, { lossless: true, exact }) });
    cands.push({ mode: 'near-lossless', buf: await encode(ref, opaque, { lossless: true, nearLossless: true, quality: 60, exact }) });
  }
  for (const c of cands) {
    const out = await rawOf(c.buf);
    c.diff = diffRgba(ref.data, out.data, ref.width, ref.height);
  }
  const ll = cands.find((c) => c.mode === 'lossless');
  const nl = cands.find((c) => c.mode === 'near-lossless');
  let pick;
  if (rule.forceLossy) pick = cands[0];
  else {
    const exactBest = nl && nl.buf.length <= NEAR_LOSSLESS_WIN * ll.buf.length && nl.diff.block <= NEAR_GATE.block && nl.diff.psnr >= NEAR_GATE.psnr ? nl : ll;
    const g = opaque && Math.max(w, h) >= PHOTO_GATE.minSide ? PHOTO_GATE : GATE;
    const ok = cands[0].diff.psnr >= g.psnr && cands[0].diff.block <= g.block;
    pick = ok && cands[0].buf.length <= LOSSY_WIN * exactBest.buf.length ? cands[0] : exactBest;
  }
  const before = fs.statSync(abs).size;
  const outAbs = toWebp(abs);
  if (!dry) {
    fs.writeFileSync(outAbs, pick.buf);
    if (outAbs !== abs) pendingDelete.add(path.resolve(abs));
  }
  const d = pick.diff;
  return {
    file: 'assets/' + r, out: 'assets/' + toWebp(r), from: [W, H], to: [w, h], alpha: !opaque, mode: pick.mode, rule: rule.why,
    before, after: pick.buf.length,
    diff: { psnr: Number.isFinite(d.psnr) ? +d.psnr.toFixed(2) : 'inf', mean: +d.mean.toFixed(3), max: d.max, block8: +d.block.toFixed(2) },
    candidates: Object.fromEntries(cands.map((c) => [c.mode, { bytes: c.buf.length, psnr: Number.isFinite(c.diff.psnr) ? +c.diff.psnr.toFixed(2) : 'inf', block8: +c.diff.block.toFixed(2) }])),
  };
}

// ------------------------------------------------------------------------------------------ reference sync

const sizeCache = new Map();
function webpSize(buf) {
  // RIFF....WEBP + VP8 / VP8L / VP8X
  const t = buf.toString('ascii', 12, 16);
  if (t === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (t === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  if (t === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  return null;
}
function webpCodec(buf) {
  const t = buf.toString('ascii', 12, 16);
  if (t === 'VP8L') return 'lossless';
  if (t === 'VP8 ') return 'lossy';
  // VP8X: look for the image chunk
  for (let o = 30; o + 8 <= buf.length;) {
    const id = buf.toString('ascii', o, o + 4), n = buf.readUInt32LE(o + 4);
    if (id === 'VP8L') return 'lossless';
    if (id === 'VP8 ') return 'lossy';
    o += 8 + n + (n & 1);
  }
  return '?';
}
/** Pixel size of a public file (WebP/PNG/JPEG headers; PNG/JPEG via sharp). */
async function pixelSize(webPath) {
  if (sizeCache.has(webPath)) return sizeCache.get(webPath);
  const abs = path.join(PUBLIC, webPath);
  let s = null;
  if (exists(abs)) {
    if (/\.webp$/i.test(abs)) s = webpSize(fs.readFileSync(abs));
    if (!s) { const m = await sharp(abs, { failOn: 'none', limitInputPixels: false }).metadata(); s = [m.width, m.height]; }
  }
  sizeCache.set(webPath, s);
  return s;
}

/** "assets/x.png" whose PNG is gone but whose WebP exists → "assets/x.webp" (else unchanged). */
function mapRef(webPath) {
  if (!IMG_RE.test(webPath) || !webPath.startsWith('assets/')) return webPath;
  const clean = webPath.split(/[?#]/)[0];
  if (exists(path.join(PUBLIC, decodeURI(clean)))) return webPath;
  const w = toWebp(clean);
  return exists(path.join(PUBLIC, decodeURI(w))) ? webPath.replace(clean, w) : webPath;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Sprite metadata follows the file's actual pixel size (keeps 9-slice borders on the same art pixels). */
async function syncSprite(o) {
  const size = await pixelSize(o.file);
  if (!size) return false;
  const prev = o.exportSize ?? o.texture;
  if (!prev || (prev[0] === size[0] && prev[1] === size[1] && o.exportSize)) return false;
  const kx = size[0] / prev[0], ky = size[1] / prev[1];
  const tex = o.texture ?? prev;
  const sx = prev[0] / tex[0], sy = prev[1] / tex[1];
  if (o.borderExported || (o.border && o.border.some((v) => v))) {
    const b = o.borderExported ?? [o.border[0] * sx, o.border[1] * sy, o.border[2] * sx, o.border[3] * sy];
    o.borderExported = [b[0] * kx, b[1] * ky, b[2] * kx, b[3] * ky].map(r4);
  }
  if (o.rectExported) { const q = o.rectExported; o.rectExported = [q[0] * kx, q[1] * ky, q[2] * kx, q[3] * ky].map(r4); }
  if (typeof o.exportScale === 'number' && o.texture) o.exportScale = r4(size[0] / o.texture[0]);
  o.exportSize = [size[0], size[1]];
  return true;
}

async function syncJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(text);
  const isTokens = path.basename(file) === 'pot-tokens.json';
  let changed = 0;
  const visit = async (o) => {
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { if (typeof o[i] === 'string') { const m = mapRef(o[i]); if (m !== o[i]) { o[i] = m; changed++; } } else await visit(o[i]); } return; }
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        let m = mapRef(v);
        if (isTokens && k === 'file' && !v.includes('/')) m = mapRef('assets/tokens/' + v).slice('assets/tokens/'.length);
        if (m !== v) { o[k] = m; changed++; }
      } else await visit(v);
    }
    if (typeof o.file === 'string' && /\.(webp|png|jpe?g)$/i.test(o.file)) {
      if (o.exportSize || (o.texture && o.ppu !== undefined)) { if (await syncSprite(o)) changed++; }
      if (isTokens && o.exportedPixels) {
        const s = await pixelSize('assets/tokens/' + o.file);
        if (s && (s[0] !== o.exportedPixels[0] || s[1] !== o.exportedPixels[1])) { o.exportedPixels = s; changed++; }
      }
    }
  };
  await visit(json);
  if (!changed) return 0;
  const nl = text.indexOf('\n');
  const indent = nl < 0 || nl > 2 ? 0 : (text.slice(nl + 1).match(/^[ \t]*/)[0] || '');
  fs.writeFileSync(file, JSON.stringify(json, null, indent || undefined) + (text.endsWith('\n') ? '\n' : ''));
  return changed;
}

function syncText(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = text.replace(/assets\/[^'"`()\s]+?\.(?:png|jpe?g)(?=['"`)\s?#])/gi, (m) => mapRef(m));
  if (out === text) return 0;
  fs.writeFileSync(file, out);
  return 1;
}

async function syncManifest(dir) {
  const file = path.join(ASSETS, dir, 'MANIFEST.md');
  if (!fs.existsSync(file)) return 0;
  let text = fs.readFileSync(file, 'utf8');
  const orig = text;
  // `assets/…` paths and folder-relative names in backticks
  text = text.replace(/`([^`]+\.(?:png|jpe?g))`/gi, (all, p) => {
    if (p.startsWith('assets/')) return '`' + mapRef(p) + '`';
    if (/^Assets\/|^Packages\//.test(p)) return all; // Unity source column
    const m = mapRef(`assets/${dir}/${p}`);
    return '`' + m.slice(`assets/${dir}/`.length) + '`';
  });
  // generated section
  const START = '<!-- optimize-assets:start -->', END = '<!-- optimize-assets:end -->';
  const webps = walk(path.join(ASSETS, dir)).filter((p) => p.endsWith('.webp')).sort();
  if (webps.length) {
    let total = 0, lossy = 0;
    const rows = [];
    for (const p of webps) {
      const buf = fs.readFileSync(p);
      const s = webpSize(buf) ?? ['?', '?'];
      const codec = webpCodec(buf);
      total += buf.length; if (codec === 'lossy') lossy++;
      rows.push(`| \`${path.relative(path.join(ASSETS, dir), p).split(path.sep).join('/')}\` | ${s[0]}×${s[1]} | ${(buf.length / 1024).toFixed(1)} KB | ${codec} |`);
    }
    const section = [
      START,
      '## Web build: shipped files (generated by `web/tools/optimize-assets.mjs`)',
      '',
      `The extractor's PNG/JPEG copies are re-encoded as WebP (sizes above are the extractor's). ${webps.length} files, ` +
        `${(total / 1048576).toFixed(2)} MB; ${lossy} lossy (PSNR >= ${GATE.psnr} dB and no 8×8 block off by > ${GATE.block}/255; large opaque backdrops >= ${PHOTO_GATE.psnr} dB / ${PHOTO_GATE.block}), ` +
        `${webps.length - lossy} lossless / near-lossless. Rules and thresholds: see the tool.`,
      '',
      '| File | Pixels | Size | WebP |',
      '|---|---|---|---|',
      ...rows,
      END,
    ].join('\n');
    const a = text.indexOf(START), b = text.indexOf(END);
    text = a >= 0 && b > a ? text.slice(0, a) + section + text.slice(b + END.length) : text.replace(/\s*$/, '\n\n') + section + '\n';
  }
  if (text === orig) return 0;
  fs.writeFileSync(file, text);
  return 1;
}

/** Every asset reference in data / source must resolve to a file. Returns the missing ones. */
export function checkReferences() {
  const missing = new Set();
  const look = (s) => { if (s.startsWith('assets/') && /\.(webp|png|jpe?g|ttf|mp3|js)$/i.test(s) && !fs.existsSync(path.join(PUBLIC, decodeURI(s)))) missing.add(s); };
  for (const f of fs.readdirSync(DATA).filter((f) => f.endsWith('.json'))) {
    const visit = (o) => { if (typeof o === 'string') look(o); else if (o && typeof o === 'object') for (const v of Object.values(o)) visit(v); };
    const j = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
    visit(j);
    if (f === 'pot-tokens.json') { const t = (o) => { if (o && typeof o === 'object') { if (typeof o.file === 'string' && !o.file.includes('/')) look('assets/tokens/' + o.file); Object.values(o).forEach(t); } }; t(j); }
    if (f === 'unity-scene.json') {
      // the 3D loaders: basename of the Unity texture path, as .webp, under assets/3d
      const c = j.card.library;
      const tex = [c.back, c.edge, c.folded].map((m) => m?.textures?._MainTex?.texture).concat(c.entries.map((e) => e.faceTexture));
      const felt = j.table.tableCanvas.images.find((i) => i.path.endsWith('/Image') && i.activeInHierarchy && i.sprite);
      if (felt) tex.push(felt.sprite.texture);
      for (const t of tex) if (t) look('assets/3d/' + toWebp(t.split('/').pop()));
    }
  }
  for (const f of walk(SRC).filter((f) => /\.(ts|css)$/.test(f))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/assets\/[^'"`()\s$]+\.(?:webp|png|jpe?g|ttf)(?=['"`)\s?#])/gi)) look(m[0]);
  }
  return [...missing];
}

// ------------------------------------------------------------------------------------------ entry

/**
 * Converts the PNG/JPEG files under public/assets/<dirs> (all folders when dirs is empty) and syncs references.
 * Returns { results, before, after, missing }.
 */
export async function optimizeAssets({ dirs = [], convert = true, dry = false, log = console.log } = {}) {
  const roots = dirs.length ? dirs.map((d) => path.join(ASSETS, d)) : [ASSETS];
  const files = convert ? roots.flatMap((r) => walk(r)).filter((p) => IMG_RE.test(p) && !p.includes(`${path.sep}dev${path.sep}`)) : [];
  for (const f of files) {
    const w = toWebp(f);
    const twin = files.find((g) => g !== f && toWebp(g) === w);
    if (twin) throw new Error(`two sources for ${rel(w)}: ${rel(f)} and ${rel(twin)}`);
  }
  const results = [];
  let i = 0, next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      results.push(await convertOne(f, { dry }));
      if (++i % 25 === 0 || i === files.length) log(`  optimize-assets: ${i}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, os.cpus().length >> 1)) }, worker));
  results.sort((a, b) => a.file.localeCompare(b.file));
  if (!dry) {
    let n = 0;
    for (const f of fs.readdirSync(DATA).filter((f) => f.endsWith('.json'))) n += await syncJson(path.join(DATA, f));
    for (const f of walk(SRC).filter((f) => /\.(ts|css)$/.test(f))) n += syncText(f);
    for (const d of fs.readdirSync(ASSETS, { withFileTypes: true }).filter((e) => e.isDirectory())) n += await syncManifest(d.name);
    if (n) log(`  optimize-assets: ${n} reference update(s)`);
    for (const p of pendingDelete) fs.rmSync(p, { force: true });
    pendingDelete.clear();
  }
  const before = results.reduce((s, r) => s + r.before, 0), after = results.reduce((s, r) => s + r.after, 0);
  if (results.length) log(`  optimize-assets: ${results.length} images ${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB${dry ? ' (dry run)' : ''}`);
  const missing = dry ? [] : checkReferences();
  if (missing.length) log(`  optimize-assets: ${missing.length} MISSING reference(s):\n    ` + missing.join('\n    '));
  return { results, before, after, missing };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const reportAt = args.indexOf('--report');
  const reportFile = reportAt >= 0 ? args[reportAt + 1] : null;
  const dirs = args.filter((a, i) => !a.startsWith('--') && !(reportAt >= 0 && i === reportAt + 1));
  if (flag('--check')) {
    const missing = checkReferences();
    console.log(missing.length ? `MISSING:\n  ${missing.join('\n  ')}` : 'all asset references resolve');
    process.exit(missing.length ? 1 : 0);
  }
  const { results, missing } = await optimizeAssets({ dirs, dry: flag('--dry') });
  const flagged = results.filter((r) => r.mode.startsWith('lossy') && (r.diff.psnr < GATE.psnr || r.diff.block8 > GATE.block));
  if (flagged.length) console.log(`  ${flagged.length} lossy file(s) beyond the UI gate (card faces / backdrops; see PHOTO_GATE):\n    ` + flagged.map((r) => `${r.file} psnr ${r.diff.psnr} block ${r.diff.block8}`).join('\n    '));
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(results, null, 1));
  if (missing.length) process.exit(1);
}

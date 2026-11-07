// Minimal dependency-free PNG decode / area-downscale / encode (node:zlib only).
// Supports non-interlaced 8/16-bit greyscale, RGB, palette, grey+alpha and RGBA — everything Unity
// UI art in this project uses. Returns null from decode for anything else so callers copy the file as-is.

import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace || ![8, 16].includes(depth) && !(ctype === 3 && depth <= 8)) return null;
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!chans) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPP = chans * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const stride = Math.ceil((w * bitsPP) / 8);
  const px = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ctype === 3) {
        let idx;
        if (depth === 8) idx = row[x]; else { const per = 8 / depth; idx = (row[(x / per) | 0] >> ((per - 1 - (x % per)) * depth)) & ((1 << depth) - 1); }
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2]; out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        continue;
      }
      const s = depth === 16 ? 2 : 1;
      const g = (k) => row[(x * chans + k) * s];
      if (ctype === 0) { out[o] = out[o + 1] = out[o + 2] = g(0); out[o + 3] = 255; }
      else if (ctype === 2) { out[o] = g(0); out[o + 1] = g(1); out[o + 2] = g(2); out[o + 3] = 255; }
      else if (ctype === 4) { out[o] = out[o + 1] = out[o + 2] = g(0); out[o + 3] = g(1); }
      else { out[o] = g(0); out[o + 1] = g(1); out[o + 2] = g(2); out[o + 3] = g(3); }
    }
  }
  return { width: w, height: h, data: out };
}

// Area-average downscale with premultiplied alpha (no dark fringes on transparent edges).
export function resizeRgba(img, nw, nh) {
  const { width: w, height: h, data } = img;
  const out = Buffer.alloc(nw * nh * 4);
  const sx = w / nw, sy = h / nh;
  const acc = new Float64Array(4);
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      acc.fill(0); let area = 0;
      for (let yy = Math.floor(y0); yy < Math.min(h, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.min(w, Math.ceil(x1)); xx++) {
          const wgt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
          const i = (yy * w + xx) * 4, a = data[i + 3] / 255;
          acc[0] += data[i] * a * wgt; acc[1] += data[i + 1] * a * wgt; acc[2] += data[i + 2] * a * wgt; acc[3] += a * wgt; area += wgt;
        }
      }
      const o = (y * nw + x) * 4, A = acc[3];
      if (A > 0) { out[o] = Math.round(acc[0] / A); out[o + 1] = Math.round(acc[1] / A); out[o + 2] = Math.round(acc[2] / A); }
      out[o + 3] = Math.round((A / area) * 255);
    }
  }
  return { width: nw, height: nh, data: out };
}

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(img) {
  const { width: w, height: h, data } = img;
  let opaque = true; for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4, stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride), cand = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) for (let k = 0; k < ch; k++) cur[x * ch + k] = data[(y * w + x) * 4 + k];
    let best = null, bestSum = Infinity, bestType = 0;
    for (let ft = 0; ft < 5; ft++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
        let p = 0;
        if (ft === 1) p = a; else if (ft === 2) p = b; else if (ft === 3) p = (a + b) >> 1;
        else if (ft === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (cur[i] - p) & 255; cand[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; bestType = ft; best = Buffer.from(cand); }
    }
    raw[y * (stride + 1)] = bestType; best.copy(raw, y * (stride + 1) + 1);
    cur.copy(prev);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

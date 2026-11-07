// node compose.cjs <parityDir> <outDir>
// web/<shot>__3d|__hud|__screens.png → composite; diff vs unity/<shot>.png → <out>/<shot>-unity.png, -web.png, -diff.png
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const [dir, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const W = 1280, H = 720;

(async () => {
  const shots = fs.readdirSync(path.join(dir, 'unity')).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
  const rows = [];
  for (const s of shots) {
    const wd = path.join(dir, 'web');
    if (!fs.existsSync(path.join(wd, `${s}__3d.png`))) continue;
    const web = await sharp(path.join(wd, `${s}__3d.png`)).resize(W, H)
      .composite([{ input: path.join(wd, `${s}__hud.png`) }, { input: path.join(wd, `${s}__screens.png`) }])
      .removeAlpha().raw().toBuffer();
    const uni = await sharp(path.join(dir, 'unity', `${s}.png`)).resize(W, H).removeAlpha().raw().toBuffer();
    const diff = Buffer.alloc(W * H * 3);
    let sum = 0, over = 0;
    for (let i = 0, p = 0; p < W * H; p++, i += 3) {
      const d = (Math.abs(uni[i] - web[i]) + Math.abs(uni[i + 1] - web[i + 1]) + Math.abs(uni[i + 2] - web[i + 2])) / 3;
      sum += d;
      if (d > 40) over++;
      // diff image: dim greyscale of Unity + red/yellow heat for the difference
      const g = ((uni[i] + uni[i + 1] + uni[i + 2]) / 3) * 0.25;
      const h = Math.min(255, d * 3);
      diff[i] = Math.min(255, g + h);
      diff[i + 1] = Math.min(255, g + Math.max(0, h - 128) * 2);
      diff[i + 2] = g;
    }
    const png = (buf) => sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png({ palette: true, quality: 90, effort: 8 });
    await png(uni).toFile(path.join(out, `${s}-unity.png`));
    await png(web).toFile(path.join(out, `${s}-web.png`));
    await png(diff).toFile(path.join(out, `${s}-diff.png`));
    rows.push({ shot: s, meanAbs: +(sum / (W * H)).toFixed(2), pctOver40: +((100 * over) / (W * H)).toFixed(2) });
  }
  fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(rows, null, 1));
  console.table(rows);
})();

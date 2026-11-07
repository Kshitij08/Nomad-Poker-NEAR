// Tiny local receiver: the browser pane POSTs data-URL PNGs / text here; also serves html-to-image as ESM.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const OUT = process.argv[2]; const LIB = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'node_modules/html-to-image/dist/html-to-image.js');
fs.mkdirSync(OUT, { recursive: true });
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.end();
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/html-to-image.js') {
    // UMD → expose as ESM default via globalThis
    const src = fs.readFileSync(LIB, 'utf8');
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(`const module={exports:{}};const exports=module.exports;\n${src}\nexport default (module.exports&&Object.keys(module.exports).length?module.exports:globalThis.htmlToImage);`);
  }
  if (req.method === 'POST' && u.pathname === '/save') {
    const name = path.basename(u.searchParams.get('name') || 'x');
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const m = /^data:[^;]+;base64,(.*)$/s.exec(body);
      fs.writeFileSync(path.join(OUT, name), m ? Buffer.from(m[1], 'base64') : body);
      res.end('ok ' + name);
    });
    return;
  }
  res.statusCode = 404; res.end();
}).listen(5199, '127.0.0.1', () => console.log('receiver on 5199 ->', OUT));

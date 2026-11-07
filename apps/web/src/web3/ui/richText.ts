/**
 * TextMeshPro rich text → safe HTML for the web3 screens (PerUi texts use <b>, <u>, <color=#…>, <size=…%>).
 * Everything is HTML-escaped first; only the TMP tags below become markup, and any other "<…>" stays visible as
 * text, the way TMP prints a tag it doesn't know. Unclosed tags close at the end of the string (TMP: end of text).
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A colour argument TMP accepts: #rgb, #rgba, #rrggbb, #rrggbbaa, or a name (red, white…). Null otherwise. */
function tmpColor(v: string): string | null {
  const s = v.replace(/^"|"$/g, '').trim();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^[a-z]+$/i.test(s)) return s.toLowerCase();
  return null;
}

/** <size=N%> | <size=Npx> | <size=N> (font units) | <size=Nem>. Null when TMP wouldn't parse it. */
function tmpSize(v: string): string | null {
  const m = /^(\d+(?:\.\d+)?)(%|px|em)?$/i.exec(v.replace(/^"|"$/g, '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  return unit === '%' ? `${n / 100}em` : `${n}${unit}`;
}

type Open = { tag: string; close: string };

/** Converts TMP rich text to HTML (escaped). `\n` stays a newline: render with `white-space: pre-wrap`/`pre-line`. */
export function tmpToHtml(src: string): string {
  let out = '';
  const stack: Open[] = [];
  const open = (tag: string, html: string, close: string) => {
    stack.push({ tag, close });
    out += html;
  };
  const closeTag = (tag: string): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.tag !== tag) continue;
      // Close down to it (inner tags left open are re-opened by nothing: TMP's own nesting is just as loose).
      while (stack.length > i) out += stack.pop()!.close;
      return true;
    }
    return false;
  };
  const re = /<(\/?)([a-z-]+)(?:=([^>]*))?>/gi;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const arg = m[3];
    let ok = true;
    if (closing) ok = closeTag(tag) || ['br'].includes(tag);
    else
      switch (tag) {
        case 'b':
          open(tag, '<b>', '</b>');
          break;
        case 'i':
          open(tag, '<i>', '</i>');
          break;
        case 'u':
          open(tag, '<u>', '</u>');
          break;
        case 's':
          open(tag, '<s>', '</s>');
          break;
        case 'sup':
          open(tag, '<sup>', '</sup>');
          break;
        case 'sub':
          open(tag, '<sub>', '</sub>');
          break;
        case 'br':
          out += '\n';
          break;
        case 'nobr':
          open(tag, '<span style="white-space:nowrap">', '</span>');
          break;
        case 'uppercase':
        case 'allcaps':
          open(tag, '<span style="text-transform:uppercase">', '</span>');
          break;
        case 'lowercase':
          open(tag, '<span style="text-transform:lowercase">', '</span>');
          break;
        case 'color': {
          const c = arg !== undefined ? tmpColor(arg) : null;
          if (c) open(tag, `<span style="color:${c}">`, '</span>');
          else ok = false;
          break;
        }
        case 'size': {
          const s = arg !== undefined ? tmpSize(arg) : null;
          if (s) open(tag, `<span style="font-size:${s}">`, '</span>');
          else ok = false;
          break;
        }
        case 'alpha': {
          const a = arg !== undefined ? /^#([0-9a-f]{2})$/i.exec(arg.trim()) : null;
          if (a) open(tag, `<span style="opacity:${(parseInt(a[1]!, 16) / 255).toFixed(3)}">`, '</span>');
          else ok = false;
          break;
        }
        default:
          ok = false;
      }
    if (!ok) out += esc(m[0]);
  }
  out += esc(src.slice(last));
  while (stack.length) out += stack.pop()!.close;
  return out;
}

/** The visible characters of TMP rich text (known tags removed, <br> as a newline). */
export function tmpPlain(src: string): string {
  const d = typeof document !== 'undefined' ? document.createElement('div') : null;
  if (!d) return src.replace(/<\/?(b|i|u|s|sup|sub|nobr|uppercase|allcaps|lowercase|color|size|alpha)(=[^>]*)?>/gi, '').replace(/<br\s*\/?>/gi, '\n');
  d.innerHTML = tmpToHtml(src);
  return d.textContent ?? '';
}

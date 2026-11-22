// A faster drop-in for makefun-site 1.0.0.
//
// Written from the published behaviour of makefun-site 1.0.0 (its README and its
// code as the reference where the two differ): same inputs in, same output tree
// out, byte for byte. Nothing is copied from the reference tree; this is a fresh
// implementation organised for speed instead of for the plugin shape:
//
//   - one pass over each source: the front matter is read off the line array the
//     body is rendered from, so a body is never joined and re-split;
//   - the Markdown renderer works straight on the lines, emitting blocks as it
//     goes, with no intermediate token objects;
//   - inline markup is scanned with a single regex for the next special
//     character, so plain runs are escaped in bulk instead of one character
//     at a time;
//   - slugs and long dates are memoised per case (never across cases), and
//     pure-ASCII text skips Unicode normalisation entirely;
//   - templates are parsed once per case and rendered by a small interpreter
//     that reuses one scope frame per loop execution.
//
// run(input) answers one case alone. Deterministic: no clock, no randomness,
// no I/O, no state kept between calls.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const hasOwn = (o, k) => Object.hasOwn(o, k);

// ------------------------------------------------------------------ text

const ESC_BY_CODE = new Array(128);
ESC_BY_CODE[38] = '&amp;';
ESC_BY_CODE[60] = '&lt;';
ESC_BY_CODE[62] = '&gt;';
ESC_BY_CODE[34] = '&quot;';
ESC_BY_CODE[39] = '&#39;';
const ESCAPE_TEST = /[&<>"']/;
const MARK_RE = /\p{M}/gu;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `text` with & < > " and ' escaped. Fast path when nothing needs escaping. */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      const r = ESC_BY_CODE[code];
      if (r !== undefined) {
        if (i > start) out += text.slice(start, i);
        out += r;
        start = i + 1;
      }
    }
  }
  if (start < text.length) out += text.slice(start);
  return out;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure ASCII text is already in NFKD form and holds no combining marks, so it
 * skips normalisation. Results are memoised in `cache` for this case only.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = `${slug}-${n++}`;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const s = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, s);
  return s;
}

/** Whether the code unit is JavaScript whitespace (the \s set). */
function isWsCode(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 128) return false;
  return c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  if (line.length === 0) return line;
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(line.length - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** `line` with trailing spaces and tabs dropped. */
function rstripLine(line) {
  let b = line.length;
  while (b > 0 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(0, b);
}

/** Whether `key` is a front-matter key shape: a-z and _ only, at least one. */
function isKey(key) {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) !== 34) {
    if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
    return { value: raw };
  }
  if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
  const end = raw.length - 1;
  // Fast path: no backslash, and the only other quote is the closing one.
  if (raw.indexOf('\\', 1) === -1 && raw.indexOf('"', 1) === end) return { value: raw.slice(1, end) };
  let out = '';
  let start = 1;
  let i = 1;
  while (i < end) {
    const c = raw.charCodeAt(i);
    if (c === 92) {
      const n = raw[i + 1];
      if ((n !== '"' && n !== '\\') || i + 1 === end) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      if (i > start) out += raw.slice(start, i);
      out += n;
      i += 2;
      start = i;
    } else if (c === 34) {
      return { error: 'a quoted string holds a stray quote' };
    } else i++;
  }
  if (start < end) out += raw.slice(start, end);
  return { value: out };
}

/** Whether `raw` is a YYYY-MM-DD date from 1970-01-01 to 2099-12-31. */
function isDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  let y = 0;
  let mo = 0;
  let d = 0;
  for (let i = 0; i < 4; i++) {
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    y = y * 10 + (c - 48);
  }
  for (let i = 5; i < 7; i++) {
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    mo = mo * 10 + (c - 48);
  }
  for (let i = 8; i < 10; i++) {
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    d = d * 10 + (c - 48);
  }
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** Whether `raw` is a template name: a-z, 0-9 and -. */
function isName(raw) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug: a-z and 0-9, single - between, at most 64 characters. */
function isSlugValue(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let needAlnum = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (needAlnum) return false;
      needAlnum = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) needAlnum = false;
    else return false;
  }
  return !needAlnum;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = [];
      let at = 0;
      for (;;) {
        const comma = inner.indexOf(',', at);
        const piece = (comma === -1 ? inner.slice(at) : inner.slice(at, comma)).trim();
        if (piece === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < piece.length; i++) {
          const c = piece.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags.push(piece);
        if (comma === -1) break;
        at = comma + 1;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter: { data, close } with `close` the index of the closing
 * --- line, or { error } with the first reason it is refused. `lines` is the
 * source's text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon < 0) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, colon);
    if (!KEYS.has(key)) {
      if (!isKey(key)) return { error: `line ${i + 1} is not "key: value"` };
      return { error: `unknown key "${key}"` };
    }
    const rest = line.slice(colon + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = rstripLine(raw);
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ------------------------------------------------------------------ markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The language of a fence-opening line, "" for a bare fence, or null when it is no fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  for (;; j++) {
    if (j >= line.length) return line.slice(3);
    const c = line.charCodeAt(j);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  let j = k;
  while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
  if (j === k) return null;
  const text = rstripLine(line.slice(j));
  if (text === '') return null;
  return { depth: k, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (!((c === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) || (c === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) return false;
  for (let k = 3; k < line.length; k++) {
    const ch = line.charCodeAt(k);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let s = 0;
  while (line.charCodeAt(s) === 32) s++;
  if (s < 2 || s >= line.length) return false;
  return !isWsCode(line.charCodeAt(s));
}

/**
 * An ordered item's { start, text }, or null when `line` is no ordered line
 * (one to nine digits, ". ", then the text).
 */
function orderedItem(line) {
  let k = 0;
  while (k < 9) {
    const c = line.charCodeAt(k);
    if (c < 48 || c > 57) break;
    k++;
  }
  if (k === 0) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return { start: Number(line.slice(0, k)), text: line.slice(k + 2) };
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape,
 * or -1. A candidate is escaped when an odd run of backslashes stands directly
 * before it, counting only backslashes at or after `from`: the scan pairs
 * backslashes left to right from `from`, so the run's parity decides it.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let n = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) n++;
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The next special character for inline scanning: \ ` * [ (created per call, below). */

/**
 * `s` rendered inline; `link(target)` is a link's href.
 *
 * One regex finds the next character that matters: a markup opener (\ ` * [)
 * or a character the escape table names (& < > " '). The plain text between
 * two matches holds neither, so it is appended raw, never escaped; an escape
 * character appends its entity on the spot. A backslash before an escapable
 * character emits that character (only '>' of them needs escaping).
 */
function inline(s, link) {
  const re = /[\\`*\[]|[&<>"']/g;
  let out = '';
  let seg = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m.index;
    const c = s[p];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (p > seg) out += s.slice(seg, p);
      out += ESC_BY_CODE[s.charCodeAt(p)];
      seg = p + 1;
      re.lastIndex = p + 1;
      continue;
    }
    if (c === '\\') {
      const n = s[p + 1];
      if (n !== undefined && ESCAPABLE.has(n)) {
        if (p > seg) out += s.slice(seg, p);
        out += n === '>' ? '&gt;' : n;
        seg = p + 2;
        re.lastIndex = p + 2;
      } else {
        re.lastIndex = p + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        if (p > seg) out += s.slice(seg, p);
        out += `<code>${escapeHtml(s.slice(p + 1, j))}</code>`;
        seg = j + 1;
        re.lastIndex = j + 1;
      } else {
        re.lastIndex = p + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(p + 1) === 42) {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          if (p > seg) out += s.slice(seg, p);
          out += `<strong>${inline(s.slice(p + 2, j), link)}</strong>`;
          seg = j + 2;
          re.lastIndex = j + 2;
        } else {
          re.lastIndex = p + 2;
        }
      } else {
        // The first single * after p (one whose run is not **), outside an
        // escape, or -1: findSingleStar(s, p + 1) inlined.
        let j = s.indexOf('*', p + 1);
        let closer = -1;
        while (j !== -1) {
          let n = 0;
          for (let k = j - 1; k >= p + 1 && s.charCodeAt(k) === 92; k--) n++;
          if (n % 2 === 1) {
            j = s.indexOf('*', j + 1);
            continue;
          }
          if (s.charCodeAt(j + 1) === 42) {
            j = s.indexOf('*', j + 2);
            continue;
          }
          closer = j;
          break;
        }
        if (closer > p + 1) {
          if (p > seg) out += s.slice(seg, p);
          out += `<em>${inline(s.slice(p + 1, closer), link)}</em>`;
          seg = closer + 1;
          re.lastIndex = closer + 1;
        } else {
          re.lastIndex = p + 1;
        }
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', p + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    let hasWs = false;
    if (target !== '') {
      for (let q = 0; q < target.length; q++) {
        if (isWsCode(target.charCodeAt(q))) {
          hasWs = true;
          break;
        }
      }
    }
    if (target !== '' && !hasWs) {
      if (p > seg) out += s.slice(seg, p);
      out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(p + 1, k), link)}</a>`;
      seg = mm + 1;
      re.lastIndex = mm + 1;
    } else {
      re.lastIndex = p + 1;
    }
  }
  if (seg < s.length) out += s.slice(seg);
  return out;
}

/**
 * The list starting at `lines[i]` rendered: { html, next }, with `next` the
 * index after the list. `isOrdered` and `start` come from its first item.
 */
function listBlock(lines, i, isOrdered, start, link) {
  const items = [];
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    const d0 = l.charCodeAt(0);
    if (isOrdered) {
      if (d0 >= 48 && d0 <= 57) {
        const o = orderedItem(l);
        if (o !== null) {
          items.push([trimLine(o.text)]);
          i++;
          continue;
        }
      }
    } else if ((d0 === 45 || d0 === 42) && l.charCodeAt(1) === 32) {
      items.push([trimLine(l.slice(2))]);
      i++;
      continue;
    }
    if (d0 === 32 && isContinued(l)) {
      items[items.length - 1].push(trimLine(l));
      i++;
      continue;
    }
    break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  let out = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
  out += '\n';
  for (const parts of items) out += `<li>${inline(parts.join('\n'), link)}</li>\n`;
  out += `</${tag}>`;
  return { html: out, next: i };
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and its
 * inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * `link(target)` resolves a link's href.
 *
 * The block dispatch reads each line's first character: a fence, a heading, a
 * thematic break, a quote and a list marker can only open at position 0, and
 * a line opening on a space or tab is either blank or a paragraph.
 */
function renderBody(lines, link, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (!isBlank(line)) {
        const body = [trimLine(line)];
        i++;
        while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
        const html = inline(body.join('\n'), link);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        continue;
      }
      i++;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '<pre><code';
        if (lang !== '') code += ` class="language-${lang}"`;
        code += '>';
        if (body.length > 0) code += `${escapeHtml(body.join('\n'))}\n`;
        code += '</code></pre>';
        blocks.push(code);
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, slugCache), ids);
        const html = inline(hd.text, link);
        blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const r = listBlock(lines, i, false, 1, link);
        blocks.push(r.html);
        i = r.next;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = [];
      for (const l of body) if (l !== '') kept.push(l);
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedItem(line);
      if (ordered !== null) {
        const r = listBlock(lines, i, true, ordered.start, link);
        blocks.push(r.html);
        i = r.next;
        continue;
      }
    }
    // A paragraph: any other line, and the lines after it up to a blank line,
    // a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function isSpacesTabs(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line is taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') {
        tokens.push({ t: 'text', text });
        text = '';
      }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isSpacesTabs(src, lineStart, open) && isSpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push({ t: 'text', text });
      text = '';
    }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `templates` holds the parsed
 * templates (a template that did not parse absent). Rendering is synchronous,
 * so one loop reuses a single scope frame and loop record, mutated per element:
 * the frame belongs to this one execution of the loop, so a re-entrant render
 * (through an include) gets a frame of its own.
 */
function renderNodes(nodes, scope, templates, depth) {
  const out = [];
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out.push(renderNodes(branch, scope, templates, depth));
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs) || xs.length === 0) break;
        const len = xs.length;
        const loop = { index: 1, first: true, last: len === 1, length: len };
        const vars = {};
        vars.loop = loop;
        const child = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          out.push(renderNodes(n.body, child, templates, depth));
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out.push(renderNodes(t, scope, templates, depth + 1));
        break;
      }
    }
  }
  return out.join('');
}

// ------------------------------------------------------------------ the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * `rel` (a link's path, "/"-separated) from a directory, or null when it climbs
 * out of the root. `prefixes[u]` is the directory with u segments dropped, so
 * a run of leading "../" resolves by index; the rest is a plain path unless it
 * holds a ".", ".." or empty segment, in which case the segment walk runs.
 */
function resolvePath(prefixes, rel) {
  let ups = 0;
  let p = 0;
  const n = rel.length;
  while (p + 3 <= n && rel.charCodeAt(p) === 46 && rel.charCodeAt(p + 1) === 46 && rel.charCodeAt(p + 2) === 47) {
    ups++;
    p += 3;
  }
  let rest = rel.slice(p);
  if (rest === '..') {
    ups++;
    rest = '';
  }
  if (ups >= prefixes.length) return null;
  if (
    rest !== '' &&
    (rest.indexOf('..') !== -1 ||
      rest.indexOf('/./') !== -1 ||
      rest.charCodeAt(0) === 47 ||
      rest.startsWith('./') ||
      rest.endsWith('/.') ||
      rest === '.' ||
      rest.indexOf('//') !== -1 ||
      rest.endsWith('/'))
  ) {
    const parts = prefixes[0] === '' ? [] : prefixes[0].split('/');
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    return parts.join('/');
  }
  const base = prefixes[ups];
  if (rest === '') return base;
  return base === '' ? rest : `${base}/${rest}`;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const lines = s.text.split('\n');
    const fm = parseFrontMatter(lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = lines.slice(fm.close + 1);
    s.body = s.bodyLines.join('\n');
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug made unique in
  // its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    // The directory's prefixes by how far a link climbs: prefixes[u] is the
    // directory with u segments dropped ("" when all are dropped).
    const segs = dir === '' ? [] : dir.split('/');
    const prefixes = [];
    for (let u = 0; u <= segs.length; u++) prefixes.push(segs.slice(0, segs.length - u).join('/'));
    const link = (target) => {
      const t0 = target.charCodeAt(0);
      if (t0 === 47 || t0 === 35) return target;
      // A scheme: a letter, then letters, digits, +, - or . up to a ':'.
      // Relative targets hold no ':' before a '/', so indexOf finds it fast.
      const colon = target.indexOf(':');
      if (colon > 0 && ((t0 >= 65 && t0 <= 90) || (t0 >= 97 && t0 <= 122))) {
        let scheme = true;
        for (let q = 1; q < colon; q++) {
          const d = target.charCodeAt(q);
          if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 43 || d === 45 || d === 46)) {
            scheme = false;
            break;
          }
        }
        if (scheme) return target;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(prefixes, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderBody(s.bodyLines, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's newer
  // and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order,
  // ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The shapes templates read.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) };
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, the index pages and the tag pages
  // through theirs, then each static file at its own path.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

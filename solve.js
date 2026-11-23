// Faster drop-in for makefun-site 1.0.0 (make.fun bounty site-generator-speed-01).
// Pure JavaScript, no dependencies, no WebAssembly, no native addon, no prebuilt
// binary, nothing cached from one case to the next: every cache lives inside run().
// Strategy: byte-identical semantics to the reference, with the hot paths rebuilt:
//  - escapeHtml / slugify / wordsOf as single-pass char-code loops (+ per-run cache
//    for slugify, whose ASCII fast path skips NFKD entirely);
//  - Markdown lex+render fused into one pass, inline rendering that buffers plain
//    runs and escapes them in bulk instead of one regex replace per character;
//  - templates parsed once per case, then compiled to plain JS functions with a
//    single flattened scope object (save/restore around for-loops) instead of an
//    interpreted node walk with a scope chain per variable lookup.

const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------------------------------------------------------- text utils */

function escapeHtml(text) {
  let out = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (out === null) out = [];
    if (i > last) out.push(text.slice(last, i));
    out.push(rep);
    last = i + 1;
  }
  if (out === null) return text;
  if (last < text.length) out.push(text.slice(last));
  return out.join('');
}

function isWSCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWSCode(c))) return true;
  }
  return false;
}

function wordsOfLines(lines) {
  let n = 0;
  for (let k = 0; k < lines.length; k++) {
    const text = lines[k];
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWSCode(c))) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    }
  }
  return n;
}

function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return out;
}

function makeSlugify() {
  const cache = new Map();
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let out;
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) >= 128) { ascii = false; break; }
    }
    if (ascii) {
      out = '';
      let gap = false;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        let keep = -1;
        if (c >= 65 && c <= 90) keep = c + 32;
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
        if (keep === -1) { gap = out.length > 0; continue; }
        if (gap) out += '-';
        gap = false;
        out += String.fromCharCode(keep);
      }
    } else {
      out = slugifySlow(text);
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
    cache.set(text, out);
    return out;
  };
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

/* ---------------------------------------------------------- front matter */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    let raw = m[2] ?? '';
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e < raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

/* ---------------------------------------------------------- markdown */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingInfo(line) {
  let j = 0;
  while (line.charCodeAt(j) === 35) j++;
  if (j < 1 || j > 6) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let a = j;
  while (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: j, text: line.slice(a, b) };
}

function isHR(line) {
  const p = line.slice(0, 3);
  if (p !== '---' && p !== '***') return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingInfo(line) !== null || isHR(line);
}

function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j < 1 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

function isContinued(line) {
  let k = 0;
  while (line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isWSCode(line.charCodeAt(k));
}

function inline(s, env) {
  // One pass: plain runs are flushed raw (no HTML-special char can sit in a
  // run unhandled, since specials are emitted as entities the moment seen),
  // so the text is scanned once instead of once here and once in escapeHtml.
  let out = '';
  let i = 0;
  let seg = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (i > seg) out += s.slice(seg, i);
      out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
      i++;
      seg = i;
      continue;
    }
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      if (i > seg) out += s.slice(seg, i);
      out += s[i + 1] === '>' ? '&gt;' : s[i + 1];
      i += 2;
      seg = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > seg) out += s.slice(seg, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > seg) out += s.slice(seg, i);
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
          seg = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > seg) out += s.slice(seg, i);
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWS(target)) {
        if (i > seg) out += s.slice(seg, i);
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        i = m + 1;
        seg = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (s.length > seg) out += s.slice(seg);
  return out;
}

function renderMarkdown(lines, env, slugify) {
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"';
      // Escape is per-character, so escaping the joined lines equals escaping
      // each line; one call instead of one per line.
      const code = body.length === 0 ? '' : escapeHtml(body.join('\n') + '\n');
      blocks.push('<pre><code' + cls + '>' + code + '</code></pre>');
      continue;
    }
    const hd = headingInfo(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, env);
      blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(ls.join('\n'), env) + '</p>\n</blockquote>');
      continue;
    }
    const bText = bulletOf(line);
    const oInfo = bText === null ? orderedOf(line) : null;
    if (bText !== null || oInfo !== null) {
      const isOrdered = oInfo !== null;
      const items = [];
      while (i < lines.length) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && oInfo.start !== 1 ? '<ol start="' + oInfo.start + '">' : '<' + tag + '>';
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += '<li>' + inline(items[k].join('\n'), env) + '</li>\n';
      blocks.push(open + '\n' + inner + '</' + tag + '>');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += blocks[k] + '\n';
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

/* ---------------------------------------------------------- templates */

class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/* Compile a parsed template tree to a function fn(S, T, depth) returning its
   rendered string. S is one flattened scope object (for-loops save/restore
   their bindings); that keeps a variable lookup to a single property read,
   matching the reference's innermost-scope rule, including `loop` beating a
   loop variable of the same name (loop is assigned after the element). A
   loop's `loop` record is one object per loop execution, its fields rewritten
   each iteration: templates can only read it while that iteration renders,
   so reusing it is invisible. */
let compileUid = 0;

function lookupCode(path, v) {
  let code = v + ' = S[' + JSON.stringify(path[0]) + '];\n';
  for (let k = 1; k < path.length; k++) {
    const key = JSON.stringify(path[k]);
    code += 'if (' + v + ' !== undefined) ' + v + ' = (' + v + ' !== null && typeof ' + v + ' === "object" && Object.hasOwn(' + v + ', ' + key + ')) ? ' + v + '[' + key + '] : undefined;\n';
  }
  return code;
}

function genNodes(nodes) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      code += '_o += ' + JSON.stringify(n.text) + ';\n';
    } else if (n.kind === 'var') {
      code += lookupCode(n.path, '_v');
      code += '_o += esc(textOf(_v));\n';
    } else if (n.kind === 'raw') {
      code += lookupCode(n.path, '_v');
      code += '_o += textOf(_v);\n';
    } else if (n.kind === 'if') {
      code += lookupCode(n.path, '_v');
      code += 'if (truthy(_v) !== ' + n.not + ') {\n' + genNodes(n.then) + '}';
      if (n.else !== null) code += ' else {\n' + genNodes(n.else) + '}';
      code += '\n';
    } else if (n.kind === 'for') {
      const id = ++compileUid;
      code += '{\n' + lookupCode(n.path, '_v') + 'const _xs' + id + ' = _v;\n';
      code += 'if (Array.isArray(_xs' + id + ')) {\n';
      code += 'const _len' + id + ' = _xs' + id + '.length;\n';
      code += 'const _lp' + id + ' = { index: 0, first: false, last: false, length: _len' + id + ' };\n';
      code += 'const _hN' + id + ' = Object.hasOwn(S, ' + JSON.stringify(n.name) + ');\n';
      code += 'const _oN' + id + ' = S[' + JSON.stringify(n.name) + '];\n';
      code += 'const _hL' + id + ' = Object.hasOwn(S, "loop");\n';
      code += 'const _oL' + id + ' = S["loop"];\n';
      code += 'for (let _k' + id + ' = 0; _k' + id + ' < _len' + id + '; _k' + id + '++) {\n';
      code += 'S[' + JSON.stringify(n.name) + '] = _xs' + id + '[_k' + id + '];\n';
      code += '_lp' + id + '.index = _k' + id + ' + 1; _lp' + id + '.first = _k' + id + ' === 0; _lp' + id + '.last = _k' + id + ' === _len' + id + ' - 1;\n';
      code += 'S["loop"] = _lp' + id + ';\n';
      code += genNodes(n.body);
      code += '}\n';
      code += 'if (_hN' + id + ') S[' + JSON.stringify(n.name) + '] = _oN' + id + '; else delete S[' + JSON.stringify(n.name) + '];\n';
      code += 'if (_hL' + id + ') S["loop"] = _oL' + id + '; else delete S["loop"];\n';
      code += '}\n}\n';
    } else if (n.kind === 'include') {
      code += 'if (T[' + JSON.stringify(n.name) + '] !== undefined && depth < 8) _o += T[' + JSON.stringify(n.name) + '](S, T, depth + 1, esc, textOf, truthy);\n';
    }
  }
  return code;
}

function compileTemplate(nodes) {
  const src = 'let _v;\nlet _o = "";\n' + genNodes(nodes) + '\nreturn _o;\n';
  return new Function('S', 'T', 'depth', 'esc', 'textOf', 'truthy', src);
}

/* ---------------------------------------------------------- build */

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

function build(input) {
  const slugify = makeSlugify();
  const report = [];
  const parsedNames = new Set();
  const compiled = Object.create(null);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      parsedNames.add(name);
      compiled[name] = compileTemplate(nodes);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(d + '/'));
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsedNames.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources = kept;

  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      let set = taken.get(dir);
      if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
      return set;
    };
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : dir + '/' + slug;
      s.url = base + '/' + s.outDir + '/';
      bySource.set(s.path, s);
    }
  }

  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add('broken-link ' + s.path + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.newer = null;
    s.older = null;
  }

  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.bodyLines) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of sources) s.card = cardOf(s);

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer),
    older: linkOf(s.older),
    is_post: s.post,
  });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const newScope = () => {
    const S = Object.create(null);
    S.site = site;
    S.tags = allTags;
    S.recent = recent;
    return S;
  };
  const renderPage = (name, page) => {
    const fn = compiled[name];
    if (fn === undefined) return null;
    const S = newScope();
    S.page = page;
    return fn(S, compiled, 0, escapeHtml, textOf, truthy);
  };
  const renderIndex = (postsSlice, pager) => {
    const fn = compiled.index;
    if (fn === undefined) return null;
    const S = newScope();
    S.posts = postsSlice;
    S.pager = pager;
    return fn(S, compiled, 0, escapeHtml, textOf, truthy);
  };
  const renderTag = (tag) => {
    const fn = compiled.tag;
    if (fn === undefined) return null;
    const S = newScope();
    S.tag = tag;
    return fn(S, compiled, 0, escapeHtml, textOf, truthy);
  };
  const renderTags = () => {
    const fn = compiled.tags;
    if (fn === undefined) return null;
    return fn(newScope(), compiled, 0, escapeHtml, textOf, truthy);
  };

  for (const s of sources) output[s.outDir + '/index.html'] = renderPage(s.layout, pageOf(s));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = renderIndex(posts.slice((k - 1) * per, k * per).map((p) => p.card),
      { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = renderTag({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderTags();
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}

export function run(input) {
  return build(input);
}

// A fast Markdown renderer producing exactly marked 18.1.3's HTML output
// (default options, GFM on). Written from scratch for this competition:
// a line-oriented block parser plus an inline parser built around a
// delimiter stack, following the CommonMark 0.31.2 parsing algorithms
// with the output shapes and quirks marked itself exhibits, verified
// empirically against marked's rendering of the practice corpus.
'use strict';

// ---------- character classes ----------

// Unicode whitespace per the CommonMark definition: tab, LF, FF, CR,
// space, and the Zs code points.
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288;
}

function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCode(c) {
  if (c < 128) return isAsciiPunctCode(c);
  return PUNCT_RE.test(String.fromCharCode(c));
}

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isWordCode(c) {
  return isAlnumCode(c) || c === 95; // \w
}

// ---------- escaping ----------

// Plain escape: every & < > " ' becomes an entity. Used for text runs,
// code spans, code blocks, and autolink hrefs/text.
function escPlain(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Attribute escape used for inline-link hrefs, titles, and fence info
// strings: like the plain escape, except an & that begins something
// shaped like an entity reference (&name; &#123; &#x1f;) is left alone.
function escAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (looksLikeRef(s, i)) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) {
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === 62) {
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    } else if (c === 34) {
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === 39) {
      out += s.slice(start, i) + '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function looksLikeRef(s, i) {
  // s[i] === '&'. True when s[i..] matches &name; &#digits; &#xhex;
  let j = i + 1;
  const n = s.length;
  if (j < n && s.charCodeAt(j) === 35) {
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const st = j;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (isAlnumCode(c)) j++;
        else break;
      }
      // hex digits only
      for (let k = st; k < j; k++) {
        const c = s.charCodeAt(k);
        const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
        if (!ok) return false;
      }
      return j > st && j < n && s.charCodeAt(j) === 59;
    }
    const st = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    return j > st && j < n && s.charCodeAt(j) === 59;
  }
  if (j < n) {
    const c0 = s.charCodeAt(j);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
    j++;
    while (j < n && isAlnumCode(s.charCodeAt(j))) j++;
    return j < n && s.charCodeAt(j) === 59;
  }
  return false;
}

// Href encoding: marked percent-encodes destinations the way encodeURI
// does (spaces, quotes, non-ASCII, backslashes), leaving %, #, ?, &,
// =, /, :, @ and friends untouched. encodeURI itself encodes a bare %,
// so the %25 it produces is mapped back to a literal %.
function encodeHref(s) {
  try {
    const e = encodeURI(s);
    return e.indexOf('%25') === -1 ? e : e.replace(/%25/g, '%');
  } catch (_e) {
    return s;
  }
}

// ---------- link labels ----------

function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').replace(/[ßẞ]/g, 'ss').toLowerCase();
}

// ---------- line state ----------
// A cursor over one source line tracking the column (tabs expand to the
// next multiple of 4) and any remainder of a partially consumed tab,
// which behaves like spaces for the rest of the scan.
class LS {
  constructor(s) {
    this.s = s;
    this.i = 0;
    this.col = 0;
    this.pend = 0;
    // Set by container matching: when a line sits inside a list
    // item or blockquote, marked expands tabs in the leading
    // whitespace before stripping the container indent (its list
    // extraction runs J() over leading whitespace, and its quote
    // extraction expands the whitespace after '>'). rest() then
    // returns the expanded remainder. tabBase is the column the
    // current container level's text starts at, so a tab expands
    // to the next multiple of 4 relative to it.
    this.tabExpand = false;
    this.tabBase = 0;
  }
  peek() {
    if (this.pend > 0) return 32;
    if (this.i >= this.s.length) return -1;
    return this.s.charCodeAt(this.i);
  }
  // Columns of whitespace ahead, without consuming.
  indentAhead() {
    let i = this.i;
    let col = this.col;
    let pend = this.pend;
    let n = 0;
    const s = this.s;
    for (;;) {
      if (pend > 0) {
        n += pend;
        col += pend;
        pend = 0;
      } else if (i >= s.length) {
        break;
      } else {
        const c = s.charCodeAt(i);
        if (c === 32) {
          i++;
          col++;
          n++;
        } else if (c === 9) {
          const w = 4 - ((col - this.tabBase) % 4);
          i++;
          col += w;
          n += w;
        } else break;
      }
    }
    return n;
  }
  advanceCols(n) {
    while (n > 0) {
      if (this.pend > 0) {
        const k = this.pend < n ? this.pend : n;
        this.pend -= k;
        this.col += k;
        n -= k;
      } else if (this.i >= this.s.length) {
        break;
      } else {
        const c = this.s.charCodeAt(this.i);
        if (c === 32) {
          this.i++;
          this.col++;
          n--;
        } else if (c === 9) {
          const w = 4 - ((this.col - this.tabBase) % 4);
          this.i++;
          if (w <= n) {
            this.col += w;
            n -= w;
          } else {
            this.pend = w - n;
            this.col += n;
            n = 0;
          }
        } else break;
      }
    }
  }
  advanceOne() {
    if (this.pend > 0) {
      this.pend--;
      this.col++;
    } else if (this.i < this.s.length) {
      this.i++;
      this.col++;
    }
  }
  rest() {
    const s = this.pend > 0 ? ' '.repeat(this.pend) + this.s.slice(this.i) : this.s.slice(this.i);
    if (!this.tabExpand) return s;
    // Expand tabs in the leading whitespace run. A tab at absolute
    // column c expands to 4 - ((c - tabBase) % 4) spaces, where
    // tabBase is the column the innermost quote's marker starts at
    // (marked's quote extraction expands the whitespace after '>'
    // relative to the marker length, recursively per quote level).
    // A list item never sets tabBase: marked's list extraction
    // expands continuation-line tabs relative to absolute columns
    // (base 0), so inside a list the base stays 0 (or the quote's).
    let col = this.col;
    let k = 0;
    let out = null;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 32) {
        if (out !== null) out += ' ';
        col++;
        k++;
      } else if (c === 9) {
        if (out === null) out = s.slice(0, k);
        const w = 4 - ((col - this.tabBase) % 4);
        out += ' '.repeat(w);
        col += w;
        k++;
      } else break;
    }
    if (out === null) return s;
    return out + s.slice(k);
  }
  atEnd() {
    return this.pend === 0 && this.i >= this.s.length;
  }
  isBlank() {
    if (this.pend > 0) {
      // pending spaces plus the remainder must all be blank
    }
    for (let i = this.i; i < this.s.length; i++) {
      const c = this.s.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  snapshot() {
    return [this.i, this.col, this.pend];
  }
  restore(snap) {
    this.i = snap[0];
    this.col = snap[1];
    this.pend = snap[2];
  }
}

// ---------- HTML blocks ----------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Classify an HTML block start at the beginning of `rest` (leading
// spaces already known to be fewer than 4 columns). Returns the block
// type 1-7, or 0 when the line does not start an HTML block.
function htmlBlockType(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32) i++;
  if (i >= rest.length || rest.charCodeAt(i) !== 60) return 0;
  const s = rest.slice(i);
  // Type 2: comment.
  if (s.startsWith('<!--')) return 2;
  // Type 3: processing instruction.
  if (s.startsWith('<?')) return 3;
  // Type 5: CDATA.
  if (s.startsWith('<![CDATA[')) return 5;
  // Type 4: declaration.
  if (s.length > 2 && s.charCodeAt(1) === 33) {
    const c = s.charCodeAt(2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
  }
  // Type 1: script, pre, style, textarea.
  const m1 = /^<(script|pre|style|textarea)(?:[ \t]|>|$)/i.exec(s);
  if (m1) return 1;
  // Type 6: block tag open/close.
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/.exec(s);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    // The follow character after the name must be space/tab/EOL/>//.
    // The regex above already constrains it, except it would also
    // accept `<divx` style mismatches; the tag name match is exact.
    return 6;
  }
  // Type 7: a complete open or closing tag, alone on the line.
  if (matchTagAlone(s)) return 7;
  return 0;
}

// True when s is exactly one (open or closing) HTML tag plus trailing
// whitespace.
function matchTagAlone(s) {
  const end = scanHtmlTag(s, 0);
  if (end < 0) return false;
  for (let i = end; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Scan one HTML tag (open or closing) starting at s[i] === '<'.
// Returns the index just past '>', or -1.
function scanHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (j < n && s.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  if (j >= n) return -1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnumCode(c) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    return j < n && s.charCodeAt(j) === 62 ? j + 1 : -1;
  }
  // A valueless attribute may be followed by whitespace that the
  // =-lookahead below consumes; carry that across so the next
  // attribute is still accepted.
  let pendingWs = false;
  for (;;) {
    // Skip whitespace (may span lines inside a tag).
    let hadWs = pendingWs;
    pendingWs = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) {
        hadWs = true;
        j++;
      } else break;
    }
    if (j >= n) return -1;
    const c = s.charCodeAt(j);
    if (c === 62) return j + 1;
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2;
    if (!hadWs) return -1;
    // Attribute name.
    const a0 = s.charCodeAt(j);
    if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return -1;
    j++;
    while (j < n) {
      const ac = s.charCodeAt(j);
      if (isAlnumCode(ac) || ac === 95 || ac === 58 || ac === 46 || ac === 45) j++;
      else break;
    }
    // Optional = value.
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k < n && s.charCodeAt(k) === 61) {
      k++;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
      if (k >= n) return -1;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) {
        k++;
        while (k < n && s.charCodeAt(k) !== q) k++;
        if (k >= n) return -1;
        k++;
      } else {
        const st = k;
        while (k < n) {
          const vc = s.charCodeAt(k);
          if (vc === 32 || vc === 9 || vc === 10 || vc === 34 || vc === 39 ||
              vc === 61 || vc === 60 || vc === 62 || vc === 96) break;
          k++;
        }
        if (k === st) return -1;
      }
      j = k;
    } else {
      pendingWs = k > j;
      j = k;
    }
  }
}

// Whether an HTML block of the given type ends with this line.
function htmlBlockEnds(type, lineLower, line) {
  switch (type) {
    case 1:
      return lineLower.includes('</script') || lineLower.includes('</pre') ||
        lineLower.includes('</style') || lineLower.includes('</textarea');
    case 2:
      return line.includes('-->');
    case 3:
      return line.includes('?>');
    case 4:
      return line.includes('>');
    case 5:
      return line.includes(']]>');
    default:
      return false; // types 6-7 end at blank lines
  }
}

// ---------- tables ----------

// Split a table row line into cells on unescaped pipes. Marked splits
// on EVERY unescaped '|' — even one inside a code span ('`a|b`' becomes
// two cells '`a' and 'b`'); only '\|' is protected. Edge pipes produce
// empty edge cells, which are dropped; the rest are trimmed.
function splitCells(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      // An escaped pipe is unescaped during the split (so it survives
      // as a literal pipe in the cell); other escapes are left for
      // the inline parser.
      if (line.charCodeAt(i + 1) === 124) cur += '|';
      else cur += line[i] + line[i + 1];
      i += 2;
      continue;
    }
    if (c === 124) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
  return cells;
}

// Parse a delimiter row: returns the alignment array (0 none, 1 left,
// 2 center, 3 right), or null when the row is not a delimiter row.
function parseDelimiterRow(line) {
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  const aligns = new Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    let a = 0;
    let b = cell.length;
    let left = false;
    let right = false;
    if (a < b && cell.charCodeAt(a) === 58) {
      left = true;
      a++;
    }
    if (b > a && cell.charCodeAt(b - 1) === 58) {
      right = true;
      b--;
    }
    if (b - a < 1) return null;
    for (let q = a; q < b; q++) {
      if (cell.charCodeAt(q) !== 45) return null;
    }
    aligns[k] = left && right ? 2 : left ? 1 : right ? 3 : 0;
  }
  return aligns;
}

// ---------- link destinations, titles, labels ----------

// Resolve backslash escapes in a destination or title: a backslash
// before ASCII punctuation yields the punctuation; anything else keeps
// both characters.
function unescapeLink(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunctCode(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Parse a link destination starting at s[i] (after leading whitespace
// has been skipped). Returns {dest, end} or null. For bare destinations
// an unmatched ')' at depth 0 ends the destination without being
// consumed; the caller decides what follows.
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === 60) {
    // <...> form: no newlines, no <, no control characters.
    let j = i + 1;
    let raw = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest: raw, end: j + 1 };
      if (c === 10 || c === 60 || c < 32) return null;
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
        raw += s[j + 1];
        j += 2;
      } else {
        raw += s[j];
        j++;
      }
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let raw = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) break;
    if (c < 32) return null;
    if (c === 40) {
      depth++;
      raw += '(';
      j++;
    } else if (c === 41) {
      if (depth === 0) break;
      depth--;
      raw += ')';
      j++;
    } else if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
      raw += s[j + 1];
      j += 2;
    } else {
      raw += s[j];
      j++;
    }
  }
  if (j === i) return null;
  if (depth !== 0) return null;
  return { dest: raw, end: j };
}

// Parse a link title starting at s[i]. Returns {title, end} or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s.charCodeAt(i);
  if (q === 34 || q === 39) {
    let j = i + 1;
    let raw = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === q) return { title: raw, end: j + 1 };
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
        raw += s[j + 1];
        j += 2;
      } else {
        raw += s[j];
        j++;
      }
    }
    return null;
  }
  if (q === 40) {
    let j = i + 1;
    let raw = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 41) return { title: raw, end: j + 1 };
      if (c === 40) return null; // unescaped ( forbidden inside
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
        raw += s[j + 1];
        j += 2;
      } else {
        raw += s[j];
        j++;
      }
    }
    return null;
  }
  return null;
}

// Scan a link label starting at s[i] === '['. Returns {label, end}
// with end just past the closing ']'. The label ends at the first
// unescaped ']' (an unescaped '[' inside invalidates it), holds no
// blank line, and is at most 999 characters.
function scanLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 91) return null;
    if (c === 93) {
      const label = s.slice(i + 1, j);
      if (label.length > 999) return null;
      if (/\n[ \t]*\n/.test(label)) return null;
      return { label, end: j + 1 };
    }
    j++;
  }
  return null;
}

function skipWs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

function skipSpacesTabs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return i;
}

// Spaces/tabs, at most one line ending, then spaces/tabs: the
// whitespace allowed between the parts of a link or definition.
function spnl(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  if (j < n && s.charCodeAt(j) === 10) {
    j++;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  }
  return j;
}

// Try to parse one link reference definition at the start of a line
// inside paragraph text s, starting at index i (a line start).
// Returns {label, dest, title, end} with end just past the newline
// that ends the definition (or the end of input), or null.
function tryParseDef(s, i) {
  const n = s.length;
  // Up to 3 columns of indent.
  let j = i;
  let cols = 0;
  while (j < n && cols < 3) {
    const c = s.charCodeAt(j);
    if (c === 32) {
      j++;
      cols++;
    } else if (c === 9) {
      cols += 4 - (cols % 4);
      j++;
    } else break;
  }
  if (cols > 3) return null;
  if (j >= n || s.charCodeAt(j) !== 91) return null;
  const lab = scanLabel(s, j);
  if (!lab) return null;
  if (lab.label.length === 0) return null;
  if (normalizeLabel(lab.label) === '') return null;
  let k = lab.end;
  if (k >= n || s.charCodeAt(k) !== 58) return null;
  k = spnl(s, k + 1);
  if (k >= n) return null;
  const d = parseDest(s, k);
  if (!d) return null;
  const beforetitle = d.end;
  // A title is allowed only when whitespace separates it from the
  // destination. If the title (or what follows it) does not end the
  // line, rewind: the definition stands without a title when the
  // destination's own line ends cleanly.
  let k2 = spnl(s, beforetitle);
  let title = null;
  if (k2 > beforetitle) {
    const t = parseTitle(s, k2);
    if (t) {
      title = t.title;
      k2 = t.end;
    }
  }
  let e = skipSpacesTabs(s, k2);
  if (e >= n || s.charCodeAt(e) === 10) {
    return { label: lab.label, dest: d.dest, title, end: e < n ? e + 1 : e };
  }
  e = skipSpacesTabs(s, beforetitle);
  if (e >= n || s.charCodeAt(e) === 10) {
    return { label: lab.label, dest: d.dest, title: null, end: e < n ? e + 1 : e };
  }
  return null;
}

// ---------- block parser ----------

function deepestOpen(root) {
  let n = root;
  for (;;) {
    if (n.t !== 'doc' && n.t !== 'quote' && n.t !== 'list' && n.t !== 'item') return n;
    const kids = n.children;
    if (kids.length === 0) return n;
    const last = kids[kids.length - 1];
    if (!last.open) return n;
    n = last;
  }
}

function addChild(container, node) {
  node.parent = container;
  if (container.t === 'item' && container.children.length > 0 && container.lastBlank) {
    container.parent.loose = true;
  }
  container.children.push(node);
  return node;
}

function finalize(node, refs, ck) {
  if (node.t === 'para') {
    const s = node.lines.join('\n');
    let i = 0;
    for (;;) {
      const d = tryParseDef(s, i);
      if (!d) break;
      const key = normalizeLabel(d.label);
      if (!refs.has(key)) refs.set(key, { href: d.dest, title: d.title });
      i = d.end;
    }
    const rest = s.slice(i);
    node.text = rest;
    if (rest === '') {
      const p = node.parent;
      if (p && p.children[p.children.length - 1] === node) p.children.pop();
      else if (p) {
        const idx = p.children.indexOf(node);
        if (idx !== -1) p.children.splice(idx, 1);
      }
      node.removed = true;
    }
  } else if (node.t === 'code') {
    if (!node.fenced) {
      while (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') node.lines.pop();
    } else if (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') {
      // Fenced code drops exactly one trailing empty line.
      node.lines.pop();
    }
    node.literal = node.lines.length > 0 ? node.lines.join('\n') + '\n' : '';
  } else if (node.t === 'html') {
    // The trailing newline survives only when the block ends by its
    // end condition or at EOF (ck 1/2), the last line had a newline,
    // and either the block is top-level or a non-blank line follows
    // it. Blank lines and container mismatches drop it.
    const keep = (ck === 1 || ck === 2) && node.lastNL &&
      (node.nextNonBlank || (node.parent.t === 'doc' && node.isLastProcessed));
    node.literal = node.lines.join('\n') + (keep ? '\n' : '');
  }
}

function closeUpTo(root, container, refs, ck) {
  for (;;) {
    const t = deepestOpen(root);
    if (t === container || t === root) return;
    finalize(t, refs, ck);
    t.open = false;
  }
}

function closeLeaves(root, refs, ck) {
  for (;;) {
    const t = deepestOpen(root);
    if (t.t === 'para' || t.t === 'table' || t.t === 'html' || t.t === 'code') {
      finalize(t, refs, ck);
      t.open = false;
    } else return;
  }
}

// Walk the open container chain from the root, matching each against
// the line. Blank lines match every container leniently.
function matchContainers(root, ls, blank) {
  let container = root;
  let allMatched = true;
  for (;;) {
    const kids = container.children;
    let last = null;
    if (kids.length > 0) {
      const cand = kids[kids.length - 1];
      if (cand.open && (cand.t === 'quote' || cand.t === 'list' || cand.t === 'item')) last = cand;
    }
    if (!last) break;
    if (last.t === 'list') {
      container = last;
      continue;
    }
    if (last.t === 'quote') {
      const baseCol = ls.col;
      const snap = ls.snapshot();
      const ind = ls.indentAhead();
      let ok = false;
      if (ind < 4) {
        ls.advanceCols(ind);
        if (ls.peek() === 62) {
          ls.advanceOne();
          // Set tabBase BEFORE consuming the optional space/tab
          // after '>': a tab there expands relative to the '>'
          // marker column (marked's quote extraction), not the
          // absolute column.
          ls.tabBase = baseCol;
          if (ls.peek() === 32 || ls.peek() === 9) ls.advanceCols(1);
          ok = true;
        }
      }
      if (!ok) {
        // A raw blank line never matches a blockquote: the quote
        // closes. (A blank line carrying '>' markers is not blank
        // here and matches normally above.)
        ls.restore(snap);
        allMatched = false;
        break;
      }
      ls.tabExpand = true;
      container = last;
      continue;
    }
    // List item.
    if (blank || ls.isBlank()) {
      // A blank line, or a line blank after the outer containers
      // matched (e.g. '>>'), matches the item leniently.
      container = last;
      continue;
    }
    const ind = ls.indentAhead();
    if (ind >= last.indent) {
      ls.advanceCols(last.indent);
      ls.tabExpand = true;
      // A list item does NOT set tabBase: marked expands a
      // continuation line's tabs relative to absolute columns
      // (J() with base 0) before slicing the item indent, so the
      // base stays 0 (or whatever the enclosing quote set).
      container = last;
      continue;
    }
    allMatched = false;
    break;
  }
  return { container, allMatched };
}

// --- block-start matchers (operate on LS, restore on failure) ---

function tryAtx(ls) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return null;
  ls.advanceCols(ind);
  let run = 0;
  while (ls.peek() === 35) {
    ls.advanceOne();
    run++;
  }
  if (run === 0 || run > 6) {
    ls.restore(snap);
    return null;
  }
  const p = ls.peek();
  if (p !== -1 && p !== 32 && p !== 9) {
    ls.restore(snap);
    return null;
  }
  while (ls.peek() === 32 || ls.peek() === 9) ls.advanceOne();
  let content = ls.rest();
  let end = content.length;
  while (end > 0) {
    const c = content.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  content = content.slice(0, end);
  if (content.length > 0 && content.charCodeAt(content.length - 1) === 35) {
    let st = content.length;
    while (st > 0 && content.charCodeAt(st - 1) === 35) st--;
    if (st === 0) {
      content = '';
    } else {
      const bc = content.charCodeAt(st - 1);
      if (bc === 32 || bc === 9) {
        let e2 = st - 1;
        while (e2 > 0) {
          const c = content.charCodeAt(e2 - 1);
          if (c === 32 || c === 9) e2--;
          else break;
        }
        content = content.slice(0, e2);
      }
    }
  }
  return { level: run, text: content };
}

function tryFence(ls) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return null;
  ls.advanceCols(ind);
  const ch = ls.peek();
  if (ch !== 96 && ch !== 126) {
    ls.restore(snap);
    return null;
  }
  let run = 0;
  while (ls.peek() === ch) {
    ls.advanceOne();
    run++;
  }
  if (run < 3) {
    ls.restore(snap);
    return null;
  }
  const info = ls.rest();
  if (ch === 96 && info.indexOf('`') !== -1) {
    ls.restore(snap);
    return null;
  }
  return { ch, len: run, info, indent: ind };
}

function tryHr(ls) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return false;
  ls.advanceCols(ind);
  const rest = ls.rest();
  ls.restore(snap);
  let ch = -1;
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if (c === 32 || c === 9) continue;
    if (c === 42 || c === 45 || c === 95) {
      if (ch === -1) ch = c;
      else if (c !== ch) return false;
      count++;
    } else return false;
  }
  return count >= 3;
}

function trySetext(ls) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return 0;
  ls.advanceCols(ind);
  const rest = ls.rest();
  ls.restore(snap);
  if (rest.length === 0) return 0;
  const ch = rest.charCodeAt(0);
  if (ch !== 61 && ch !== 45) return 0;
  let i = 1;
  while (i < rest.length && rest.charCodeAt(i) === ch) i++;
  while (i < rest.length) {
    const c = rest.charCodeAt(i);
    if (c !== 32 && c !== 9) return 0;
    i++;
  }
  return ch === 61 ? 1 : 2;
}

function tryHtml(ls) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return 0;
  ls.advanceCols(ind);
  const t = htmlBlockType(ls.rest());
  ls.restore(snap);
  return t;
}

function tryQuote(ls) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return false;
  ls.advanceCols(ind);
  if (ls.peek() !== 62) {
    ls.restore(snap);
    return false;
  }
  ls.advanceOne();
  if (ls.peek() === 32 || ls.peek() === 9) ls.advanceCols(1);
  return true;
}

function tryList(ls) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return null;
  ls.advanceCols(ind);
  const rest = ls.rest();
  if (rest.length === 0) {
    ls.restore(snap);
    return null;
  }
  const c0 = rest.charCodeAt(0);
  let ordered;
  let delim = 0;
  let bullet = 0;
  let num = 0;
  let markerLen = 0;
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    if (rest.length > 1) {
      const c1 = rest.charCodeAt(1);
      if (c1 !== 32 && c1 !== 9) {
        ls.restore(snap);
        return null;
      }
    }
    ordered = false;
    bullet = c0;
    markerLen = 1;
  } else if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < rest.length && j < 9 && rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57) j++;
    if (j >= rest.length) {
      ls.restore(snap);
      return null;
    }
    if (rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57) {
      ls.restore(snap);
      return null;
    }
    const d = rest.charCodeAt(j);
    if (d !== 46 && d !== 41) {
      ls.restore(snap);
      return null;
    }
    if (j + 1 < rest.length) {
      const c1 = rest.charCodeAt(j + 1);
      if (c1 !== 32 && c1 !== 9) {
        ls.restore(snap);
        return null;
      }
    }
    ordered = true;
    delim = d;
    num = parseInt(rest.slice(0, j), 10);
    markerLen = j + 1;
  } else {
    ls.restore(snap);
    return null;
  }
  for (let k = 0; k < markerLen; k++) ls.advanceOne();
  const wsCols = ls.indentAhead();
  const snap2 = ls.snapshot();
  ls.advanceCols(wsCols);
  const blankAfter = ls.isBlank();
  ls.restore(snap2);
  let padding;
  if (blankAfter) {
    padding = markerLen + 1;
    ls.advanceCols(1);
  } else if (wsCols >= 5) {
    padding = markerLen + 1;
    ls.advanceCols(1);
  } else {
    padding = markerLen + wsCols;
    ls.advanceCols(wsCols);
  }
  return { ordered, delim, bullet, num, contentIndent: ind + padding, blankAfter };
}

function peekListMarker(ls) {
  const snap = ls.snapshot();
  const r = tryList(ls);
  ls.restore(snap);
  return r;
}

// Whether the line starts any block construct (used to end tables and
// to decide lazy continuations). indentedCode counts only when asked.
function startsBlock(ls, countIndented) {
  const snap = ls.snapshot();
  let r = false;
  const ind = ls.indentAhead();
  if (ind < 4) {
    if (tryAtx(ls)) r = true;
    else if (tryFence(ls)) r = true;
    else if (tryHtml(ls)) r = true;
    else if (tryHr(ls)) r = true;
    else if (tryQuote(ls)) r = true;
    else if (tryList(ls)) r = true;
  } else if (countIndented) {
    r = true;
  }
  ls.restore(snap);
  return r;
}

function isClosingFence(ls, node) {
  const snap = ls.snapshot();
  const ind = ls.indentAhead();
  if (ind >= 4) return false;
  ls.advanceCols(ind);
  let run = 0;
  while (ls.peek() === node.fenceCh) {
    ls.advanceOne();
    run++;
  }
  if (run < node.fenceLen) {
    ls.restore(snap);
    return false;
  }
  if (!ls.isBlank()) {
    ls.restore(snap);
    return false;
  }
  return true;
}

function firstWord(info) {
  let i = 0;
  while (i < info.length && (info.charCodeAt(i) === 32 || info.charCodeAt(i) === 9)) i++;
  let j = i;
  while (j < info.length && info.charCodeAt(j) !== 32 && info.charCodeAt(j) !== 9) j++;
  return info.slice(i, j);
}

function addListItem(container, lm) {
  let list = null;
  if (container.t === 'list' && container.open && container.ordered === lm.ordered &&
      (lm.ordered ? container.delim === lm.delim : container.bullet === lm.bullet)) {
    list = container;
  } else {
    const kids = container.children;
    const last = kids.length > 0 ? kids[kids.length - 1] : null;
    if (last && last.t === 'list' && last.open && last.ordered === lm.ordered &&
        (lm.ordered ? last.delim === lm.delim : last.bullet === lm.bullet)) {
      list = last;
    } else {
      list = {
        t: 'list', ordered: lm.ordered, delim: lm.delim, bullet: lm.bullet,
        start: lm.num, loose: false, children: [], open: true, lastBlank: false,
      };
      addChild(container, list);
    }
  }
  const prev = list.children[list.children.length - 1];
  if (prev && prev.trailingBlank) list.loose = true;
  const item = {
    t: 'item', children: [], open: true, indent: lm.contentIndent,
    lastBlank: false, trailingBlank: false,
  };
  item.parent = list;
  list.children.push(item);
  return item;
}

// Open new blocks for the line starting at the current position.
// When `para` is given, the line is a potential interruption of that
// paragraph: block starts that cannot interrupt leave the paragraph
// open and this returns false. Returns true when the line is consumed.
function tryBlockStarts(ls, container, para, refs, lineIdx, totalLines, lines) {
  let interruptPara = para !== null;
  for (;;) {
    if (ls.isBlank()) return true;
    const ind = ls.indentAhead();
    if (ind < 4) {
      const atx = tryAtx(ls);
      if (atx) {
        closePara(para, refs);
        addChild(container, { t: 'head', level: atx.level, text: atx.text, open: false });
        return true;
      }
      const fence = tryFence(ls);
      if (fence) {
        closePara(para, refs);
        const node = {
          t: 'code', fenced: true, fenceCh: fence.ch, fenceLen: fence.len,
          fenceIndent: fence.indent, lang: unescapeLink(firstWord(fence.info)),
          lines: [], open: true, prevBlank: false,
        };
        addChild(container, node);
        return true;
      }
      const ht = tryHtml(ls);
      if (ht !== 0 && !(interruptPara && ht === 7)) {
        closePara(para, refs);
        const node = {
          t: 'html', htmlType: ht, lines: [ls.rest()], open: true,
          lastNL: lineIdx < totalLines - 1,
          nextNonBlank: nextNonBlank(lines, lineIdx),
          isLastProcessed: isLastProcessedLine(lineIdx, totalLines, lines),
        };
        addChild(container, node);
        const line = node.lines[0];
        if (ht <= 5 && htmlBlockEnds(ht, line.toLowerCase(), line)) {
          finalize(node, refs, 1);
          node.open = false;
        }
        return true;
      }
      if (tryHr(ls)) {
        closePara(para, refs);
        addChild(container, { t: 'hr', open: false });
        return true;
      }
      if (tryQuote(ls)) {
        closePara(para, refs);
        para = null;
        const q = { t: 'quote', children: [], open: true, lastBlank: false };
        addChild(container, q);
        container = q;
        interruptPara = false;
        continue;
      }
      const snap = ls.snapshot();
      const lm = tryList(ls);
      if (lm) {
        // An empty item, and an ordered item not starting at 1,
        // cannot interrupt a paragraph — except when the paragraph
        // sits directly inside a list item: there the marker line
        // (which matched the item's content indent) does interrupt
        // and starts a nested list (marked: '- Foo\n 2. bar' nests,
        // while 'Foo\n2. bar' and '> Foo\n> 2. bar' stay lazy).
        if (interruptPara && (lm.blankAfter || (lm.ordered && lm.num !== 1)) &&
            para.parent.t !== 'item') {
          ls.restore(snap);
          return false;
        }
        closePara(para, refs);
        para = null;
        container = addListItem(container, lm);
        interruptPara = false;
        continue;
      }
    } else if (!interruptPara) {
      ls.advanceCols(4);
      const node = { t: 'code', fenced: false, lines: [ls.rest()], open: true };
      addChild(container, node);
      return true;
    }
    if (interruptPara) return false;
    const p = { t: 'para', lines: [ls.rest()], open: true };
    addChild(container, p);
    return true;
  }
}

function closePara(para, refs) {
  if (para && para.open) {
    finalize(para, refs);
    para.open = false;
  }
}

function clearFlagsUp(node) {
  let n = node;
  while (n) {
    n.lastBlank = false;
    if (n.t === 'item') n.trailingBlank = false;
    n = n.parent;
  }
}

// Strip n columns of leading whitespace from a (blank) line,
// materializing a partially consumed tab as spaces.
function stripCols(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      i++;
      col++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) {
        i++;
        col += w;
      } else {
        return ' '.repeat(col + w - n) + s.slice(i + 1);
      }
    } else break;
  }
  return s.slice(i);
}

// Whether lines[idx] is the last line that gets processed: either
// the final line, or the one before the empty artifact of a trailing
// newline (which processLine skips).
function isLastProcessedLine(lineIdx, totalLines, lines) {
  return lineIdx === totalLines - 1 ||
    (lineIdx === totalLines - 2 && lines[totalLines - 1] === '');
}

// Whether the line after lines[idx] holds any non-whitespace.
// Whether the line after idx exists and is non-empty (length > 0).
// This decides the trailing newline of an HTML block: marked keeps
// the '\n' when the next line is non-empty even if it is only
// whitespace (' ' or '\t'), and drops it only when the next line is
// truly empty or absent. A line holding only quote markers ('>' and
// spaces) is blank, and a line opening a DEEPER quote level than the
// current line (e.g. '> > ...' after a '> ...' line) closes the
// current list item, so it does not count as a continuation either.
function quoteDepthCount(line) {
  let i = 0;
  let d = 0;
  for (;;) {
    let k = i;
    while (k < line.length && k - i < 3 &&
           (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
    if (k < line.length && line.charCodeAt(k) === 62) {
      d++;
      i = k + 1;
      if (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
    } else break;
  }
  return { depth: d, rest: line.slice(i) };
}
function nextNonBlank(lines, idx) {
  const j = idx + 1;
  if (j >= lines.length) return false;
  const nxt = lines[j];
  if (nxt.length === 0) return false;
  const nx = quoteDepthCount(nxt);
  if (nx.rest.length === 0) {
    // Only quote markers (and spaces): blank — unless there were no
    // markers at all, i.e. a whitespace-only line, which still counts
    // as non-blank (marked keeps '\n' for ' ' / '\t').
    return nx.depth === 0;
  }
  if (nx.depth > quoteDepthCount(lines[idx]).depth) return false;
  return true;
}

function handleBlank(root, container, refs, lineIdx, totalLines, ls, lines) {
  const t = deepestOpen(root);
  if (t.t === 'code' && t.fenced) {
    // Same character-based strip as fenced content lines (Dt).
    const rest = ls.rest();
    let n = 0;
    if (t.fenceCh === 96) {
      while (n < rest.length && n < t.fenceIndent &&
        (rest.charCodeAt(n) === 32 || rest.charCodeAt(n) === 9)) n++;
    }
    t.lines.push(rest.slice(n));
    t.prevBlank = true;
    return;
  }
  if (t.t === 'code') {
    t.lines.push(stripCols(ls.rest(), 4));
    return;
  }
  if (t.t === 'html' && t.htmlType <= 5) {
    t.lines.push(ls.rest());
    t.lastNL = lineIdx < totalLines - 1;
    t.nextNonBlank = nextNonBlank(lines, lineIdx);
    t.isLastProcessed = isLastProcessedLine(lineIdx, totalLines, lines);
    return;
  }
  closeLeaves(root, refs);
  // A blank line closes an empty list item: later content at the
  // item's indent belongs to the enclosing block, not the item.
  for (;;) {
    const d = deepestOpen(root);
    if (d.t === 'item' && d.children.length === 0) {
      d.open = false;
      continue;
    }
    break;
  }
  // Blank flags propagate up from the matched container through
  // lists and items, but stop at a blockquote boundary: a blank
  // line inside a quote does not loosen the enclosing list.
  let n = container;
  while (n) {
    n.lastBlank = true;
    if (n.t === 'item') n.trailingBlank = true;
    if (n.t === 'quote') break;
    n = n.parent;
  }
}

// Check whether the current line is a table delimiter row for the
// paragraph's last line. Returns {aligns, headerCells} or null.
function tryTableDelim(ls, para) {
  const ind = ls.indentAhead();
  if (ind >= 4) return null;
  const snap = ls.snapshot();
  ls.advanceCols(ind);
  const rest = ls.rest();
  ls.restore(snap);
  // Quick reject: a delimiter row holds only : - | space tab.
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if (c !== 58 && c !== 45 && c !== 124 && c !== 32 && c !== 9) return null;
  }
  const aligns = parseDelimiterRow(rest);
  if (!aligns) return null;
  const headerCells = splitCells(para.lines[para.lines.length - 1]);
  if (headerCells.length === 0 || headerCells.length !== aligns.length) return null;
  return { aligns, headerCells };
}

function convertParaToTable(para, info, refs) {
  const parent = para.parent;
  para.lines.pop();
  const table = {
    t: 'table', header: info.headerCells, aligns: info.aligns,
    rows: [], open: true,
  };
  if (para.lines.length === 0) {
    // The paragraph was only the header line: remove it.
    const kids = parent.children;
    if (kids[kids.length - 1] === para) kids.pop();
    else {
      const idx = kids.indexOf(para);
      if (idx !== -1) kids.splice(idx, 1);
    }
    para.open = false;
    para.removed = true;
  } else {
    finalize(para, refs);
    para.open = false;
  }
  addChild(parent, table);
  return table;
}

// Whether a lazy line has the shape of a setext underline whose
// leading whitespace is spaces only: a run of '=' (any length) or
// exactly '--', plus trailing spaces/tabs.
function isQuirkUnderline(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  if (i >= s.length) return false;
  const ch = s.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return false;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === ch) j++;
  if (ch === 45 && j - i !== 2) return false;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
    j++;
  }
  return true;
}

// Whether the chain from the paragraph up to (excluding) the last
// matched container passes through a blockquote.
function hasUnmatchedQuote(t, container) {
  let n = t.parent;
  while (n && n !== container) {
    if (n.t === 'quote') return true;
    n = n.parent;
  }
  return false;
}

// Whether an unmatched line may be swallowed as content by the open
// fenced code block t: the fence must sit inside a list item (seen
// walking up to the matched container), and no blockquote ancestor
// of the fence may be unmatched (a quote met before reaching the
// matched container did not match this line, so the fence closes).
function fenceSwallowOk(t, container) {
  let n = t.parent;
  let inItem = false;
  while (n && n !== container) {
    if (n.t === 'quote') return false;
    if (n.t === 'item') inItem = true;
    n = n.parent;
  }
  return inItem;
}

function processLine(lines, idx, root, refs) {
  const totalLines = lines.length;
  // The empty last line produced by a trailing newline is not a
  // real line: skip it so leaves close at EOF, not on a blank line.
  if (idx === totalLines - 1 && lines[idx] === '' && totalLines > 1) return;
  const ls = new LS(lines[idx]);
  const rawBlank = ls.isBlank();
  const mc = matchContainers(root, ls, rawBlank);
  let container = mc.container;
  if (!mc.allMatched) {
    const blankAfter = ls.isBlank();
    const t = deepestOpen(root);
    if (!blankAfter && t.t === 'para' && !startsBlock(ls, false)) {
      // Lazy continuation. One run of lazy lines shares a strip
      // mode, set by its first line: 4 columns when that line is
      // indented 4 or more, else nothing is stripped. In a
      // no-strip run, a setext-underline-shaped line inside an
      // unmatched blockquote is padded to 4 spaces (marked quirk).
      let strip;
      if (t.lastLazy) {
        strip = t.lazyStrip;
      } else {
        strip = ls.indentAhead() >= 4 ? 4 : 0;
        t.lazyStrip = strip;
      }
      if (strip === 4) ls.advanceCols(4);
      let content = ls.rest();
      if (strip === 0 && t.lastLazy && isQuirkUnderline(content) &&
          hasUnmatchedQuote(t, container)) {
        let sp = 0;
        while (sp < content.length && content.charCodeAt(sp) === 32) sp++;
        if (sp < 4) content = ' '.repeat(4 - sp) + content;
      }
      t.lines.push(content);
      t.lastLazy = true;
      clearFlagsUp(t);
      return;
    }
    if (!blankAfter && t.t === 'code' && t.fenced && t.lines.length > 0 &&
        !t.prevBlank && !startsBlock(ls, false) && fenceSwallowOk(t, container)) {
      // Unmatched line while a fence is open inside a list item:
      // marked's list extraction keeps such a line as a lazy line
      // of the item text, and the open fence takes it as content
      // (the line must not follow a blank line and must not start
      // a block construct; a fence with no content yet, or one
      // inside a quote only, does not swallow).
      const rest = ls.rest();
      let n = 0;
      if (t.fenceCh === 96) {
        while (n < rest.length && n < t.fenceIndent &&
          (rest.charCodeAt(n) === 32 || rest.charCodeAt(n) === 9)) n++;
      }
      t.lines.push(rest.slice(n));
      t.prevBlank = false;
      clearFlagsUp(t);
      return;
    }
    closeUpTo(root, container, refs);
  }
  // A line consisting of exactly one tab is a table row (an empty
  // row), not a blank line: marked's table keeps going through it
  // (and through the rows after it) until a real blank line or a
  // line starting a block construct.
  if (lines[idx] === '\t' && deepestOpen(root).t === 'table') {
    const t = deepestOpen(root);
    t.rows.push(new Array(t.header.length).fill(''));
    clearFlagsUp(t);
    return;
  }
  // Blank when the raw line is blank, or when container matching
  // consumed everything: a whitespace remainder left by a marker
  // (e.g. '>  ') is paragraph content, not a blank line.
  if (rawBlank || ls.atEnd()) {
    handleBlank(root, container, refs, idx, totalLines, ls, lines);
    return;
  }
  // A list only stays open for a following item of the same kind.
  // A thematic break takes precedence over a list marker.
  if (container.t === 'list') {
    const lm = peekListMarker(ls);
    if (!lm || lm.ordered !== container.ordered ||
        (lm.ordered ? lm.delim !== container.delim : lm.bullet !== container.bullet) ||
        tryHr(ls)) {
      container.open = false;
      container = container.parent;
    }
  }
  let t = deepestOpen(root);
  if (t.t === 'code' && t.fenced) {
    if (isClosingFence(ls, t)) {
      finalize(t, refs);
      t.open = false;
    } else {
      // Fenced code content: marked's Dt() slices up to
      // fenceIndent leading-whitespace CHARACTERS (not columns)
      // off each line, where fenceIndent is the opening fence's
      // leading whitespace length — but only for BACKTICK fences:
      // Dt's indentCodeCompensation regex requires ```, so a
      // tilde fence keeps its content lines verbatim.
      const rest = ls.rest();
      let n = 0;
      if (t.fenceCh === 96) {
        while (n < rest.length && n < t.fenceIndent &&
          (rest.charCodeAt(n) === 32 || rest.charCodeAt(n) === 9)) n++;
      }
      t.lines.push(rest.slice(n));
      t.prevBlank = false;
    }
    clearFlagsUp(t);
    return;
  }
  if (t.t === 'html') {
    const line = ls.rest();
    t.lines.push(line);
    t.lastNL = idx < totalLines - 1;
    t.nextNonBlank = nextNonBlank(lines, idx);
    t.isLastProcessed = isLastProcessedLine(idx, totalLines, lines);
    if (t.htmlType <= 5 && htmlBlockEnds(t.htmlType, line.toLowerCase(), line)) {
      finalize(t, refs, 1);
      t.open = false;
    }
    clearFlagsUp(t);
    return;
  }
  if (t.t === 'code') {
    if (ls.indentAhead() >= 4) {
      ls.advanceCols(4);
      t.lines.push(ls.rest());
      clearFlagsUp(t);
      return;
    }
    finalize(t, refs);
    t.open = false;
    t = deepestOpen(root);
  }
  if (t.t === 'table') {
    if (startsBlock(ls, true)) {
      finalize(t, refs);
      t.open = false;
      t = deepestOpen(root);
    } else {
      const cells = splitCells(ls.rest());
      const row = new Array(t.header.length);
      for (let k = 0; k < t.header.length; k++) row[k] = k < cells.length ? cells[k] : '';
      t.rows.push(row);
      clearFlagsUp(t);
      return;
    }
  }
  if (t.t === 'para') {
    t.lastLazy = false;
    if (ls.isBlank()) {
      // A whitespace-only remainder (e.g. after a '>' marker) is a
      // paragraph line, not a blank line.
      t.lines.push(ls.rest());
      clearFlagsUp(t);
      return;
    }
    const st = trySetext(ls);
    if (st !== 0) {
      // Leading link reference definitions are stripped before the
      // heading is formed (and registered: the paragraph is never
      // finalized on this path). With no content left, the
      // underline is an ordinary paragraph continuation line.
      const s = t.lines.join('\n');
      let di = 0;
      for (;;) {
        const d = tryParseDef(s, di);
        if (!d) break;
        const key = normalizeLabel(d.label);
        if (!refs.has(key)) refs.set(key, { href: d.dest, title: d.title });
        di = d.end;
      }
      const rest = s.slice(di);
      if (rest.trim() === '') {
        t.lines.push(ls.rest());
        clearFlagsUp(t);
        return;
      }
      const parent = t.parent;
      const head = {
        t: 'head', level: st,
        text: rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
        open: false,
      };
      const kids = parent.children;
      const at = kids.indexOf(t);
      if (at !== -1) kids[at] = head;
      else kids.push(head);
      head.parent = parent;
      t.open = false;
      clearFlagsUp(head);
      return;
    }
    const td = tryTableDelim(ls, t);
    if (td) {
      convertParaToTable(t, td, refs);
      clearFlagsUp(deepestOpen(root));
      return;
    }
    const parent = t.parent;
    if (!tryBlockStarts(ls, parent, t, refs, idx, totalLines, lines)) {
      t.lines.push(ls.rest());
    }
    clearFlagsUp(deepestOpen(root));
    return;
  }
  tryBlockStarts(ls, container, null, refs, idx, totalLines, lines);
  clearFlagsUp(deepestOpen(root));
}

function parseBlocks(text, refs) {
  const lines = text.split('\n');
  const root = { t: 'doc', children: [], open: true, parent: null, lastBlank: false };
  for (let i = 0; i < lines.length; i++) processLine(lines, i, root, refs);
  closeUpTo(root, root, refs, 2);
  root.open = false;
  return root;
}

// ---------- inline parser ----------
// Item kinds: 0 text, 1 entity, 2 delimiter, 3 code, 4 html,
// 5 autolink, 6 hard break, 7 link, 8 image, 9 emphasis wrapper,
// 10 open bracket.

function flanking(src, i, len) {
  const before = i > 0 ? src.charCodeAt(i - 1) : -1;
  const after = i + len < src.length ? src.charCodeAt(i + len) : -1;
  const beforeSpace = before === -1 ? true : isSpaceCode(before);
  const afterSpace = after === -1 ? true : isSpaceCode(after);
  const beforePunct = before === -1 ? false : isPunctCode(before);
  const afterPunct = after === -1 ? false : isPunctCode(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return { left, right, beforePunct, afterPunct };
}

function matchEntity(src, i) {
  const n = src.length;
  if (i + 1 < n && src.charCodeAt(i + 1) === 35) {
    let j = i + 2;
    let hex = false;
    if (j < n && (src.charCodeAt(j) === 120 || src.charCodeAt(j) === 88)) {
      hex = true;
      j++;
    }
    const st = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (hex
        ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
        : c >= 48 && c <= 57) j++;
      else break;
    }
    if (j > st && j < n && src.charCodeAt(j) === 59) {
      // Numeric references are capped: at most 7 decimal digits or
      // 6 hex digits; longer runs are literal text.
      if (hex ? j - st > 6 : j - st > 7) return null;
      let code = parseInt(src.slice(st, j), hex ? 16 : 10);
      if (!isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
      return { s: String.fromCodePoint(code), end: j + 1, raw: false };
    }
    return null;
  }
  let j = i + 1;
  if (j < n) {
    const c0 = src.charCodeAt(j);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      j++;
      while (j < n && isAlnumCode(src.charCodeAt(j))) j++;
      if (j < n && src.charCodeAt(j) === 59) return { s: src.slice(i, j + 1), end: j + 1, raw: true };
    }
  }
  return null;
}

function findCodeEnd(src, i, runLen) {
  const n = src.length;
  let j = i;
  while (j < n) {
    if (src.charCodeAt(j) === 96) {
      let k = j;
      while (k < n && src.charCodeAt(k) === 96) k++;
      if (k - j === runLen) return j;
      j = k;
    } else j++;
  }
  return -1;
}

function matchInlineHtml(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return i + 5;
    if (src.startsWith('<!--->', i)) return i + 6;
    const e = src.indexOf('-->', i + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    return e === -1 ? -1 : e + 3;
  }
  if (i + 2 < n && src.charCodeAt(i + 1) === 33) {
    const c = src.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const e = src.indexOf('>', i + 3);
      return e === -1 ? -1 : e + 1;
    }
  }
  return scanHtmlTag(src, i);
}

function matchAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j < n) {
    const c0 = src.charCodeAt(j);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      j++;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (isAlnumCode(c) || c === 43 || c === 46 || c === 45) j++;
        else break;
      }
      const schemeLen = j - (i + 1);
      if (schemeLen >= 2 && schemeLen <= 32 && j < n && src.charCodeAt(j) === 58) {
        let k = j + 1;
        while (k < n) {
          const c = src.charCodeAt(k);
          if (c === 62) {
            const dest = src.slice(i + 1, k);
            return { href: dest, text: dest, end: k + 1 };
          }
          if (c === 32 || c === 60 || c < 32) break;
          k++;
        }
      }
    }
  }
  // Email form.
  j = i + 1;
  const st = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
        c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 ||
        c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
        c === 125 || c === 126 || c === 45) j++;
    else break;
  }
  if (j === st || j >= n || src.charCodeAt(j) !== 64) return null;
  j++;
  // Domain: label (. label)*
  for (;;) {
    if (j >= n) return null;
    const lc = src.charCodeAt(j);
    if (!isAlnumCode(lc)) return null;
    j++;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isAlnumCode(c) || c === 45) j++;
      else break;
    }
    if (j < n && src.charCodeAt(j) === 46) {
      j++;
      continue;
    }
    break;
  }
  if (j >= n || src.charCodeAt(j) !== 62) return null;
  const email = src.slice(i + 1, j);
  return { href: 'mailto:' + email, text: email, end: j + 1 };
}

// --- GFM extended autolinks ---

function scanUrl(src, i, stopBracket) {
  let j = i;
  const n = src.length;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c <= 32 || c === 127 || c === 60) break;
    // A ']' that closes a bracket (followed by '(' or '[') is not
    // part of the URL when a '[' is open: marked resolves the link
    // at the '[' first, so the URL inside the label stops here and
    // the ']' closes the link instead of being swallowed.
    if (stopBracket && c === 93 && j + 1 < n &&
        (src.charCodeAt(j + 1) === 40 || src.charCodeAt(j + 1) === 91)) break;
    j++;
  }
  return j;
}

// Trim a scanned GFM URL exactly the way marked's _backpedal does:
// apply the backpedal regex in a loop until the URL stops changing.
// The regex matches the longest valid prefix: runs of ordinary chars,
// balanced '(...)' groups, '&' not starting an entity reference, and
// runs of trailing punctuation that are NOT at the end of the string.
// A '(' with no later ')' is therefore dropped together with the rest
// ('a](b' -> 'a]'), and a ')' that closes a balanced group is kept
// ('a(b))' -> 'a(b)', 'a)](b)' -> 'a)](b)').
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimUrl(src, start, end) {
  let url = src.slice(start, end);
  for (;;) {
    const before = url;
    url = BACKPEDAL.exec(url)?.[0] ?? '';
    if (url === before) break;
  }
  return start + url.length;
}

function matchWww(src, i, stopBracket) {
  const n = src.length;
  if (i + 4 >= n) return null;
  const c = src.charCodeAt(i + 4);
  if (!isWordCode(c) && c !== 45) return null;
  const end = trimUrl(src, i, scanUrl(src, i, stopBracket));
  if (end <= i + 4) return null;
  const url = src.slice(i, end);
  return { href: 'http://' + url, text: url, end };
}

function matchSchemeLink(src, i, stopBracket) {
  const n = src.length;
  let schemeLen = 0;
  const c0 = src.charCodeAt(i);
  if (c0 === 104 || c0 === 72) {
    if (src.slice(i, i + 8).toLowerCase() === 'https://') schemeLen = 8;
    else if (src.slice(i, i + 7).toLowerCase() === 'http://') schemeLen = 7;
  } else if (c0 === 102 || c0 === 70) {
    if (src.slice(i, i + 6).toLowerCase() === 'ftp://') schemeLen = 6;
  }
  if (schemeLen === 0) return null;
  const hostAt = i + schemeLen;
  if (hostAt >= n) return null;
  const c = src.charCodeAt(hostAt);
  if (!isWordCode(c) && c !== 45) return null;
  const end = trimUrl(src, i, scanUrl(src, i, stopBracket));
  if (end <= hostAt) return null;
  const url = src.slice(i, end);
  return { href: url, text: url, end };
}

// GFM email, matching marked's regex:
// [A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])
// Each dot-label must end with an alphanumeric char; after the match
// the next char must not be a word char or '-'. When it is, the regex
// backtracks by dropping the last dot-label (so 'when@atlas.example.com_'
// still links 'when@atlas.example', while 'a@b.c_' links nothing).
// One exception: a '_' right after the address is an emphasis closer,
// not part of the word, when an '_' opener is still unmatched on the
// items stack — then the full address links ('__a b@c.d__' links
// 'b@c.d', because marked strips the emphasis delimiters first).
function scanGfmEmail(src, i, items) {
  const n = src.length;
  let j = i;
  const st = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isWordCode(c) || c === 46 || c === 43 || c === 45) j++;
    else break;
  }
  if (j === st) return -1;
  if (j >= n || src.charCodeAt(j) !== 64) return -1;
  j++;
  const firstStart = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isWordCode(c) || c === 45) j++;
    else break;
  }
  if (j === firstStart) return -1;
  // Dot-labels, each ending at its last alphanumeric char (a trailing
  // '_' or '-' is not part of the label). Record each label end so the
  // lookahead can backtrack by dropping labels.
  const labelEnds = [];
  while (j < n && src.charCodeAt(j) === 46 && j + 1 < n) {
    const nc = src.charCodeAt(j + 1);
    if (!isWordCode(nc) && nc !== 45) break;
    let k = j + 1;
    let lastAlnum = -1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (isWordCode(c) || c === 45) {
        if (isAlnumCode(c)) lastAlnum = k;
        k++;
      } else break;
    }
    if (lastAlnum < j + 1) break;
    j = lastAlnum + 1;
    labelEnds.push(j);
  }
  if (labelEnds.length === 0) return -1;
  for (let li = labelEnds.length - 1; li >= 0; li--) {
    const end = labelEnds[li];
    if (end >= n) return end;
    const nc = src.charCodeAt(end);
    if (!isWordCode(nc) && nc !== 45) return end;
    if (nc === 95 && items) {
      for (let q = items.length - 1; q >= 0; q--) {
        const it = items[q];
        if (it.k === 2 && it.ch === 95 && it.open) return end;
      }
    }
  }
  return -1;
}

function matchGfmEmail(src, i, items) {
  if (src.startsWith('mailto:', i)) {
    const e = scanGfmEmail(src, i + 7, items);
    if (e !== -1) {
      const text = src.slice(i, e);
      return { href: text, text, end: e };
    }
    return null;
  }
  if (src.startsWith('xmpp:', i)) {
    const e = scanGfmEmail(src, i + 5, items);
    if (e === -1) return null;
    let end = e;
    if (e < src.length && src.charCodeAt(e) === 47) {
      // One optional path segment after the address.
      let j = e + 1;
      const n = src.length;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (c <= 32 || c === 127 || c === 60 || c === 47 || c === 63 || c === 35) break;
        j++;
      }
      if (j > e + 1) {
        const te = trimUrl(src, i, j);
        end = te > e + 1 ? te : e;
      }
    }
    const text = src.slice(i, end);
    return { href: text, text, end };
  }
  const e = scanGfmEmail(src, i, items);
  if (e === -1) return null;
  const text = src.slice(i, e);
  return { href: 'mailto:' + text, text, end: e };
}

function wwwAllowed(prevChar) {
  return prevChar === -1 || isSpaceCode(prevChar) ||
    prevChar === 40 || prevChar === 42 || prevChar === 95 || prevChar === 126;
}

// Parse an inline link destination/title starting at src[openParen]
// === '('. Returns {href, title, end} or null.
function tryInlineLink(src, openParen) {
  const n = src.length;
  let k = spnl(src, openParen + 1);
  if (k < n && src.charCodeAt(k) === 41) return { href: '', title: null, end: k + 1 };
  const d = parseDest(src, k);
  if (!d) return null;
  const afterDest = d.end;
  k = spnl(src, afterDest);
  if (k < n && src.charCodeAt(k) === 41) return { href: d.dest, title: null, end: k + 1 };
  if (k === afterDest) return null; // a title needs preceding whitespace
  const t = parseTitle(src, k);
  if (!t) return null;
  k = spnl(src, t.end);
  if (k < n && src.charCodeAt(k) === 41) return { href: d.dest, title: t.title, end: k + 1 };
  return null;
}

// Resolve a link/image at the ']' at src[j] against the open bracket:
// inline first, then full/collapsed reference, then the shortcut
// form (barred when another bracket followed the opener).
// Returns {href, title, end} or null.
// Whether a link label contains a backtick that marked's label regex
// cannot match: every backtick run must either open a code span (a
// run, non-backtick content, a closing run) or sit immediately before
// the closing ']' ('``+(?=])'). A stray backtick blocks inline /
// full / collapsed link resolution (images and shortcut links are
// unaffected).
function labelHasStrayBacktick(src, start, end) {
  let k = start;
  while (k < end) {
    const c = src.charCodeAt(k);
    if (c === 92 && k + 1 < end) { k += 2; continue; }
    if (c !== 96) { k++; continue; }
    let run = 0;
    while (k + run < end && src.charCodeAt(k + run) === 96) run++;
    let m = k + run;
    while (m < end && src.charCodeAt(m) !== 96) m++;
    if (m < end && m > k + run) {
      let crun = 0;
      while (m + crun < end && src.charCodeAt(m + crun) === 96) crun++;
      k = m + crun;
      continue;
    }
    if (k + run === end) return false;
    return true;
  }
  return false;
}

function tryResolveLink(src, j, opener, refs) {
  const n = src.length;
  const next = j + 1 < n ? src.charCodeAt(j + 1) : -1;
  const stray = !opener.image && (next === 40 || next === 91) &&
    labelHasStrayBacktick(src, opener.srcEnd, j);
  if (next === 40 && !stray) {
    const res = tryInlineLink(src, j + 1);
    if (res) return res;
    // A failed inline attempt falls through to the reference forms.
  }
  if (stray && next === 91) return null;
  let lab = null;
  if (next === 91) lab = scanLabel(src, j + 1);
  if (lab && lab.label.trim() !== '') {
    const ref = refs.get(normalizeLabel(lab.label));
    if (ref) return { href: ref.href, title: ref.title, end: lab.end };
    return null;
  }
  if (!opener.bracketAfter) {
    const key = normalizeLabel(src.slice(opener.srcEnd, j));
    if (key !== '') {
      const ref = refs.get(key);
      if (ref) return { href: ref.href, title: ref.title, end: lab ? lab.end : j + 1 };
    }
  }
  return null;
}

function stripGfmAutolinks(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k === 5 && it.gfm) items[i] = { k: 0, s: it.text };
    else if (it.k === 9 || it.k === 7) stripGfmAutolinks(it.children);
  }
  return items;
}

// The delimiter-stack emphasis algorithm over one flat item list.
// `~` runs match only equal-length runs and produce <del>; `*` and `_`
// follow the CommonMark matching rules including the rule of three.
function itemsHaveBacktick(items) {
  for (const it of items) {
    if (it.k === 0 && it.s.indexOf('`') >= 0) return true;
    if (it.k === 3) return true;
    if ((it.k === 9 || it.k === 7 || it.k === 8) && it.children &&
        itemsHaveBacktick(it.children)) return true;
  }
  return false;
}

function processEmphasis(items, inLabel) {
  const rebuild = () => {
    const ds = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].k === 2) ds.push({ it: items[i], idx: i });
    }
    return ds;
  };
  let delims = rebuild();
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di].it;
    if (!closer.close) {
      di++;
      continue;
    }
    let oi = -1;
    for (let j = di - 1; j >= 0; j--) {
      const o = delims[j].it;
      if (o.ch !== closer.ch || !o.open) continue;
      if (o.ch !== 126) {
        if ((o.close || closer.open) && (o.len + closer.len) % 3 === 0 &&
            !(o.len % 3 === 0 && closer.len % 3 === 0)) continue;
      } else if (o.len !== closer.len) {
        continue;
      }
      oi = j;
      break;
    }
    if (oi === -1) {
      di++;
      continue;
    }
    const opener = delims[oi].it;
    const use = opener.ch === 126 ? opener.len
      : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
    const oIdx = delims[oi].idx;
    const cIdx = delims[di].idx;
    // Marked emStrong `m`-counting: in `**X *Y*Z* W**` the `*`
    // after Z stays literal inside the <strong> (the inner em's
    // closer is followed by a word char, so the outer `**` is not
    // consumed by the single `*`). But in `**a *b* c* d**` (inner
    // em's closer followed by a space) the single `*` DOES pair
    // with the `**` opener (nested <em>). Replicate: a one-star
    // closer pairing with a two-star opener is skipped when an
    // <em> node inside is immediately followed by text starting
    // with a word char and a later `**` closer exists.
    if (use === 1 && opener.ch === 42 && opener.len >= 2 && closer.len === 1) {
      let emWord = false;
      for (let q = oIdx + 1; q < cIdx; q++) {
        if (items[q].k === 9 && items[q].tag === 'em' && items[q].ch === 42 &&
            q + 1 < cIdx && items[q + 1].k === 0 && items[q + 1].s.length > 0 &&
            isWordCode(items[q + 1].s.charCodeAt(0))) { emWord = true; break; }
      }
      if (emWord) {
        let laterStrong = false;
        for (let q = di + 1; q < delims.length; q++) {
          if (delims[q].it.ch === 42 && delims[q].it.len >= 2 && delims[q].it.close) {
            laterStrong = true; break;
          }
        }
        if (laterStrong) { di++; continue; }
      }
    }
    // In `**X *Y **Z**W* V**` the inner `*Y **Z**W*` must NOT form
    // an <em>: marked lexes the outer <strong>'s inner text
    // separately, where the `*`s have no closer (the final `**`
    // belongs to the outer strong). Replicate: a one-star <em>
    // whose span holds a <strong> immediately followed by text
    // starting with a word char, whose opener sits inside an
    // unmatched `**` opener, and with a later `**` closer, is
    // skipped (the `*`s stay literal). (cm-432 `*bar **baz**\nbim*`
    // DOES form: the strong there is followed by a newline.)
    if (use === 1 && opener.ch === 42 && opener.len === 1 && closer.len === 1) {
      let hasStrongWord = false;
      for (let q = oIdx + 1; q < cIdx; q++) {
        if (items[q].k === 9 && items[q].tag === 'strong' &&
            q + 1 < cIdx && items[q + 1].k === 0 && items[q + 1].s.length > 0 &&
            isWordCode(items[q + 1].s.charCodeAt(0))) { hasStrongWord = true; break; }
      }
      if (hasStrongWord) {
        let inStrong = false, laterStrong = false;
        for (let q = 0; q < delims.length; q++) {
          const d = delims[q];
          if (d.idx < oIdx && d.it.ch === 42 && d.it.len >= 2 && d.it.open) inStrong = true;
          if (d.idx > cIdx && d.it.ch === 42 && d.it.len >= 2 && d.it.close) laterStrong = true;
        }
        if (inStrong && laterStrong) {
          // Both `*`s stay literal: deactivate the opener too, so
          // the later `**` pairs with the outer `**` (not this `*`).
          opener.open = false;
          di++;
          continue;
        }
      }
    }
    // Marked quirk (its regex-based emStrong): in `*a **b**c*` the
    // outer `*` stays literal, while in `*foo**bar**baz*` (cm-411)
    // it forms. Its scanner counts an inner `**` opener against the
    // outer opener's length only when that opener is preceded by
    // whitespace, and it skips the inner closer by the rule of three
    // only when the closer is followed by a word char. Replicate:
    // a one-char closer for an <em>, immediately preceded by text
    // starting with a word char, itself immediately preceded by a
    // <strong> node of the SAME char that sits inside the opener,
    // with the text before that strong node ending in whitespace —
    // then the outer emphasis does not form.
    if (use === 1 && opener.ch !== 126 && cIdx >= 3) {
      const after = items[cIdx - 1];
      const strong = items[cIdx - 2];
      const beforeStrong = items[cIdx - 3];
      if (after && after.k === 0 && after.s.length > 0 &&
          isWordCode(after.s.charCodeAt(0)) &&
          strong && strong.k === 9 && strong.tag === 'strong' &&
          strong.ch === opener.ch && oIdx < cIdx - 2 &&
          beforeStrong && beforeStrong.k === 0 &&
          beforeStrong.s.length > 0) {
        const last = beforeStrong.s.charCodeAt(beforeStrong.s.length - 1);
        if (last === 32 || last === 9 || last === 10) {
          di++;
          continue;
        }
      }
    }
    // Marked #n-masking veto for `_` (its emStrong scans a masked
    // text where links/code spans are hidden, so a `_` whose span
    // crosses one never matches): inside a link label (or an
    // unresolved bracket), a `_` wrapping a code span whose content
    // holds a backtick (`` `` a ` b `` ``) stays literal.
    // At paragraph level, a `_`/`__` is blocked when a link whose
    // label holds a LITERAL backtick (an unclosed backtick run, e.g.
    // `` ``url` ``) appears earlier in the paragraph and a code
    // span appears after the emphasis (the blockSkip code-span
    // match spans from the link's stray backtick to the later code
    // span, hiding the `_` in between).
    if (opener.ch === 95) {
      let bad = false;
      for (let q = oIdx + 1; q < cIdx; q++) {
        if (items[q].k === 3 && items[q].s.indexOf('`') >= 0) { bad = true; break; }
      }
      if (bad && (inLabel || (() => {
        for (let q = 0; q < oIdx; q++) if (items[q].k === 10) return true;
        return false;
      })())) { di++; continue; }
      if (!inLabel && !bad) {
        let linkStray = false;
        for (let q = 0; q < oIdx; q++) {
          if (items[q].k === 7 && items[q].children) {
            // A stray (unclosed) double-backtick run in the label,
            // e.g. `` ``url` `` — a single escaped backtick (`\``)
            // does not count (doc-07).
            const hasStray = (its) => {
              for (const it of its) {
                if (it.k === 0 && it.s.indexOf('``') >= 0) return true;
                if ((it.k === 9 || it.k === 7 || it.k === 8) && it.children &&
                    hasStray(it.children)) return true;
              }
              return false;
            };
            if (hasStray(items[q].children)) { linkStray = true; break; }
          }
        }
        if (linkStray) {
          let codeAfter = false;
          for (let q = cIdx + 1; q < items.length; q++) {
            if (items[q].k === 3) { codeAfter = true; break; }
          }
          if (codeAfter) { di++; continue; }
        }
      }
    }
    // Marked #n-masking veto for `*` emphasis: same blockSkip span
    // as the `_` veto — a link with a stray `` `` `` in its label
    // before the emphasis and a code span (even inside a later
    // link's label) after it hides the `*...*` / `**...**` in marked.
    if (opener.ch === 42 && !inLabel) {
      let linkStray = false;
      for (let q = 0; q < oIdx; q++) {
        if (items[q].k === 7 && items[q].children) {
          const hasStray = (its) => {
            for (const it of its) {
              if (it.k === 0 && it.s.indexOf('``') >= 0) return true;
              if ((it.k === 9 || it.k === 7 || it.k === 8) && it.children &&
                  hasStray(it.children)) return true;
            }
            return false;
          };
          if (hasStray(items[q].children)) { linkStray = true; break; }
        }
      }
      if (linkStray) {
        const hasCode = (its) => {
          for (const it of its) {
            if (it.k === 3) return true;
            if ((it.k === 9 || it.k === 7 || it.k === 8) && it.children &&
                hasCode(it.children)) return true;
          }
          return false;
        };
        let codeAfter = false;
        for (let q = cIdx + 1; q < items.length; q++) {
          if (hasCode([items[q]])) { codeAfter = true; break; }
        }
        if (codeAfter) { di++; continue; }
      }
    }
    const children = items.slice(oIdx + 1, cIdx);
    const tag = opener.ch === 126 ? 'del' : (use === 2 ? 'strong' : 'em');
    const node = { k: 9, tag, children, ch: opener.ch };
    opener.len -= use;
    closer.len -= use;
    // In `**X *Y*Z***` the leftover `*` of the `***` closer belongs
    // INSIDE the <strong> (`<strong>X <em>Y</em>Z*</strong>`), while
    // in `**foo***` it stays outside. The discriminator is an <em>
    // inside immediately followed by text starting with a word char.
    if (use === 2 && closer.len > 0 && opener.ch === 42) {
      let emWord = false;
      for (let q = 0; q < children.length; q++) {
        if (children[q].k === 9 && children[q].tag === 'em' && children[q].ch === 42 &&
            q + 1 < children.length && children[q + 1].k === 0 &&
            children[q + 1].s.length > 0 &&
            isWordCode(children[q + 1].s.charCodeAt(0))) { emWord = true; break; }
      }
      if (emWord) {
        children.push({ k: 0, s: '*'.repeat(closer.len) });
        closer.len = 0;
      }
    }
    const repl = [];
    if (opener.len > 0) repl.push(opener);
    repl.push(node);
    if (closer.len > 0) repl.push(closer);
    items.splice(oIdx, cIdx - oIdx + 1, ...repl);
    delims = rebuild();
    let nd = -1;
    for (let q = 0; q < delims.length; q++) {
      if (delims[q].it === closer) {
        nd = q;
        break;
      }
    }
    if (nd === -1) {
      const nodeIdx = oIdx + (opener.len > 0 ? 1 : 0);
      nd = delims.length;
      for (let q = 0; q < delims.length; q++) {
        if (delims[q].idx > nodeIdx) {
          nd = q;
          break;
        }
      }
    }
    di = nd;
  }
  return items;
}

function scanInline(src, refs, st) {
  const items = [];
  const brackets = [];
  const n = src.length;
  let text = '';
  let prevChar = -1;
  let afterHard = false;
  let i = 0;
  const flush = () => {
    if (text !== '') {
      items.push({ k: 0, s: text });
      text = '';
    }
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (afterHard) {
      // Leading spaces/tabs of the line after a hard break are
      // dropped; soft breaks keep them.
      if (c === 32 || c === 9) {
        i++;
        continue;
      }
      afterHard = false;
    }
    if (c === 92) {
      if (i + 1 < n) {
        const nc = src.charCodeAt(i + 1);
        if (isAsciiPunctCode(nc)) {
          text += src[i + 1];
          prevChar = nc;
          i += 2;
          continue;
        }
        if (nc === 10) {
          flush();
          items.push({ k: 6 });
          prevChar = -1;
          afterHard = true;
          i += 2;
          continue;
        }
      }
      text += '\\';
      prevChar = 92;
      i++;
      continue;
    }
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      const close = findCodeEnd(src, j, runLen);
      // Marked resolves a link at '[' before considering a code span
      // inside the label, and its label regex accepts a code span
      // with ANY closing backtick run (`` `+ ... `+ ``), while the
      // rendered code span needs equal runs. A ']' that lies after
      // the label-regex span still closes the label (doc-09:
      // `` ``url` `` ends at the single backtick, the ']' after it
      // closes the link). The label-regex span is then literal text
      // in the rendered label — skip it wholesale so neither its
      // opening run (a rendered span swallowing the ']') nor its
      // closing backtick (a fresh one-backtick span swallowing the
      // ']', doc-28/35) can form. But when the ']' is INSIDE the
      // label-regex span, the link cannot form and the rendered span
      // is correct instead (cm-342); and when the rendered span
      // closes before the ']' it does not swallow it
      // ([a ``b`c`` d] renders <code>b`c</code>).
      if (brackets.length > 0) {
        let m = j;
        while (m < n && src.charCodeAt(m) !== 96) m++;
        if (m < n && m > j) {
          let cr = 0;
          while (m + cr < n && src.charCodeAt(m + cr) === 96) cr++;
          const labelEnd = m + cr;
          let b = j;
          while (b < n) {
            const bc = src.charCodeAt(b);
            if (bc === 92) { b += 2; continue; }
            if (bc === 93) break;
            b++;
          }
          if (b >= labelEnd && (close === -1 || b < close)) {
            text += src.slice(i, labelEnd);
            prevChar = 96;
            i = labelEnd;
            continue;
          }
        }
      }
      if (close !== -1) {
        let content = src.slice(j, close);
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
            content.charCodeAt(content.length - 1) === 32) {
          let allSpaces = true;
          for (let k = 0; k < content.length; k++) {
            if (content.charCodeAt(k) !== 32) {
              allSpaces = false;
              break;
            }
          }
          if (!allSpaces) content = content.slice(1, -1);
        }
        flush();
        items.push({ k: 3, s: content });
        prevChar = -1;
        i = close + runLen;
        continue;
      }
      text += src.slice(i, j);
      prevChar = 96;
      i = j;
      continue;
    }
    if (c === 38) {
      const ent = matchEntity(src, i);
      if (ent) {
        if (ent.raw) {
          flush();
          items.push({ k: 1, s: ent.s });
          prevChar = 59;
        } else {
          text += ent.s;
          prevChar = ent.s.charCodeAt(ent.s.length - 1);
        }
        i = ent.end;
        continue;
      }
      text += '&';
      prevChar = 38;
      i++;
      continue;
    }
    if (c === 60) {
      const he = matchInlineHtml(src, i);
      if (he !== -1) {
        flush();
        const tag = src.slice(i, he);
        items.push({ k: 4, s: tag });
        // marked's inLink flag (per parse, shared across blocks):
        // '<a ' (open tag with attributes) sets it, '</a>' clears it.
        // '<a>' and '<a/>' do not set it (startATag is /^<a /i).
        if (!st.inLink && tag.length >= 3 && tag.charCodeAt(0) === 60 &&
            (tag.charCodeAt(1) === 97 || tag.charCodeAt(1) === 65) &&
            tag.charCodeAt(2) === 32) {
          st.inLink = true;
        } else if (st.inLink && tag.length >= 4 && tag.charCodeAt(0) === 60 &&
            tag.charCodeAt(1) === 47 &&
            (tag.charCodeAt(2) === 97 || tag.charCodeAt(2) === 65) &&
            tag.charCodeAt(3) === 62) {
          st.inLink = false;
        }
        prevChar = -1;
        i = he;
        continue;
      }
      const al = matchAutolink(src, i);
      if (al) {
        flush();
        items.push({ k: 5, href: al.href, text: al.text, gfm: false });
        prevChar = -1;
        i = al.end;
        continue;
      }
      text += '<';
      prevChar = 60;
      i++;
      continue;
    }
    if (c === 91) {
      flush();
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ itemIdx: items.length, image: false, srcEnd: i + 1, active: true, bracketAfter: false });
      items.push({ k: 10, image: false });
      prevChar = 91;
      i++;
      continue;
    }
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) {
      flush();
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ itemIdx: items.length, image: true, srcEnd: i + 2, active: true, bracketAfter: false });
      items.push({ k: 10, image: true });
      prevChar = 91;
      i += 2;
      continue;
    }
    if (c === 93) {
      flush();
      if (brackets.length === 0) {
        text += ']';
        prevChar = 93;
        i++;
        continue;
      }
      const b = brackets[brackets.length - 1];
      if (!b.active) {
        brackets.pop();
        text += ']';
        prevChar = 93;
        i++;
        continue;
      }
      const res = tryResolveLink(src, i, b, refs);
      if (!res) {
        brackets.pop();
        text += ']';
        prevChar = 93;
        i++;
        continue;
      }
      let segment = processEmphasis(items.slice(b.itemIdx + 1), true);
      let node;
      if (b.image) {
        node = { k: 8, alt: renderInline(segment, true), href: res.href, title: res.title };
      } else {
        segment = stripGfmAutolinks(segment);
        node = { k: 7, children: segment, href: res.href, title: res.title };
      }
      items.length = b.itemIdx;
      items.push(node);
      brackets.pop();
      if (!b.image) {
        for (const ob of brackets) if (!ob.image) ob.active = false;
      }
      prevChar = -1;
      i = res.end;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const len = j - i;
      if (c === 95) {
        // GFM autolinks are suppressed while an inline '<a ...>'
        // tag is unclosed (marked's per-parse inLink flag).
        const em = st.inLink ? null : matchGfmEmail(src, i, items);
        if (em) {
          flush();
          items.push({ k: 5, href: em.href, text: em.text, gfm: true });
          prevChar = -1;
          i = em.end;
          continue;
        }
      }
      if (c === 126 && len >= 3) {
        text += src.slice(i, j);
        prevChar = 126;
        i = j;
        continue;
      }
      const fl = flanking(src, i, len);
      let open;
      let close;
      if (c === 95) {
        open = fl.left && (!fl.right || fl.beforePunct);
        close = fl.right && (!fl.left || fl.afterPunct);
      } else {
        open = fl.left;
        close = fl.right;
      }
      flush();
      items.push({ k: 2, ch: c, len, open, close });
      prevChar = c;
      i = j;
      continue;
    }
    if (c === 10) {
      let sp = 0;
      for (let k = text.length - 1; k >= 0 && text.charCodeAt(k) === 32; k--) sp++;
      if (sp >= 2) {
        text = text.slice(0, text.length - sp);
        flush();
        items.push({ k: 6 });
        prevChar = -1;
        afterHard = true;
      } else {
        text += '\n';
        prevChar = 10;
      }
      i++;
      continue;
    }
    if (!st.inLink && c === 119 && src.charCodeAt(i + 1) === 119 && src.charCodeAt(i + 2) === 119 &&
        src.charCodeAt(i + 3) === 46 && wwwAllowed(prevChar)) {
      // Only stop the URL at a ']' that would close a link: the ']'
      // closes the topmost bracket, and only an ACTIVE one can form
      // a link (an inner link deactivates the outer brackets, so a
      // ']' after one is literal text and belongs to the URL).
      const topActive = brackets.length > 0 && brackets[brackets.length - 1].active;
      const m = matchWww(src, i, topActive);
      if (m) {
        flush();
        items.push({ k: 5, href: m.href, text: m.text, gfm: true });
        prevChar = -1;
        i = m.end;
        continue;
      }
    }
    if (!st.inLink && (c === 104 || c === 72 || c === 102 || c === 70)) {
      const topActive = brackets.length > 0 && brackets[brackets.length - 1].active;
      const m = matchSchemeLink(src, i, topActive);
      if (m) {
        flush();
        items.push({ k: 5, href: m.href, text: m.text, gfm: true });
        prevChar = -1;
        i = m.end;
        continue;
      }
    }
    if (!st.inLink && (isWordCode(c) || c === 46 || c === 43 || c === 45)) {
      const m = matchGfmEmail(src, i, items);
      if (m) {
        flush();
        items.push({ k: 5, href: m.href, text: m.text, gfm: true });
        prevChar = -1;
        i = m.end;
        continue;
      }
    }
    text += src[i];
    prevChar = c;
    i++;
  }
  flush();
  return processEmphasis(items);
}

function renderInline(items, plain) {
  let out = '';
  for (const it of items) {
    switch (it.k) {
      case 0:
        out += escPlain(it.s);
        break;
      case 1:
        out += it.s;
        break;
      case 2:
        out += String.fromCharCode(it.ch).repeat(it.len);
        break;
      case 3:
        out += plain ? escPlain(it.s) : '<code>' + escPlain(it.s) + '</code>';
        break;
      case 4:
        out += plain ? escPlain(it.s) : it.s;
        break;
      case 5: {
        const t = escPlain(it.text);
        if (plain) out += t;
        else out += '<a href="' + escPlain(encodeHref(it.href)) + '">' + t + '</a>';
        break;
      }
      case 6:
        out += '<br>';
        break;
      case 7: {
        if (plain) {
          out += renderInline(it.children, true);
        } else {
          out += '<a href="' + escAttr(encodeHref(it.href)) + '"';
          if (it.title !== null && it.title !== undefined) out += ' title="' + escAttr(it.title) + '"';
          out += '>' + renderInline(it.children, false) + '</a>';
        }
        break;
      }
      case 8: {
        if (plain) {
          out += it.alt;
        } else {
          out += '<img src="' + escAttr(encodeHref(it.href)) + '" alt="' + it.alt + '"';
          if (it.title !== null && it.title !== undefined) out += ' title="' + escAttr(it.title) + '"';
          out += '>';
        }
        break;
      }
      case 9: {
        if (plain) out += renderInline(it.children, true);
        else out += '<' + it.tag + '>' + renderInline(it.children, false) + '</' + it.tag + '>';
        break;
      }
      case 10:
        out += it.image ? '![' : '[';
        break;
    }
  }
  return out;
}

function inline(text, refs, st) {
  return renderInline(scanInline(text, refs, st), false);
}

// ---------- block rendering ----------

function alignAttr(a) {
  if (a === 1) return ' align="left"';
  if (a === 2) return ' align="center"';
  if (a === 3) return ' align="right"';
  return '';
}

function renderItem(item, loose, refs, out, st) {
  let checkbox = null;
  let firstText = null;
  const first = item.children.length > 0 ? item.children[0] : null;
  if (first && first.t === 'para') {
    const tx = first.text;
    if (tx.length >= 4 && tx.charCodeAt(0) === 91 &&
        (tx.charCodeAt(1) === 32 || tx.charCodeAt(1) === 120 || tx.charCodeAt(1) === 88) &&
        tx.charCodeAt(2) === 93 &&
        (tx.charCodeAt(3) === 32 || tx.charCodeAt(3) === 9)) {
      checkbox = tx.charCodeAt(1) === 32
        ? '<input disabled="" type="checkbox">'
        : '<input checked="" disabled="" type="checkbox">';
      firstText = tx.slice(4);
    }
  }
  out.push('<li>');
  for (let idx = 0; idx < item.children.length; idx++) {
    const child = item.children[idx];
    if (child.t === 'para') {
      const body = idx === 0 && firstText !== null ? firstText : child.text;
      if (loose) {
        out.push('<p>');
        if (idx === 0 && checkbox) out.push(checkbox, ' ');
        out.push(inline(body, refs, st), '</p>\n');
      } else {
        if (idx === 0 && checkbox) out.push(checkbox, ' ');
        out.push(inline(body, refs, st));
      }
    } else {
      renderBlock(child, refs, out, st);
    }
  }
  out.push('</li>\n');
}

function renderBlock(b, refs, out, st) {
  switch (b.t) {
    case 'head':
      out.push('<h', String(b.level), '>', inline(b.text, refs, st), '</h', String(b.level), '>\n');
      break;
    case 'para':
      out.push('<p>', inline(b.text, refs, st), '</p>\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'code':
      out.push('<pre><code');
      if (b.lang) out.push(' class="language-', escAttr(b.lang), '"');
      out.push('>', escPlain(b.literal), '</code></pre>\n');
      break;
    case 'html':
      out.push(b.literal);
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const c of b.children) renderBlock(c, refs, out, st);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      if (b.ordered) {
        if (b.start !== 1) out.push('<ol start="', String(b.start), '">\n');
        else out.push('<ol>\n');
      } else {
        out.push('<ul>\n');
      }
      for (const item of b.children) renderItem(item, b.loose, refs, out, st);
      out.push(b.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < b.header.length; k++) {
        out.push('<th', alignAttr(b.aligns[k]), '>', inline(b.header[k], refs, st), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let k = 0; k < row.length; k++) {
            out.push('<td', alignAttr(b.aligns[k]), '>', inline(row[k], refs, st), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

// ---------- entry point ----------

export function parse(markdown) {
  const text = markdown.indexOf('\r') === -1
    ? markdown
    : markdown.replace(/\r\n?/g, '\n');
  const refs = new Map();
  // Per-parse lexer state, shared across every inline() call in
  // this document (marked keeps the same Lexer for the whole doc):
  // inLink is set by an inline '<a ...>' open tag and cleared by
  // '</a>'; while set, GFM autolinks are suppressed.
  const st = { inLink: false };
  const root = parseBlocks(text, refs);
  const out = [];
  for (const child of root.children) renderBlock(child, refs, out, st);
  return out.join('');
}

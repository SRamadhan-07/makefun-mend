// mend: the CLI SPEC.md specifies. Node 22, standard library alone; run as `node main.ts [options] [PATCH]` with
// the working directory as the root of a tree of text files. It reads a patch in one of four formats (unified
// diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers, writes every change or none, and prints what changed or why it failed, as SPEC.md sections 1 to 10 say.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print (SPEC.md section 2). */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
/** One edit's failure: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (section 3): split at `\n`, one trailing `\r` removed from each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3). */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, in order, for the `R` lines of section 2. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines (section 3): its own line break, its lines, and whether it ends with a line break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function writeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** A file an edit creates: LF breaks (section 3). */
function createdFile(lines: string[], final: boolean): string {
  return writeFile({ br: '\n', lines, final });
}

// Section 5: matching lines at three tiers.

const NORMS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

function tiersOf(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every start position at or after `from` where `old` matches `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const norm = NORMS[tier]!;
  const target = old.map(norm);
  const out: number[] = [];
  for (let i = Math.max(0, from); i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (norm(lines[i + j]!) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence of `old` at or after `from` (end-of-file occurrences only when `eofOnly`). */
function findTier(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; at: number[] } | null {
  for (const t of tiersOf(strict)) {
    let at = occurrences(lines, old, t, from);
    if (eofOnly) at = at.filter((p) => p + old.length === lines.length);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const t of tiersOf(strict)) {
    const norm = NORMS[t]!;
    const target = norm(anchor);
    for (let i = from; i < lines.length; i += 1) if (norm(lines[i]!) === target) return i;
  }
  return -1;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** Tier 2 (section 5): a new line that starts with P has that P replaced by F; empty and whitespace-only lines stay. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk: in O and N (ctx), in O only (del) or in N only (add). */
interface Item {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line (no newline at end of file) follows this line; unified hunks only. */
  nonl: boolean;
  /** The patch line was empty; unified hunks only, for the trailing-empty-lines rule of section 6. */
  emptyLine: boolean;
}

function oldOf(items: Item[]): string[] {
  const out: string[] = [];
  for (const it of items) if (it.kind !== 'add') out.push(it.text);
  return out;
}

/**
 * The lines a matched hunk or chunk writes (section 5): a context line is the file's own matched line, and at
 * tier 2 every other new line is re-indented from O's first line's indentation to the file's first matched line's.
 */
function buildNew(items: Item[], fileLines: string[], pos: number, tier: number, old: string[]): string[] {
  const f = tier === 2 ? leadWs(fileLines[pos]!) : '';
  const p = tier === 2 ? leadWs(old[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(it.text, f, p) : it.text);
    }
  }
  return out;
}

/** The lines a SEARCH/REPLACE block writes: no line of N is a context line, so tier 2 re-indents them all. */
function buildNewPlain(newLines: string[], fileLines: string[], pos: number, tier: number, old: string[]): string[] {
  if (tier !== 2) return [...newLines];
  const f = leadWs(fileLines[pos]!);
  const p = leadWs(old[0]!);
  return newLines.map((l) => reindent(l, f, p));
}

/** Whether a `\` line follows the last context or `+` line of a hunk's items (section 6). */
function lastContentNonl(items: Item[]): boolean {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.nonl;
  }
  return false;
}

// Section 4: detecting the format.

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// Section 9: JSON edits.

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const fin = before !== '' && before.endsWith(br);
      if (fin) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (fin ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Section 6: unified diffs.

interface Hunk {
  a: number;
  items: Item[];
  newLen: number;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  /** The `---`/`+++` paths; undefined until the pair is seen, null for `/dev/null`. */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The paths of a `diff --git a/<X> b/<Y>` line, or a parse error at its line when it is not of that form. */
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const mid = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (mid < 0) throw new Exit2(`error: parse ${lineNo}`);
  return [rest.slice(2, mid), rest.slice(mid + 3)];
}

/** A `---`/`+++` path: after the four characters, up to the first tab, spaces removed, a leading `a/` or `b/` removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function renamePath(line: string, prefix: string): string {
  let p = line.slice(prefix.length);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

function newSection(gitOld: string | null, gitNew: string | null): Section {
  return { gitOld, gitNew, pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [] };
}

/** Reads one section's header and hunks from index `i`; returns the index the section ends at. */
function sectionBody(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  // The header: everything before the first hunk.
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('@@')) {
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (sec.pairOld !== undefined) return i;
      sec.pairOld = headerPath(l);
      sec.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.renOld = renamePath(l, 'rename from ');
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renNew = renamePath(l, 'rename to ');
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.newFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // any other header line is ignored
  }
  // The hunks.
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (!l.startsWith('@@')) {
      i += 1; // outside bodies, lines that are not part of a header are ignored
      continue;
    }
    const m = HUNK_RE.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const a = parseInt(m[1]!, 10);
    i += 1;
    const items: Item[] = [];
    while (i < n) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      const c = b[0];
      if (c === ' ') items.push({ kind: 'ctx', text: b.slice(1), nonl: false, emptyLine: false });
      else if (c === '-') items.push({ kind: 'del', text: b.slice(1), nonl: false, emptyLine: false });
      else if (c === '+') items.push({ kind: 'add', text: b.slice(1), nonl: false, emptyLine: false });
      else if (c === '\\') {
        const prev = items[items.length - 1];
        if (prev !== undefined) prev.nonl = true;
      } else if (b === '') items.push({ kind: 'ctx', text: '', nonl: false, emptyLine: true });
      else break;
      i += 1;
    }
    while (items.length > 0 && items[items.length - 1]!.emptyLine) items.pop();
    let newLen = 0;
    for (const it of items) if (it.kind !== 'del') newLen += 1;
    sec.hunks.push({ a, items, newLen });
  }
  return i;
}

/** A section's old and new paths: the `---`/`+++` pair, else the rename lines, else the `diff --git` paths. */
function sectionPaths(sec: Section): { oldP: string | null; newP: string | null } {
  if (sec.pairOld !== undefined) return { oldP: sec.pairOld, newP: sec.pairNew ?? null };
  if (sec.renOld !== undefined || sec.renNew !== undefined) {
    return { oldP: sec.renOld ?? sec.gitOld, newP: sec.renNew ?? sec.gitNew };
  }
  return { oldP: sec.gitOld, newP: sec.gitNew };
}

/** Applies a section's hunks in order to a file's state; `d` tracks the sections' line drift (section 6). */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, errPath: string): FileState {
  const lines = [...st.lines];
  let fin = st.final;
  let d = 0;
  for (const h of hunks) {
    const old = oldOf(h.items);
    if (old.length === 0) {
      const add = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
      const idx = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = idx === lines.length;
      lines.splice(idx, 0, ...add);
      if (atEnd) fin = !lastContentNonl(h.items);
    } else {
      const found = findTier(lines, old, strict, 0, false);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      for (const cand of found.at) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      const built = buildNew(h.items, lines, pos, found.tier, old);
      const runsToEnd = pos + old.length === lines.length;
      lines.splice(pos, old.length, ...built);
      if (runsToEnd) fin = !lastContentNonl(h.items);
    }
    d += h.newLen - old.length;
  }
  return { br: st.br, lines, final: fin };
}

/** One unified section as one edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = sectionPaths(sec);
    if (oldP === null && newP === null) return;
    if (sec.newFile || oldP === null) {
      // A creation: the file is the `+` lines of all its hunks.
      const p = newP ?? oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastNonl = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            out.push(it.text);
            lastNonl = it.nonl;
          }
        }
      }
      tree.now.set(p, createdFile(out, !lastNonl));
      return;
    }
    if (sec.delFile || newP === null) {
      // A deletion: its hunks are not read.
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      // A move: the hunks apply to the old file's lines and the result is written at the new path.
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const st = applyHunks(parseFile(before), sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, writeFile(st));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, writeFile(applyHunks(parseFile(before), sec.hunks, strict, p)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const [gx, gy] = gitPaths(l, i + 1);
      const sec = newSection(gx, gy);
      sections.push(sec);
      i = sectionBody(lines, i + 1, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = newSection(null, null);
      sections.push(sec);
      i = sectionBody(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    } else {
      i += 1; // prose outside sections is ignored
    }
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, createdFile([...newLines], true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = parseFile(before);
    const found = findTier(st.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const built = buildNewPlain(newLines, st.lines, pos, found.tier, oldLines);
    const out = [...st.lines];
    out.splice(pos, oldLines.length, ...built);
    tree.now.set(path, writeFile({ br: st.br, lines: out, final: st.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    prevPath = path;
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// Section 8: V4A patches.

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

/** The chunks of an Update File section's lines; `rawStart` is the patch index of `raw[0]`, for parse errors. */
function parseChunks(raw: string[], rawStart: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let closed = true;
  raw.forEach((l, k) => {
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      chunks.push(cur);
      closed = false;
    } else if (l.trim() === '*** End of File') {
      if (cur === null || closed) {
        cur = { anchor: null, items: [], eof: true };
        chunks.push(cur);
      } else {
        cur.eof = true;
      }
      closed = true;
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null || closed) {
        cur = { anchor: null, items: [], eof: false };
        chunks.push(cur);
        closed = false;
      }
      const kind = l.startsWith('-') ? 'del' : l.startsWith('+') ? 'add' : 'ctx';
      cur.items.push({ kind, text: l === '' ? '' : l.slice(1), nonl: false, emptyLine: l === '' });
    } else {
      throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
  });
  return chunks;
}

function vAdd(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, createdFile([...content], true));
  };
}

function vDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdate(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(before);
    const lines = [...st.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(lines, ch.anchor, strict, cursor);
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      const old = oldOf(ch.items);
      if (old.length === 0) {
        const add = ch.items.map((it) => it.text);
        const idx = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(idx, 0, ...add);
        cursor = idx + add.length;
      } else {
        const found = findTier(lines, old, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.at[0]!;
        const built = buildNew(ch.items, lines, pos, found.tier, old);
        lines.splice(pos, old.length, ...built);
        cursor = pos + built.length;
      }
    }
    const out = writeFile({ br: st.br, lines, final: st.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let k = 0; k < n; k += 1) {
    if (!blank(lines[k]!)) {
      if (first < 0) first = k;
      last = k;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i += 1;
      // A `+` line's rest is a line of the file even when empty; a bare empty line is one too, but only the
      // bare ones at the end of the section are the blank lines section 8 leaves out of it.
      const content: Array<{ text: string; bare: boolean }> = [];
      while (i < last) {
        const c = lines[i]!;
        if (c.startsWith('+')) {
          content.push({ text: c.slice(1), bare: false });
          i += 1;
        } else if (c === '') {
          content.push({ text: '', bare: true });
          i += 1;
        } else break;
      }
      while (content.length > 0 && content[content.length - 1]!.bare) content.pop();
      edits.push(vAdd(path, content.map((c) => c.text)));
    } else if (l.startsWith('*** Delete File: ')) {
      edits.push(vDelete(l.slice('*** Delete File: '.length).trim()));
      i += 1;
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const headLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const rawStart = i;
      while (i < last) {
        const c = lines[i]!;
        if (c.startsWith('*** Add File: ') || c.startsWith('*** Delete File: ') || c.startsWith('*** Update File: ')) break;
        i += 1;
      }
      const raw = lines.slice(rawStart, i);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const chunks = parseChunks(raw, rawStart);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      edits.push(vUpdate(path, moveTo, chunks, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

// Sections 1, 2 and 10: the command line, the run, and the all-or-nothing write.

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // The changed paths, in byte order; a successful move replaces its pair's `D` and `A` lines with one `R` line.
  const cur = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (consumed.has(o) || consumed.has(nw)) continue;
    if (tree.original(o) !== null && cur(o) === null && tree.original(nw) === null && cur(nw) !== null) {
      rows.push({ key: nw, text: `R ${o} -> ${nw}` });
      consumed.add(o);
      consumed.add(nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

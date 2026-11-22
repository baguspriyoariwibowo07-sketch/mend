// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI models write,
// in four formats (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls), to a tree of files.
// It finds the lines an edit names at the first of three matching tiers (section 5), applies every edit or
// none (section 10), and prints what it changed or why it failed (section 2). Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ended with a line break (section 3). */
interface FileState {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Current path -> original path it was moved from (for R lines, section 2). */
  readonly origin = new Map<string, string>();
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

/** Move a file inside the tree, remembering where it came from. */
function moveInTree(tree: Tree, oldP: string, newP: string, text: string): void {
  const o = tree.origin.has(oldP) ? tree.origin.get(oldP)! : oldP;
  tree.origin.delete(oldP);
  tree.now.set(oldP, null);
  tree.now.set(newP, text);
  tree.origin.set(newP, o);
}

type Edit = (tree: Tree) => void;

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

// ---- Matching lines (section 5) ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in lines at the tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; null when it never occurs. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from` count. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos: pos[0]! };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
interface NewEntry {
  text: string;
  /** Index into O when this is a context line, else -1. */
  oIndex: number;
}

/** Split hunk/chunk body items into old lines O and new lines N (with context marks). */
function splitOps(items: BodyItem[]): { o: string[]; n: NewEntry[] } {
  const o: string[] = [];
  const n: NewEntry[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push({ text: it.text, oIndex: o.length });
      o.push(it.text);
    } else if (it.kind === 'del') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, oIndex: -1 });
    }
  }
  return { o, n };
}

/**
 * Render N at a match: context lines are the file's own matched lines; at tier 2 every other
 * non-blank line that starts with O's first line's leading whitespace has that whitespace
 * replaced by the file's first matched line's leading whitespace.
 */
function buildNewLines(n: NewEntry[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  if (tier !== 2 || o.length === 0) {
    return n.map((e) => (e.oIndex >= 0 ? fileLines[pos + e.oIndex]! : e.text));
  }
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(o[0]!);
  return n.map((e) => {
    if (e.oIndex >= 0) return fileLines[pos + e.oIndex]!;
    const t = e.text;
    if (t !== '' && !onlyWs(t) && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** One line of a hunk or chunk body: context, old, or new. `backslash` marks a `\` line after it. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  backslash: boolean;
}

// ---- JSON edits (section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---- Unified diffs (section 6) ----

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
const isDashPair = (lines: string[], i: number): boolean =>
  lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

/** The path a `--- ` / `+++ ` line names: after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxPlusBackslash(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.backslash;
  }
  return false;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (!m || (m[5] !== '' && !/^[ \t]/.test(m[5]!))) throw new Exit2(`error: parse ${i + 1}`);
  const items: BodyItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (isDiffGitLine(l)) break;
    if (isDashPair(lines, j)) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', backslash: false });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1), backslash: false });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'del', text: l.slice(1), backslash: false });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'add', text: l.slice(1), backslash: false });
      j++;
      continue;
    }
    if (c === '\\') {
      if (items.length > 0) items[items.length - 1]!.backslash = true;
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it (unless a `\` line follows one).
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '' && !last.backslash) items.pop();
    else break;
  }
  return { hunk: { a: parseInt(m[1]!, 10), items }, next: j };
}

/**
 * Parse one section's header (from `i`, just past its `diff --git` line, or at its `--- ` line)
 * and its hunks; return the index of the first line after the section.
 */
function parseSection(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  let hasDash = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      break;
    }
    if (isDiffGitLine(line)) break;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (hasDash) break; // a further pair starts a new section
        sec.oldPath = dashPath(line);
        sec.newPath = dashPath(lines[i + 1]!);
        hasDash = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.newFile = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (!hasDash) {
    if (renameFrom !== null) sec.oldPath = renameFrom;
    if (renameTo !== null) sec.newPath = renameTo;
  }
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (isDiffGitLine(line)) break;
    if (isDashPair(lines, i)) break;
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (isDiffGitLine(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { oldPath: m[1]!, newPath: m[2]!, newFile: false, delFile: false, hunks: [] };
      i = parseSection(lines, i + 1, sec);
      sections.push(sec);
      continue;
    }
    if (isDashPair(lines, i)) {
      const sec: UniSection = { oldPath: null, newPath: null, newFile: false, delFile: false, hunks: [] };
      i = parseSection(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyUniHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, failPath: string): { state: FileState; d: number } {
  const { o, n } = splitOps(hunk.items);
  if (o.length === 0) {
    const at = Math.min(hunk.a + d, state.lines.length);
    const newLines = buildNewLines(n, state.lines, at, 0, o);
    let fb = state.finalBreak;
    if (at === state.lines.length) fb = !lastCtxPlusBackslash(hunk.items);
    return {
      state: { br: state.br, lines: [...state.lines.slice(0, at), ...newLines, ...state.lines.slice(at)], finalBreak: fb },
      d: d + n.length,
    };
  }
  const found = findTier(state.lines, o, strict);
  if (!found) throw new Fail('no-match', failPath);
  const target = hunk.a - 1 + d;
  let best = found.pos[0]!;
  let bd = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bd) {
      best = p;
      bd = dist;
    }
  }
  const newLines = buildNewLines(n, state.lines, best, found.tier, o);
  const runsToEnd = best + o.length === state.lines.length;
  const fb = runsToEnd ? !lastCtxPlusBackslash(hunk.items) : state.finalBreak;
  return {
    state: { br: state.br, lines: [...state.lines.slice(0, best), ...newLines, ...state.lines.slice(best + o.length)], finalBreak: fb },
    d: d + (n.length - o.length),
  };
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const creation = sec.newFile || sec.oldPath === null;
  const deletion = !creation && (sec.delFile || sec.newPath === null);
  const move = !creation && !deletion && sec.oldPath !== sec.newPath;
  return (tree) => {
    if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    if (sec.oldPath === null && sec.newPath === null) return;
    if (creation) {
      const p = sec.newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            plus.push(it.text);
            lastPlusBs = it.backslash;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = sec.oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      tree.origin.delete(p);
      return;
    }
    const oldP = sec.oldPath!;
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (move) {
      const newP = sec.newPath!;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let state = parseFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyUniHunk(state, h, d, strict, oldP);
        state = r.state;
        d = r.d;
      }
      moveInTree(tree, oldP, newP, renderFile(state));
      return;
    }
    let state = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUniHunk(state, h, d, strict, oldP);
      state = r.state;
      d = r.d;
    }
    tree.now.set(oldP, renderFile(state));
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const nEntries: NewEntry[] = newLines.map((t) => ({ text: t, oIndex: -1 }));
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const state = parseFile(cur);
    const found = findTier(state.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const built = buildNewLines(nEntries, state.lines, pos, found.tier, oldLines);
    const lines = [...state.lines.slice(0, pos), ...built, ...state.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile({ br: state.br, lines, finalBreak: state.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  ops: BodyItem[];
}

const V4A_PREFIXES: ReadonlyArray<readonly [string, 'add' | 'delete' | 'update']> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const [prefix, kind] of V4A_PREFIXES) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
    tree.origin.delete(path);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = parseFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTierFrom(state.lines, [chunk.anchor], cursor, strict);
        if (!found) throw new Fail('no-match', path);
        cursor = found.pos + 1;
      }
      const { o, n } = splitOps(chunk.ops);
      if (o.length === 0) {
        const at = chunk.eof ? state.lines.length : cursor;
        const built = buildNewLines(n, state.lines, at, 0, o);
        state = {
          br: state.br,
          lines: [...state.lines.slice(0, at), ...built, ...state.lines.slice(at)],
          finalBreak: state.finalBreak,
        };
        cursor = at + built.length;
        continue;
      }
      let tierFound: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const pos = occurrences(state.lines, o, t).filter(
          (p) => p >= cursor && (!chunk.eof || p + o.length === state.lines.length),
        );
        if (pos.length > 0) {
          tierFound = { tier: t, pos: pos[0]! };
          break;
        }
      }
      if (tierFound === null) throw new Fail('no-match', path);
      const built = buildNewLines(n, state.lines, tierFound.pos, tierFound.tier, o);
      state = {
        br: state.br,
        lines: [...state.lines.slice(0, tierFound.pos), ...built, ...state.lines.slice(tierFound.pos + o.length)],
        finalBreak: state.finalBreak,
      };
      cursor = tierFound.pos + built.length;
    }
    const text = renderFile(state);
    if (moveTo !== null) moveInTree(tree, path, moveTo, text);
    else tree.now.set(path, text);
  };
}

/** Parse an Update File section's raw lines (trailing blank lines already removed) into its edit. */
function parseV4aUpdate(path: string, raw: string[], sectionLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  let cur: V4aChunk | null = null;
  let chunkOpen = false;
  let seenChunk = false;
  for (let k = idx; k < raw.length; k++) {
    const l = raw[k]!;
    const lineNo = sectionLine + 1 + k;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
      chunks.push(cur);
      chunkOpen = true;
      seenChunk = true;
      continue;
    }
    if (l === '*** End of File') {
      if (!chunkOpen || cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunkOpen = false;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!chunkOpen) {
        if (seenChunk) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, ops: [] };
        chunks.push(cur);
        chunkOpen = true;
        seenChunk = true;
      }
      const kind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add';
      cur!.ops.push({ kind, text: l === '' ? '' : l.slice(1), backslash: false });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return v4aUpdateEdit(path, moveTo, chunks, strict);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const start = v4aSectionStart(line);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && v4aSectionStart(lines[j]!) === null) j++;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (start.kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(start.path, fileLines));
    } else if (start.kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aDeleteEdit(start.path));
    } else {
      edits.push(parseV4aUpdate(start.path, raw, i + 1, strict));
    }
    i = j;
  }
  return edits;
}

// ---- Running the CLI (sections 1, 2, 10) ----

interface OutRow {
  key: string;
  text: string;
  path: string;
  kind: 'A' | 'D' | 'M' | 'R';
}

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
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeOrigin = new Map(tree.origin);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.origin.clear();
      for (const [k, v] of beforeOrigin) tree.origin.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  let rows: OutRow[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) rows.push({ key: p, text: `D ${p}`, path: p, kind: 'D' });
    else if (was === null) rows.push({ key: p, text: `A ${p}`, path: p, kind: 'A' });
    else rows.push({ key: p, text: `M ${p}`, path: p, kind: 'M' });
  }
  // A move that succeeded replaces its D and A lines with one R line, sorted by the new path.
  for (const p of [...tree.now.keys()]) {
    const now = tree.now.get(p)!;
    if (now === null) continue;
    if (tree.original(p) !== null) continue;
    const o = tree.origin.get(p);
    if (o === undefined) continue;
    if (tree.original(o) === null) continue;
    if (tree.get(o) !== null) continue;
    rows = rows.filter((r) => !(r.kind === 'D' && r.path === o) && !(r.kind === 'A' && r.path === p));
    rows.push({ key: p, text: `R ${o} -> ${p}`, path: p, kind: 'R' });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now !== null && now !== tree.original(p)) {
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

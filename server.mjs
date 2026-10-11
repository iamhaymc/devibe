#!/usr/bin/env node
// devibe server — scans repos, builds one model of their content, runs checks,
// stages edits for review, drives the editing agent, and talks to the client
// over a single WebSocket.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { index, liftTo, isUnder, walk, boundary, linkIndices, strongGroups, STATIC as STATIC_KINDS } from './sets.mjs';

export { strongGroups };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const posix = path.posix;

// ───────────────────────────── Languages ─────────────────────────────

const C_STYLE = { line: ['//'], block: [['/*', '*/']], quotes: `"'` };
const HASH_STYLE = { line: ['#'], block: [], quotes: `"'` };

export const LANGS = [
  { id: 'cs', name: 'C#', exts: ['.cs', '.csx'], ...C_STYLE },
  { id: 'java', name: 'Java', exts: ['.java'], ...C_STYLE },
  { id: 'kt', name: 'Kotlin', exts: ['.kt', '.kts'], ...C_STYLE },
  { id: 'scala', name: 'Scala', exts: ['.scala', '.sc'], ...C_STYLE },
  { id: 'swift', name: 'Swift', exts: ['.swift'], ...C_STYLE },
  { id: 'dart', name: 'Dart', exts: ['.dart'], ...C_STYLE },
  { id: 'go', name: 'Go', exts: ['.go'], ...C_STYLE, quotes: '"\'`' },
  { id: 'rs', name: 'Rust', exts: ['.rs'], ...C_STYLE },
  { id: 'c', name: 'C', exts: ['.c', '.h'], ...C_STYLE },
  { id: 'cpp', name: 'C++', exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.ino', '.cu'], ...C_STYLE },
  { id: 'js', name: 'JavaScript', exts: ['.js', '.mjs', '.cjs', '.jsx'], ...C_STYLE, quotes: '"\'`' },
  { id: 'ts', name: 'TypeScript', exts: ['.ts', '.tsx', '.mts', '.cts'], ...C_STYLE, quotes: '"\'`' },
  { id: 'vue', name: 'Vue', exts: ['.vue', '.svelte'], ...C_STYLE, quotes: '"\'`' },
  { id: 'php', name: 'PHP', exts: ['.php'], line: ['//', '#'], block: [['/*', '*/']], quotes: `"'` },
  { id: 'py', name: 'Python', exts: ['.py', '.pyi', '.pyw'], ...HASH_STYLE, indent: true },
  { id: 'rb', name: 'Ruby', exts: ['.rb', '.rake', '.gemspec'], ...HASH_STYLE, block: [['=begin', '=end']], indent: true },
  { id: 'lua', name: 'Lua', exts: ['.lua'], line: ['--'], block: [['--[[', ']]']], quotes: `"'`, indent: true },
  { id: 'sh', name: 'Shell', exts: ['.sh', '.bash', '.zsh', '.fish', '.ps1'], ...HASH_STYLE },
  { id: 'sql', name: 'SQL', exts: ['.sql'], line: ['--'], block: [['/*', '*/']], quotes: `'"` },
  { id: 'html', name: 'HTML', exts: ['.html', '.htm', '.cshtml', '.razor', '.xhtml'], line: [], block: [['<!--', '-->']], quotes: '' },
  { id: 'css', name: 'CSS', exts: ['.css', '.scss', '.sass', '.less'], line: [], block: [['/*', '*/']], quotes: `"'` },
  { id: 'json', name: 'JSON', exts: ['.json', '.jsonc', '.json5'], data: true },
  { id: 'yaml', name: 'YAML', exts: ['.yml', '.yaml'], data: true },
  { id: 'toml', name: 'TOML', exts: ['.toml', '.ini', '.cfg', '.conf', '.properties', '.editorconfig'], data: true },
  { id: 'xml', name: 'XML', exts: ['.xml', '.csproj', '.fsproj', '.vbproj', '.props', '.targets', '.xaml', '.axaml', '.plist', '.svg', '.resx', '.config', '.nuspec'], data: true },
  { id: 'md', name: 'Markdown', exts: ['.md', '.mdx', '.markdown', '.rst', '.adoc'], data: true },
  { id: 'text', name: 'Text', exts: ['.txt', '.csv', '.tsv', '.env', '.log', '.lock', '.sum'], data: true },
];
export const LANG = Object.fromEntries(LANGS.map((L) => [L.id, L]));
const BY_EXT = new Map(LANGS.flatMap((L) => L.exts.map((e) => [e, L.id])));
const BY_BASE = { dockerfile: 'sh', makefile: 'sh', 'cmakelists.txt': 'sh', gemfile: 'rb', rakefile: 'rb', license: 'text', 'readme': 'md' };
const LOCK_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'go.sum', 'poetry.lock', 'composer.lock', 'gemfile.lock', 'packages.lock.json', 'bun.lockb', 'uv.lock', 'pipfile.lock']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bower_components', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'coverage', '.idea', '.vs', '.gradle', '.terraform', '.devibe', 'Pods', 'DerivedData']);
const MAX_BYTES = 2_000_000;
const MAX_FILES = 40_000;

export function langOf(rel) {
  const base = posix.basename(rel).toLowerCase();
  return BY_BASE[base] ?? BY_EXT.get(posix.extname(base)) ?? 'text';
}

const KEYWORDS = new Set(`abstract and as assert async await base bool boolean break byte case catch char chan class const constructor continue crate def default defer del delete do double dyn elif else enum except export extends extern false final finally float fn for foreach from func function get go goto if impl implements import in init instanceof int interface internal is lambda let long loop match mod module mut namespace new nil none not null object of or out override package pass private protected pub public raise readonly ref return sealed select self set short static string struct super switch this throw throws trait true try type typeof uint unsafe use using val var virtual void volatile when where while with yield None True False Self`.split(/\s+/));
const NOT_FUNC = new Set('if else for foreach while do switch case catch try finally using lock fixed checked unchecked return new delete throw sizeof typeof nameof alignof decltype when match guard defer synchronized function func fn fun def sub await yield in of is as with assert elif except unless until select go super this base self print echo require import export typeid static_assert'.split(' '));
const TYPE_WORDS = new Set(['class', 'struct', 'interface', 'enum', 'record', 'trait', 'object', 'protocol', 'extension', 'union', 'impl', 'namespace', 'module', 'mixin', 'actor', 'new', 'extends', 'implements', 'typedef', 'type']);
const PRE_STOP = /(?:^|[^\w$])(?:new|return|await|throw|else|case|typeof|yield|in|of|delete|echo|print|do|goto)\s*$|[.=,(!?&|+\-*/%^~]\s*$/;

// ───────────────────────────── Masking ─────────────────────────────
// Replace comments and string contents with spaces (newlines kept) so that
// later passes see only code, with every offset and line number intact.

const blank = (s) => (s.indexOf('\n') < 0 ? ' '.repeat(s.length) : s.replace(/[^\n]/g, ' '));
const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));

export function maskCode(text, langId) {
  const L = LANG[langId];
  if (!L || L.data) return text;
  const lineToks = L.line ?? [], blocks = L.block ?? [], quotes = L.quotes ?? '';
  const js = langId === 'js' || langId === 'ts' || langId === 'vue';
  const starts = new Set([...lineToks, ...blocks.map((b) => b[0])].map((t) => t[0]));
  for (const q of quotes) starts.add(q);
  if (js) starts.add('/');
  if (langId === 'rs') starts.add('r');
  const n = text.length;
  let out = '', last = 0, i = 0, prev = '';
  while (i < n) {
    const c = text[i];
    if (!starts.has(c)) { if (c > ' ') prev = c; i++; continue; }
    let j = -1;
    for (const [a, b] of blocks) {
      if (text.startsWith(a, i) && (a !== '=begin' || i === 0 || text[i - 1] === '\n')) {
        const k = text.indexOf(b, i + a.length);
        j = k < 0 ? n : k + b.length;
        break;
      }
    }
    if (j < 0) {
      for (const t of lineToks) {
        if (text.startsWith(t, i) && (langId !== 'sh' || i === 0 || /\s/.test(text[i - 1]))) {
          const k = text.indexOf('\n', i);
          j = k < 0 ? n : k;
          break;
        }
      }
    }
    if (j >= 0) { out += text.slice(last, i) + blank(text.slice(i, j)); last = i = j; continue; }
    if (quotes.includes(c)) {
      j = stringEnd(text, i, langId);
      if (j > i) {
        const closed = j - i >= 2 && text[j - 1] === c;
        out += text.slice(last, i + 1) + blank(text.slice(i + 1, closed ? j - 1 : j)) + (closed ? c : '');
        last = i = j; prev = 'a';
        continue;
      }
    }
    if (js && c === '/' && (prev === '' || REGEX_PREV.has(prev) || /\b(?:return|typeof|case|do|else|in|of|yield|await|void|delete|throw)\s*$/.test(text.slice(Math.max(0, i - 12), i)))) {
      j = regexEnd(text, i);
      if (j > 0) { out += text.slice(last, i + 1) + blank(text.slice(i + 1, j)); last = i = j; prev = 'a'; continue; }
    }
    if (langId === 'rs' && c === 'r' && !/[\w]/.test(text[i - 1] ?? '') && /^r#*"/.test(text.slice(i, i + 12))) {
      const h = /^r(#*)"/.exec(text.slice(i, i + 12))[1];
      const k = text.indexOf('"' + h, i + 2 + h.length);
      j = k < 0 ? n : k + 1 + h.length;
      out += text.slice(last, i + 2 + h.length) + blank(text.slice(i + 2 + h.length, j));
      last = i = j; prev = 'a';
      continue;
    }
    if (c > ' ') prev = c;
    i++;
  }
  return out + text.slice(last);
}

function stringEnd(text, i, lang) {
  const c = text[i], n = text.length;
  if ((c === '"' || (c === "'" && (lang === 'py' || lang === 'dart'))) && text.startsWith(c + c + c, i)) {
    const k = text.indexOf(c + c + c, i + 3);
    return k < 0 ? n : k + 3;
  }
  if (lang === 'rs' && c === "'") {
    const m = /^'(?:\\.[^']{0,8}|[^\\'\n])'/.exec(text.slice(i, i + 14));
    return m ? i + m[0].length : -1;
  }
  const verbatim = lang === 'cs' && c === '"' && (text[i - 1] === '@' || (text[i - 1] === '$' && text[i - 2] === '@'));
  const raw = lang === 'go' && c === '`';
  const multi = c === '`' || verbatim || lang === 'sh' || lang === 'php' || lang === 'rb' || lang === 'sql';
  for (let j = i + 1; j < n; j++) {
    const d = text[j];
    if (d === '\\' && !verbatim && !raw) { j++; continue; }
    if (d === c) {
      if (verbatim && text[j + 1] === '"') { j++; continue; }
      return j + 1;
    }
    if (d === '\n' && !multi) return j;
  }
  return n;
}

function regexEnd(text, i) {
  let inClass = false;
  for (let j = i + 1; j < text.length && j < i + 400; j++) {
    const d = text[j];
    if (d === '\n') return -1;
    if (d === '\\') { j++; continue; }
    if (d === '[') inClass = true;
    else if (d === ']') inClass = false;
    else if (d === '/' && !inClass) {
      if (j === i + 1) return -1;
      let k = j + 1;
      while (/[a-z]/.test(text[k] ?? '')) k++;
      return k;
    }
  }
  return -1;
}

// ───────────────────────────── Text helpers ─────────────────────────────

function lineStarts(text) {
  const a = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) a.push(i + 1);
  return a;
}

function lineAt(starts, idx) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

// Map every '{', '(' and '[' to its partner. Tolerates stray closers.
function pairMap(masked) {
  const end = new Int32Array(masked.length).fill(-1);
  const stack = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked.charCodeAt(i);
    if (c === 123 || c === 40 || c === 91) stack.push(i);
    else if (c === 125 || c === 41 || c === 93) {
      const want = c === 125 ? 123 : c === 41 ? 40 : 91;
      let k = stack.length - 1;
      while (k >= 0 && masked.charCodeAt(stack[k]) !== want) k--;
      if (k < 0) continue;
      end[stack[k]] = i;
      stack.length = k;
    }
  }
  return end;
}

// End of a statement that starts near `i`: first ';' at depth 0, or a line
// break that does not continue the expression.
function statementEnd(masked, i, pairs) {
  const n = masked.length;
  for (let k = i; k < n; k++) {
    const c = masked[k];
    if ((c === '{' || c === '(' || c === '[') && pairs[k] > k) { k = pairs[k]; continue; }
    if (c === ';') return k;
    if (c === '\n') {
      const before = masked.slice(Math.max(i, k - 3), k).trimEnd();
      const after = masked.slice(k + 1, k + 160).trimStart();
      if (/[=+\-*/%&|?:,(.>]$/.test(before)) continue;
      if (/^[.?:+\-*/&|,)\]}]/.test(after) && !/^}/.test(after)) continue;
      return k;
    }
  }
  return n;
}

// ───────────────────────────── Symbols ─────────────────────────────
// A symbol is { kind, form, name, s, e, head, bases?, args?, recv? } where s/e
// are char offsets. kind is one of: space, type, func, part.

const TYPE_RE = {
  cs: /\b(class|struct|interface|enum|record(?:\s+struct|\s+class)?)\s+(@?[A-Za-z_]\w*)/g,
  java: /(?<![\w.])(class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/g,
  kt: /\b(class|interface|object)\s+([A-Za-z_]\w*)/g,
  scala: /\b(class|object|trait)\s+([A-Za-z_]\w*)/g,
  swift: /\b(class|struct|enum|protocol|extension|actor)\s+([A-Za-z_][\w.]*)/g,
  dart: /\b(class|mixin|enum|extension)\s+([A-Za-z_]\w*)/g,
  rs: /\b(struct|enum|trait|union|mod)\s+([A-Za-z_]\w*)/g,
  c: /\b(struct|union|enum)\s+([A-Za-z_]\w*)/g,
  cpp: /\b(class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/g,
  js: /\b(class)\s+([A-Za-z_$][\w$]*)/g,
  ts: /\b(class|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  vue: /\b(class|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  php: /\b(class|interface|trait|enum)\s+([A-Za-z_]\w*)/g,
};
const SPACE_RE = {
  cs: /\bnamespace\s+([A-Za-z_][\w.]*)\s*([{;])/g,
  cpp: /\bnamespace\s+([A-Za-z_][\w:]*)\s*(\{)/g,
  ts: /\b(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*(\{)/g,
  php: /\bnamespace\s+([A-Za-z_][\w\\]*)\s*([{;])/g,
};
const PARENS_OK = new Set(['kt', 'scala', 'cs', 'java', 'ts', 'js', 'vue', 'dart', 'php', 'swift']);
const LINE_DECL = new Set(['kt', 'scala', 'swift', 'dart']);
const CALL_RE = /([A-Za-z_$~][\w$]*(?:::~?[A-Za-z_]\w*)*)\s*(<(?:[^<>;{}()]|<[^<>;{}()]*>)*>)?\s*\(/g;
const AFTER_RE = /^\s*(?:(?:const|noexcept|override|final|mutable|volatile|async|throws\s+[\w.<>, ]+?|where\s+[^{;]+?|:\s*[^{;]+?|->\s*[^{;]+?)\s*)*(\{|=>)/;
// Declarations without a body: interface members, abstract methods, C prototypes.
const PROTO_RE = /^\s*(?:(?:const|noexcept|override|throws\s+[\w.<>, ]+?|->\s*[^{;=]+?|=\s*0)\s*)*;/;
const PROTO_LANGS = new Set(['cs', 'java', 'c', 'cpp', 'rs', 'php', 'dart']);
const TYPEY_PRE = /^[\s\w<>[\],.?*&:@$]*[\w>\]?*&]\s*$/;

export function readSymbols(text, masked, langId) {
  const L = LANG[langId];
  if (!L) return [];
  let raw;
  if (langId === 'md') raw = mdSymbols(text);
  else if (langId === 'yaml') raw = yamlSymbols(text);
  else if (langId === 'json') raw = jsonSymbols(text);
  else if (langId === 'toml') raw = tomlSymbols(text);
  else if (L.data || langId === 'html' || langId === 'css') raw = [];
  else if (langId === 'py') raw = indentSymbols(masked, 'py');
  else if (langId === 'rb' || langId === 'lua') raw = indentSymbols(masked, langId);
  else if (langId === 'sql') raw = sqlSymbols(masked);
  else if (langId === 'sh') raw = shellSymbols(masked);
  else raw = braceSymbols(masked, langId);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  for (const s of raw) {
    s.from = lineAt(starts, s.s);
    s.to = Math.max(s.from, lineAt(starts, Math.max(s.s, s.e - (masked[s.e - 1] === '\n' ? 1 : 0))));
    s.head ??= (lines[s.from - 1] ?? '').trim().slice(0, 160);
  }
  return nestSymbols(raw, masked, langId, lines);
}

function braceSymbols(masked, lang) {
  const out = [];
  const pairs = pairMap(masked);
  const spaceRe = SPACE_RE[lang];
  if (spaceRe) {
    for (const m of masked.matchAll(spaceRe)) {
      const brace = m.index + m[0].length - 1;
      const e = m[2] === '{' ? (pairs[brace] > 0 ? pairs[brace] + 1 : masked.length) : masked.length;
      out.push({ kind: 'space', form: 'namespace', name: m[1], s: m.index, e, body: brace });
    }
  }
  if (lang === 'go') return out.concat(goSymbols(masked, pairs));
  const typeRe = TYPE_RE[lang];
  if (typeRe) {
    for (const m of masked.matchAll(typeRe)) {
      const name = m[2].replace(/^@/, '');
      if (KEYWORDS.has(name)) continue;
      if (lang === 'kt' && /companion\s*$/.test(masked.slice(Math.max(0, m.index - 12), m.index))) continue;
      const found = typeBody(masked, m.index + m[0].length, pairs, lang);
      if (!found) continue;
      if (found.body < 0 && !(LINE_DECL.has(lang) || /record/.test(m[1]))) continue;
      const sig = masked.slice(m.index + m[0].length, found.body < 0 ? found.end : found.body);
      const form = m[1].replace(/\s+/g, ' ');
      out.push({ kind: 'type', form: form === '@interface' ? 'annotation' : form, name, s: m.index, e: found.end + 1, body: found.body, bases: readBases(sig) });
    }
  }
  if (lang === 'rs') {
    for (const m of masked.matchAll(/\bimpl\b\s*(?:<[^>{]*>)?\s*([\w:<>, ]+?)(?:\s+for\s+([\w:]+)[^{]*)?\s*\{/g)) {
      const brace = m.index + m[0].length - 1;
      const target = (m[2] ?? m[1]).replace(/<.*$/, '').split('::').pop().trim();
      if (!target) continue;
      const trait = m[2] ? m[1].replace(/<.*$/, '').trim() : null;
      out.push({ kind: 'type', form: 'impl', name: target, s: m.index, e: (pairs[brace] > 0 ? pairs[brace] : brace) + 1, body: brace, bases: trait ? [trait.split('::').pop()] : [] });
    }
  }
  if (lang === 'ts' || lang === 'vue') {
    for (const m of masked.matchAll(/(?<![\w$.])type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=;]*>)?\s*=(?!=)/g)) {
      out.push({ kind: 'type', form: 'type', name: m[1], s: m.index, e: statementEnd(masked, m.index + m[0].length, pairs) + 1, body: -1 });
    }
  }
  if (lang === 'kt' || lang === 'scala') {
    const re = lang === 'kt' ? /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/g : /\bdef\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/g;
    for (const m of masked.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = pairs[open];
      if (close < 0) continue;
      const rest = /^[^{=;\n]*/.exec(masked.slice(close + 1, close + 300))[0];
      const at = close + 1 + rest.length;
      let e, body = -1;
      if (masked[at] === '{') { body = at; e = pairs[at] > 0 ? pairs[at] + 1 : at + 1; }
      else if (masked[at] === '=') {
        const next = masked.slice(at + 1).search(/\S/) + at + 1;
        if (masked[next] === '{') { body = next; e = pairs[next] > 0 ? pairs[next] + 1 : next + 1; }
        else e = statementEnd(masked, at + 1, pairs) + 1;
      } else continue;
      out.push({ kind: 'func', form: 'function', name: m[1], s: m.index, e, body, args: countArgs(masked.slice(open + 1, close)) });
    }
  }
  if (lang === 'js' || lang === 'ts' || lang === 'vue') {
    const arrows = /(?:\b(?:const|let|var)\s+|^[ \t]*(?:(?:public|private|protected|readonly|static)\s+)*)([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b[^(\n]*\(|(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+?)?=>)/gm;
    for (const m of masked.matchAll(arrows)) {
      const name = m[1];
      if (KEYWORDS.has(name)) continue;
      let k = m.index + m[0].length;
      let body = -1, e;
      if (m[0].endsWith('(')) {
        const close = pairs[k - 1];
        const brace = close > 0 ? masked.indexOf('{', close) : -1;
        if (brace < 0 || pairs[brace] < 0) continue;
        body = brace; e = pairs[brace] + 1;
      } else {
        while (k < masked.length && /\s/.test(masked[k])) k++;
        if (masked[k] === '{' && pairs[k] > 0) { body = k; e = pairs[k] + 1; }
        else e = statementEnd(masked, k, pairs) + 1;
      }
      const open = masked.indexOf('(', m.index + m[1].length);
      const args = open > 0 && open < m.index + m[0].length && pairs[open] > 0 ? countArgs(masked.slice(open + 1, pairs[open])) : 1;
      out.push({ kind: 'func', form: 'function', name, s: m.index + m[0].indexOf(name), e, body, args });
    }
    for (const m of masked.matchAll(/:\s*(?:async\s+)?function\s*\*?\s*\(/g)) {
      const name = /([A-Za-z_$][\w$]*)\s*$/.exec(masked.slice(Math.max(0, m.index - 80), m.index))?.[1];
      if (!name) continue;
      const open = m.index + m[0].length - 1;
      const close = pairs[open];
      const brace = close > 0 ? masked.indexOf('{', close) : -1;
      if (brace < 0 || pairs[brace] < 0) continue;
      out.push({ kind: 'func', form: 'function', name, s: masked.lastIndexOf(name, m.index), e: pairs[brace] + 1, body: brace, args: countArgs(masked.slice(open + 1, close)) });
    }
  }
  for (const m of masked.matchAll(CALL_RE)) {
    let name = m[1];
    const tail = name.split('::').pop();
    if (NOT_FUNC.has(tail) || NOT_FUNC.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = pairs[open];
    if (close < 0) continue;
    const lineStart = masked.lastIndexOf('\n', m.index) + 1;
    const pre = masked.slice(Math.max(lineStart, m.index - 200), m.index);
    if (PRE_STOP.test(pre) && !/(?:->|::|=>)\s*$/.test(pre)) continue;
    const lastWord = /([A-Za-z_]\w*)\s*$/.exec(pre)?.[1];
    if (lastWord && TYPE_WORDS.has(lastWord)) continue;
    if (/#\s*define\b/.test(pre)) continue;
    const am = AFTER_RE.exec(masked.slice(close + 1, close + 240));
    if (!am) {
      if (PROTO_LANGS.has(lang) && pre.trim() && TYPEY_PRE.test(pre) && PROTO_RE.test(masked.slice(close + 1, close + 200))) {
        out.push({ kind: 'func', form: 'function', name, s: m.index, e: masked.indexOf(';', close) + 1, body: -1, args: countArgs(masked.slice(open + 1, close)) });
      }
      continue;
    }
    const at = close + 1 + am[0].length - am[1].length;
    let body = -1, e;
    if (am[1] === '{') { if (pairs[at] < 0) continue; body = at; e = pairs[at] + 1; }
    else {
      let k = at + 2;
      while (k < masked.length && /\s/.test(masked[k])) k++;
      if (masked[k] === '{' && pairs[k] > 0) { body = k; e = pairs[k] + 1; }
      else e = statementEnd(masked, k, pairs) + 1;
    }
    out.push({ kind: 'func', form: 'function', name, s: m.index, e, body, args: countArgs(masked.slice(open + 1, close)) });
  }
  return out;
}

function typeBody(masked, j, pairs, lang) {
  const limit = Math.min(masked.length, j + 3000);
  let angle = 0;
  for (let k = j; k < limit; k++) {
    const c = masked[k];
    if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(' || c === '[') {
      if (c === '(' && !PARENS_OK.has(lang) && angle === 0) return null;
      if (pairs[k] > k) { k = pairs[k]; continue; }
    } else if (c === '{') return { body: k, end: pairs[k] > 0 ? pairs[k] : k };
    else if (c === ';' && angle === 0) return { body: -1, end: k };
    else if (c === '=' && angle === 0 && lang !== 'cs') return null;
    else if (c === '\n' && angle === 0 && LINE_DECL.has(lang)) {
      const rest = masked.slice(k + 1, k + 200).trimStart();
      if (!/^(?:[{:,(]|extends\b|implements\b|with\b|where\b)/.test(rest)) return { body: -1, end: k - 1 };
    }
  }
  return null;
}

function readBases(sig) {
  const at = sig.search(/:|\bextends\b|\bimplements\b|<(?!\s*\w+\s*>)/);
  if (at < 0) return [];
  let s = sig.slice(at).replace(/\bwhere\b[\s\S]*$/, '');
  for (let i = 0; i < 3; i++) s = s.replace(/<[^<>]*>/g, ' ').replace(/\([^()]*\)/g, ' ');
  const out = [];
  for (const m of s.matchAll(/[A-Za-z_][\w.:]*/g)) {
    const name = m[0].split(/\.|::/).pop();
    if (KEYWORDS.has(name) || /^(public|private|protected|virtual|extends|implements|with)$/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

function countArgs(params) {
  const p = params.replace(/<[^<>]*>/g, '').replace(/\([^()]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
  if (!p || p === 'void') return 0;
  return p.split(',').filter((a) => {
    const t = a.trim();
    return t && !/^(?:&?\s*(?:mut\s+)?self|this|cls|\*)$/.test(t);
  }).length;
}

function goSymbols(masked, pairs) {
  const out = [];
  for (const m of masked.matchAll(/^type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?(struct|interface)?/gm)) {
    let e, body = -1;
    const k = m.index + m[0].length;
    const brace = masked.slice(k, k + 4).trimStart()[0] === '{' ? masked.indexOf('{', k) : -1;
    if (m[2] && brace > 0 && pairs[brace] > 0) { body = brace; e = pairs[brace] + 1; }
    else e = masked.indexOf('\n', k) < 0 ? masked.length : masked.indexOf('\n', k);
    out.push({ kind: 'type', form: m[2] ?? 'type', name: m[1], s: m.index, e, body, bases: [] });
  }
  for (const m of masked.matchAll(/^func\s*(?:\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/gm)) {
    const open = m.index + m[0].length - 1;
    const close = pairs[open];
    if (close < 0) continue;
    let k = close + 1, brace = -1;
    for (; k < masked.length && k < close + 400; k++) {
      const c = masked[k];
      if (c === '(' && pairs[k] > k) { k = pairs[k]; continue; }
      if (c === '{') { brace = k; break; }
      if (c === '\n') break;
    }
    if (brace < 0 || pairs[brace] < 0) continue;
    out.push({ kind: 'func', form: m[1] ? 'method' : 'function', name: m[2], recv: m[1], s: m.index, e: pairs[brace] + 1, body: brace, args: countArgs(masked.slice(open + 1, close)) });
  }
  return out;
}

function indentSymbols(masked, lang) {
  const lines = masked.split('\n');
  const starts = lineStarts(masked);
  const re = lang === 'py'
    ? /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(\()?/
    : lang === 'rb'
      ? /^(\s*)(def|class|module)\s+(?:self\.)?([A-Za-z_][\w?!=:]*)/
      : /^(\s*)(?:local\s+)?(function)\s+([A-Za-z_][\w.:]*)\s*\(/;
  const out = [];
  const indentOf = (t) => t.length - t.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const ind = m[1].length;
    let end = i;
    let usedEnd = false;
    if (lang !== 'py') {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j];
        if (indentOf(t) === ind && /^\s*end\b/.test(t)) { end = j; usedEnd = true; break; }
        if (t.trim() && indentOf(t) < ind) break;
      }
    }
    if (!usedEnd) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j];
        if (!t.trim()) continue;
        if (indentOf(t) <= ind && !/^\s*[)\]}]/.test(t)) break;
        end = j;
      }
    }
    const word = m[2];
    const kind = word === 'def' || word === 'function' ? 'func' : 'type';
    let args = 0, bases = [];
    const tail = masked.slice(starts[i] + m[0].length - (m[4] ? 1 : 0), starts[Math.min(end, i + 8)] + (lines[Math.min(end, i + 8)]?.length ?? 0));
    const close = matchParen(tail);
    if (tail[0] === '(' && close > 0) {
      const inner = tail.slice(1, close);
      if (kind === 'func') args = countArgs(inner);
      else bases = inner.split(',').map((b) => b.trim().split('.').pop().replace(/\[.*$/, '')).filter((b) => b && !/=/.test(b) && b !== 'object');
    }
    if (lang === 'rb' && kind === 'type') {
      const b = /<\s*([\w:]+)/.exec(lines[i]);
      if (b) bases = [b[1].split('::').pop()];
    }
    out.push({ kind, form: word === 'def' || word === 'function' ? 'function' : word, name: m[3], s: starts[i] + ind, e: starts[end] + lines[end].length, body: starts[i], args, bases, indent: ind });
  }
  return out;
}

function matchParen(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')' && --d === 0) return i;
  }
  return -1;
}

function sqlSymbols(masked) {
  const pairs = pairMap(masked);
  const out = [];
  for (const m of masked.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(table|view|function|procedure|trigger|index|type)\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)/gi)) {
    out.push({ kind: /table|view|type/i.test(m[1]) ? 'type' : 'func', form: m[1].toLowerCase(), name: m[2].replace(/["`[\]]/g, ''), s: m.index, e: statementEnd(masked, m.index + m[0].length, pairs) + 1, body: -1 });
  }
  return out;
}

function shellSymbols(masked) {
  const pairs = pairMap(masked);
  const out = [];
  for (const m of masked.matchAll(/^[ \t]*(?:function\s+([\w.-]+)\s*(?:\(\s*\))?|([\w.-]+)\s*\(\s*\))\s*\{/gm)) {
    const brace = m.index + m[0].length - 1;
    if (pairs[brace] < 0) continue;
    out.push({ kind: 'func', form: 'function', name: m[1] ?? m[2], s: m.index, e: pairs[brace] + 1, body: brace, args: 0 });
  }
  return out;
}

function mdSymbols(text) {
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const heads = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) heads.push({ i, level: m[1].length, name: m[2].slice(0, 80) });
  }
  return heads.map((h, k) => {
    let end = lines.length - 1;
    for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].i - 1; break; }
    return { kind: 'part', form: 'h' + h.level, name: h.name, s: starts[h.i], e: starts[end] + lines[end].length, body: -1 };
  });
}

function keyedParts(text, test) {
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const keys = [];
  for (let i = 0; i < lines.length && keys.length < 400; i++) {
    const name = test(lines[i]);
    if (name) keys.push({ i, name });
  }
  return keys.map((k, j) => {
    let end = j + 1 < keys.length ? keys[j + 1].i - 1 : lines.length - 1;
    while (end > k.i && !lines[end].trim()) end--;
    return { kind: 'part', form: 'key', name: k.name.slice(0, 80), s: starts[k.i], e: starts[end] + lines[end].length, body: -1 };
  });
}

const yamlSymbols = (text) => keyedParts(text, (l) => /^([A-Za-z_"'][^:#\n]*?)\s*:(?:\s|$)/.exec(l)?.[1].replace(/["']/g, ''));
const tomlSymbols = (text) => keyedParts(text, (l) => /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(l)?.[1].trim());

function jsonSymbols(text) {
  if (!/^\s*\{/.test(text) || text.length > 1_000_000) return [];
  const starts = lineStarts(text);
  const keys = [];
  let depth = 0;
  for (let i = 0; i < text.length && keys.length < 400; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1, j + 8))) keys.push({ s: i, name: text.slice(i + 1, j) });
      i = j;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return keys.map((k, j) => {
    const lineStart = starts[lineAt(starts, k.s) - 1];
    const next = j + 1 < keys.length ? starts[lineAt(starts, keys[j + 1].s) - 1] - 1 : text.lastIndexOf('}');
    return { kind: 'part', form: 'key', name: k.name.slice(0, 80), s: lineStart, e: Math.max(lineStart, next), body: -1 };
  });
}

const BRANCH_RE = /\b(?:if|for|foreach|while|case|catch|except|elif|elsif|when|guard|unless|until|rescue)\b|&&|\|\||\?\?/g;
const WORD_BRANCH_RE = /\b(?:and|or)\b/g;

function nestSymbols(raw, masked, lang, lines) {
  raw.sort((a, b) => a.s - b.s || b.e - a.e);
  const seen = new Set();
  const list = [];
  for (const s of raw) {
    const id = `${s.kind}:${s.name}:${s.from}`;
    if (seen.has(id) || s.e <= s.s) continue;
    seen.add(id);
    list.push(s);
  }
  const stack = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    while (stack.length && list[stack.at(-1)].e < s.e) stack.pop();
    s.up = stack.length ? stack.at(-1) : -1;
    stack.push(i);
  }
  // Go methods live outside their type: attach them by receiver name.
  if (lang === 'go') {
    const types = new Map(list.map((s, i) => [s.kind === 'type' ? s.name : null, i]));
    for (const s of list) if (s.recv && types.has(s.recv) && s.up < 0) s.up = types.get(s.recv);
  }
  for (const s of list) {
    s.lines = s.to - s.from + 1;
    if (s.kind === 'func') {
      const parent = s.up >= 0 ? list[s.up] : null;
      const tail = s.name.split('::').pop();
      if (parent && parent.kind === 'type' || s.name.includes('::')) s.form = 'method';
      if ((parent && tail === parent.name) || ['constructor', '__init__', 'init'].includes(tail) || (s.name.includes('::') && s.name.split('::').at(-2) === tail)) s.form = 'ctor';
      const body = masked.slice(Math.max(s.s, s.body), s.e);
      s.cx = 1 + (body.match(BRANCH_RE)?.length ?? 0) + (LANG[lang]?.indent ? body.match(WORD_BRANCH_RE)?.length ?? 0 : 0);
      s.nest = LANG[lang]?.indent ? indentDepth(lines, s.from, s.to) : braceDepth(body);
    }
    delete s.body; delete s.recv; delete s.indent;
  }
  return list;
}

function braceDepth(body) {
  let d = 0, max = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 123) { d++; if (d > max) max = d; } else if (c === 125) d--;
  }
  return Math.max(0, max - 1);
}

function indentDepth(lines, from, to) {
  const base = lines[from - 1].length - lines[from - 1].trimStart().length;
  let unit = 0, max = 0;
  for (let i = from; i < to && i < lines.length; i++) {
    const t = lines[i];
    if (!t.trim()) continue;
    const d = t.length - t.trimStart().length - base;
    if (d > 0 && (!unit || d < unit)) unit = d;
    if (d > max) max = d;
  }
  return unit ? Math.max(0, Math.round(max / unit) - 1) : 0;
}

// ───────────────────────────── Imports ─────────────────────────────

const JS_IMPORTS = [/\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/g, /\bexport\s+(?:type\s+)?[\w*${}\s,]*?\s+from\s+(['"])([^'"\n]+)\1/g, /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g];
const IMPORT_RES = {
  js: JS_IMPORTS, ts: JS_IMPORTS, vue: JS_IMPORTS,
  py: [/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+([\w*, ()\\\n]+)/gm, /^[ \t]*import\s+([\w., ]+)/gm],
  java: [/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm],
  kt: [/^\s*import\s+([\w.]+(?:\.\*)?)/gm],
  scala: [/^\s*import\s+([\w.]+(?:\._)?)/gm],
  go: [/\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g, /\bimport\s*\(([^)]*)\)/g],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm, /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/gm],
  c: [/^\s*#\s*include\s*([<"])([^>"\n]+)[>"]/gm],
  cpp: [/^\s*#\s*include\s*([<"])([^>"\n]+)[>"]/gm],
  php: [/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g, /^\s*use\s+([\w\\]+)/gm],
  rb: [/\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g, /\brequire\s*\(?\s*['"]([^'"]+)['"]/g],
  lua: [/\brequire\s*\(?\s*['"]([^'"]+)['"]/g],
  css: [/@(?:import|use|forward)\s+(?:url\()?\s*['"]([^'"]+)['"]/g],
  html: [/\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/g],
  dart: [/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm],
  sh: [/^\s*(?:source|\.)\s+([\w./-]+\.(?:sh|bash))/gm],
};

export function readImports(text, masked, langId) {
  const res = IMPORT_RES[langId];
  if (!res) return [];
  const starts = lineStarts(text);
  const out = [];
  const isCode = (i) => masked === text || masked[i] === text[i];
  res.forEach((re, which) => {
    for (const m of text.matchAll(re)) {
      const at = m.index + (m[0].length - m[0].trimStart().length);
      if (!isCode(at)) continue;
      const line = lineAt(starts, at);
      if (langId === 'go' && which === 1) {
        for (const g of m[1].matchAll(/"([^"]+)"/g)) out.push({ spec: g[1], line: lineAt(starts, m.index + 1 + m[0].indexOf(g[0])), kind: 'go' });
        continue;
      }
      if (langId === 'py' && which === 0) {
        const names = m[2].replace(/[()\\\n]/g, ' ').split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
        out.push({ spec: m[1], names, line });
        continue;
      }
      if (langId === 'py' && which === 1) {
        for (const p of m[1].split(',')) { const spec = p.trim().split(/\s+/)[0]; if (spec) out.push({ spec, line }); }
        continue;
      }
      if (langId === 'c' || langId === 'cpp') { out.push({ spec: m[2], line, system: m[1] === '<' }); continue; }
      if (langId === 'rs') { out.push({ spec: m[1], line, mod: which === 0 }); continue; }
      out.push({ spec: m[2] ?? m[1], line });
    }
  });
  return out.slice(0, 400);
}

// ───────────────────────────── File facts ─────────────────────────────

const TEST_RE = /(?:^|\/)(?:tests?|spec|specs|__tests__|testing)(?:\/|$)|[._-](?:test|spec)s?\.\w+$|Tests?\.\w+$|_test\.go$|(?:^|\/)test_[^/]+\.py$/i;
const GEN_HEAD = /auto-?generated|do not edit|generated by|@generated|<auto-generated/i;
const SECRET_RES = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'Private key'],
  [/\bsk_live_[0-9a-zA-Z]{16,}/, 'Stripe live key'],
  [/\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{20,}/, 'API secret key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i, 'Hard-coded secret'],
];
const SECRET_HINT = /AKIA|PRIVATE KEY|sk_live_|sk-|gh[pousr]_|xox[baprs]-|AIza|passw|pwd|secret|api[_-]?key|apikey|token/i;
const MARK_HINT = /TODO|FIXME|HACK|XXX|NotImplemented|Unsupported|unimplemented|todo!|panic|not implemented/i;
const SECRET_FAKE = /^(?:x+|\*+|your|example|changeme|dummy|test|placeholder|<|\$\{|process\.env|env\(|os\.environ|todo|redacted|none|null|undefined|password|secret)/i;
const DEBUG_RES = {
  js: /\bconsole\.(?:log|debug|trace|dir)\s*\(|\bdebugger\b/, ts: /\bconsole\.(?:log|debug|trace|dir)\s*\(|\bdebugger\b/, vue: /\bconsole\.(?:log|debug|trace)\s*\(|\bdebugger\b/,
  py: /^\s*print\s*\(|\bbreakpoint\s*\(\s*\)|\bpdb\.set_trace\s*\(/, cs: /\bDebug\.(?:WriteLine|Print)\s*\(|\bConsole\.WriteLine\s*\(/,
  java: /\bSystem\.(?:out|err)\.print(?:ln)?\s*\(|\.printStackTrace\s*\(/, kt: /^\s*println\s*\(/, go: /\bfmt\.Print(?:ln|f)?\s*\(/,
  rs: /\b(?:dbg|println|eprintln)!\s*\(/, php: /\b(?:var_dump|print_r|dd|dump)\s*\(/, rb: /\bbinding\.pry\b|^\s*(?:p|pp)\s+/, swift: /^\s*(?:print|debugPrint)\s*\(/, dart: /^\s*print\s*\(/,
  c: /\bprintf\s*\(\s*"DEBUG/, cpp: /\bstd::cerr\s*<</,
};
const STUB_RE = /\b(?:NotImplementedException|NotImplementedError|UnsupportedOperationException|unimplemented!|todo!)|\bpanic!?\(\s*["'](?:todo|not implemented)|throw\s+new\s+Error\(\s*['"`](?:todo|not implemented)/i;
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.{0,80})/;
const CODEY_RE = /[;{}]\s*$|^\s*(?:if|for|while|return|var|let|const|def|import|from|class|public|private|int|string|console\.|print\(|System\.|await|throw)\b|^\s*[\w.]+\s*\(.*\)\s*;?\s*$|^\s*[\w.[\]]+\s*=\s*\S/;

export function readFacts(rel, text) {
  const lang = langOf(rel);
  const L = LANG[lang];
  const masked = maskCode(text, lang);
  const lines = text.split('\n');
  const base = posix.basename(rel).toLowerCase();
  const head = lines.slice(0, 6).join('\n');
  const lineCount = countLines(text);
  const avg = lineCount ? text.length / lineCount : 0;
  const gen = LOCK_FILES.has(base) || /\.min\.\w+$|\.(?:g|generated|designer)\.\w+$|\.pb\.go$|_pb2\.py$/.test(base) || GEN_HEAD.test(head) || (avg > 300 && lineCount > 2);
  const test = TEST_RE.test(rel);
  const syms = gen ? [] : readSymbols(text, masked, lang);
  const imports = gen ? [] : readImports(text, masked, lang);
  const pkg = ['java', 'kt', 'scala', 'go'].includes(lang) ? /^\s*package\s+([\w.]+)/m.exec(masked)?.[1] ?? null : null;
  const words = gen ? new Map() : readWords(L?.data ? text : masked);
  const marks = gen ? [] : readMarks(rel, lang, text, masked, lines, syms, test);
  const copy = gen || L?.data ? null : readNorm(lines, masked.split('\n'));
  return { rel, lang, lines: lineCount, gen, test, syms, imports, pkg, words, marks, copy, hash: sha1(text), empty: !text.trim() };
}

function readWords(code) {
  const words = new Map();
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue;
    for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const w = m[0];
      if (w.length < 3 || KEYWORDS.has(w)) continue;
      const list = words.get(w);
      if (!list) words.set(w, [i + 1]);
      else if (list.at(-1) !== i + 1) list.push(i + 1);
    }
  }
  return words;
}

function readMarks(rel, lang, text, masked, lines, syms, test) {
  const marks = [];
  const mlines = masked.split('\n');
  const data = LANG[lang]?.data;
  const debug = DEBUG_RES[lang];
  let run = [];
  const flush = () => {
    if (run.length >= 3 && run.filter((r) => r.codey).length >= Math.ceil(run.length * 0.6)) marks.push({ rule: 'dead', line: run[0].i + 1, note: `${run.length} lines of commented-out code` });
    run = [];
  };
  let wide = 0, wideAt = 0;
  const hasSecret = SECRET_HINT.test(text), hasMark = MARK_HINT.test(text);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (t.length > 2000) continue;
    const m = mlines[i] ?? '';
    if (!data && t.length > 160) { wide++; wideAt ||= i + 1; }
    if (hasSecret && SECRET_HINT.test(t)) for (const [re, label] of SECRET_RES) {
      const s = re.exec(t);
      if (!s) continue;
      if (s[1] && SECRET_FAKE.test(s[1])) continue;
      marks.push({ rule: 'secret', line: i + 1, note: `${label}: ${(s[1] ?? s[0]).slice(0, 4)}…` });
      break;
    }
    if (data) continue;
    if (hasMark) {
      const todo = TODO_RE.exec(t);
      if (todo && m.slice(todo.index, todo.index + 4).trim() === '' && t.trim()) marks.push({ rule: 'stub', line: i + 1, note: `${todo[1]}${todo[2] ? ': ' + todo[2].trim() : ''}`, level: 'low' });
      const stub = STUB_RE.exec(t);
      if (stub && m[stub.index] === t[stub.index]) marks.push({ rule: 'stub', line: i + 1, note: `Not implemented: ${t.trim().slice(0, 80)}`, level: 'medium' });
    }
    if (debug && !test && debug.test(m)) marks.push({ rule: 'debug', line: i + 1, note: t.trim().slice(0, 90) });
    const isComment = t.trim() && !m.trim();
    if (isComment) {
      const body = t.replace(/^\s*(?:\/\/+|#+|--|\/\*+|\*+\/?|<!--)\s?/, '').replace(/\*\/\s*$/, '');
      if (/^\s*(?:\/\/\/|\*\s*@|#!)/.test(t)) flush();
      else run.push({ i, codey: CODEY_RE.test(body) && body.trim().length > 3 });
    } else flush();
  }
  flush();
  if (wide) marks.push({ rule: 'wide', line: wideAt, note: `${wide} line${wide > 1 ? 's' : ''} over 160 characters` });
  if (lang === 'py') {
    for (const s of syms) {
      if (s.kind !== 'func') continue;
      const body = mlines.slice(s.from, s.to).join('\n').trim();
      if (/^(?:pass|\.\.\.)$/.test(body)) marks.push({ rule: 'stub', line: s.from, note: `Empty body: ${s.name}`, level: 'medium' });
    }
  }
  return marks.slice(0, 300);
}

// Normalized lines for copy detection: trimmed code with single spaces,
// skipping blank and trivial lines. `at` maps back to original line numbers.
function readNorm(lines, mlines) {
  const norm = [], at = [], imp = [];
  for (let i = 0; i < mlines.length; i++) {
    const t = mlines[i].trim().replace(/\s+/g, ' ');
    if (t.length < 4 || /^[{}()[\];,]+$/.test(t)) continue;
    norm.push(t); at.push(i + 1);
    imp.push(/^(?:import|using|#include|from|require|use|package)\b/.test(t) ? 1 : 0);
  }
  return { norm, at, imp };
}

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// ───────────────────────────── Rules ─────────────────────────────

export const RULES = [
  { id: 'secret', name: 'Possible secrets', about: 'Keys, tokens, or passwords written into files.' },
  { id: 'loop', name: 'Import loops', about: 'Files that import each other in a circle.' },
  { id: 'copy', name: 'Copied code', about: 'Blocks of code that appear more than once.', mid: 8, high: 30 },
  { id: 'size', name: 'Big files', about: 'Code files that are long enough to be hard to review.', mid: 400, high: 1000 },
  { id: 'length', name: 'Long functions', about: 'Functions with many lines.', mid: 60, high: 150 },
  { id: 'branch', name: 'Complex logic', about: 'Functions with many branches (if, loops, cases, &&, ||).', mid: 12, high: 25 },
  { id: 'nest', name: 'Deep nesting', about: 'Blocks inside blocks inside blocks.', mid: 4, high: 6 },
  { id: 'args', name: 'Many parameters', about: 'Functions that take many inputs.', mid: 5, high: 8 },
  { id: 'stub', name: 'Stubs and TODOs', about: 'Unfinished work: TODO notes, empty bodies, "not implemented".' },
  { id: 'tangle', name: 'Folder loops', about: 'Folders that depend on each other in both directions.' },
  { id: 'unused', name: 'Unused code', about: 'Declared, but the name is never used anywhere else.' },
  { id: 'version', name: 'Versioned names', about: 'Names like _v2, _new, _old, copy. Often left over from drafts.' },
  { id: 'debug', name: 'Debug leftovers', about: 'Print and log calls, debugger statements.' },
  { id: 'dead', name: 'Commented-out code', about: 'Code that was turned into comments instead of removed.' },
  { id: 'naming', name: 'Mixed naming', about: 'Function names that break the style most of the language uses here.' },
  { id: 'lone', name: 'Unlinked files', about: 'Code files with no links in or out.' },
  { id: 'couple', name: 'Hidden coupling', about: 'Files that keep changing in the same commits, though nothing links them.', mid: 5, ratio: 0.5 },
  { id: 'empty', name: 'Empty files', about: 'Files with no content.' },
  { id: 'wide', name: 'Long lines', about: 'Lines over 160 characters.' },
  { id: 'crowd', name: 'Crowded folders', about: 'Folders with many files side by side.', mid: 30 },
];
const RULE = Object.fromEntries(RULES.map((r) => [r.id, r]));
// `change` (changes with) is appended so the indexes of the others never move.
export const LINK_KINDS = ['import', 'call', 'use', 'base', 'copy', 'change'];
const SITE_CAP = 12;
const ENTRY_NAMES = new Set(['main', 'Main', 'index', 'program', 'Program', 'app', 'App', 'server', 'cli', 'setup', 'manage', 'conftest', '__init__', '__main__', 'lib', 'mod', 'build', 'vite.config', 'webpack.config', 'Startup']);
const ENTRY_FUNCS = new Set(['main', 'Main', 'constructor', 'init', '__init__', 'setUp', 'tearDown', 'toString', 'ToString', 'Equals', 'GetHashCode', 'Dispose', 'render', 'handler', 'default', 'Configure', 'ConfigureServices', 'OnGet', 'OnPost', 'componentDidMount', 'ngOnInit', 'setup', 'run', 'execute', 'Execute', 'invoke', 'Invoke', 'call', 'drop', 'fmt', 'new', 'from', 'into', 'deref', 'clone', 'eq', 'hash', 'String', 'Error', 'ServeHTTP', 'init']);
const VERSION_RE = /(?:^|[\s._-])(?:v\d+|new|old|copy|backup|bak|orig|final|tmp|temp|fixed|draft|working|updated|improved|enhanced|refactored|alt)$|\(\d+\)$|\bcopy(?: \d+)?$/i;
const VERSION_SYM_RE = /^(.{3,}?)(?:_?[Vv]\d+|New|Old|Copy|Backup|Fixed|Final|Improved|Enhanced|Updated|Refactored|Alt|2|_new|_old|_copy|_fixed|_final|_alt)$/;

function levelOf(rule, value) {
  const r = RULE[rule];
  return value >= r.high ? 'high' : 'medium';
}

// ───────────────────────────── Model ─────────────────────────────
// One flat node list: root → repos → dirs → files → symbols. Links are
// [from, to, kind, weight] between node ids. Issues point at node ids. Link
// sites (the source lines of each link) ride along as a non-enumerable
// `sites` map, so they never go out with `repo.model`.

export function buildModel(repos, { ledgers = new Map(), stage = null, preview = false } = {}) {
  const nodes = [];
  const add = (n) => { n.id = nodes.length; nodes.push(n); return n.id; };
  add({ kind: 'root', name: 'workspace', up: -1, key: '', lines: 0 });
  const files = [];
  const fileOf = [];
  const fileIds = new Map();
  for (const repo of repos) {
    const rid = add({ kind: 'repo', name: repo.name, up: 0, key: repo.name, path: '', root: repo.root, branch: repo.git?.branch ?? null, lines: 0 });
    fileOf[rid] = -1;
    const dirs = new Map([['', rid]]);
    const dirOf = (d) => {
      if (dirs.has(d)) return dirs.get(d);
      const up = dirOf(posix.dirname(d) === '.' ? '' : posix.dirname(d));
      const id = add({ kind: 'dir', name: posix.basename(d), up, key: `${repo.name}/${d}`, path: d, lines: 0 });
      fileOf[id] = -1;
      dirs.set(d, id);
      return id;
    };
    const facts = viewFacts(repo, stage, preview);
    const rels = [...facts.keys()].sort((a, b) => a.localeCompare(b));
    for (const rel of rels) {
      const f = facts.get(rel);
      const dir = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
      const git = repo.git?.files.get(rel);
      const fkey = `${repo.name}/${rel}`;
      const staged = stage?.items.get(fkey);
      const fid = add({
        kind: 'file', name: posix.basename(rel), up: dirOf(dir), key: fkey, path: rel, lang: f.lang, lines: f.lines,
        gen: f.gen || undefined, test: f.test || undefined, churn: git?.churn ?? 0, time: timeOf(repo, rel, f),
        dirty: repo.git?.dirty.has(rel) || undefined, staged: staged ? staged.state : undefined,
      });
      fileOf[fid] = fid;
      fileIds.set(fkey, fid);
      const rec = { id: fid, repo, f, syms: [], owner: null, imports: new Set(), ext: new Set() };
      const counts = new Map();
      for (const s of f.syms) {
        const up = s.up >= 0 ? rec.syms[s.up] : fid;
        const chain = (s.up >= 0 ? nodes[up].key.split('#')[1] + '.' : '') + s.name;
        const n = (counts.get(chain) ?? 0) + 1;
        counts.set(chain, n);
        const sid = add({ kind: s.kind, form: s.form, name: s.name, up, key: `${fkey}#${chain}${n > 1 ? '~' + n : ''}`, path: rel, lang: f.lang, from: s.from, to: s.to, lines: s.lines, cx: s.cx, nest: s.nest, args: s.args, head: s.head, bases: s.bases?.length ? s.bases : undefined });
        fileOf[sid] = fid;
        rec.syms.push(sid);
      }
      const owner = new Int32Array(f.lines + 2).fill(fid);
      for (const sid of rec.syms) {
        const n = nodes[sid];
        for (let l = n.from; l <= n.to && l <= f.lines + 1; l++) owner[l] = sid;
      }
      rec.owner = owner;
      files.push(rec);
    }
  }
  for (let i = nodes.length - 1; i > 0; i--) {
    const n = nodes[i];
    if (n.kind === 'file') for (let p = n.up; p >= 0; p = nodes[p].up) nodes[p].lines += n.lines;
  }

  const links = new Map();
  const sites = new Map();
  const link = (s, t, kind, w = 1, line = 0) => {
    if (s === t || s < 0 || t < 0) return;
    const key = `${s},${t},${kind}`;
    links.set(key, (links.get(key) ?? 0) + w);
    if (!line) return;
    let list = sites.get(key);
    if (!list) sites.set(key, (list = []));
    if (list.length < SITE_CAP && !list.includes(line)) list.push(line);
  };
  const isUnder = (child, anc) => { for (let p = child; p >= 0; p = nodes[p].up) if (p === anc) return true; return false; };

  // Imports
  const index = makeIndex(files);
  for (const rec of files) {
    for (const imp of rec.f.imports) {
      const hits = resolveImport(rec, imp, index);
      if (!hits) {
        if (!imp.spec.startsWith('.') && !imp.mod) rec.ext.add(extName(imp.spec, rec.f.lang));
        continue;
      }
      for (const t of hits) if (t.id !== rec.id) { rec.imports.add(t.id); link(rec.id, t.id, 'import', 1, imp.line); }
    }
    if (rec.ext.size) nodes[rec.id].ext = [...rec.ext].slice(0, 40);
  }

  // Names: declarations and total use counts
  const decls = new Map();
  for (const n of nodes) {
    if ((n.kind === 'type' || n.kind === 'func' || n.kind === 'space') && n.name.length >= 3) {
      const name = n.name.split('::').pop();
      if (!decls.has(name)) decls.set(name, []);
      decls.get(name).push(n.id);
    }
  }
  const uses = new Map();
  for (const rec of files) for (const [w, lines] of rec.f.words) uses.set(w, (uses.get(w) ?? 0) + lines.length);

  const FAMILY = { ts: 'js', vue: 'js', html: 'js', js: 'js', kt: 'jvm', java: 'jvm', scala: 'jvm', c: 'c', cpp: 'c' };
  const family = (lang) => FAMILY[lang] ?? lang;
  const pick = (rec, cands, typesOnly) => {
    const fam = family(rec.f.lang);
    cands = cands.filter((t) => family(nodes[t].lang) === fam);
    if (!cands.length) return cands;
    if (cands.length === 1) return cands;
    const same = cands.filter((t) => fileOf[t] === rec.id);
    if (same.length) return same;
    const imp = cands.filter((t) => rec.imports.has(fileOf[t]));
    if (imp.length) return imp;
    const dir = nodes[rec.id].up;
    const near = cands.filter((t) => nodes[fileOf[t]].up === dir);
    if (near.length) return near;
    return typesOnly || cands.every((t) => nodes[t].kind === 'type') ? cands : [];
  };

  // References and calls
  for (const rec of files) {
    if (LANG[rec.f.lang]?.data || rec.f.lang === 'css') continue;
    for (const [w, lines] of rec.f.words) {
      const targets = decls.get(w);
      if (!targets || targets.length > 4) continue;
      for (const line of lines) {
        const src = rec.owner[line] ?? rec.id;
        if (nodes[src].name === w) continue;
        for (const t of pick(rec, targets, false)) {
          if (t === src || isUnder(src, t) || isUnder(t, src)) continue;
          if (fileOf[t] === rec.id && nodes[t].from === line) continue;
          link(src, t, nodes[t].kind === 'func' ? 'call' : 'use', 1, line);
        }
      }
    }
  }
  // Base types
  for (const rec of files) {
    for (const sid of rec.syms) {
      for (const b of nodes[sid].bases ?? []) {
        const cands = (decls.get(b) ?? []).filter((t) => nodes[t].kind === 'type' && t !== sid);
        for (const t of pick(rec, cands, true)) link(sid, t, 'base', 1, nodes[sid].from);
      }
    }
  }

  const issues = [];
  const flag = (rule, node, line, note, level) => issues.push({ rule, node, line: line ?? nodes[node].from ?? 1, note, level });

  // Copies: one issue per place, naming how many other places repeat it.
  const spots = new Map();
  const spot = (rec, line, size, other, otherLine) => {
    const node = rec.owner[line] ?? rec.id;
    let s = spots.get(node);
    if (!s) spots.set(node, (s = { node, line, size: 0, others: new Map() }));
    s.size = Math.max(s.size, size);
    if (!s.others.has(other)) s.others.set(other, `${nodes[fileOf[other]].path}:${otherLine}`);
    return node;
  };
  for (const c of findCopies(files)) {
    const a = files[c.a], b = files[c.b];
    const sa = a.owner[c.fromA] ?? a.id, sb = b.owner[c.fromB] ?? b.id;
    spot(a, c.fromA, c.size, sb, c.fromB);
    spot(b, c.fromB, c.size, sa, c.fromA);
    link(sa, sb, 'copy', c.size);
    // A copy's sites are the block's first line in the source, then in the target.
    if (sa !== sb && !sites.has(`${sa},${sb},copy`)) sites.set(`${sa},${sb},copy`, [c.fromA, c.fromB]);
  }
  for (const s of spots.values()) {
    const first = s.others.values().next().value;
    const more = s.others.size - 1;
    flag('copy', s.node, s.line, `${s.size} lines also in ${first}${more ? ` and ${more} more place${more > 1 ? 's' : ''}` : ''}`, s.size >= RULE.copy.high ? 'high' : 'medium');
  }

  // Per-file and per-symbol rules
  const nameStyles = new Map();
  for (const rec of files) {
    const n = nodes[rec.id];
    const f = rec.f;
    const code = !LANG[f.lang]?.data && f.lang !== 'html' && f.lang !== 'css';
    for (const m of f.marks) flag(m.rule, rec.owner[m.line] ?? rec.id, m.line, m.note, m.level ?? (m.rule === 'secret' ? 'high' : m.rule === 'wide' || m.rule === 'dead' || m.rule === 'debug' ? 'low' : 'medium'));
    if (code && !f.gen && f.lines > RULE.size.mid) flag('size', rec.id, 1, `${f.lines} lines`, levelOf('size', f.lines));
    if (f.empty && !/^(?:__init__\.py|\.gitkeep|\.keep|\.nojekyll)$/.test(n.name)) flag('empty', rec.id, 1, 'No content', 'low');
    const stem = n.name.replace(/\.[^.]+$/, '');
    if (VERSION_RE.test(stem)) flag('version', rec.id, 1, `File name "${n.name}" looks like a draft or copy`, 'medium');
    for (const sid of rec.syms) {
      const s = nodes[sid];
      if (s.kind !== 'func') continue;
      if (s.lines > RULE.length.mid) flag('length', sid, s.from, `${s.lines} lines`, levelOf('length', s.lines));
      if (s.cx > RULE.branch.mid) flag('branch', sid, s.from, `${s.cx} branches`, levelOf('branch', s.cx));
      if (s.nest > RULE.nest.mid) flag('nest', sid, s.from, `${s.nest} levels deep`, levelOf('nest', s.nest));
      if (s.args > RULE.args.mid) flag('args', sid, s.from, `${s.args} parameters`, levelOf('args', s.args));
      if (s.form !== 'ctor' && !f.test) {
        const style = styleOf(s.name, f.lang);
        if (style) {
          if (!nameStyles.has(f.lang)) nameStyles.set(f.lang, { snake: [], camel: [], pascal: [] });
          nameStyles.get(f.lang)[style].push(sid);
        }
      }
    }
    for (const sid of rec.syms) {
      const s = nodes[sid];
      if (s.kind !== 'func' && s.kind !== 'type') continue;
      const name = s.name.split('::').pop();
      const v = VERSION_SYM_RE.exec(name);
      if (v && decls.has(v[1])) flag('version', sid, s.from, `"${name}" next to "${v[1]}"`, 'low');
      if (f.test || f.gen || s.form === 'ctor' || s.form === 'impl' || name.length < 3 || ENTRY_FUNCS.has(name) || /^(?:__|test|Test|on[A-Z]|On[A-Z]|handle[A-Z])/.test(name)) continue;
      if (/\boverride\b|@Override|export\s+default|\[(?:Http|Fact|Test|Theory)/.test(s.head ?? '')) continue;
      if ((uses.get(name) ?? 0) <= (decls.get(name)?.length ?? 1)) flag('unused', sid, s.from, `"${name}" is never used`, 'low');
    }
  }
  for (const [lang, st] of nameStyles) {
    const merged = lang === 'cs' ? st : { snake: st.snake, camel: [...st.camel, ...st.pascal], pascal: [] };
    const total = merged.snake.length + merged.camel.length + merged.pascal.length;
    if (total < 6) continue;
    const top = Object.entries(merged).sort((a, b) => b[1].length - a[1].length)[0];
    if (top[1].length / total < 0.7) continue;
    for (const [style, ids] of Object.entries(merged)) {
      if (style === top[0]) continue;
      for (const id of ids.slice(0, 200)) flag('naming', id, nodes[id].from, `${style} name; most ${LANG[lang]?.name ?? lang} functions here use ${top[0]}`, 'low');
    }
  }

  // Crowded folders
  const direct = new Map();
  for (const rec of files) direct.set(nodes[rec.id].up, (direct.get(nodes[rec.id].up) ?? 0) + 1);
  for (const [dir, count] of direct) if (count > RULE.crowd.mid) flag('crowd', dir, 1, `${count} files in one folder`, 'low');

  // Import loops (files) and folder loops
  const fileGraph = new Map();
  const dirGraph = new Map();
  const dirOfNode = (id) => nodes[fileOf[id]]?.up ?? -1;
  for (const [key] of links) {
    const [s, t, kind] = key.split(',');
    const a = +s, b = +t;
    if (kind === 'import') {
      if (!fileGraph.has(a)) fileGraph.set(a, new Set());
      fileGraph.get(a).add(b);
    }
    if (STATIC_KINDS.has(kind)) {
      const da = dirOfNode(a), db = dirOfNode(b);
      if (da >= 0 && db >= 0 && da !== db && !isUnder(da, db) && !isUnder(db, da)) {
        if (!dirGraph.has(da)) dirGraph.set(da, new Set());
        dirGraph.get(da).add(db);
      }
    }
  }
  for (const group of strongGroups(fileGraph)) {
    const names = group.map((id) => nodes[id].name);
    for (const id of group) flag('loop', id, 1, `Loop: ${names.slice(0, 5).join(' ⇄ ')}${names.length > 5 ? ` +${names.length - 5}` : ''}`, group.length > 3 ? 'high' : 'medium');
  }
  for (const group of strongGroups(dirGraph)) {
    const names = group.map((id) => nodes[id].path || nodes[id].name);
    for (const id of group) flag('tangle', id, 1, `Depends both ways: ${names.slice(0, 4).join(' ⇄ ')}${names.length > 4 ? ` +${names.length - 4}` : ''}`, 'medium');
  }

  // Unlinked files
  const touched = new Set();
  const fileLinked = new Set();
  for (const [key] of links) {
    const [s, t, kind] = key.split(',');
    if (!STATIC_KINDS.has(kind)) continue;
    const a = fileOf[+s], b = fileOf[+t];
    touched.add(a); touched.add(b);
    if (a !== b) fileLinked.add(`${Math.min(a, b)},${Math.max(a, b)}`);
  }
  for (const rec of files) {
    const n = nodes[rec.id];
    const stem = n.name.replace(/\.[^.]+$/, '');
    if (touched.has(rec.id) || rec.f.gen || rec.f.test || rec.f.empty || LANG[rec.f.lang]?.data || ['html', 'css', 'sh', 'sql'].includes(rec.f.lang) || ENTRY_NAMES.has(stem)) continue;
    flag('lone', rec.id, 1, 'No imports, uses, or calls in or out', 'low');
  }

  // Changes-with links (undirected, lower id first) and hidden coupling: files
  // that keep changing in the same commits while nothing links them.
  const coupled = new Map();
  for (const repo of repos) {
    for (const [ra, rb, count] of repo.git?.pairs ?? []) {
      const fa = fileIds.get(`${repo.name}/${ra}`), fb = fileIds.get(`${repo.name}/${rb}`);
      if (fa == null || fb == null || fa === fb) continue;
      const a = Math.min(fa, fb), b = Math.max(fa, fb);
      link(a, b, 'change', count);
      const ca = nodes[a].churn || count, cb = nodes[b].churn || count;
      if (count < RULE.couple.mid || count / Math.min(ca, cb) < RULE.couple.ratio || fileLinked.has(`${a},${b}`)) continue;
      const skip = (n) => n.test || n.gen || LANG[n.lang]?.data;
      if (skip(nodes[a]) || skip(nodes[b])) continue;
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!coupled.has(x)) coupled.set(x, []);
        coupled.get(x).push([y, count]);
      }
    }
  }
  for (const [x, list] of coupled) {
    list.sort((p, q) => q[1] - p[1]);
    const [y, count] = list[0];
    const more = list.length - 1;
    flag('couple', x, 1, `Changes with ${nodes[y].path} in ${count} of ${nodes[x].churn || count} commits, but nothing links them${more ? ` (+${more} more file${more > 1 ? 's' : ''})` : ''}.`, 'low');
  }

  // Ledger: reviews and waived issues
  const marks = {};
  const waived = new Set();
  for (const repo of repos) {
    const led = ledgers.get(repo.name);
    if (!led) continue;
    for (const [key, mark] of Object.entries(led.marks ?? {})) {
      const text = repo.texts.get(key.slice(repo.name.length + 1).split('#')[0]);
      if (text == null) continue;
      marks[key] = mark.hash === rangeHash(text, mark.from, mark.to) ? 'ok' : 'stale';
    }
    for (const w of Object.keys(led.waives ?? {})) waived.add(w);
  }
  for (const i of issues) if (waived.has(`${i.rule}|${nodes[i.node].key}`)) i.waived = true;

  const linkList = [];
  for (const [key, w] of links) {
    const [s, t, kind] = key.split(',');
    linkList.push([+s, +t, LINK_KINDS.indexOf(kind), w]);
  }
  const langs = {};
  for (const rec of files) langs[rec.f.lang] = (langs[rec.f.lang] ?? 0) + rec.f.lines;
  const model = {
    nodes, links: linkList, issues, marks, preview: !!preview,
    rules: RULES.map(({ id, name, about }) => ({ id, name, about })),
    linkKinds: LINK_KINDS,
    langs: Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([id, lines]) => ({ id, name: LANG[id]?.name ?? id, lines })),
    stats: { files: files.length, lines: nodes[0].lines, symbols: nodes.length - files.length, links: linkList.length, issues: issues.length },
    made: Date.now(),
  };
  Object.defineProperty(model, 'sites', { value: sites, enumerable: false });
  return model;
}

function timeOf(repo, rel, f) {
  if (repo.git?.dirty.has(rel)) return Math.floor((f.mtime ?? Date.now()) / 1000);
  const t = repo.git?.files.get(rel)?.time;
  return t ?? (f.mtime ? Math.floor(f.mtime / 1000) : 0);
}

function extName(spec, lang) {
  if (lang === 'go') return spec;
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split(/[/:\\.]/)[0];
}

function styleOf(name, lang) {
  const n = name.split('::').pop().replace(/^_+/, '');
  if (!/[a-z]/.test(n) || n.length < 4) return null;
  if (/_/.test(n)) return /^[a-z0-9_]+$/.test(n) ? 'snake' : null;
  if (/^[a-z]/.test(n) && /[A-Z]/.test(n)) return 'camel';
  if (/^[A-Z][a-z]/.test(n) && /[A-Z]/.test(n.slice(1))) return 'pascal';
  return null;
}

export function rangeHash(text, from, to) {
  if (!from) return sha1(text);
  return sha1(text.split('\n').slice(from - 1, to).join('\n'));
}

function viewFacts(repo, stage, preview) {
  if (!preview || !stage?.items.size) return repo.facts;
  const out = new Map(repo.facts);
  for (const item of stage.items.values()) {
    if (item.repo !== repo) continue;
    if (item.after == null) out.delete(item.rel);
    else {
      const f = repo.preview.get(item.rel + ':' + sha1(item.after)) ?? readFacts(item.rel, item.after);
      repo.preview.set(item.rel + ':' + sha1(item.after), f);
      out.set(item.rel, f);
    }
  }
  return out;
}

// ───────────────────────────── Import resolution ─────────────────────────────

const PROBE = {
  js: ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'],
  css: ['', '.css', '.scss', '.sass', '.less', '/_index.scss'],
  py: ['.py', '/__init__.py'],
  rb: ['', '.rb'], lua: ['.lua', '/init.lua'], dart: [''], c: [''], php: ['', '.php'], html: [''], sh: [''],
};
const PROBE_OF = { ts: 'js', vue: 'js', js: 'js', css: 'css', py: 'py', rb: 'rb', lua: 'lua', dart: 'dart', c: 'c', cpp: 'c', php: 'php', html: 'js', sh: 'sh' };

function makeIndex(files) {
  const byPath = new Map(), byBase = new Map(), byPkg = new Map(), byDir = new Map(), goMods = new Map();
  for (const rec of files) {
    const p = `${rec.repo.name}/${rec.f.rel}`;
    byPath.set(p, rec);
    const base = posix.basename(rec.f.rel).replace(/\.[^.]+$/, '').toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rec);
    const d = `${rec.repo.name}/${posix.dirname(rec.f.rel)}`;
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(rec);
    if (rec.f.pkg && (rec.f.lang === 'java' || rec.f.lang === 'kt' || rec.f.lang === 'scala')) {
      if (!byPkg.has(rec.f.pkg)) byPkg.set(rec.f.pkg, []);
      byPkg.get(rec.f.pkg).push(rec);
    }
    if (posix.basename(rec.f.rel) === 'go.mod') {
      const text = rec.repo.texts.get(rec.f.rel) ?? '';
      const mod = /^module\s+(\S+)/m.exec(text)?.[1];
      if (mod) goMods.set(mod, `${rec.repo.name}/${posix.dirname(rec.f.rel)}`.replace(/\/\.$/, ''));
    }
  }
  return { byPath, byBase, byPkg, byDir, goMods };
}

function suffixMatch(index, spec, rec, exts = ['']) {
  const clean = spec.replace(/^[./]+/, '').replace(/\\/g, '/');
  if (!clean) return null;
  const base = posix.basename(clean).replace(/\.[^.]+$/, '').toLowerCase();
  const cands = index.byBase.get(base) ?? index.byBase.get(posix.basename(clean).toLowerCase()) ?? [];
  const hits = cands.filter((c) => {
    const p = c.f.rel.replace(/\.[^.]+$/, '');
    return exts.some((e) => (c.f.rel === clean + e || c.f.rel.endsWith('/' + clean + e) || p === clean || p.endsWith('/' + clean)));
  });
  if (!hits.length) return null;
  const same = hits.filter((h) => h.repo === rec.repo);
  return [(same.length ? same : hits).sort((a, b) => a.f.rel.length - b.f.rel.length)[0]];
}

function resolveImport(rec, imp, index) {
  const { spec } = imp;
  const lang = rec.f.lang;
  const repo = rec.repo.name;
  const dir = posix.dirname(rec.f.rel);
  const probe = (p, exts) => {
    for (const e of exts) {
      const hit = index.byPath.get(`${repo}/${posix.normalize(p + e)}`);
      if (hit) return [hit];
    }
    if (/\.js$/.test(p)) return probe(p.replace(/\.js$/, ''), exts);
    return null;
  };
  const exts = PROBE[PROBE_OF[lang]] ?? [''];
  if (lang === 'py') {
    if (spec.startsWith('.')) {
      const dots = /^\.+/.exec(spec)[0].length;
      let base = dir;
      for (let i = 1; i < dots; i++) base = posix.dirname(base);
      const rest = spec.slice(dots).replace(/\./g, '/');
      const target = rest ? posix.join(base, rest) : base;
      const hit = probe(target, exts);
      if (hit) return hit;
      const names = (imp.names ?? []).flatMap((n) => probe(posix.join(target, n), exts) ?? []);
      return names.length ? names : null;
    }
    const path1 = spec.replace(/\./g, '/');
    return suffixMatch(index, path1, rec, ['.py', '/__init__.py']);
  }
  if (lang === 'java' || lang === 'kt' || lang === 'scala') {
    if (/\.[*_]$/.test(spec)) return index.byPkg.get(spec.slice(0, -2)) ?? null;
    const parts = spec.split('.');
    const pkg = parts.slice(0, -1).join('.');
    const name = parts.at(-1);
    const inPkg = (index.byPkg.get(pkg) ?? []).filter((r) => r.f.rel.replace(/\.[^.]+$/, '').endsWith('/' + name) || posix.basename(r.f.rel).replace(/\.[^.]+$/, '') === name);
    if (inPkg.length) return inPkg;
    return suffixMatch(index, parts.join('/'), rec, ['.java', '.kt', '.scala']);
  }
  if (lang === 'go') {
    for (const [mod, root] of index.goMods) {
      if (spec === mod || spec.startsWith(mod + '/')) {
        const d = posix.join(root, spec.slice(mod.length + 1)).replace(/\/$/, '');
        const list = (index.byDir.get(d) ?? []).filter((r) => r.f.lang === 'go' && !r.f.test);
        return list.length ? list : null;
      }
    }
    return null;
  }
  if (lang === 'rs') {
    if (imp.mod) {
      const stem = posix.basename(rec.f.rel, '.rs');
      const base = ['mod', 'lib', 'main'].includes(stem) ? dir : posix.join(dir, stem);
      return probe(posix.join(base, spec), ['.rs', '/mod.rs']);
    }
    const parts = spec.split('::');
    if (parts[0] !== 'crate' && parts[0] !== 'super' && parts[0] !== 'self') return null;
    let base = dir;
    if (parts[0] === 'crate') { const at = rec.f.rel.lastIndexOf('src/'); base = at >= 0 ? rec.f.rel.slice(0, at + 3) : dir; }
    if (parts[0] === 'super') base = posix.dirname(dir);
    for (let k = parts.length; k > 1; k--) {
      const hit = probe(posix.join(base, ...parts.slice(1, k)), ['.rs', '/mod.rs']);
      if (hit) return hit;
    }
    return null;
  }
  if (lang === 'c' || lang === 'cpp') return (!imp.system && probe(posix.join(dir, spec), [''])) || suffixMatch(index, spec, rec, ['']);
  if (lang === 'php' && !/\.php$/.test(spec) && spec.includes('\\')) return suffixMatch(index, spec.split('\\').slice(-2).join('/'), rec, ['.php']);
  if (lang === 'dart' && spec.startsWith('package:')) return suffixMatch(index, 'lib/' + spec.split('/').slice(1).join('/'), rec, ['']);
  if (lang === 'cs' || lang === 'swift') return null;
  if (/^(?:https?:|data:|mailto:|\/\/)/.test(spec)) return null;
  if (spec.startsWith('.')) return probe(posix.join(dir, spec), exts) ?? (lang === 'css' ? probe(posix.join(dir, posix.dirname(spec), '_' + posix.basename(spec)), exts) : null);
  if (spec.startsWith('/')) return probe(spec.slice(1), exts);
  if (/^[@~]\//.test(spec)) return probe(posix.join('src', spec.slice(2)), exts) ?? probe(spec.slice(2), exts) ?? suffixMatch(index, spec.slice(2), rec, exts);
  if (lang === 'rb' || lang === 'lua') return suffixMatch(index, spec.replace(/\./g, lang === 'lua' ? '/' : '.'), rec, exts);
  if (lang === 'html' || lang === 'sh') return probe(posix.join(dir, spec), exts);
  return null;
}

// ───────────────────────────── Copies ─────────────────────────────

const WINDOW = 6;

export function findCopies(files, { min = RULE.copy.mid, cap = 300 } = {}) {
  const table = new Map();
  const list = files.map((r) => r.f.copy);
  list.forEach((c, fi) => {
    if (!c) return;
    for (let j = 0; j + WINDOW <= c.norm.length; j++) {
      let imps = 0;
      for (let k = 0; k < WINDOW; k++) imps += c.imp[j + k];
      if (imps >= 3) continue;
      const h = hashWindow(c.norm, j);
      let b = table.get(h);
      if (!b) table.set(h, (b = []));
      if (b.length < 12) b.push(fi, j);
    }
  });
  const diags = new Map();
  for (const b of table.values()) {
    if (b.length < 4) continue;
    for (let x = 0; x < b.length; x += 2) {
      for (let y = x + 2; y < b.length; y += 2) {
        let [fa, ja, fb, jb] = [b[x], b[x + 1], b[y], b[y + 1]];
        if (fa > fb || (fa === fb && ja > jb)) [fa, ja, fb, jb] = [fb, jb, fa, ja];
        if (fa === fb && Math.abs(ja - jb) < WINDOW) continue;
        if (!sameWindow(list[fa].norm, ja, list[fb].norm, jb)) continue;
        const key = `${fa}:${fb}:${ja - jb}`;
        if (!diags.has(key)) diags.set(key, []);
        diags.get(key).push(ja);
      }
    }
  }
  const out = [];
  for (const [key, starts] of diags) {
    const [fa, fb, off] = key.split(':').map(Number);
    starts.sort((p, q) => p - q);
    let s = starts[0], prev = starts[0];
    const close = (end) => {
      const ca = list[fa], cb = list[fb];
      const fromA = ca.at[s], toA = ca.at[end + WINDOW - 1];
      const fromB = cb.at[s - off], toB = cb.at[end - off + WINDOW - 1];
      const size = Math.min(toA - fromA, toB - fromB) + 1;
      if (size >= min) out.push({ a: fa, b: fb, fromA, toA, fromB, toB, size });
    };
    for (let i = 1; i <= starts.length; i++) {
      if (i < starts.length && starts[i] === prev + 1) { prev = starts[i]; continue; }
      close(prev);
      if (i < starts.length) s = prev = starts[i];
    }
  }
  return out.sort((p, q) => q.size - p.size).slice(0, cap);
}

function hashWindow(norm, j) {
  let h = 2166136261;
  for (let k = 0; k < WINDOW; k++) {
    const s = norm[j + k];
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 10, 16777619);
  }
  return h >>> 0;
}

function sameWindow(a, ja, b, jb) {
  for (let k = 0; k < WINDOW; k++) if (a[ja + k] !== b[jb + k]) return false;
  return true;
}

// ───────────────────────────── Diff ─────────────────────────────
// Myers diff on lines. Returns ops [{ t: ' ' | '-' | '+', a, b, text }].

export function diffLines(before, after) {
  const A = before === '' ? [] : before.split('\n');
  const B = after === '' ? [] : after.split('\n');
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a = A.slice(head, A.length - tail), b = B.slice(head, B.length - tail);
  const mid = myers(a, b);
  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ t: ' ', a: i + 1, b: i + 1, text: A[i] });
  let ia = head, ib = head;
  for (const t of mid) {
    if (t === ' ') { ops.push({ t, a: ia + 1, b: ib + 1, text: A[ia] }); ia++; ib++; }
    else if (t === '-') { ops.push({ t, a: ia + 1, b: null, text: A[ia] }); ia++; }
    else { ops.push({ t, a: null, b: ib + 1, text: B[ib] }); ib++; }
  }
  for (let i = 0; i < tail; i++) ops.push({ t: ' ', a: ia + i + 1, b: ib + i + 1, text: A[ia + i] });
  return ops;
}

function myers(a, b) {
  const n = a.length, m = b.length, max = n + m;
  if (!n) return Array(m).fill('+');
  if (!m) return Array(n).fill('-');
  if (n * m > 4e7 && max > 20000) return [...Array(n).fill('-'), ...Array(m).fill('+')];
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, v, a, b, off, d);
    }
    if (trace.length * v.length > 6e7) return [...Array(n).fill('-'), ...Array(m).fill('+')];
  }
  return [];
}

function backtrack(trace, last, a, b, off, dEnd) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const px = v[off + prevK], py = px - prevK;
    while (x > px && y > py) { ops.push(' '); x--; y--; }
    ops.push(x === px ? '+' : '-');
    x = px; y = py;
  }
  while (x > 0 && y > 0) { ops.push(' '); x--; y--; }
  return ops.reverse();
}

// Group ops into hunks with context. Each hunk also carries the op index
// range [i0, i1) it covers, so a single hunk can be reverted.
export function makeHunks(ops, context = 3) {
  const hunks = [];
  let cur = null, lastChange = -Infinity;
  const put = (k) => { if (!cur.idx.includes(k)) cur.idx.push(k); };
  ops.forEach((op, i) => {
    if (op.t !== ' ') {
      if (!cur || i - lastChange > context * 2) {
        cur = { idx: [] };
        hunks.push(cur);
        for (let k = Math.max(0, i - context); k < i; k++) put(k);
      } else for (let k = lastChange + 1; k < i; k++) put(k);
      put(i);
      lastChange = i;
    } else if (cur && i - lastChange <= context) {
      const nextChange = ops.findIndex((o, k) => k > i && o.t !== ' ');
      if (nextChange < 0 || nextChange - lastChange > context * 2) put(i);
    }
  });
  return hunks.map((h) => {
    const lines = h.idx.map((k) => ops[k]);
    return { a: lines.find((l) => l.a)?.a ?? 0, b: lines.find((l) => l.b)?.b ?? 0, i0: h.idx[0], i1: h.idx.at(-1) + 1, lines: lines.map((l) => [l.t, l.a, l.b, l.text]) };
  });
}

// The lines a symbol occupies, widened to its attached attributes,
// decorators, and doc comments, plus one trailing blank line when the symbol
// sits between blank lines. Returns 0-based [a, b).
export function symbolSpan(lines, from, to) {
  let a = from - 1, b = to;
  while (a > 0 && /^\s*(?:@|\[[A-Z]|\/\/|\/\*\*|\*|#\[)/.test(lines[a - 1])) a--;
  if (!lines[b]?.trim() && a > 0 && !lines[a - 1]?.trim()) b++;
  return [a, b];
}

// ───────────────────────────── Stage ─────────────────────────────
// Pending edits. Nothing touches disk until apply(). Every apply can be undone.

export class Stage {
  constructor(space) {
    this.space = space;
    this.items = new Map();   // key → { key, repo, rel, before, after, from? }
    this.undos = [];
  }
  read(key) {
    const item = this.items.get(key);
    if (item) return item.after;
    return this.space.diskText(key);
  }
  write(key, text) {
    const { repo, rel } = this.space.locate(key);
    const k = `${repo.name}/${rel}`;
    let item = this.items.get(k);
    if (!item) {
      item = { key: k, repo, rel, before: this.space.diskText(k), after: null };
      this.items.set(k, item);
    }
    item.after = text;
    if (item.after === item.before) this.items.delete(k);
  }
  remove(key) { this.write(key, null); }
  // Replace lines from..to (1-based, inclusive) with `text`. from = to + 1
  // inserts without removing.
  editRange(key, from, to, text) {
    const k = this.space.locate(key).key;
    const cur = this.read(k);
    if (cur == null) throw new Error(`No such file: ${key}`);
    const lines = cur === '' ? [] : cur.split('\n');
    const count = cur === '' ? 0 : cur.endsWith('\n') ? lines.length - 1 : lines.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > count + 1 || to < from - 1 || to > count) throw new Error(`Lines ${from}–${to} are outside ${k} (1–${count}).`);
    const repl = text === '' ? [] : String(text).replace(/\n$/, '').split('\n');
    lines.splice(from - 1, to - from + 1, ...repl);
    this.write(k, lines.join('\n'));
    return k;
  }
  // Undo one hunk of a staged edit. New and deleted files have one hunk:
  // reverting it drops the item.
  revertHunk(key, index) {
    const k = this.space.locate(key).key;
    const it = this.items.get(k);
    if (!it) throw new Error(`${k} is not staged.`);
    if (it.before == null || it.after == null) { this.items.delete(k); return k; }
    const ops = diffLines(it.before, it.after);
    const h = makeHunks(ops)[index];
    if (!h) throw new Error(`No hunk ${index + 1} in ${k}.`);
    const out = [];
    ops.forEach((op, i) => {
      const inside = i >= h.i0 && i < h.i1;
      if (op.t === ' ' || (op.t === '-' && inside) || (op.t === '+' && !inside)) out.push(op.text);
    });
    this.write(k, out.join('\n'));
    return k;
  }
  move(from, to) {
    const text = this.read(from);
    if (text == null) throw new Error(`No such file: ${from}`);
    if (this.read(to) != null) throw new Error(`Already exists: ${to}`);
    this.write(to, text);
    this.remove(from);
    const item = this.items.get(this.space.locate(to).key);
    if (item) item.from = this.space.locate(from).key;
  }
  list() {
    return [...this.items.values()].sort((a, b) => a.key.localeCompare(b.key)).map((it) => {
      const ops = diffLines(it.before ?? '', it.after ?? '');
      return { key: it.key, path: it.rel, repo: it.repo.name, state: stateOf(it), adds: ops.filter((o) => o.t === '+').length, dels: ops.filter((o) => o.t === '-').length, from: it.from, conflict: this.space.diskText(it.key) !== it.before || undefined };
    });
  }
  diff(key) {
    const it = this.items.get(key);
    if (!it) return null;
    const ops = diffLines(it.before ?? '', it.after ?? '');
    return { key, path: it.rel, state: stateOf(it), from: it.from, lang: langOf(it.rel), hunks: makeHunks(ops) };
  }
  async apply(keys) {
    const picked = (keys?.length ? keys : [...this.items.keys()]).map((k) => this.items.get(k)).filter(Boolean);
    const done = [];
    for (const it of picked) {
      const abs = path.join(it.repo.root, it.rel);
      if (!(await insideRoot(abs, it.repo.root))) throw new Error(`${it.key} points outside its repo. Not written.`);
      const now = await readMaybe(abs);
      if (now !== it.before) throw new Error(`${it.key} changed on disk since it was staged. Discard and redo it.`);
    }
    for (const it of picked) {
      const abs = path.join(it.repo.root, it.rel);
      if (it.after == null) { await fsp.rm(abs, { force: true }); await pruneDirs(path.dirname(abs), it.repo.root); }
      else { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, it.after); }
      done.push({ key: it.key, repo: it.repo, rel: it.rel, before: it.before, after: it.after });
      this.items.delete(it.key);
    }
    if (done.length) this.undos.push(done);
    if (this.undos.length > 30) this.undos.shift();
    return done.map((d) => d.key);
  }
  discard(keys) {
    for (const k of keys?.length ? keys : [...this.items.keys()]) this.items.delete(k);
  }
  async undo() {
    const group = this.undos.pop();
    if (!group) return [];
    for (const d of group.reverse()) {
      const abs = path.join(d.repo.root, d.rel);
      if (d.before == null) { await fsp.rm(abs, { force: true }); await pruneDirs(path.dirname(abs), d.repo.root); }
      else { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, d.before); }
    }
    return group.map((d) => d.key);
  }
}

const stateOf = (it) => (it.before == null ? 'add' : it.after == null ? 'delete' : 'edit');

// Refuse to write through symlinks that lead outside the repo.
async function insideRoot(abs, root) {
  let probe = abs;
  while (probe.startsWith(root) && probe !== root) {
    try {
      const real = await fsp.realpath(probe);
      const realRoot = await fsp.realpath(root);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch { probe = path.dirname(probe); }
  }
  return probe === root;
}

async function readMaybe(abs) {
  try { return await fsp.readFile(abs, 'utf8'); } catch { return null; }
}

async function pruneDirs(dir, root) {
  while (dir.startsWith(root) && dir !== root) {
    try { if ((await fsp.readdir(dir)).length) return; await fsp.rmdir(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

// ───────────────────────────── Scanning ─────────────────────────────

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function isGit(root) {
  return (await run('git', ['rev-parse', '--is-inside-work-tree'], root))?.trim() === 'true';
}

export async function listFiles(root) {
  if (await isGit(root)) {
    const out = await run('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], root);
    if (out != null) return [...new Set(out.split('\0').filter(Boolean))].filter((r) => !r.split('/').some((p) => p === '.git' || p === 'node_modules')).slice(0, MAX_FILES);
  }
  const out = [];
  const walk = async (rel) => {
    let entries;
    try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.env.example' && e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(r); }
      else if (e.isFile()) out.push(r);
    }
  };
  await walk('');
  return out;
}

async function readGit(root) {
  if (!(await isGit(root))) return null;
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root))?.trim() ?? null;
  const prefix = (await run('git', ['rev-parse', '--show-prefix'], root))?.trim() ?? '';
  const log = (await run('git', ['log', '-n', '3000', '--no-merges', '--format=%x01%at', '--name-only', '--', '.'], root)) ?? '';
  const files = new Map();
  const together = new Map();
  for (const chunk of log.split('\x01')) {
    const lines = chunk.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const time = +lines[0];
    const rels = [];
    for (const p of lines.slice(1)) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      rels.push(rel);
      const f = files.get(rel);
      if (f) { f.churn++; f.time = Math.max(f.time, time); } else files.set(rel, { churn: 1, time });
    }
    // Commits that touch many files are formatting, renames, or merges: skip them.
    if (rels.length < 2 || rels.length > 24) continue;
    const list = [...new Set(rels)].sort();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const key = list[i] + '\0' + list[j];
      together.set(key, (together.get(key) ?? 0) + 1);
    }
  }
  // Pairs that change together often enough to mean something.
  const pairs = [];
  for (const [key, count] of together) {
    if (count < 3) continue;
    const [a, b] = key.split('\0');
    if (count / Math.min(files.get(a).churn, files.get(b).churn) >= 0.35) pairs.push([a, b, count]);
  }
  pairs.sort((p, q) => q[2] - p[2]);
  pairs.length = Math.min(pairs.length, 4000);
  const status = (await run('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], root)) ?? '';
  const dirty = new Set();
  const parts = status.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const rel = p.slice(3);
    if (p[0] === 'R' || p[0] === 'C') i++;
    dirty.add(rel.startsWith(prefix) ? rel.slice(prefix.length) : rel);
  }
  return { branch, files, dirty, pairs };
}

async function pool(list, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  }));
}

export async function scanRepo(repo, onStep) {
  const rels = await listFiles(repo.root);
  const seen = new Set();
  let done = 0;
  const total = rels.length;
  await pool(rels, 16, async (rel) => {
    const abs = path.join(repo.root, rel);
    let st;
    try { st = await fsp.stat(abs); } catch { return; }
    if (!st.isFile()) return;
    done++;
    if (done % 100 === 0) onStep?.({ repo: repo.name, done, total });
    const old = repo.facts.get(rel);
    if (old && old.mtime === st.mtimeMs && old.bytes === st.size) { seen.add(rel); return; }
    if (repo.skip.get(rel) === st.mtimeMs) return;
    if (st.size > MAX_BYTES) {
      seen.add(rel);
      repo.facts.set(rel, { rel, lang: langOf(rel), lines: Math.round(st.size / 40), gen: true, syms: [], imports: [], words: new Map(), marks: [], copy: null, mtime: st.mtimeMs, bytes: st.size, hash: '' });
      return;
    }
    let buf;
    try { buf = await fsp.readFile(abs); } catch { return; }
    if (buf.subarray(0, 8000).includes(0)) { repo.skip.set(rel, st.mtimeMs); return; }
    seen.add(rel);
    const text = buf.toString('utf8');
    repo.texts.set(rel, text);
    const f = readFacts(rel, text);
    f.mtime = st.mtimeMs;
    f.bytes = st.size;
    repo.facts.set(rel, f);
  });
  for (const rel of [...repo.facts.keys()]) if (!seen.has(rel)) { repo.facts.delete(rel); repo.texts.delete(rel); }
  repo.git = await readGit(repo.root);
  onStep?.({ repo: repo.name, done: total, total });
}

// ───────────────────────────── Config and ledger ─────────────────────────────

export const DEFAULTS = { endpoint: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4.1-flash', apiKey: '', style: '', maxTurns: 40, recent: [] };

export function homeDir() { return process.env.DEVIBE_HOME || path.join(os.homedir(), '.devibe'); }

export function loadConfig(home = homeDir()) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { /* first run */ }
  const env = process.env;
  return {
    ...DEFAULTS, ...saved,
    endpoint: env.DEVIBE_ENDPOINT || saved.endpoint || DEFAULTS.endpoint,
    model: env.DEVIBE_MODEL || saved.model || DEFAULTS.model,
    apiKey: env.DEVIBE_API_KEY || saved.apiKey || env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || '',
  };
}

export function saveConfig(cfg, home = homeDir()) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function ledgerFile(home, root) { return path.join(home, 'ledger', crypto.createHash('sha1').update(root).digest('hex').slice(0, 16) + '.json'); }

function loadLedger(home, root) {
  try { return JSON.parse(fs.readFileSync(ledgerFile(home, root), 'utf8')); } catch { return { root, marks: {}, waives: {} }; }
}

function saveLedger(home, root, led) {
  const file = ledgerFile(home, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(led, null, 1));
}

// ───────────────────────────── Workspace ─────────────────────────────
// The app core. Owns repos, the model, the stage, the ledger, and the agent.
// The socket layer only maps messages to these methods.

export class Workspace {
  constructor({ home = homeDir(), watch = true } = {}) {
    this.home = home;
    this.watching = watch;
    this.repos = [];
    this.model = null;
    this.preview = false;
    this.stage = new Stage(this);
    this.config = loadConfig(home);
    this.ledgers = new Map();
    this.subs = new Set();
    this.agent = { busy: false, history: [], abort: null };
    this.timers = new Map();
    this.quiet = 0;
  }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(type, data) { for (const fn of this.subs) fn(type, data); }

  async open(dir) {
    const root = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
    let st;
    try { st = await fsp.stat(root); } catch { throw new Error(`Folder not found: ${root}`); }
    if (!st.isDirectory()) throw new Error(`Not a folder: ${root}`);
    if (this.repos.some((r) => r.root === root)) return this.repos.find((r) => r.root === root);
    let name = path.basename(root) || 'root';
    for (let i = 2; this.repos.some((r) => r.name === name); i++) name = `${path.basename(root)}-${i}`;
    const repo = { name, root, facts: new Map(), texts: new Map(), skip: new Map(), preview: new Map(), git: null, watchers: new Map() };
    this.repos.push(repo);
    this.ledgers.set(name, loadLedger(this.home, root));
    this.config.recent = [root, ...(this.config.recent ?? []).filter((r) => r !== root)].slice(0, 12);
    this.saveConfig();
    await this.scan([repo]);
    return repo;
  }

  shut(name) {
    const repo = this.repos.find((r) => r.name === name);
    if (!repo) return;
    for (const w of repo.watchers.values()) w.close();
    this.repos = this.repos.filter((r) => r !== repo);
    for (const [k, it] of this.stage.items) if (it.repo === repo) this.stage.items.delete(k);
    this.build();
  }

  async scan(list = this.repos) {
    for (const repo of list) {
      await scanRepo(repo, (step) => this.emit('scan.step', step));
      if (this.watching) this.watch(repo);
    }
    this.build();
  }

  build() {
    this.model = buildModel(this.repos, { ledgers: this.ledgers, stage: this.stage, preview: this.preview });
    this.emit('repo.model', this.model);
    this.emit('stage.state', this.stageState());
  }

  watch(repo) {
    const dirs = new Set(['']);
    for (const rel of repo.facts.keys()) for (let d = posix.dirname(rel); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
    for (const [d, w] of repo.watchers) if (!dirs.has(d)) { w.close(); repo.watchers.delete(d); }
    for (const d of dirs) {
      if (repo.watchers.has(d) || repo.watchers.size >= 4000) continue;
      try {
        const w = fs.watch(path.join(repo.root, d), (evt, name) => {
          if (name && (name === '.git' || name.startsWith('.#') || name.endsWith('~'))) return;
          this.poke(repo);
        });
        w.on('error', () => { w.close(); repo.watchers.delete(d); });
        repo.watchers.set(d, w);
      } catch { /* folder gone or watch limit hit */ }
    }
  }

  poke(repo) {
    if (Date.now() < this.quiet) return;
    clearTimeout(this.timers.get(repo.name));
    this.timers.set(repo.name, setTimeout(() => { if (this.repos.includes(repo)) this.scan([repo]).catch(() => {}); }, 350));
  }

  close() {
    for (const repo of this.repos) for (const w of repo.watchers.values()) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.agent.abort?.abort();
  }

  node(key) {
    if (!this.model) return null;
    const id = index(this.model).byKey.get(key);
    return id == null ? null : this.model.nodes[id];
  }

  locate(key) {
    const clean = String(key).replace(/^\/+/, '').split('#')[0];
    let repo = this.repos.find((r) => clean === r.name || clean.startsWith(r.name + '/'));
    let rel;
    if (repo) rel = clean.slice(repo.name.length + 1);
    else if (this.repos.length === 1) { repo = this.repos[0]; rel = clean; }
    else throw new Error(`Start the path with a repo name: ${this.repos.map((r) => r.name).join(', ')}`);
    rel = posix.normalize(rel.replace(/\\/g, '/'));
    while (rel.startsWith('./')) rel = rel.slice(2);
    if (!rel || rel === '.' || rel.split('/').includes('..') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`Path is outside the repo: ${key}`);
    const abs = path.resolve(repo.root, rel);
    if (!abs.startsWith(repo.root + path.sep)) throw new Error(`Path is outside the repo: ${key}`);
    return { repo, rel, key: `${repo.name}/${rel}`, abs };
  }

  diskText(key) {
    const { repo, rel, abs } = this.locate(key);
    if (repo.texts.has(rel)) {
      const f = repo.facts.get(rel);
      try { const st = fs.statSync(abs); if (f && st.mtimeMs === f.mtime) return repo.texts.get(rel); } catch { return null; }
    }
    try {
      const real = fs.realpathSync(abs);
      const root = fs.realpathSync(repo.root);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return fs.readFileSync(real, 'utf8');
    } catch { return null; }
  }

  text(key) {
    const { key: k } = this.locate(key);
    return this.preview && this.stage.items.has(k) ? this.stage.items.get(k).after : this.diskText(k);
  }

  find(query, { regex = false, cased = false, limit = 400 } = {}) {
    if (!query) return [];
    let re;
    try { re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cased ? '' : 'i'); } catch (e) { throw new Error(`Bad pattern: ${e.message}`); }
    const hits = [];
    for (const repo of this.repos) {
      for (const [rel, text] of repo.texts) {
        if (!repo.facts.has(rel) || repo.facts.get(rel).gen) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          hits.push({ key: `${repo.name}/${rel}`, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  stageState() {
    return { items: this.stage.list(), undo: this.stage.undos.length, preview: this.preview };
  }

  async applyStage(keys) {
    this.quiet = Date.now() + 1500;
    const done = await this.stage.apply(keys);
    await this.scan(this.repos.filter((r) => done.some((k) => k.startsWith(r.name + '/'))));
    return done;
  }

  async undoStage() {
    this.quiet = Date.now() + 1500;
    const done = await this.stage.undo();
    await this.scan(this.repos.filter((r) => done.some((k) => k.startsWith(r.name + '/'))));
    return done;
  }

  setPreview(on) { this.preview = !!on; this.build(); }

  // Mechanical edits (no agent): rename a symbol, move or delete files and symbols.
  renameSymbol(key, name) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('Use a plain identifier.');
    const node = this.node(key);
    if (!node || !['type', 'func', 'space'].includes(node.kind)) throw new Error('Pick a type or function to rename.');
    const old = node.name.split('::').pop();
    const re = new RegExp(`(?<![\\w$])${old.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
    let touched = 0;
    for (const repo of this.repos) {
      for (const [rel, f] of repo.facts) {
        if (f.gen || LANG[f.lang]?.data || !f.words.has(old)) continue;
        const k = `${repo.name}/${rel}`;
        const text = this.stage.read(k);
        if (text == null || !text.includes(old)) continue;
        const masked = maskCode(text, f.lang);
        let out = '', last = 0;
        for (const m of text.matchAll(re)) {
          if (masked[m.index] !== text[m.index]) continue;
          out += text.slice(last, m.index) + name;
          last = m.index + old.length;
        }
        if (!last) continue;
        this.stage.write(k, out + text.slice(last));
        touched++;
      }
    }
    return touched;
  }

  moveFile(key, toDir) {
    const node = this.node(key);
    const target = this.node(toDir);
    if (!node || !target || !['dir', 'repo'].includes(target.kind)) throw new Error('Drop onto a folder.');
    const fromRepo = this.locate(key).repo, toRepo = target.kind === 'repo' ? this.repos.find((r) => r.name === target.name) : this.locate(target.key).repo;
    const files = node.kind === 'file' ? [node] : this.model.nodes.filter((n) => n.kind === 'file' && n.key.startsWith(node.key + '/'));
    if (!files.length) throw new Error('Nothing to move.');
    const baseDir = node.kind === 'file' ? posix.dirname(node.path) : posix.dirname(node.path);
    const moved = [];
    for (const f of files) {
      const tail = posix.relative(baseDir === '.' ? '' : baseDir, f.path);
      const to = `${toRepo.name}/${posix.join(target.path ?? '', tail)}`;
      if (to === f.key) continue;
      this.stage.move(`${fromRepo.name}/${f.path}`, to);
      moved.push(to);
    }
    return moved;
  }

  deleteNodes(keys) {
    let count = 0;
    const byFile = new Map();
    for (const key of keys) {
      const node = this.node(key);
      if (!node) continue;
      if (node.kind === 'file') { this.stage.remove(key); count++; }
      else if (node.kind === 'dir') { for (const f of this.model.nodes) if (f.kind === 'file' && f.key.startsWith(key + '/')) { this.stage.remove(f.key); count++; } }
      else if (node.from) {
        const fk = key.split('#')[0];
        if (!byFile.has(fk)) byFile.set(fk, []);
        byFile.get(fk).push([node.from, node.to]);
      }
    }
    for (const [fk, ranges] of byFile) {
      const text = this.stage.read(fk);
      if (text == null) continue;
      const lines = text.split('\n');
      ranges.sort((a, b) => b[0] - a[0]);
      for (const [from, to] of ranges) {
        const [a, b] = symbolSpan(lines, from, to);
        lines.splice(a, b - a);
        count++;
      }
      this.stage.write(fk, lines.join('\n'));
    }
    return count;
  }

  // Move a type or function to the end of another file. Its attributes,
  // decorators, and doc comments go with it. Both files are staged.
  moveSymbol(key, toFile) {
    const node = this.node(key);
    const target = this.node(toFile);
    if (!node || !node.from || !['type', 'func', 'space', 'part'].includes(node.kind)) throw new Error('Pick a type or function to move.');
    if (!target || target.kind !== 'file') throw new Error('Drop onto a file.');
    const from = key.split('#')[0];
    if (from === target.key) throw new Error(`${node.name} is already in ${target.name}.`);
    const text = this.stage.read(from);
    const dest = this.stage.read(target.key);
    if (text == null || dest == null) throw new Error('That file is gone or staged for delete.');
    const lines = text.split('\n');
    const [a, b] = symbolSpan(lines, node.from, node.to);
    const cut = lines.slice(a, b);
    while (cut.length && !cut.at(-1).trim()) cut.pop();
    lines.splice(a, b - a);
    this.stage.write(from, lines.join('\n'));
    const body = dest.replace(/\s+$/, '');
    this.stage.write(target.key, (body ? body + '\n\n' : '') + cut.join('\n') + '\n');
    return { from, to: target.key, name: node.name };
  }

  // Lines in a file that are link sites (out), and lines elsewhere that link
  // into the file (in). Changes-with links have no lines.
  fileLinks(key) {
    const m = this.model;
    const I = index(m);
    const f = I.byKey.get(key);
    if (f == null || m.nodes[f].kind !== 'file') throw new Error(`No such file: ${key}`);
    const out = [], inn = [];
    const lines = (s, t, kind) => { const list = m.sites.get(`${s},${t},${kind}`) ?? []; return kind === 'copy' ? list.slice(0, 1) : list; };
    walk(I, f, (x) => {
      for (const li of I.out[x]) {
        const [s, t, k] = m.links[li];
        const kind = m.linkKinds[k];
        if (kind === 'change') continue;
        for (const line of lines(s, t, kind)) if (out.length < 2000) out.push({ line, from: m.nodes[s].key, to: m.nodes[t].key, kind });
      }
      for (const li of I.inn[x]) {
        const [s, t, k] = m.links[li];
        const kind = m.linkKinds[k];
        if (kind === 'change' || isUnder(I, s, t)) continue;
        for (const line of lines(s, t, kind)) if (inn.length < 2000) inn.push({ from: m.nodes[s].key, line, kind, to: m.nodes[t].key });
      }
    });
    return { key, out, in: inn };
  }

  // Saved sets live in the ledger of the repo that holds their first member.
  setsState() {
    const sets = [];
    for (const repo of this.repos) for (const [id, s] of Object.entries(this.ledgers.get(repo.name)?.sets ?? {})) sets.push({ id, repo: repo.name, ...s });
    return { sets: sets.sort((a, b) => b.at - a.at) };
  }

  saveSet(set) {
    const strs = (list, n) => (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string').slice(0, n);
    const nodes = strs(set?.nodes, 5000);
    const links = (Array.isArray(set?.links) ? set.links : []).filter((l) => Array.isArray(l) && l.length === 3 && l.every((x) => typeof x === 'string')).slice(0, 5000);
    const ranges = (Array.isArray(set?.ranges) ? set.ranges : []).filter((r) => Array.isArray(r) && typeof r[0] === 'string' && Number.isInteger(r[1]) && Number.isInteger(r[2])).slice(0, 5000);
    const first = nodes[0] ?? links[0]?.[0] ?? ranges[0]?.[0];
    if (!first) throw new Error('The set is empty.');
    const repo = this.repoFor(first);
    const led = this.ledgers.get(repo.name);
    led.sets ??= {};
    let id = typeof set.id === 'string' && /^[\w-]{1,40}$/.test(set.id) ? set.id : null;
    for (const r of this.repos) {
      const other = this.ledgers.get(r.name);
      if (id && r !== repo && other.sets?.[id]) { delete other.sets[id]; saveLedger(this.home, r.root, other); }
    }
    if (!id || !led.sets[id]) {
      if (Object.keys(led.sets).length >= 200) throw new Error(`${repo.name} already has 200 saved sets. Remove one first.`);
      id ??= crypto.randomBytes(6).toString('hex');
    }
    const name = String(set.name ?? '').trim().slice(0, 80) || 'Untitled set';
    led.sets[id] = { name, nodes, links, ranges, recipe: Array.isArray(set.recipe) ? set.recipe.slice(0, 20) : null, at: Date.now() };
    saveLedger(this.home, repo.root, led);
    this.emit('sets.state', this.setsState());
    return id;
  }

  dropSet(id) {
    for (const repo of this.repos) {
      const led = this.ledgers.get(repo.name);
      if (!led.sets?.[id]) continue;
      delete led.sets[id];
      saveLedger(this.home, repo.root, led);
    }
    this.emit('sets.state', this.setsState());
  }

  repoFor(key) {
    const repo = this.repos.find((r) => key === r.name || key.startsWith(r.name + '/')) ?? (this.repos.length === 1 ? this.repos[0] : null);
    if (!repo) throw new Error(`Unknown repo for ${key}`);
    return repo;
  }

  mark(keys, on) {
    const nodes = this.model?.nodes ?? [];
    for (const key of keys) {
      const repo = this.repoFor(key);
      const led = this.ledgers.get(repo.name);
      const node = this.node(key);
      const targets = node && (node.kind === 'dir' || node.kind === 'repo') ? nodes.filter((f) => f.kind === 'file' && f.key.startsWith(key + '/')) : [node ?? { key }];
      for (const t of targets) {
        if (!on) { delete led.marks[t.key]; continue; }
        const text = this.diskText(t.key);
        if (text == null) continue;
        led.marks[t.key] = { hash: rangeHash(text, t.from, t.to), from: t.from, to: t.to, at: Date.now() };
      }
    }
    for (const repo of this.repos) saveLedger(this.home, repo.root, this.ledgers.get(repo.name));
    this.build();
  }

  waive(rule, key, on) {
    const repo = this.repoFor(key);
    const led = this.ledgers.get(repo.name);
    led.waives ??= {};
    if (on) led.waives[`${rule}|${key}`] = Date.now(); else delete led.waives[`${rule}|${key}`];
    saveLedger(this.home, repo.root, led);
    this.build();
  }

  setConfig(patch) {
    for (const k of ['endpoint', 'model', 'apiKey', 'style', 'maxTurns']) if (patch[k] !== undefined) this.config[k] = k === 'maxTurns' ? Math.max(1, Math.min(200, +patch[k] || 40)) : String(patch[k]);
    this.saveConfig();
  }
  saveConfig() { try { saveConfig(this.config, this.home); } catch { /* read-only home */ } }
  configState() {
    const { endpoint, model, style, maxTurns, recent } = this.config;
    return { endpoint, model, style, maxTurns, recent, hasKey: !!this.config.apiKey, repos: this.repos.map((r) => ({ name: r.name, root: r.root })) };
  }
}

// ───────────────────────────── Agent ─────────────────────────────

function brief(space) {
  const m = space.model;
  const repos = space.repos.map((r) => `- ${r.name} (${r.root})`).join('\n');
  const langs = m?.langs.slice(0, 6).map((l) => `${l.name} ${l.lines} lines`).join(', ') ?? '';
  return [
    'You are the editing agent inside devibe, a tool for seeing, checking, and reshaping codebases.',
    `Repos (paths start with the repo name):\n${repos}`,
    `Size: ${m?.stats.files ?? 0} files, ${m?.stats.lines ?? 0} lines. Languages: ${langs}.`,
    'How to work:',
    '- Read before you write. Never guess file contents. Use show_outline and find_refs to see structure.',
    '- Your edits are staged, not saved. The user reviews and applies them. Never claim they are applied.',
    '- Make the smallest change that fully does the task. Keep the existing style and naming.',
    '- When you move or rename something, update every reference. Check with find_refs, show_links, and find_text.',
    '- show_links lists what a part uses and what uses it, with the lines where it happens.',
    '- When asked to explain, answer in plain, direct words and do not edit.',
    '- Finish with a short summary of what changed and why, as a bullet list.',
    space.config.style ? `The user\'s style guide (always follow it):\n${space.config.style}` : '',
  ].filter(Boolean).join('\n');
}

// Agent actions. The Act bar shows them; the prompts live here, next to the
// rules, so they can be tested. `takes` says what a set needs for the action
// to apply (see the Act bar in DESIGN.md).
export const ACTS = [
  { id: 'explain', name: 'Explain', edits: false, takes: 'any', about: 'What it does, how it connects, what is risky. No edits.', prompt: 'Explain what the selection does and how its parts work together. Use the connections listed below: say how it depends on the rest and what depends on it. Point out anything surprising, risky, or unused. Do not edit.' },
  { id: 'tidy', name: 'Tidy', edits: true, takes: 'code', about: 'Clearer names, simpler logic, no leftovers. Same behavior.', prompt: 'Tidy the selection: clearer names, simpler logic, no dead code or leftovers. Keep behavior and the interface listed below the same.' },
  { id: 'split', name: 'Split', edits: true, takes: 'one', about: 'Smaller, well-named parts, each where it belongs.', prompt: 'Split the selection into smaller, well-named parts. Put each part where it belongs. Update every reference listed below.' },
  { id: 'fix', name: 'Fix findings', edits: true, takes: 'issues', about: 'Fix the open findings in the selection.', prompt: 'Fix the findings listed for the selection. Keep behavior the same.' },
  { id: 'tests', name: 'Add tests', edits: true, takes: 'code', about: 'Focused unit tests in the repo’s test style.', prompt: 'Add focused unit tests for the selection, in the test style this repo already uses. Cover the interface listed below.' },
  { id: 'docs', name: 'Document', edits: true, takes: 'code', about: 'Short doc comments on the public parts.', prompt: 'Add short doc comments to the public parts of the selection. Plain words, no filler.' },
  { id: 'decouple', name: 'Decouple', edits: true, takes: 'link', about: 'Remove the selected dependency without changing behavior.', prompt: 'Remove the dependency in the selected links without changing behavior: pass it in, put it behind a small interface, or move the shared part where both sides can use it. Update every call site listed.' },
  { id: 'merge', name: 'Merge copies', edits: true, takes: 'copy', about: 'Replace copied code with one shared part.', prompt: 'The selected places hold copied code. Replace the copies with one shared function or type in the best place and use it from each place. Keep behavior the same.' },
  { id: 'extract', name: 'Extract', edits: true, takes: 'group', about: 'Move the parts into one new folder or module.', prompt: 'Move the selected parts into one new, well-named folder or module. Expose only what the rest of the code uses (the "used from outside" list). Update every import and reference.' },
];
const ACT = Object.fromEntries(ACTS.map((a) => [a.id, a]));
const KIND_WORD = { import: 'import', call: 'call', use: 'use', base: 'extends', copy: 'copy', change: 'changes with' };

// A short, qualified name: Cart.total, api.post, web/src/cart.ts, web/src/.
function partName(m, I, id) {
  const n = m.nodes[id];
  if (n.kind === 'file') return n.path;
  if (n.kind === 'dir') return `${n.path || n.name}/`;
  if (n.kind === 'repo' || n.kind === 'root') return n.name;
  const chain = n.key.split('#')[1] ?? n.name;
  const stem = m.nodes[I.fileOf[id]].name.replace(/\.[^.]+$/, '');
  return chain.includes('.') || stem.toLowerCase() === chain.toLowerCase() ? chain : `${stem}.${chain}`;
}

const kindsText = (m, list) => {
  const w = new Map();
  for (const li of list) { const [, , k, weight] = m.links[li]; const kind = KIND_WORD[m.linkKinds[k]] ?? m.linkKinds[k]; w.set(kind, (w.get(kind) ?? 0) + weight); }
  return [...w].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
};

// Where links happen: file:line, line; grouped by source file, 12 lines at most.
function sitesText(m, I, list, full = false, cap = 12) {
  const byFile = new Map();
  let n = 0;
  for (const li of list) {
    const [s, t, k] = m.links[li];
    const kind = m.linkKinds[k];
    let lines = m.sites?.get(`${s},${t},${kind}`) ?? [];
    if (kind === 'copy') lines = lines.slice(0, 1);
    const f = m.nodes[I.fileOf[s]];
    if (!f || !lines.length) continue;
    const name = full ? f.key : f.name;
    if (!byFile.has(name)) byFile.set(name, new Set());
    for (const l of lines) { if (n >= cap) break; if (!byFile.get(name).has(l)) { byFile.get(name).add(l); n++; } }
  }
  return [...byFile].filter(([, set]) => set.size).map(([f, set]) => `${f}:${[...set].sort((a, b) => a - b).join(', ')}`).join('; ');
}

function scopeOf(set, focus = []) {
  const strs = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  return {
    nodes: [...new Set([...strs(set?.nodes), ...strs(focus)])],
    links: (Array.isArray(set?.links) ? set.links : []).filter((l) => Array.isArray(l) && l.length === 3 && l.every((x) => typeof x === 'string')),
    ranges: (Array.isArray(set?.ranges) ? set.ranges : []).filter((r) => Array.isArray(r) && typeof r[0] === 'string' && Number.isInteger(r[1]) && Number.isInteger(r[2])),
  };
}

// The prompt text for a set: its members with findings, the links inside it,
// and its interface to the rest of the code, with call sites. Replaces the
// old focus list; a plain `focus` array still counts as `set.nodes`.
export function setText(space, set, { limit = 12000 } = {}) {
  const m = space.model;
  if (!m || !set) return '';
  const I = index(m);
  const scope = scopeOf(set);
  const ids = scope.nodes.map((k) => I.byKey.get(k)).filter((id) => id != null);
  const links = scope.links.filter((l) => I.byKey.has(l[0]) && I.byKey.has(l[1]));
  const ranges = scope.ranges.filter((r) => I.byKey.has(r[0]));
  if (!ids.length && !links.length && !ranges.length) return '';
  const N = m.nodes;
  const open = m.issues.filter((i) => !i.waived);
  const ruleName = (id) => RULES.find((r) => r.id === id)?.name ?? id;
  const issuesUnder = (id) => open.filter((i) => isUnder(I, i.node, id));
  const out = [];
  const counts = [];
  if (ids.length) counts.push(`${ids.length} part${ids.length === 1 ? '' : 's'}`);
  if (links.length) counts.push(`${links.length} link${links.length === 1 ? '' : 's'}`);
  if (ranges.length) counts.push(`${ranges.length} line range${ranges.length === 1 ? '' : 's'}`);
  out.push(`Selection (${counts.join(', ')}):`);
  const findings = (list) => {
    for (const i of list.slice(0, 6)) out.push(`  finding: ${ruleName(i.rule)}: ${i.note} (${N[I.fileOf[i.node]]?.path ?? N[i.node].path ?? ''}:${i.line})`);
    if (list.length > 6) out.push(`  +${list.length - 6} more findings`);
  };
  for (const id of ids.slice(0, 40)) {
    const n = N[id];
    const facts = [`${n.lines} lines`];
    if (n.kind === 'func') facts.push(`${n.cx ?? 0} branches`, `${n.args ?? 0} parameters`);
    if (n.kind === 'file') facts.push(LANG[n.lang]?.name ?? n.lang);
    if (n.kind === 'dir' || n.kind === 'repo') { let files = 0; walk(I, id, (x) => { if (N[x].kind === 'file') { files++; return false; } }); facts.unshift(`${files} file${files === 1 ? '' : 's'}`); }
    const word = n.kind === 'dir' ? 'folder' : n.form ?? n.kind;
    const where = n.from ? ` at ${n.key.split('#')[0]}:${n.from}-${n.to}` : '';
    out.push(`- ${word} ${n.from ? partName(m, I, id) : n.key}${where} (${facts.join(', ')})`);
    findings(issuesUnder(id));
  }
  if (ids.length > 40) {
    const rest = new Map();
    for (const id of ids.slice(40)) {
      const n = N[id];
      const word = n.kind === 'dir' ? 'folder' : n.kind === 'func' ? 'function' : n.kind;
      const dir = N[I.fileOf[id] >= 0 ? N[I.fileOf[id]].up : n.up];
      const key = `${word}s in ${dir?.path || dir?.name || 'the workspace'}`;
      rest.set(key, (rest.get(key) ?? 0) + 1);
    }
    for (const [what, n] of rest) out.push(`- +${n} more ${what}`);
  }
  for (const [fk, from, to] of ranges) {
    out.push(`- lines ${fk}:${from}-${to}`);
    const f = I.byKey.get(fk);
    findings(open.filter((i) => I.fileOf[i.node] === f && i.line >= from && i.line <= to));
  }
  for (const l of links) {
    const list = linkIndices(I, l);
    const [a, b] = [I.byKey.get(l[0]), I.byKey.get(l[1])];
    const arrow = l[2] === 'change' || l[2] === 'copy' ? '↔' : '→';
    if (!list.length) { out.push(`- link: ${partName(m, I, a)} ${arrow} ${partName(m, I, b)} (no ${l[2] === '*' ? '' : KIND_WORD[l[2]] + ' '}links found)`); continue; }
    const where = sitesText(m, I, list, true);
    out.push(`- link: ${partName(m, I, a)} ${arrow} ${partName(m, I, b)} (${kindsText(m, list)}${where ? `, at ${where}` : ''})`);
  }
  // The interface: links inside the set, what it uses, and what uses it.
  const bound = boundary(I, { nodes: ids.map((id) => N[id].key) }, 5);
  const uses = bound.out.map((e) => ({ name: partName(m, I, e.b), list: e.list, w: e.w }));
  const users = bound.in.map((e) => ({ name: partName(m, I, e.a), list: e.list, w: e.w }));
  for (const [fk, from, to] of ranges) {
    const f = I.byKey.get(fk);
    const inRange = (line) => line >= from && line <= to;
    const usesR = new Map(), usersR = new Map();
    const add = (map, id, li) => { const e = map.get(id) ?? { name: partName(m, I, id), list: [], w: 0 }; e.list.push(li); e.w += m.links[li][3]; map.set(id, e); };
    walk(I, f, (x) => {
      for (const li of I.out[x]) {
        const [s, t, k] = m.links[li];
        const lines = m.sites.get(`${s},${t},${m.linkKinds[k]}`) ?? [];
        if (!STATIC_KINDS.has(m.linkKinds[k]) || !lines.some(inRange)) continue;
        if (I.fileOf[t] === f && inRange(N[t].from ?? 0)) continue;
        add(usesR, liftTo(I, t, 5), li);
      }
      if (x !== f && inRange(N[x].from ?? 0)) {
        for (const li of I.inn[x]) {
          const [s, t, k] = m.links[li];
          if (!STATIC_KINDS.has(m.linkKinds[k]) || isUnder(I, s, x)) continue;
          add(usersR, liftTo(I, s, 5), li);
        }
      }
    });
    uses.push(...usesR.values());
    users.push(...usersR.values());
  }
  const line = (title, rows) => {
    if (!rows.length) return;
    const merged = new Map();
    for (const e of rows) { const x = merged.get(e.name); if (x) { x.list.push(...e.list); x.w += e.w; } else merged.set(e.name, { ...e, list: [...e.list] }); }
    const list = [...merged.values()].sort((p, q) => q.w - p.w);
    const shown = list.slice(0, 20).map((e) => { const where = sitesText(m, I, e.list); return `${e.name} (${kindsText(m, e.list)}${where ? `, ${where}` : ''})`; });
    out.push(`${title}: ${shown.join('; ')}${list.length > 20 ? `; +${list.length - 20} more` : ''}`);
  };
  line('Inside the selection', bound.inside.map((e) => ({ name: `${partName(m, I, e.a)} → ${partName(m, I, e.b)}`, list: e.list, w: e.w })));
  line('The selection uses', uses);
  line('Used from outside by', users);
  let text = out.join('\n');
  if (text.length > limit) text = text.slice(0, limit - 40).replace(/\n[^\n]*$/, '') + '\n… (the selection is cut to fit)';
  return `\n\n${text}`;
}

// Items for one-by-one runs: each node, link, and range on its own.
function batchItems(space, scope) {
  const m = space.model;
  const I = index(m);
  const items = [];
  for (const k of scope.nodes) { const id = I.byKey.get(k); if (id != null) items.push({ label: m.nodes[id].from ? partName(m, I, id) : k, set: { nodes: [k], links: [], ranges: [] } }); }
  for (const l of scope.links) { const a = I.byKey.get(l[0]), b = I.byKey.get(l[1]); if (a != null && b != null) items.push({ label: `${partName(m, I, a)} → ${partName(m, I, b)}`, set: { nodes: [], links: [l], ranges: [] } }); }
  for (const r of scope.ranges) if (I.byKey.has(r[0])) items.push({ label: `${r[0]}:${r[1]}-${r[2]}`, set: { nodes: [], links: [], ranges: [r] } });
  return items;
}

function agentTools(space, sdk, { write = true } = {}) {
  const step = (name, args, note) => space.emit('agent.step', { kind: 'tool', name, args, note });
  const staged = () => space.emit('stage.state', space.stageState());
  const obj = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
  const str = (d) => ({ type: 'string', description: d });
  const int = (d) => ({ type: 'integer', description: d });
  const make = (name, description, parameters, fn) => sdk.tool({
    name, description, parameters, strict: false,
    execute: async (args) => {
      try { return await fn(args ?? {}); } catch (e) { step(name, args, `Failed: ${e.message}`); return `Error: ${e.message}`; }
    },
  });
  const read = [
    make('list_files', 'List files under a folder with their line counts.', obj({ dir: str('Folder path, or empty for all repos.') }, []), ({ dir = '' }) => {
      const out = [];
      for (const n of space.model.nodes) if (n.kind === 'file' && (!dir || n.key.startsWith(dir.replace(/\/$/, '') + '/') || n.path.startsWith(dir.replace(/\/$/, '') + '/'))) out.push(`${n.key} (${n.lines})`);
      for (const it of space.stage.items.values()) if (it.before == null && it.after != null) out.push(`${it.key} (staged new)`);
      step('list_files', { dir }, `${out.length} files`);
      return out.slice(0, 600).join('\n') + (out.length > 600 ? `\n… ${out.length - 600} more` : '');
    }),
    make('read_file', 'Read a file (staged version if edited). Returns numbered lines. Read at most 400 lines per call.', obj({ path: str('File path.'), from: int('First line, 1-based.'), to: int('Last line.') }, ['path']), ({ path: p, from = 1, to }) => {
      const { key } = space.locate(p);
      const text = space.stage.read(key);
      if (text == null) throw new Error(`No such file: ${p}`);
      const lines = text.split('\n');
      const a = Math.max(1, from), b = Math.min(lines.length, to ?? a + 399, a + 399);
      step('read_file', { path: key, from: a, to: b }, `${b - a + 1} lines`);
      return lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n') + (b < lines.length ? `\n… ${lines.length - b} more lines` : '');
    }),
    make('find_text', 'Search all files for text or a regular expression. Returns path:line: text.', obj({ pattern: str('Text or regex.'), regex: { type: 'boolean' } }, ['pattern']), ({ pattern, regex = false }) => {
      const hits = space.find(pattern, { regex, cased: true, limit: 150 });
      step('find_text', { pattern }, `${hits.length} hit${hits.length === 1 ? '' : 's'}`);
      return hits.map((h) => `${h.key}:${h.line}: ${h.text}`).join('\n') || 'No matches.';
    }),
    make('show_outline', 'Show the types and functions in a file with line ranges.', obj({ path: str('File path.') }, ['path']), ({ path: p }) => {
      const { key } = space.locate(p);
      const file = space.node(key);
      if (!file) throw new Error(`No such file: ${p}`);
      const I = index(space.model);
      const out = [];
      const walkOut = (id, depth) => { for (const k of I.kids[id]) { const n = space.model.nodes[k]; out.push(`${'  '.repeat(depth)}${n.form ?? n.kind} ${n.name} [${n.from}-${n.to}]`); walkOut(k, depth + 1); } };
      walkOut(file.id, 0);
      step('show_outline', { path: key }, `${out.length} items`);
      return out.join('\n') || 'No types or functions found.';
    }),
    make('find_refs', 'Find where a name is declared and every line that uses it.', obj({ name: str('Identifier.') }, ['name']), ({ name }) => {
      const decl = space.model.nodes.filter((n) => n.name === name && n.from).map((n) => `declared: ${n.key.split('#')[0]}:${n.from} (${n.form ?? n.kind})`);
      const uses = [];
      for (const repo of space.repos) for (const [rel, f] of repo.facts) for (const l of f.words.get(name) ?? []) uses.push(`${repo.name}/${rel}:${l}`);
      step('find_refs', { name }, `${uses.length} use${uses.length === 1 ? '' : 's'}`);
      return [...decl, ...uses.slice(0, 300)].join('\n') || 'Not found.';
    }),
    make('show_links', 'Show what a file, type, or function uses (out), what uses it (in), or both, with link kinds, counts, and the path:line where each link happens.', obj({ name_or_path: str('A file path, a symbol key like web/src/cart.ts#Cart.pay, or a name like Cart.pay.'), dir: { type: 'string', enum: ['out', 'in', 'both'], description: 'out: what it uses. in: what uses it. both: both.' } }, ['name_or_path']), ({ name_or_path: q, dir = 'both' }) => {
      const m = space.model;
      const I = index(m);
      const text = String(q ?? '').trim();
      let ids = [];
      try {
        const [p, chain] = text.split('#');
        const { key } = space.locate(p);
        const id = I.byKey.get(chain ? `${key}#${chain}` : key);
        if (id != null) ids = [id];
      } catch { /* not a path */ }
      if (!ids.length) {
        const v = text.toLowerCase();
        ids = m.nodes.filter((n) => n.from && (n.name.toLowerCase() === v || (n.key.split('#')[1] ?? '').toLowerCase() === v || (n.key.split('#')[1] ?? '').toLowerCase().endsWith('.' + v))).map((n) => n.id).slice(0, 3);
      }
      if (!ids.length) throw new Error(`Nothing named ${text}. Use a path or a name from show_outline.`);
      const out = [];
      let total = 0;
      for (const id of ids) {
        const n = m.nodes[id];
        out.push(`${partName(m, I, id)} (${n.form ?? n.kind}, ${n.key.split('#')[0]}${n.from ? `:${n.from}-${n.to}` : ''})`);
        for (const d of dir === 'both' ? ['out', 'in'] : [dir === 'in' ? 'in' : 'out']) {
          const groups = new Map();
          walk(I, id, (x) => {
            for (const li of d === 'out' ? I.out[x] : I.inn[x]) {
              const [s, t] = m.links[li];
              const end = d === 'out' ? t : s;
              if (isUnder(I, end, id)) continue;
              const key = liftTo(I, end, 5);
              const g = groups.get(key) ?? { list: [], w: 0 };
              g.list.push(li); g.w += m.links[li][3];
              groups.set(key, g);
            }
          });
          out.push(d === 'out' ? 'uses:' : 'used by:');
          const list = [...groups].sort((p, q) => q[1].w - p[1].w);
          if (!list.length) out.push('- nothing');
          for (const [end, g] of list.slice(0, 60)) {
            const where = sitesText(m, I, g.list, true);
            out.push(`- ${partName(m, I, end)} (${kindsText(m, g.list)}${where ? `, at ${where}` : ''})`);
          }
          if (list.length > 60) out.push(`- +${list.length - 60} more`);
          total += list.length;
        }
      }
      step('show_links', { name: text, dir }, `${total} link${total === 1 ? '' : 's'}`);
      return out.join('\n');
    }),
  ];
  if (!write) return read;
  return [
    ...read,
    make('write_file', 'Create or replace a whole file (staged).', obj({ path: str('File path.'), text: str('Full new content.') }, ['path', 'text']), ({ path: p, text }) => {
      const { key } = space.locate(p);
      space.stage.write(key, text);
      step('write_file', { path: key }, `${text.split('\n').length} lines`);
      staged();
      return `Staged ${key}.`;
    }),
    make('edit_file', 'Replace an exact piece of text in a file (staged). `find` must match exactly once unless all is true.', obj({ path: str('File path.'), find: str('Exact text to replace.'), replace: str('New text.'), all: { type: 'boolean' } }, ['path', 'find', 'replace']), ({ path: p, find, replace, all = false }) => {
      const { key } = space.locate(p);
      const text = space.stage.read(key);
      if (text == null) throw new Error(`No such file: ${p}`);
      const count = find ? text.split(find).length - 1 : 0;
      if (!count) throw new Error('Text not found. Read the file again and copy the exact text.');
      if (count > 1 && !all) throw new Error(`Text found ${count} times. Add more context or set all.`);
      space.stage.write(key, all ? text.split(find).join(replace) : text.replace(find, () => replace));
      step('edit_file', { path: key }, `${count} change${count > 1 ? 's' : ''}`);
      staged();
      return `Staged edit to ${key}.`;
    }),
    make('move_file', 'Move or rename a file (staged). Update references separately.', obj({ from: str('Current path.'), to: str('New path.') }, ['from', 'to']), ({ from, to }) => {
      const a = space.locate(from).key, b = space.locate(to).key;
      space.stage.move(a, b);
      step('move_file', { from: a, to: b }, 'moved');
      staged();
      return `Staged move ${a} → ${b}.`;
    }),
    make('delete_file', 'Delete a file (staged).', obj({ path: str('File path.') }, ['path']), ({ path: p }) => {
      const { key } = space.locate(p);
      if (space.stage.read(key) == null) throw new Error(`No such file: ${p}`);
      space.stage.remove(key);
      step('delete_file', { path: key }, 'deleted');
      staged();
      return `Staged delete of ${key}.`;
    }),
  ];
}

async function makeClient(cfg) {
  const { default: OpenAI } = await import('openai');
  return new OpenAI({ baseURL: cfg.endpoint, apiKey: cfg.apiKey || 'none', defaultHeaders: { 'X-Title': 'devibe' } });
}

// Throws (before anything starts) when the agent cannot run.
export function agentReady(space, { act } = {}) {
  if (space.agent.busy) throw new Error('The agent is already running.');
  if (!space.config.model || !space.config.endpoint) throw new Error('Set an endpoint and model in Settings.');
  if (!space.model) throw new Error('Open a repo first.');
  if (act && !ACT[act]) throw new Error(`Unknown action: ${act}`);
}

// One streamed run. Text deltas go to onText; throws with the partial text.
async function runOnce(space, sdk, agent, input, onText) {
  const abort = new AbortController();
  space.agent.abort = abort;
  let text = '';
  try {
    const result = await sdk.run(agent, input, { stream: true, maxTurns: space.config.maxTurns || 40, signal: abort.signal });
    for await (const ev of result) {
      if (ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta' && ev.data.delta) {
        text += ev.data.delta;
        onText(ev.data.delta);
      }
    }
    await result.completed;
    return { text: typeof result.finalOutput === 'string' ? result.finalOutput : text, history: result.history ?? input };
  } catch (err) {
    const e = new Error(abort.signal.aborted ? 'Stopped.' : err?.message ?? String(err));
    e.text = text;
    throw e;
  } finally {
    space.agent.abort = null;
  }
}

// Run the agent on a set. `act` picks a server action (its prompt and its
// tools: read-only actions get read tools only). `mode: 'each'` runs once per
// member with a fresh history; only the batch summary joins the conversation.
export async function runAgent(space, { prompt = '', act = null, set = null, focus = [], mode = 'together' } = {}) {
  agentReady(space, { act });
  const A = act ? ACT[act] : null;
  const scope = scopeOf(set, focus);
  const ask = String(prompt ?? '').trim();
  const task = [A?.prompt, ask].filter(Boolean).join('\n\n');
  if (!task) throw new Error('Ask something, or pick an action.');
  const sdk = await import('@openai/agents');
  sdk.setTracingDisabled(true);
  const client = await makeClient(space.config);
  const agent = new sdk.Agent({ name: 'devibe', instructions: brief(space), model: new sdk.OpenAIChatCompletionsModel(client, space.config.model), tools: agentTools(space, sdk, { write: A ? A.edits : true }) });
  const label = A?.name ?? 'Ask';
  space.agent.busy = true;
  space.agent.halt = false;
  space.agent.batch = mode === 'each';
  try {
    if (mode !== 'each') {
      space.emit('agent.step', { kind: 'start', text: ask || label, act, mode: 'together', set: scope });
      const input = [...space.agent.history, sdk.user(task + setText(space, scope))];
      try {
        const r = await runOnce(space, sdk, agent, input, (d) => space.emit('agent.step', { kind: 'text', text: d }));
        space.agent.history = r.history;
        space.emit('agent.done', { text: r.text });
        return r.text;
      } catch (e) {
        space.emit('agent.done', { error: e.message, text: e.text ?? '' });
        return null;
      }
    }
    const items = batchItems(space, scope).slice(0, 50);
    space.emit('agent.step', { kind: 'start', text: ask || label, act, mode: 'each', total: items.length, set: scope });
    if (!items.length) { space.emit('agent.done', { error: 'Nothing to run on. Select something first.', text: '' }); return null; }
    const results = [];
    const changed = (before) => {
      let n = 0;
      for (const [k, it] of space.stage.items) if (!before.has(k) || before.get(k) !== it.after) n++;
      for (const k of before.keys()) if (!space.stage.items.has(k)) n++;
      return n;
    };
    for (let i = 0; i < items.length; i++) {
      if (space.agent.halt) break;
      const it = items[i];
      space.emit('agent.step', { kind: 'item', index: i, total: items.length, label: it.label, state: 'run' });
      const before = new Map([...space.stage.items].map(([k, x]) => [k, x.after]));
      let state = 'none', files = 0, error;
      try {
        await runOnce(space, sdk, agent, [sdk.user(task + setText(space, it.set))], (d) => space.emit('agent.step', { kind: 'text', text: d, index: i }));
        files = changed(before);
        state = files ? 'staged' : 'none';
      } catch (e) {
        state = 'error';
        error = e.message;
        files = changed(before);
        if (e.message === 'Stopped.') space.agent.halt = true;
      }
      results.push({ label: it.label, state, files, error });
      space.emit('agent.step', { kind: 'item', index: i, total: items.length, label: it.label, state, files, error });
      space.emit('stage.state', space.stageState());
    }
    const staged = results.filter((r) => r.state === 'staged');
    const failed = results.filter((r) => r.state === 'error');
    const head = `${label}, one by one: ${results.length} of ${items.length} item${items.length === 1 ? '' : 's'} done${results.length < items.length ? ' (stopped)' : ''}. ${staged.length} staged changes, ${failed.length} failed.`;
    const summary = [head, '', ...results.map((r) => `- ${r.label}: ${r.state === 'staged' ? `staged ${r.files} file${r.files === 1 ? '' : 's'}` : r.state === 'error' ? `failed (${r.error})` : 'no change'}`)].join('\n');
    space.agent.history = [...space.agent.history, sdk.user(`${task}\n\nRun one by one on ${items.length} item${items.length === 1 ? '' : 's'}:\n${items.map((x) => `- ${x.label}`).join('\n')}`), sdk.assistant(summary)];
    space.emit('agent.done', { text: summary, batch: { act, total: items.length, done: results.length, items: results } });
    return summary;
  } finally {
    space.agent.busy = false;
    space.agent.batch = false;
    space.agent.abort = null;
    space.emit('stage.state', space.stageState());
  }
}

// Stop: in a one-by-one batch the first stop finishes the current item and
// then stops; a second stop (or any stop of a single run) aborts at once.
export function stopAgent(space) {
  if (!space.agent.busy) return;
  if (space.agent.batch && !space.agent.halt) {
    space.agent.halt = true;
    space.emit('agent.step', { kind: 'halt' });
    return;
  }
  space.agent.abort?.abort();
}

export async function testAgent(cfg) {
  try {
    const client = await makeClient(cfg);
    const res = await client.chat.completions.create({ model: cfg.model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 8 });
    return { ok: true, text: res.choices?.[0]?.message?.content?.trim() || '(empty reply)' };
  } catch (err) {
    return { ok: false, text: err?.message ?? String(err) };
  }
}

// ───────────────────────────── Sockets and HTTP ─────────────────────────────

const STATIC = {
  '/': ['client.html', 'text/html'],
  '/client.html': ['client.html', 'text/html'],
  '/client.mjs': ['client.mjs', 'text/javascript'],
  '/client.css': ['client.css', 'text/css'],
  '/sets.mjs': ['sets.mjs', 'text/javascript'],
  '/city.mjs': ['city.mjs', 'text/javascript'],
  '/force.mjs': ['force.mjs', 'text/javascript'],
  '/lib/d3.js': ['node_modules/d3/dist/d3.min.js', 'text/javascript'],
};
const LIB_DIRS = [['/lib/three/addons/', 'node_modules/three/examples/jsm/'], ['/lib/three/', 'node_modules/three/build/']];

// The import map is the page's only inline script; allow exactly it by hash.
const IMPORT_MAP_HASH = (() => {
  try {
    const html = fs.readFileSync(path.join(HERE, 'client.html'), 'utf8');
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    return `'sha256-${crypto.createHash('sha256').update(map).digest('base64')}'`;
  } catch { return ''; }
})();

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file, type;
  if (STATIC[url.pathname]) [file, type] = STATIC[url.pathname];
  else {
    for (const [prefix, dir] of LIB_DIRS) {
      if (!url.pathname.startsWith(prefix)) continue;
      const rel = posix.normalize(url.pathname.slice(prefix.length));
      if (rel.startsWith('..') || !rel.endsWith('.js')) break;
      file = dir + rel; type = 'text/javascript';
      break;
    }
  }
  if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
  fs.readFile(path.join(HERE, file), (err, body) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'content-type': type + '; charset=utf-8',
      'cache-control': file.startsWith('node_modules') ? 'max-age=3600' : 'no-cache',
      'x-content-type-options': 'nosniff',
      ...(type === 'text/html' ? { 'content-security-policy': `default-src 'self'; connect-src 'self' ws://${req.headers.host} wss://${req.headers.host}; img-src 'self' data: blob:; style-src 'self'; script-src 'self' ${IMPORT_MAP_HASH}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` } : {}),
    });
    res.end(body);
  });
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Loopback servers only answer to loopback names, which blocks DNS rebinding.
function hostOk(req, host) {
  if (!LOCAL_HOSTS.has(host)) return true;
  const h = (req.headers.host ?? '').replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(h);
}

async function listDir(dir) {
  const abs = path.resolve((dir || os.homedir()).replace(/^~(?=$|\/)/, os.homedir()));
  let entries = [];
  try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { throw new Error(`Cannot read ${abs}`); }
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(abs, e.name);
    items.push({ name: e.name, path: full, repo: fs.existsSync(path.join(full, '.git')) });
  }
  items.sort((a, b) => Number(b.repo) - Number(a.repo) || a.name.localeCompare(b.name));
  return { path: abs, up: path.dirname(abs) !== abs ? path.dirname(abs) : null, repo: fs.existsSync(path.join(abs, '.git')), items: items.slice(0, 500) };
}

function handlers(space) {
  return {
    hello: () => {
      const acts = ACTS.map(({ id, name, edits, takes, about }) => ({ id, name, edits, takes, about }));
      return { type: 'hello', data: { config: space.configState(), model: space.model, stage: space.stageState(), busy: space.agent.busy, acts, sets: space.setsState().sets } };
    },
    'repo.open': async ({ path: p }) => { await space.open(p); return { type: 'config.state', data: space.configState() }; },
    'repo.shut': ({ name }) => { space.shut(name); return { type: 'config.state', data: space.configState() }; },
    'repo.scan': async () => { await space.scan(); return null; },
    'repo.demo': async () => { await space.open(await makeSample(path.join(os.tmpdir(), 'devibe-demo'))); return { type: 'config.state', data: space.configState() }; },
    'dir.list': async ({ path: p }) => ({ type: 'dir.items', data: await listDir(p) }),
    'file.read': ({ key, staged }) => ({ type: 'file.text', data: { key, text: staged ? space.stage.read(space.locate(key).key) : space.text(key), staged: !!staged || undefined } }),
    'file.links': ({ key }) => ({ type: 'file.links', data: space.fileLinks(key) }),
    'text.find': ({ query, regex, cased }) => ({ type: 'find.hits', data: { query, hits: space.find(query, { regex, cased }) } }),
    'agent.run': (opts) => {
      agentReady(space, opts);
      if (!opts.act && !String(opts.prompt ?? '').trim()) throw new Error('Ask something, or pick an action.');
      runAgent(space, opts).catch((e) => space.emit('note', { level: 'error', text: e.message }));
      return null;
    },
    'agent.stop': () => { stopAgent(space); return null; },
    'agent.reset': () => { space.agent.history = []; return { type: 'agent.reset', data: {} }; },
    'agent.test': async () => ({ type: 'agent.tested', data: await testAgent(space.config) }),
    'stage.diff': ({ key }) => ({ type: 'stage.diff', data: space.stage.diff(key) }),
    'stage.apply': async ({ keys }) => { const done = await space.applyStage(keys); return { type: 'note', data: { level: 'good', text: `Applied ${done.length} file${done.length === 1 ? '' : 's'}.` } }; },
    'stage.discard': ({ keys }) => { space.stage.discard(keys); space.build(); return null; },
    'stage.undo': async () => { const done = await space.undoStage(); return { type: 'note', data: { level: 'good', text: done.length ? `Undid ${done.length} file${done.length === 1 ? '' : 's'}.` : 'Nothing to undo.' } }; },
    'stage.rename': ({ key, name }) => { const n = space.renameSymbol(key, name); space.build(); return { type: 'note', data: { level: 'good', text: `Staged rename in ${n} file${n === 1 ? '' : 's'}.` } }; },
    'stage.move': ({ key, to }) => {
      if (['type', 'func', 'space', 'part'].includes(space.node(key)?.kind)) {
        const r = space.moveSymbol(key, to);
        space.build();
        return { type: 'note', data: { level: 'good', text: `Staged move of ${r.name} to ${r.to}.` } };
      }
      const moved = space.moveFile(key, to);
      space.build();
      return { type: 'note', data: { level: 'good', text: `Staged move of ${moved.length} file${moved.length === 1 ? '' : 's'}.` } };
    },
    'stage.edit': ({ key, from, to, text }) => { const k = space.stage.editRange(key, from, to, text ?? ''); space.build(); return { type: 'note', data: { level: 'good', text: `Staged edit to ${k}.` } }; },
    'stage.hunk': ({ key, index: i }) => { const k = space.stage.revertHunk(key, i); space.build(); return { type: 'note', data: { level: 'good', text: `Reverted a change in ${k}.` } }; },
    'set.save': ({ set }) => { const id = space.saveSet(set ?? {}); return { type: 'sets.state', data: { ...space.setsState(), id } }; },
    'set.drop': ({ id }) => { space.dropSet(id); return { type: 'sets.state', data: space.setsState() }; },
    'stage.delete': ({ keys }) => { const n = space.deleteNodes(keys); space.build(); return { type: 'note', data: { level: 'good', text: `Staged ${n} deletion${n === 1 ? '' : 's'}.` } }; },
    'stage.preview': ({ on }) => { space.setPreview(on); return null; },
    'review.mark': ({ keys, on }) => { space.mark(keys, on); return null; },
    'issue.waive': ({ rule, key, on }) => { space.waive(rule, key, on); return null; },
    'config.set': (patch) => { space.setConfig(patch); return { type: 'config.state', data: space.configState() }; },
  };
}

export async function startServer({ port = 4747, host = '127.0.0.1', repos = [], home, watch = true, quiet = false } = {}) {
  const space = new Workspace({ home, watch });
  const server = http.createServer((req, res) => {
    if (!hostOk(req, host)) { res.writeHead(403); res.end('Forbidden host'); return; }
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const ok = hostOk(req, host) && (!origin || origin === `http://${req.headers.host}`);
    if (!ok || new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  const acts = handlers(space);
  const clients = new Set();
  const send = (ws, type, data, re) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, data, re })); };
  space.on((type, data) => { for (const ws of clients) send(ws, type, data); });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const act = acts[msg.type];
      if (!act) { send(ws, 'note', { level: 'error', text: `Unknown message: ${msg.type}` }, msg.id); return; }
      try {
        const out = await act(msg.data ?? {});
        send(ws, out?.type ?? 'ok', out?.data ?? {}, msg.id);
      } catch (err) {
        send(ws, 'note', { level: 'error', text: err?.message ?? String(err) }, msg.id);
      }
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`;
  for (const r of repos) {
    try { await space.open(r); } catch (e) { if (!quiet) console.error(e.message); }
  }
  return {
    url, space, server,
    close: () => new Promise((resolve) => { space.close(); for (const ws of clients) ws.terminate(); wss.close(); server.close(() => resolve()); }),
  };
}

// ───────────────────────────── Demo repo ─────────────────────────────
// A small multi-language project with known problems. Used by `--demo` and tests.

export async function makeSample(dir) {
  const files = sampleFiles();
  await fsp.rm(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text);
  }
  const git = (args, date) => new Promise((resolve) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
    execFile('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env }, (err) => resolve(!err));
  });
  if (await git(['init', '-q'], '2026-01-05T10:00:00Z')) {
    const late = new Set(['web/src/utils_v2.ts', 'tools/report_copy.py', 'server/Payments/PaymentGateway.cs']);
    await git(['add', ...Object.keys(files).filter((f) => !late.has(f))], '2026-01-05T10:00:00Z');
    await git(['commit', '-q', '-m', 'Initial shop'], '2026-01-05T10:00:00Z');
    for (const [i, f] of ['web/src/checkout.ts', 'server/Orders/OrderService.cs', 'web/src/cart.ts'].entries()) {
      await fsp.appendFile(path.join(dir, f), `\n`);
      await git(['add', f], `2026-02-1${i}T10:00:00Z`);
      await git(['commit', '-q', '-m', `Tune ${f}`], `2026-02-1${i}T10:00:00Z`);
    }
    // The web client and the order service keep changing together, though
    // nothing links them: a hidden coupling (an API contract).
    for (let i = 0; i < 5; i++) {
      const date = `2026-02-2${i}T10:00:00Z`;
      for (const f of ['web/src/api.ts', 'server/Orders/OrderService.cs']) await fsp.appendFile(path.join(dir, f), `\n`);
      await git(['add', 'web/src/api.ts', 'server/Orders/OrderService.cs'], date);
      await git(['commit', '-q', '-m', `Sync the order API (${i + 1})`], date);
    }
    await git(['add', '-A'], '2026-03-01T10:00:00Z');
    await git(['commit', '-q', '-m', 'Add drafts'], '2026-03-01T10:00:00Z');
  }
  return dir;
}

function sampleFiles() {
  const svcMethods = [];
  const verbs = ['Create', 'Load', 'Save', 'Cancel', 'Refund', 'Ship', 'Track', 'Merge', 'Split', 'Price', 'Tax', 'Audit', 'Archive', 'Restore', 'Notify'];
  for (const v of verbs) {
    svcMethods.push(`    public async Task<Order> ${v}Order(Guid id, CancellationToken token)
    {
        var order = await _store.Find(id, token);
        if (order == null)
        {
            throw new InvalidOperationException("Order not found: " + id);
        }
        _log.Info("${v} " + id);
        order.Touch();
        await _store.Save(order, token);
        return order;
    }
`);
  }
  const report = `import csv
import json
from .format import money


def load_rows(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def summarize(rows):
    total = 0
    count = 0
    for row in rows:
        if row.get("status") == "paid":
            total += float(row["amount"])
            count += 1
    return {"total": total, "count": count}


def write_report(rows, out_path):
    summary = summarize(rows)
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=2)
    print("wrote", out_path)
`;
  return {
    'README.md': '# Acme Shop\n\nA small shop used to try devibe.\n\n## Parts\n\n- web: TypeScript front end\n- server: C# order service\n- engine: Go pricing\n- core: Rust money types\n- tools: Python reports\n\n## Setup\n\nRun `npm start` in web and `dotnet run` in server.\n',
    'package.json': JSON.stringify({ name: 'acme-shop', private: true, scripts: { start: 'node web/src/app.js' }, dependencies: { lodash: '^4.17.21' } }, null, 2) + '\n',
    'config/settings.yaml': 'server:\n  port: 8080\n  host: 0.0.0.0\ndatabase:\n  url: postgres://localhost/shop\n  pool: 10\npayments:\n  provider: stripe\n  api_key: "sk_live_51HxQe2aBcDeFgHiJkLmNoPq"\n',
    'data/products.json': JSON.stringify({ products: [{ id: 1, name: 'Lamp', price: 30 }, { id: 2, name: 'Desk', price: 220 }], currencies: ['USD', 'EUR'], updated: '2026-01-05' }, null, 2) + '\n',
    'web/src/app.ts': `import { Cart } from './cart';
import { fetchProducts } from './api';
import { renderCart, renderList } from './ui/render';
import { formatPrice } from './utils';

export class App {
  private cart = new Cart();

  async start(): Promise<void> {
    const products = await fetchProducts();
    renderList(products, (id) => this.add(id));
    renderCart(this.cart);
  }

  add(id: number): void {
    this.cart.add(id, 1);
    document.title = 'Cart ' + formatPrice(this.cart.total());
    renderCart(this.cart);
  }
}

new App().start();
`,
    'web/src/cart.ts': `import { checkout } from './checkout';
import { clamp } from './utils';

export interface Line {
  id: number;
  qty: number;
  price: number;
}

export class Cart {
  lines: Line[] = [];

  add(id: number, qty: number): void {
    const line = this.lines.find((l) => l.id === id);
    if (line) line.qty = clamp(line.qty + qty, 0, 99);
    else this.lines.push({ id, qty, price: 0 });
  }

  remove(id: number): void {
    this.lines = this.lines.filter((l) => l.id !== id);
  }

  total(): number {
    return this.lines.reduce((sum, l) => sum + l.qty * l.price, 0);
  }

  pay(card: string) {
    return checkout(this, card);
  }
}
`,
    'web/src/checkout.ts': `import { Cart } from './cart';
import { post } from './api';
import { formatPrice } from './utils';

// TODO: move tax rules to the server
export async function checkout(cart: Cart, card: string, coupon?: string, region?: string, rush?: boolean, gift?: boolean) {
  console.log('checkout', cart.lines.length);
  let total = cart.total();
  if (coupon) {
    if (coupon === 'SAVE10') {
      total = total * 0.9;
    } else if (coupon === 'SAVE20') {
      if (total > 100) {
        total = total * 0.8;
      } else {
        total = total * 0.85;
      }
    } else if (coupon.startsWith('VIP')) {
      for (const line of cart.lines) {
        if (line.qty > 3) {
          if (line.price > 50) {
            total -= 5;
          }
        }
      }
    }
  }
  if (region === 'EU') {
    total = total * 1.2;
  } else if (region === 'UK') {
    total = total * 1.2;
  } else if (region === 'US' || region === 'CA') {
    total = total * 1.07;
  }
  if (rush && total > 0) {
    total += 15;
  }
  if (gift || (coupon && coupon.includes('GIFT'))) {
    total += 3;
  }
  const body = {
    card,
    total,
    lines: cart.lines.map((l) => ({ id: l.id, qty: l.qty })),
    region: region ?? 'US',
    rush: !!rush,
    gift: !!gift,
  };
  const res = await post('/api/checkout', body);
  if (!res.ok) {
    if (res.status === 402) {
      throw new Error('Card declined');
    } else if (res.status === 409) {
      throw new Error('Cart changed');
    } else {
      throw new Error('Checkout failed');
    }
  }
  // const old = await post('/api/checkout-v1', body);
  // if (old.ok) { return old; }
  // console.log(old.status);
  return formatPrice(total);
}
`,
    'web/src/cart.test.ts': `import { Cart } from './cart';

export function testAddsLines() {
  const cart = new Cart();
  cart.add(1, 2);
  if (cart.lines.length !== 1) throw new Error('expected one line');
}

export function testTotalIsZeroWhenEmpty() {
  if (new Cart().total() !== 0) throw new Error('expected 0');
}
`,
    'web/src/api.ts': `const BASE = '/api';
const API_KEY = 'sk-proj-a8F3kLm2Qx9Zt7Vb4Nc1Rw5Ye6Uh0Jp';

export async function fetchProducts() {
  const res = await fetch(BASE + '/products', { headers: { key: API_KEY } });
  return res.json();
}

export async function post(path: string, body: unknown) {
  return fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}
`,
    'web/src/utils.ts': `export function formatPrice(value: number): string {
  const fixed = Math.round(value * 100) / 100;
  const parts = fixed.toFixed(2).split('.');
  const whole = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  const cents = parts[1];
  return '$' + whole + '.' + cents;
}

export function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
`,
    'web/src/utils_v2.ts': `export function formatPriceV2(value: number): string {
  const fixed = Math.round(value * 100) / 100;
  const parts = fixed.toFixed(2).split('.');
  const whole = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  const cents = parts[1];
  return '$' + whole + '.' + cents;
}

export function slug_text(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
`,
    'web/src/ui/render.ts': `import type { Cart } from '../cart';
import { formatPrice } from '../utils';

export function renderList(items: { id: number; name: string; price: number }[], onAdd: (id: number) => void) {
  const list = document.querySelector('#list')!;
  list.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('li');
    row.textContent = item.name + ' ' + formatPrice(item.price);
    row.onclick = () => onAdd(item.id);
    list.appendChild(row);
  }
}

export function renderCart(cart: Cart) {
  const el = document.querySelector('#cart')!;
  el.textContent = cart.lines.length + ' items, ' + formatPrice(cart.total());
}
`,
    'web/src/ui/widgets.ts': `export function makeBadge(text: string) {
  const el = document.createElement('span');
  el.className = 'badge';
  el.textContent = text;
  return el;
}

export function makeSpinner() {
  const el = document.createElement('div');
  el.className = 'spinner';
  return el;
}
`,
    'server/Program.cs': `using Shop.Orders;
using Shop.Data;

var store = new SqlOrderStore("Server=.;Database=shop");
var service = new OrderService(store, new Log());
await service.CreateOrder(Guid.NewGuid(), CancellationToken.None);
Console.WriteLine("ready");
`,
    'server/Orders/Order.cs': `namespace Shop.Orders;

public class Order
{
    public Guid Id { get; init; }
    public decimal Total { get; set; }
    public DateTime Updated { get; private set; }

    public void Touch()
    {
        Updated = DateTime.UtcNow;
    }
}

public record OrderLine(Guid ProductId, int Quantity, decimal Price);
`,
    'server/Orders/IOrderStore.cs': `namespace Shop.Orders;

public interface IOrderStore
{
    Task<Order?> Find(Guid id, CancellationToken token);
    Task Save(Order order, CancellationToken token);
}
`,
    'server/Orders/OrderService.cs': `using Shop.Payments;

namespace Shop.Orders;

public class Log
{
    public void Info(string text) => Console.WriteLine(text);
}

public class OrderService
{
    private readonly IOrderStore _store;
    private readonly Log _log;
    private readonly PaymentGateway _payments = new PaymentGateway();

    public OrderService(IOrderStore store, Log log)
    {
        _store = store;
        _log = log;
    }

${svcMethods.join('\n')}
    public decimal Quote(Order order, string region, string coupon, bool rush, bool gift, int items, decimal weight)
    {
        decimal total = order.Total;
        if (region == "EU" || region == "UK")
        {
            total *= 1.2m;
        }
        else if (region == "US")
        {
            total *= 1.07m;
        }
        if (coupon != null && coupon.StartsWith("VIP"))
        {
            total -= 5;
        }
        if (rush && weight < 20)
        {
            total += 15;
        }
        else if (rush)
        {
            total += 30;
        }
        if (gift)
        {
            total += 3;
        }
        for (var i = 0; i < items; i++)
        {
            if (i > 10)
            {
                total -= 0.5m;
            }
        }
        return _payments.Round(total);
    }
}
`,
    'server/Data/SqlOrderStore.cs': `using Shop.Orders;

namespace Shop.Data;

public class SqlOrderStore : IOrderStore
{
    private readonly string _connection;

    public SqlOrderStore(string connection)
    {
        _connection = connection;
    }

    public Task<Order?> Find(Guid id, CancellationToken token)
    {
        return Task.FromResult<Order?>(new Order { Id = id });
    }

    public Task Save(Order order, CancellationToken token)
    {
        return Task.CompletedTask;
    }
}
`,
    'server/Payments/PaymentGateway.cs': `using Shop.Orders;

namespace Shop.Payments;

public class PaymentGateway
{
    private const string Secret = "sk_live_51HxQe2aBcDeFgHiJkLmNoPq";

    public decimal Round(decimal value) => Math.Round(value, 2);

    public Task Charge(Order order, string card)
    {
        throw new NotImplementedException();
    }
}
`,
    'server/Legacy/OldPricing.cs': `namespace Shop.Legacy;

public class OldPricing
{
    public decimal LegacyQuote(decimal total)
    {
        // var tax = total * 0.2m;
        // if (tax > 100) { tax = 100; }
        // return total + tax;
        return total;
    }
}
`,
    'engine/go.mod': 'module acme/engine\n\ngo 1.22\n',
    'engine/pricing.go': `package engine

import "fmt"

type Price struct {
	Cents int
	Currency string
}

func (p Price) String() string {
	return fmt.Sprintf("%d.%02d %s", p.Cents/100, p.Cents%100, p.Currency)
}

func Add(a, b Price) Price {
	return Price{Cents: a.Cents + b.Cents, Currency: a.Currency}
}
`,
    'engine/tax.go': `package engine

func WithTax(p Price, region string) Price {
	switch region {
	case "EU", "UK":
		return Price{Cents: p.Cents * 120 / 100, Currency: p.Currency}
	case "US":
		return Price{Cents: p.Cents * 107 / 100, Currency: p.Currency}
	}
	return p
}
`,
    'core/src/lib.rs': `mod money;

pub use money::Money;

pub fn total(items: &[Money]) -> Money {
    items.iter().fold(Money::zero(), |acc, m| acc.add(m))
}
`,
    'core/src/money.rs': `#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Money {
    pub cents: i64,
}

impl Money {
    pub fn zero() -> Self {
        Money { cents: 0 }
    }

    pub fn add(&self, other: &Money) -> Money {
        Money { cents: self.cents + other.cents }
    }
}
`,
    'native/vec.hpp': `#pragma once

namespace shop {

struct Vec2 {
  float x;
  float y;
  float length() const;
};

}
`,
    'native/vec.cpp': `#include "vec.hpp"
#include <cmath>

namespace shop {

float Vec2::length() const {
  return std::sqrt(x * x + y * y);
}

}
`,
    'tools/__init__.py': '',
    'tools/format.py': 'def money(value):\n    return f"${value:,.2f}"\n',
    'tools/report.py': report,
    'tools/report_copy.py': report.replace('def write_report', 'def writeReport'),
    'tools/notes.py': '',
  };
}

// ───────────────────────────── CLI ─────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* no browser */ }
}

async function main(argv) {
  const opts = { port: 4747, host: '127.0.0.1', repos: [], open: false, watch: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = +argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--open' || a === '-o') opts.open = true;
    else if (a === '--no-watch') opts.watch = false;
    else if (a === '--demo') opts.repos.push(await makeSample(path.join(os.tmpdir(), 'devibe-demo')));
    else if (a === '--help' || a === '-h') {
      console.log('Usage: devibe [folders...] [--port 4747] [--host 127.0.0.1] [--open] [--demo] [--no-watch]');
      return;
    } else opts.repos.push(a);
  }
  const app = await startServer(opts);
  console.log(`devibe is running at ${app.url}`);
  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') console.log('Warning: devibe can read and write files. Only expose it on networks you trust.');
  if (opts.open) openBrowser(app.url);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}

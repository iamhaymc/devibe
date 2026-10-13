// Unit tests for the devibe server: parsing, linking, checks, diff, stage,
// ledger, sockets, and the agent loop (against a mock chat endpoint).
// Run: node --test test/server.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import {
  maskCode, readSymbols, readImports, readFacts, langOf, findCopies, strongGroups, diffLines, makeHunks,
  Workspace, buildModel, startServer, makeSample, runAgent, stopAgent, testAgent, loadConfig, setText, LINK_KINDS, ACTS,
  listFiles, readIgnore, isIgnored, readTyped,
} from '../app/server.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `devibe-${name}-`));
const syms = (text, lang) => readSymbols(text, maskCode(text, lang), lang).map((s) => `${s.kind}:${s.form}:${s.name}@${s.from}-${s.to}`);
// A model from in-memory files, and the targets each symbol calls or uses.
const modelOf = (files, opts) => buildModel([{ name: 'r', root: '/r', facts: new Map(Object.entries(files).map(([rel, text]) => [rel, readFacts(rel, text, opts)])), texts: new Map(Object.entries(files)), git: null }]);
const targets = (m, from, kind = 'call') => m.links.filter(([s, , k]) => m.nodes[s].key === `r/${from}` && LINK_KINDS[k] === kind).map(([, t]) => m.nodes[t].key.slice(2)).sort();

// A tiny OpenAI-compatible chat endpoint. Each request answers with the next
// scripted step: tool calls or text, streamed as server-sent events.
export function mockModel(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      seen.push(data);
      const lastUser = data.messages.findLastIndex((m) => m.role === 'user');
      const turn = data.messages.slice(lastUser).filter((m) => m.role === 'assistant').length;
      const step = script[Math.min(turn, script.length - 1)];
      const id = `chatcmpl-${seen.length}`;
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      if (!data.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: data.model, choices: [{ index: 0, message: { role: 'assistant', content: step.text ?? 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (step.tools) {
        send(chunk({ role: 'assistant', content: null, tool_calls: step.tools.map((t, i) => ({ index: i, id: `call_${seen.length}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) }));
        send(chunk({}, 'tool_calls'));
      } else {
        send(chunk({ role: 'assistant', content: '' }));
        for (const piece of step.text.match(/.{1,12}/gs)) send(chunk({ content: piece }));
        send(chunk({}, 'stop'));
      }
      send({ id, object: 'chat.completion.chunk', created: 1, model: data.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((r) => server.close(r)) })));
}

describe('masking', () => {
  test('blanks comments and string contents, keeps offsets and lines', () => {
    const src = 'int a = 1; // note { \nstring s = "x { y"; /* block\n } */ int b;';
    const out = maskCode(src, 'cs');
    assert.equal(out.length, src.length);
    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.ok(!out.includes('note') && !out.includes('block'));
    assert.ok(out.includes('"     "'));
    assert.ok(out.includes('int b;'));
  });
  test('handles C# verbatim strings, JS regex and templates, Rust lifetimes, Python triple quotes', () => {
    assert.ok(!maskCode('var p = @"C:\\dir\\"" { ";', 'cs').includes('{'));
    const js = maskCode('const r = /[{}]+/g; const t = `a ${b} {`; f(x)', 'js');
    assert.ok(!js.includes('{}') && js.includes('f(x)'));
    const rs = maskCode("fn f<'a>(x: &'a str) -> char { 'x' }", 'rs');
    assert.ok(rs.includes("fn f<'a>(x: &'a str)") && rs.includes('{') && !rs.includes("'x'"));
    const py = maskCode('def f():\n    """doc { here\n    more"""\n    return 1', 'py');
    assert.ok(!py.includes('doc') && py.includes('return 1'));
  });
  test('leaves data files untouched', () => {
    assert.equal(maskCode('{"a": "// b"}', 'json'), '{"a": "// b"}');
  });
});

describe('symbols', () => {
  test('a long comment after a name parses in linear time', () => {
    // Masked to one blank run after `X`: a call pattern that splits it two ways is quadratic.
    const src = `#define X\n/*${' doc\n'.repeat(10_000)}*/\nint main(void) { return 0; }\n`;
    const t = performance.now();
    const f = readFacts('big.h', src);
    assert.ok(performance.now() - t < 500, `${Math.round(performance.now() - t)} ms`);
    assert.ok(f.syms.some((s) => s.name === 'main'));
  });
  test('C#: namespaces, types, constructors, methods, interface members, records', () => {
    const src = `namespace Shop.Orders;
public interface IStore
{
    Task<Order> Find(Guid id);
}
public class OrderService : BaseService, IStore
{
    public OrderService(IStore store) : base(store) { }
    public async Task<Order> Find(Guid id)
    {
        if (id == Guid.Empty) { return null; }
        return await _store.Find(id);
    }
    public int Total => _lines.Sum(l => l.Price);
}
public record Line(Guid Id, int Qty);`;
    const out = syms(src, 'cs');
    assert.ok(out.includes('space:namespace:Shop.Orders@1-16'), out.join('\n'));
    assert.ok(out.includes('type:interface:IStore@2-5'));
    assert.ok(out.includes('func:method:Find@4-4'));
    assert.ok(out.includes('type:class:OrderService@6-15'));
    assert.ok(out.includes('func:ctor:OrderService@8-8'));
    assert.ok(out.includes('func:method:Find@9-13'));
    assert.ok(out.includes('type:record:Line@16-16'));
    const list = readSymbols(src, maskCode(src, 'cs'), 'cs');
    assert.deepEqual(list.find((s) => s.name === 'OrderService' && s.kind === 'type').bases, ['BaseService', 'IStore']);
    const find = list.find((s) => s.name === 'Find' && s.from === 9);
    assert.equal(find.cx, 2);
    assert.equal(find.args, 1);
  });
  test('TypeScript: classes, methods, arrow functions, interfaces, type aliases', () => {
    const src = `export interface Line { id: number }
export type Id = string | number;
export class Cart extends Base {
  constructor(private lines: Line[]) { super(); }
  total(): number {
    return this.lines.length;
  }
}
export const add = (a: number, b: number): number => a + b;
const handler = async (e) => {
  if (e && e.ok) { await go(); }
};`;
    const out = syms(src, 'ts');
    for (const want of ['type:interface:Line@1-1', 'type:type:Id@2-2', 'type:class:Cart@3-8', 'func:ctor:constructor@4-4', 'func:method:total@5-7', 'func:function:add@9-9', 'func:function:handler@10-12']) assert.ok(out.includes(want), `${want}\n${out.join('\n')}`);
  });
  test('Python: nested classes and functions by indentation', () => {
    const src = 'class Shop(Base):\n    def add(self, item, qty=1):\n        if qty > 1 and item:\n            pass\n        return item\n\n    def drop(self):\n        pass\n\ndef main():\n    print(1)\n';
    const out = syms(src, 'py');
    assert.deepEqual(out, ['type:class:Shop@1-8', 'func:method:add@2-5', 'func:method:drop@7-8', 'func:function:main@10-11']);
    const list = readSymbols(src, maskCode(src, 'py'), 'py');
    assert.equal(list[1].args, 2);
    assert.equal(list[1].cx, 3);
    assert.deepEqual(list[0].bases, ['Base']);
  });
  test('Go: types and methods attached by receiver', () => {
    const src = 'package money\n\ntype Price struct {\n\tCents int\n}\n\nfunc (p *Price) Add(o Price) Price {\n\treturn Price{p.Cents + o.Cents}\n}\n\nfunc Zero() (Price, error) {\n\treturn Price{}, nil\n}\n';
    const list = readSymbols(src, maskCode(src, 'go'), 'go');
    const add = list.find((s) => s.name === 'Add');
    assert.equal(list[add.up].name, 'Price');
    assert.ok(syms(src, 'go').includes('func:function:Zero@11-13'));
  });
  test('Rust, Java, Kotlin, C++, Ruby, Markdown, JSON, YAML', () => {
    assert.ok(syms('pub struct Money { c: i64 }\nimpl Add for Money {\n  fn add(self, o: Money) -> Money { Money { c: self.c + o.c } }\n}', 'rs').includes('func:method:add@3-3'));
    assert.ok(syms('public class A extends B {\n  public void run() throws IOException {\n  }\n}', 'java').includes('func:method:run@2-3'));
    assert.ok(syms('class A(val x: Int) {\n  fun twice(): Int = x * 2\n}', 'kt').includes('func:method:twice@2-2'));
    assert.ok(syms('namespace geo {\nfloat Vec::length() const {\n  return 1;\n}\n}', 'cpp').includes('func:method:Vec::length@2-4'));
    assert.deepEqual(syms('class Cart < Base\n  def add(x)\n    x\n  end\nend\n', 'rb'), ['type:class:Cart@1-5', 'func:method:add@2-4']);
    assert.deepEqual(syms('# Title\ntext\n## Part\nmore\n```\n# not a heading\n```\n', 'md'), ['part:h1:Title@1-7', 'part:h2:Part@3-7']);
    assert.deepEqual(syms('{\n  "name": "x",\n  "deps": {\n    "a": 1\n  }\n}', 'json'), ['part:key:name@2-2', 'part:key:deps@3-5']);
    assert.deepEqual(syms('server:\n  port: 1\ndb:\n  url: x\n', 'yaml'), ['part:key:server@1-2', 'part:key:db@3-4']);
  });
  test('ignores control flow, calls, and lambdas', () => {
    const src = 'void Run() {\n  if (x) { Do(); }\n  foreach (var a in b) { Go(a); }\n  items.ForEach(x => { Use(x); });\n  var t = Make(1) ;\n}';
    assert.deepEqual(syms(src, 'cs'), ['func:function:Run@1-6']);
  });
});

describe('imports and languages', () => {
  test('detects language by extension and name', () => {
    assert.equal(langOf('src/App.cs'), 'cs');
    assert.equal(langOf('web/x.tsx'), 'ts');
    assert.equal(langOf('Dockerfile'), 'sh');
    assert.equal(langOf('notes.unknown'), 'text');
  });
  test('reads imports from code, not from comments', () => {
    const src = "import { a } from './a';\n// import { b } from './b';\nconst c = require('../c');\nexport * from './d';";
    assert.deepEqual(readImports(src, maskCode(src, 'ts'), 'ts').map((i) => i.spec).sort(), ['../c', './a', './d']);
    const py = 'from .format import money\nimport os, json\n';
    assert.deepEqual(readImports(py, maskCode(py, 'py'), 'py').map((i) => i.spec), ['.format', 'os', 'json']);
  });
});

describe('model', () => {
  let space, model, dir;
  const byKey = (key) => model.nodes.find((n) => n.key === key);
  const linked = (a, b, kind) => model.links.some(([s, t, k]) => model.nodes[s].key.startsWith(a) && model.nodes[t].key.startsWith(b) && (!kind || LINK_KINDS[k] === kind));
  const flagged = (rule, keyPart) => model.issues.some((i) => i.rule === rule && model.nodes[i.node].key.includes(keyPart));
  before(async () => {
    dir = await makeSample(path.join(tmp('model'), 'shop'));
    space = new Workspace({ home: tmp('home'), watch: false });
    await space.open(dir);
    model = space.model;
  });
  test('builds a tree of repo, folders, files, and symbols', () => {
    assert.equal(model.nodes[0].kind, 'root');
    assert.equal(byKey('shop').kind, 'repo');
    assert.equal(byKey('shop/server/Orders').kind, 'dir');
    assert.equal(byKey('shop/web/src/cart.ts').lang, 'ts');
    assert.equal(byKey('shop/web/src/cart.ts#Cart.add').kind, 'func');
    assert.ok(model.stats.files >= 30 && model.stats.lines > 600);
    assert.equal(model.nodes[0].lines, model.stats.lines);
  });
  test('links imports, calls, uses, and base types', () => {
    assert.ok(linked('shop/web/src/cart.ts', 'shop/web/src/checkout.ts', 'import'));
    assert.ok(linked('shop/core/src/lib.rs', 'shop/core/src/money.rs', 'import'));
    assert.ok(linked('shop/native/vec.cpp', 'shop/native/vec.hpp', 'import'));
    assert.ok(linked('shop/tools/report.py', 'shop/tools/format.py', 'import'));
    assert.ok(linked('shop/web/src/cart.ts#Cart.pay', 'shop/web/src/checkout.ts#checkout', 'call'));
    assert.ok(linked('shop/server/Data/SqlOrderStore.cs#Shop.Data.SqlOrderStore', 'shop/server/Orders/IOrderStore.cs#Shop.Orders.IOrderStore', 'base'));
    assert.ok(linked('shop/server/Orders/OrderService.cs#Shop.Orders.OrderService.CreateOrder', 'shop/server/Orders/IOrderStore.cs#Shop.Orders.IOrderStore.Find', 'call'));
    assert.ok(!linked('shop/core', 'shop/tools'), 'no links across languages');
  });
  test('finds the planted problems', () => {
    assert.ok(flagged('secret', 'web/src/api.ts'));
    assert.ok(flagged('secret', 'config/settings.yaml'));
    assert.ok(flagged('loop', 'web/src/cart.ts') && flagged('loop', 'web/src/checkout.ts'));
    assert.ok(flagged('copy', 'tools/report.py') && flagged('copy', 'tools/report_copy.py'));
    assert.ok(flagged('version', 'web/src/utils_v2.ts'));
    assert.ok(flagged('stub', 'PaymentGateway.cs'));
    assert.ok(flagged('stub', 'checkout.ts'));
    assert.ok(flagged('branch', 'checkout.ts#checkout'));
    assert.ok(flagged('nest', 'checkout.ts#checkout'));
    assert.ok(flagged('args', 'OrderService.Quote'));
    assert.ok(flagged('unused', 'widgets.ts#makeBadge'));
    assert.ok(!flagged('unused', 'utils.ts#formatPrice'));
    assert.ok(flagged('empty', 'tools/notes.py') && !flagged('empty', 'tools/__init__.py'));
    assert.ok(flagged('debug', 'checkout.ts'));
    assert.ok(flagged('dead', 'OldPricing.cs'));
    assert.ok(flagged('naming', 'utils_v2.ts#slug_text'));
    assert.ok(flagged('lone', 'Legacy/OldPricing.cs'));
    assert.ok(flagged('tangle', 'server/Orders'));
  });
  test('keeps link sites, off the wire', () => {
    assert.ok(!JSON.stringify(model).includes('"sites"'), 'sites are not sent with the model');
    const site = (a, b, kind) => model.sites.get(`${byKey(a).id},${byKey(b).id},${kind}`);
    const checkout = fs.readFileSync(path.join(dir, 'web/src/checkout.ts'), 'utf8').split('\n');
    const calls = site('shop/web/src/checkout.ts#checkout', 'shop/web/src/cart.ts#Cart.total', 'call');
    assert.ok(calls.length >= 2 && calls.length <= 12, `${calls.length} sites`);
    for (const l of calls) assert.match(checkout[l - 1], /\btotal\b/);
    assert.deepEqual(site('shop/web/src/checkout.ts#checkout', 'shop/web/src/cart.ts#Cart', 'use'), [6]);
    assert.match(checkout[5], /\bCart\b/);
    const imp = site('shop/web/src/checkout.ts', 'shop/web/src/cart.ts', 'import');
    assert.match(checkout[imp[0] - 1], /from '\.\/cart'/);
    const cart = fs.readFileSync(path.join(dir, 'web/src/cart.ts'), 'utf8').split('\n');
    const [pay] = site('shop/web/src/cart.ts#Cart.pay', 'shop/web/src/checkout.ts#checkout', 'call');
    assert.match(cart[pay - 1], /checkout\(this, card\)/);
    const links = space.fileLinks('shop/web/src/cart.ts');
    assert.ok(links.in.some((x) => x.from === 'shop/web/src/checkout.ts#checkout' && x.line === 6 && x.kind === 'use'));
    assert.ok(links.out.some((x) => x.to === 'shop/web/src/checkout.ts#checkout' && x.line === pay));
  });
  test('links files that change together and flags hidden coupling', () => {
    assert.ok(linked('shop/server/Orders/OrderService.cs', 'shop/web/src/api.ts', 'change') || linked('shop/web/src/api.ts', 'shop/server/Orders/OrderService.cs', 'change'));
    assert.ok(flagged('couple', 'web/src/api.ts') && flagged('couple', 'OrderService.cs'));
    assert.match(model.issues.find((i) => i.rule === 'couple' && model.nodes[i.node].key.endsWith('api.ts')).note, /Changes with server\/Orders\/OrderService\.cs in 5 of \d+ commits/);
  });
  test('reads git history', () => {
    const f = byKey('shop/web/src/checkout.ts');
    assert.ok(f.churn >= 2, `churn ${f.churn}`);
    assert.ok(f.time > 0);
    assert.equal(byKey('shop').branch, 'main');
  });
});

describe('changes with', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
  const touch = (dir, files, n) => { for (const f of files) fs.appendFileSync(path.join(dir, f), `// ${n}\n`); git(dir, 'add', ...files); git(dir, 'commit', '-q', '-m', `c${n}`); };
  test('pairs files from commits of 2 to 24 files and flags couplings without links', async () => {
    const dir = path.join(tmp('pairs'), 'r');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `${f}.ts`), `export const ${f}Value = 1;\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'start');
    const fill = Array.from({ length: 23 }, (_, i) => `fill${i}.txt`);
    for (const f of [...fill, 'd.ts']) fs.writeFileSync(path.join(dir, f), 'x\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'fill');
    for (let i = 0; i < 4; i++) touch(dir, ['a.ts', 'b.ts'], i);
    for (let i = 0; i < 2; i++) touch(dir, ['c.ts'], 10 + i);
    for (let i = 0; i < 3; i++) touch(dir, ['c.ts', 'd.ts', ...fill], 20 + i);
    const space = new Workspace({ home: tmp('home'), watch: false });
    await space.open(dir);
    const m = space.model;
    const id = (rel) => m.nodes.find((n) => n.key === `r/${rel}`).id;
    const change = m.links.filter((l) => m.linkKinds[l[2]] === 'change');
    const has = (x, y) => change.some(([s, t]) => (s === id(x) && t === id(y)) || (s === id(y) && t === id(x)));
    assert.ok(has('a.ts', 'b.ts'), 'a and b change together');
    assert.equal(change.find(([s, t]) => s === Math.min(id('a.ts'), id('b.ts')) && t === Math.max(id('a.ts'), id('b.ts')))[3], 5, 'stored once, lower id first');
    assert.ok(!has('c.ts', 'd.ts'), 'commits over 24 files are ignored');
    assert.ok(!m.issues.some((i) => i.rule === 'loop' || i.rule === 'tangle'), 'no loops from changes-with links');
    const couple = m.issues.filter((i) => i.rule === 'couple').map((i) => m.nodes[i.node].name).sort();
    assert.deepEqual(couple, ['a.ts', 'b.ts']);
    fs.writeFileSync(path.join(dir, 'a.ts'), "import { bValue } from './b';\nexport const aValue = bValue;\n");
    await space.scan();
    assert.ok(!space.model.issues.some((i) => i.rule === 'couple'), 'a link explains the coupling');
  });
});

describe('scanning', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
  const put = (dir, files) => { for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'x\n'); } };
  test('reads .gitignore patterns', () => {
    const rules = readIgnore('# note\n*.log\n!keep.log\n/top.txt\nbuild/\ndocs/**/draft-*\n\\#hash\n[ab].tmp\n');
    const hit = (p, dir = false) => isIgnored([{ base: '', rules }], p, dir);
    assert.ok(hit('a.log') && hit('x/y/a.log') && !hit('keep.log') && !hit('x/keep.log'));
    assert.ok(hit('top.txt') && !hit('x/top.txt'), 'a leading slash anchors');
    assert.ok(hit('build', true) && hit('x/build', true) && !hit('build'), 'a trailing slash matches folders only');
    assert.ok(hit('docs/draft-1.md') && hit('docs/a/b/draft-2.md') && !hit('docs/final.md'));
    assert.ok(hit('#hash') && hit('a.tmp') && !hit('c.tmp'));
    const nested = [{ base: '', rules }, { base: 'sub', rules: readIgnore('*.md\n!a.log\n') }];
    assert.ok(isIgnored(nested, 'sub/x.md', false) && !isIgnored(nested, 'x.md', false), 'nested rules apply under their folder');
    assert.ok(!isIgnored(nested, 'sub/a.log', false) && isIgnored(nested, 'b.log', false), 'deeper rules win');
  });
  test('outside git: skips cache and build folders and honors .gitignore files', async () => {
    const dir = tmp('walk');
    put(dir, ['src/a.py', 'src/b.log', 'src/keep.log', 'node_modules/m/i.js', '.venv/lib/x.py', 'pkg/__pycache__/a.pyc', 'build/out.js', 'x.egg-info/PKG', 'gen/deep/g.ts', 'sub/tmp/t.ts', 'sub/ok.ts', 'sub/notes.md']);
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n!keep.log\n/gen/\n');
    fs.writeFileSync(path.join(dir, 'sub/.gitignore'), 'tmp\n*.md\n');
    const files = (await listFiles(dir)).sort();
    assert.deepEqual(files, ['.gitignore', 'src/a.py', 'src/keep.log', 'sub/.gitignore', 'sub/ok.ts']);
  });
  test('in git: cache folders always skipped, build folders only when untracked', async () => {
    const dir = path.join(tmp('lsgit'), 'r');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    put(dir, ['src/a.ts', 'bin/run.sh', 'node_modules/kept/i.js', 'vendor/lib.go']);
    git(dir, 'add', '-f', '.'); git(dir, 'commit', '-q', '-m', 'start');
    put(dir, ['src/b.ts', 'dist/app.js', '.venv/lib/x.py', 'pkg/__pycache__/a.pyc', 'obj/Debug/a.dll', 'ignored/x.ts']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
    const files = (await listFiles(dir)).sort();
    assert.deepEqual(files, ['.gitignore', 'bin/run.sh', 'src/a.ts', 'src/b.ts', 'vendor/lib.go']);
  });
});

describe('receivers', () => {
  test('reads typed names and member accesses', () => {
    const cs = 'class S {\n  private readonly IOrderStore _store;\n  public void M(List<int> xs, Repo? r) {\n    var q = new Query<Order>();\n    _store.Find(1);\n    this._store.Save(q);\n    base.Run();\n  }\n}\n';
    const t = readTyped(maskCode(cs, 'cs'), 'cs');
    assert.deepEqual(t.vars, [['_store', 'IOrderStore', 2], ['xs', 'List', 3], ['r', 'Repo', 3], ['q', 'Query', 4]]);
    assert.deepEqual(t.refs, [['_store', 'Find', 5], ['this', '_store', 6], ['this._store', 'Save', 6], ['super', 'Run', 7]]);
    const py = 'class A:\n    store: Store\n    def __init__(self, cache: Cache):\n        self.repo = Repo()\n        repo = make()\n        self.repo.find(1)\n        super().save()\n';
    const p = readTyped(maskCode(py, 'py'), 'py');
    assert.deepEqual(p.vars, [['store', 'Store', 2], ['cache', 'Cache', 3], ['@repo', 'Repo', 4]]);
    assert.deepEqual(p.refs, [['this', 'repo', 4], ['this', 'repo', 6], ['this.repo', 'find', 6], ['super', 'save', 7]]);
    const go = 'func (s *Svc) Run(a, b Price, n int) {\n\tx := &Store{}\n\ty, err := NewCache()\n\tvar z Queue\n\ts.store.Find(1)\n}\n';
    const g = readTyped(maskCode(go, 'go'), 'go');
    assert.deepEqual(g.vars, [['s', 'Svc', 1], ['a', 'Price', 1], ['b', 'Price', 1], ['n', 'int', 1], ['x', 'Store', 2], ['y', 'Cache', 3], ['z', 'Queue', 4]]);
    assert.deepEqual(g.refs, [['s', 'store', 5], ['s.store', 'Find', 5]]);
  });
  test('C#: a member access links to the member of the receiver type', () => {
    const m = modelOf({
      'Data/Store.cs': 'namespace App.Data;\npublic interface IOrderStore\n{\n    Order Find(int id);\n    void Save(Order o);\n}\npublic class SqlStore : IOrderStore\n{\n    public Order Find(int id) => null;\n    public void Save(Order o) {}\n}\npublic class MemStore : IOrderStore\n{\n    public Order Find(int id) => null;\n    public void Save(Order o) {}\n}\npublic class Other\n{\n    public void Find() {}\n}\npublic class More\n{\n    public void Find() {}\n}\n',
      'Web/Service.cs': 'namespace App.Web;\npublic class Service\n{\n    private readonly IOrderStore _store;\n    private readonly List<int> _ids = new();\n    public void Run(MemStore mem)\n    {\n        _store.Find(1);\n        this._store.Save(null);\n        mem.Find(2);\n        _ids.Find(3);\n        Helper.Find(4);\n        Console.Find(5);\n    }\n}\npublic static class Helper { public static int Find(int x) => x; }\n',
    });
    assert.deepEqual(targets(m, 'Web/Service.cs#App.Web.Service.Run'), ['Data/Store.cs#App.Data.IOrderStore.Find', 'Data/Store.cs#App.Data.IOrderStore.Save', 'Data/Store.cs#App.Data.MemStore.Find', 'Web/Service.cs#App.Web.Helper.Find']);
  });
  test('TypeScript: this, fields, constructor parameter properties, and parameters', () => {
    const m = modelOf({
      'cart.ts': 'export class Cart {\n  total() { return 1; }\n}\nexport class Box {\n  total() { return 2; }\n}\n',
      'app.ts': "import { Cart, Box } from './cart';\nexport class App {\n  private cart = new Cart();\n  constructor(private box: Box) {}\n  run(list: string[], other: Box) {\n    this.cart.total();\n    this.box.total();\n    other.total();\n    list.total();\n    this.size();\n  }\n  size() { return 0; }\n}\nexport function total() { return 3; }\n",
    });
    assert.deepEqual(targets(m, 'app.ts#App.run'), ['app.ts#App.size', 'cart.ts#Box.total', 'cart.ts#Cart.total']);
  });
  test('Python: self fields, annotated parameters, base classes', () => {
    const m = modelOf({
      'store.py': 'class Base:\n    def save(self):\n        pass\n\nclass Store(Base):\n    def find(self, x):\n        return x\n\nclass Cache:\n    def find(self, x):\n        return x\n',
      'svc.py': 'from .store import Store, Cache\n\nclass Service:\n    def __init__(self):\n        self.store = Store()\n\n    def run(self, cache: Cache):\n        self.store.find(1)\n        self.store.save()\n        cache.find(2)\n        self.done()\n\n    def done(self):\n        pass\n',
    });
    assert.deepEqual(targets(m, 'svc.py#Service.run'), ['store.py#Base.save', 'store.py#Cache.find', 'store.py#Store.find', 'svc.py#Service.done']);
  });
  test('Go: receivers, struct fields, and methods declared in other files', () => {
    const m = modelOf({
      'a.go': 'package p\n\ntype Store struct{}\n\ntype Svc struct {\n\tstore Store\n}\n',
      'b.go': 'package p\n\nfunc (s *Store) Find(id int) {}\n\nfunc (s *Svc) Run() {\n\ts.store.Find(1)\n}\n',
      'c.go': 'package p\n\ntype Other struct{}\n\nfunc (o Other) Find(id int) {}\n',
    });
    assert.deepEqual(targets(m, 'b.go#Run'), ['b.go#Find']);
  });
  test('constructor functions, namespaces, same-named types, and partial classes', () => {
    const m = modelOf({
      'poly.js': 'function CubicPoly() {\n  return { calc: function () { return 1; } };\n}\nconst px = new CubicPoly();\nexport function curve() {\n  return px.calc();\n}\n',
      'events.ts': 'export type Action = Action.Click | Action.Move;\nexport namespace Action {\n  export interface Click { x: number }\n  export interface Move { y: number }\n}\n',
      'a/base.ts': 'export class WSBase {\n  reconnect() { return 1; }\n  run() { return this.reconnect(); }\n}\n',
      'b/base.ts': 'export class WSBase {\n  reconnect() { return 2; }\n  run() { return this.reconnect(); }\n}\n',
      'Parts/A.cs': 'namespace P;\npublic partial class Shop\n{\n    public void Open() { Close(); this.Close(); }\n}\n',
      'Parts/B.cs': 'namespace P;\npublic partial class Shop\n{\n    public void Close() {}\n}\n',
    });
    assert.deepEqual(targets(m, 'poly.js#curve'), ['poly.js#CubicPoly.calc'], 'a constructor function is not an external type');
    assert.deepEqual(targets(m, 'events.ts#Action', 'use'), ['events.ts#Action~2.Click', 'events.ts#Action~2.Move'], 'namespace members');
    assert.deepEqual(targets(m, 'b/base.ts#WSBase.run'), ['b/base.ts#WSBase.reconnect'], 'this is the enclosing type, not a same-named one');
    assert.deepEqual(targets(m, 'Parts/A.cs#P.Shop.Open'), ['Parts/B.cs#P.Shop.Close'], 'partial classes pool their members');
  });
  test('C++ out-of-class methods and Rust impl blocks', () => {
    const m = modelOf({
      'shapes.hpp': 'struct Box {\n  int area();\n};\nstruct Ring {\n  int area();\n};\n',
      'shapes.cpp': '#include "shapes.hpp"\n\nint Box::area() {\n  return 1;\n}\n\nint total(Box* b, Ring r) {\n  return b->area() + r.area();\n}\n',
      'lib.rs': 'pub struct Store;\n\nimpl Store {\n    pub fn find(&self) -> i32 {\n        1\n    }\n}\n\npub struct Cache;\n\nimpl Cache {\n    pub fn find(&self) -> i32 {\n        2\n    }\n}\n\npub fn run(s: &Store) -> i32 {\n    s.find()\n}\n',
    });
    assert.deepEqual(targets(m, 'shapes.cpp#total'), ['shapes.cpp#Box::area', 'shapes.hpp#Box.area', 'shapes.hpp#Ring.area']);
    assert.deepEqual(targets(m, 'lib.rs#run'), ['lib.rs#Store.find']);
  });
});

describe('helpers', () => {
  test('findCopies groups repeated blocks', () => {
    const block = Array.from({ length: 10 }, (_, i) => `total = total + values[${i}] * rate;`);
    const files = ['a', 'b'].map((name) => {
      const lines = [`function ${name}() {`, ...block, '}'];
      const text = lines.join('\n');
      return { f: readFacts(`${name}.js`, text) };
    });
    const copies = findCopies(files);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].size, 10);
  });
  test('strongGroups finds cycles', () => {
    const g = new Map([[1, new Set([2])], [2, new Set([3])], [3, new Set([1])], [4, new Set([1])]]);
    assert.deepEqual(strongGroups(g).map((x) => x.sort()), [[1, 2, 3]]);
  });
  test('diffLines and makeHunks', () => {
    const a = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
    const b = 'a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nk';
    const ops = diffLines(a, b);
    assert.equal(ops.filter((o) => o.t === '-').length, 1);
    assert.equal(ops.filter((o) => o.t === '+').length, 2);
    const hunks = makeHunks(ops);
    assert.equal(hunks.length, 2);
    assert.deepEqual(hunks[0].lines.find((l) => l[0] === '-'), ['-', 3, null, 'c']);
    assert.equal(diffLines('', 'x\ny').length, 2);
  });
  test('buildModel works without git or ledger', () => {
    const repo = { name: 'r', root: '/x', facts: new Map([['a.js', readFacts('a.js', 'export function alpha() { return beta(); }\nfunction beta() { return 1; }\n')]]), texts: new Map(), git: null };
    const m = buildModel([repo]);
    assert.equal(m.stats.files, 1);
    assert.ok(m.links.some(([s, t, k]) => m.nodes[s].name === 'alpha' && m.nodes[t].name === 'beta' && LINK_KINDS[k] === 'call'));
  });
});

describe('stage and ledger', () => {
  let space, dir;
  before(async () => {
    dir = await makeSample(path.join(tmp('stage'), 'shop'));
    space = new Workspace({ home: tmp('home'), watch: false });
    await space.open(dir);
  });
  test('stages edits without touching disk, then applies and undoes', async () => {
    const key = 'shop/web/src/utils.ts';
    const before = fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8');
    space.stage.write(key, before.replace('clamp', 'limit'));
    assert.equal(fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8'), before);
    const [item] = space.stage.list();
    assert.equal(item.state, 'edit');
    assert.equal(item.adds, 1);
    assert.equal(space.stage.diff(key).hunks.length, 1);
    await space.applyStage();
    assert.ok(fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('function limit'));
    assert.equal(space.stage.items.size, 0);
    await space.undoStage();
    assert.equal(fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8'), before);
  });
  test('refuses to apply over changes made on disk', async () => {
    const key = 'shop/README.md';
    space.stage.write(key, '# Changed\n');
    fs.appendFileSync(path.join(dir, 'README.md'), 'edited elsewhere\n');
    await assert.rejects(() => space.stage.apply(), /changed on disk/);
    space.stage.discard();
  });
  test('moves files and deletes symbols', async () => {
    space.moveFile('shop/web/src/ui/widgets.ts', 'shop/web/src');
    const moved = space.stage.list();
    assert.deepEqual(moved.map((i) => i.state).sort(), ['add', 'delete']);
    space.stage.discard();
    const n = space.deleteNodes(['shop/web/src/ui/widgets.ts#makeSpinner']);
    assert.equal(n, 1);
    const text = space.stage.read('shop/web/src/ui/widgets.ts');
    assert.ok(!text.includes('makeSpinner') && text.includes('makeBadge'));
    space.stage.discard();
  });
  test('renames a symbol in code only', () => {
    const files = space.renameSymbol('shop/web/src/utils.ts#formatPrice', 'formatMoney');
    assert.ok(files >= 4, `touched ${files}`);
    const utils = space.stage.read('shop/web/src/utils.ts');
    assert.ok(utils.includes('function formatMoney') && !utils.includes('function formatPrice'));
    assert.ok(space.stage.read('shop/web/src/app.ts').includes("import { formatMoney } from './utils'"));
    assert.ok(space.stage.read('shop/web/src/utils_v2.ts').includes('formatPriceV2'), 'whole words only');
    space.stage.discard();
  });
  test('preview builds the model from staged text', () => {
    space.stage.write('shop/web/src/extra.ts', 'export function extra() { return 1; }\n');
    space.setPreview(true);
    assert.ok(space.model.nodes.some((n) => n.key === 'shop/web/src/extra.ts#extra'));
    space.setPreview(false);
    assert.ok(!space.model.nodes.some((n) => n.key === 'shop/web/src/extra.ts'));
    space.stage.discard();
  });
  test('review marks go stale when code changes; waived issues are flagged', async () => {
    space.mark(['shop/web/src/cart.ts'], true);
    assert.equal(space.model.marks['shop/web/src/cart.ts'], 'ok');
    fs.appendFileSync(path.join(dir, 'web/src/cart.ts'), '// more\n');
    await space.scan();
    assert.equal(space.model.marks['shop/web/src/cart.ts'], 'stale');
    space.mark(['shop/tools'], true);
    assert.equal(space.model.marks['shop/tools/report.py'], 'ok');
    const issue = space.model.issues.find((i) => i.rule === 'empty');
    space.waive('empty', space.model.nodes[issue.node].key, true);
    assert.ok(space.model.issues.find((i) => i.rule === 'empty').waived);
  });
  test('edits a line range: replace, insert, refuse out of range, preview, undo', async () => {
    const key = 'shop/web/src/utils.ts';
    const before = fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8');
    space.stage.editRange(key, 1, 1, 'export function formatPrice(value: number, sign = "$"): string {');
    let text = space.stage.read(key);
    assert.equal(text.split('\n')[0], 'export function formatPrice(value: number, sign = "$"): string {');
    assert.equal(text.split('\n').length, before.split('\n').length);
    space.stage.editRange(key, 8, 7, '// Slugs\n');
    text = space.stage.read(key);
    assert.equal(text.split('\n')[7], '// Slugs');
    assert.equal(text.split('\n').length, before.split('\n').length + 1);
    assert.throws(() => space.stage.editRange(key, 0, 1, 'x'), /outside/);
    assert.throws(() => space.stage.editRange(key, 5, 400, 'x'), /outside/);
    assert.throws(() => space.stage.editRange('shop/nope.ts', 1, 1, 'x'), /No such file/);
    space.stage.editRange(key, 17, 16, 'export function triple(n: number) { return n * 3; }');
    space.setPreview(true);
    assert.ok(space.model.nodes.some((n) => n.key === 'shop/web/src/utils.ts#triple'));
    space.setPreview(false);
    await space.applyStage();
    assert.ok(fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('function triple'));
    await space.undoStage();
    assert.equal(fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8'), before);
  });
  test('reverts one hunk at a time', () => {
    const key = 'shop/server/Orders/OrderService.cs';
    const before = space.stage.read(key);
    const lines = before.split('\n');
    lines[2] = 'namespace Shop.Orders.Core;';
    lines[lines.length - 4] = lines[lines.length - 4] + ' // end';
    space.stage.write(key, lines.join('\n'));
    const hunks = space.stage.diff(key).hunks;
    assert.equal(hunks.length, 2);
    assert.ok(hunks.every((h) => h.i1 > h.i0));
    space.stage.revertHunk(key, 0);
    const after = space.stage.read(key).split('\n');
    assert.equal(after[2], 'namespace Shop.Orders;');
    assert.ok(after[after.length - 4].endsWith(' // end'));
    assert.equal(space.stage.diff(key).hunks.length, 1);
    space.stage.revertHunk(key, 0);
    assert.ok(!space.stage.items.has(key), 'reverting every hunk drops the item');
  });
  test('moves a symbol to another file with its doc comment and decorator', async () => {
    fs.writeFileSync(path.join(dir, 'web/src/helper.ts'), "import { clamp } from './utils';\n\n/** Shopping helper. */\n@sealed\nexport class Helper {\n  run() { return clamp(1, 0, 2); }\n}\n\nexport function other() { return 2; }\n");
    await space.scan();
    const r = space.moveSymbol('shop/web/src/helper.ts#Helper', 'shop/web/src/utils.ts');
    assert.equal(r.to, 'shop/web/src/utils.ts');
    const from = space.stage.read('shop/web/src/helper.ts');
    assert.ok(!/Helper|sealed|Shopping/.test(from), from);
    assert.ok(from.includes('export function other'));
    const to = space.stage.read('shop/web/src/utils.ts');
    assert.ok(to.endsWith("}\n\n/** Shopping helper. */\n@sealed\nexport class Helper {\n  run() { return clamp(1, 0, 2); }\n}\n"), to);
    const items = space.stage.list();
    assert.deepEqual(items.map((i) => [i.key, i.state]), [['shop/web/src/helper.ts', 'edit'], ['shop/web/src/utils.ts', 'edit']]);
    assert.equal(items[1].adds, 6);
    assert.equal(items[0].dels, 6);
    assert.throws(() => space.moveSymbol('shop/web/src/helper.ts#other', 'shop/web/src'), /Drop onto a file/);
    space.stage.discard();
    fs.rmSync(path.join(dir, 'web/src/helper.ts'));
    await space.scan();
  });
  test('saves and drops sets in the ledger, kept across restarts', async () => {
    const home = space.home;
    const id = space.saveSet({ name: 'Checkout flow', nodes: ['shop/web/src/checkout.ts#checkout', 'shop/web/src/cart.ts#Cart'], links: [['shop/web/src/cart.ts#Cart.pay', 'shop/web/src/checkout.ts#checkout', 'call']], ranges: [['shop/web/src/api.ts', 4, 7]], recipe: [{ seed: ['shop/web/src/checkout.ts#checkout'] }, { grow: 'out', depth: 1, rank: 3 }] });
    assert.match(id, /^[0-9a-f]{12}$/);
    const again = new Workspace({ home, watch: false });
    await again.open(dir);
    const saved = again.setsState().sets.find((x) => x.id === id);
    assert.equal(saved.name, 'Checkout flow');
    assert.equal(saved.repo, 'shop');
    assert.deepEqual(saved.links, [['shop/web/src/cart.ts#Cart.pay', 'shop/web/src/checkout.ts#checkout', 'call']]);
    assert.equal(saved.recipe[1].grow, 'out');
    again.saveSet({ ...saved, name: 'Checkout' });
    assert.equal(again.setsState().sets.filter((x) => x.id === id).length, 1, 'saving with an id updates it');
    again.dropSet(id);
    const third = new Workspace({ home, watch: false });
    await third.open(dir);
    assert.ok(!third.setsState().sets.some((x) => x.id === id));
    assert.throws(() => space.saveSet({ name: 'x', nodes: [] }), /empty/);
  });
});

describe('move fixes', () => {
  // A workspace on a small repo written to disk; `read` gives staged text.
  const open = async (files) => {
    const dir = path.join(tmp('fix'), 'r');
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const space = new Workspace({ home: tmp('home'), watch: false });
    await space.open(dir);
    return { space, read: (rel) => space.stage.read(`r/${rel}`), staged: () => space.stage.list().map((i) => `${i.state} ${i.path}`).sort() };
  };

  test('JS/TS file moves fix the moved file and its importers, one move after another', async () => {
    const { space, read, staged } = await open({
      'src/app.ts': "import { util } from './lib/util';\nimport { other } from './lib/other.js';\nimport * as ui from './ui';\nexport const app = util() + other() + ui.x;\n",
      'src/lib/util.ts': "import { other } from './other';\nimport { x } from '../ui/index';\nexport function util() { return other() + x; }\n",
      'src/lib/other.ts': 'export function other() { return 1; }\n',
      'src/ui/index.ts': 'export const x = 1;\n',
      'src/deep/a.ts': "import {\n  util,\n} from '@/lib/util';\nexport const a = util;\n",
      'src/core/keep.ts': 'export const keep = 1;\n',
    });
    space.moveFile('r/src/lib/util.ts', 'r/src/core');
    assert.equal(read('src/core/util.ts'), "import { other } from '../lib/other';\nimport { x } from '../ui/index';\nexport function util() { return other() + x; }\n");
    assert.match(read('src/app.ts'), /^import \{ util \} from '\.\/core\/util';\n/);
    assert.match(read('src/deep/a.ts'), /from '@\/core\/util';/, 'aliases keep their form');
    space.moveFile('r/src/lib/other.ts', 'r/src/core');
    assert.match(read('src/app.ts'), /import \{ other \} from '\.\/core\/other\.js';/, '.js specifiers keep their extension');
    assert.match(read('src/core/util.ts'), /^import \{ other \} from '\.\/other';/, 'a staged file is fixed again');
    space.moveFile('r/src/ui', 'r/src/core');
    assert.match(read('src/app.ts'), /import \* as ui from '\.\/core\/ui';/, 'folder imports follow the folder');
    assert.match(read('src/core/util.ts'), /import \{ x \} from '\.\/ui\/index';/);
    assert.deepEqual(staged(), ['add src/core/other.ts', 'add src/core/ui/index.ts', 'add src/core/util.ts', 'delete src/lib/other.ts', 'delete src/lib/util.ts', 'delete src/ui/index.ts', 'edit src/app.ts', 'edit src/deep/a.ts']);
  });

  test('Python file moves fix absolute and relative modules and qualified uses', async () => {
    const { space, read } = await open({
      'shop/__init__.py': '',
      'shop/util.py': 'def fmt(x):\n    return x\n',
      'shop/orders/__init__.py': '',
      'shop/orders/svc.py': 'from shop.util import fmt\nfrom ..util import fmt as f2\nimport shop.util\nfrom shop import util\n\n\ndef run():\n    return shop.util.fmt(1) + util.fmt(2) + f2(3)\n',
      'shop/orders/model.py': 'from . import svc\nfrom .svc import run\n',
      'shop/core/__init__.py': '',
    });
    space.moveFile('r/shop/util.py', 'r/shop/core');
    assert.equal(read('shop/orders/svc.py'), 'from shop.core.util import fmt\nfrom ..core.util import fmt as f2\nimport shop.core.util\nfrom shop.core import util\n\n\ndef run():\n    return shop.core.util.fmt(1) + util.fmt(2) + f2(3)\n');
    space.moveFile('r/shop/orders/svc.py', 'r/shop/core');
    assert.equal(read('shop/core/svc.py').split('\n')[1], 'from .util import fmt as f2', 'the moved file\'s relative imports');
    assert.equal(read('shop/orders/model.py'), 'from ..core import svc\nfrom ..core.svc import run\n');
  });

  test('C# file moves: the namespace follows the folder; usings and qualified names follow the types', async () => {
    const { space, read } = await open({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
      'Orders/Order.cs': 'namespace App.Orders;\n\npublic class Order\n{\n    public Money Total { get; set; }\n}\n',
      'Orders/Money.cs': 'namespace App.Orders;\n\npublic class Money { }\n',
      'Orders/Service.cs': 'namespace App.Orders\n{\n    public class Service\n    {\n        public Order Make() => new Order();\n    }\n}\n',
      'Web/Page.cs': 'using System;\n\nnamespace App.Web;\n\npublic class Page\n{\n    public App.Orders.Order Load() => new App.Orders.Order();\n}\n',
      'Billing/Keep.cs': 'namespace App.Billing;\n\npublic class Keep { }\n',
    });
    space.moveFile('r/Orders/Order.cs', 'r/Billing');
    assert.equal(read('Billing/Order.cs'), 'using App.Orders;\n\nnamespace App.Billing;\n\npublic class Order\n{\n    public Money Total { get; set; }\n}\n');
    assert.equal(read('Orders/Service.cs'), 'using App.Billing;\n\nnamespace App.Orders\n{\n    public class Service\n    {\n        public Order Make() => new Order();\n    }\n}\n');
    assert.equal(read('Web/Page.cs'), 'using System;\n\nnamespace App.Web;\n\npublic class Page\n{\n    public App.Billing.Order Load() => new App.Billing.Order();\n}\n', 'qualified names change; no using needed');
    assert.equal(read('Orders/Money.cs'), 'namespace App.Orders;\n\npublic class Money { }\n', 'files that do not use the type stay');
  });

  test('symbol moves: JS/TS importers, imports carried along, and the old file imports it back', async () => {
    const { space, read } = await open({
      'src/a.ts': "import { dep } from './dep';\n\nexport function moved() {\n  return dep() + local();\n}\n\nfunction local() {\n  return 1;\n}\n\nexport function stay() {\n  return moved();\n}\n",
      'src/dep.ts': 'export function dep() { return 2; }\n',
      'src/b.ts': 'export const b = 1;\n',
      'src/user.ts': "import { moved, stay } from './a';\nexport const u = moved() + stay();\n",
      'src/sub/user2.ts': "import { moved } from '../a';\nexport const u2 = moved();\n",
    });
    space.moveSymbol('r/src/a.ts#moved', 'r/src/b.ts');
    assert.equal(read('src/b.ts'), "import { dep } from './dep';\nimport { local } from './a';\n\nexport const b = 1;\n\nexport function moved() {\n  return dep() + local();\n}\n");
    assert.equal(read('src/a.ts'), "import { dep } from './dep';\nimport { moved } from './b';\n\nexport function local() {\n  return 1;\n}\n\nexport function stay() {\n  return moved();\n}\n");
    assert.equal(read('src/user.ts'), "import { stay } from './a';\nimport { moved } from './b';\nexport const u = moved() + stay();\n");
    assert.equal(read('src/sub/user2.ts'), "import { moved } from '../b';\nexport const u2 = moved();\n");
  });

  test('symbol moves: Python from-imports, carried imports, and the old module imports it back', async () => {
    const { space, read } = await open({
      'pkg/__init__.py': '',
      'pkg/a.py': 'import os\nfrom .dep import dep\n\n\ndef moved():\n    return dep() + os.getpid() + local()\n\n\ndef local():\n    return 1\n\n\ndef stay():\n    return moved()\n',
      'pkg/dep.py': 'def dep():\n    return 2\n',
      'pkg/b.py': 'X = 1\n',
      'pkg/user.py': 'from pkg.a import moved, stay\n',
      'pkg/sub/__init__.py': '',
      'pkg/sub/user2.py': 'from ..a import moved\n',
    });
    space.moveSymbol('r/pkg/a.py#moved', 'r/pkg/b.py');
    assert.equal(read('pkg/b.py'), 'import os\nfrom .dep import dep\nfrom .a import local\n\nX = 1\n\n\ndef moved():\n    return dep() + os.getpid() + local()\n');
    assert.equal(read('pkg/a.py'), 'import os\nfrom .dep import dep\nfrom .b import moved\n\n\ndef local():\n    return 1\n\n\ndef stay():\n    return moved()\n');
    assert.equal(read('pkg/user.py'), 'from pkg.a import stay\nfrom pkg.b import moved\n');
    assert.equal(read('pkg/sub/user2.py'), 'from ..b import moved\n');
  });

  test('symbol moves: C# types land inside a block namespace and bring usings', async () => {
    const { space, read } = await open({
      'Orders/Order.cs': 'namespace App.Orders\n{\n    public class Order { }\n\n    public class Line\n    {\n        public Order Parent;\n    }\n}\n',
      'Billing/Bill.cs': 'namespace App.Billing\n{\n    public class Bill { }\n}\n',
      'Web/Page.cs': 'using App.Orders;\n\nnamespace App.Web;\n\npublic class Page { public Line L; }\n',
    });
    space.moveSymbol('r/Orders/Order.cs#App.Orders.Line', 'r/Billing/Bill.cs');
    assert.equal(read('Billing/Bill.cs'), 'using App.Orders;\n\nnamespace App.Billing\n{\n    public class Bill { }\n\n    public class Line\n    {\n        public Order Parent;\n    }\n}\n');
    assert.equal(read('Orders/Order.cs'), 'namespace App.Orders\n{\n    public class Order { }\n}\n');
    assert.equal(read('Web/Page.cs'), 'using App.Orders;\nusing App.Billing;\n\nnamespace App.Web;\n\npublic class Page { public Line L; }\n');
  });
});

describe('set prompt', () => {
  let space;
  before(async () => {
    const dir = await makeSample(path.join(tmp('prompt'), 'shop'));
    space = new Workspace({ home: tmp('home'), watch: false });
    await space.open(dir);
  });
  test('lists members, findings, inside links, and the interface with sites', () => {
    const text = setText(space, { nodes: ['shop/web/src/checkout.ts#checkout', 'shop/web/src/cart.ts#Cart'], links: [['shop/web/src/cart.ts#Cart.pay', 'shop/web/src/checkout.ts#checkout', '*']], ranges: [['shop/web/src/api.ts', 4, 7]] });
    assert.match(text, /^\n\nSelection \(2 parts, 1 link, 1 line range\):/);
    assert.match(text, /- function checkout at shop\/web\/src\/checkout\.ts:6-63 \(58 lines, 22 branches, 6 parameters\)/);
    assert.match(text, /finding: Complex logic: 22 branches/);
    assert.match(text, /- class Cart at shop\/web\/src\/cart\.ts:10-\d+/);
    assert.match(text, /- lines shop\/web\/src\/api\.ts:4-7/);
    assert.match(text, /- link: Cart\.pay → checkout \(call, at shop\/web\/src\/cart\.ts:28\)/);
    assert.match(text, /Inside the selection: checkout → Cart \(use, call ×\d+, checkout\.ts:6, 8/);
    assert.match(text, /The selection uses: api\.post \(call, checkout\.ts:49\)/);
    assert.match(text, /Used from outside by: .*App\.start \(call, app\.ts:10\)/);
    assert.equal(setText(space, { nodes: [] }), '');
  });
  test('keeps to its caps', () => {
    const funcs = space.model.nodes.filter((n) => n.kind === 'func').map((n) => n.key);
    assert.ok(funcs.length > 45);
    const text = setText(space, { nodes: funcs });
    assert.ok(text.length <= 12000);
    assert.match(text, /- \+\d+ more functions in /);
    assert.equal(text.split('\n').filter((l) => l.startsWith('- ') && / at /.test(l)).length, 40);
    for (const l of text.split('\n').filter((x) => /^(The selection uses|Used from outside by|Inside the selection)/.test(x))) assert.ok(l.split('; ').length <= 21);
    const link = setText(space, { links: [['shop/web/src/checkout.ts#checkout', 'shop/web/src/cart.ts#Cart.total', 'call']] });
    const sites = /at shop\/web\/src\/checkout\.ts:([\d, ]+)\)/.exec(link)[1].split(', ');
    assert.ok(sites.length <= 12);
    assert.ok(setText(space, { nodes: funcs }, { limit: 2000 }).length <= 2000);
  });
});

describe('config', () => {
  test('env overrides file, key is never sent to clients', () => {
    const home = tmp('cfg');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'from-file', apiKey: 'secret-key' }));
    const old = process.env.DEVIBE_MODEL;
    process.env.DEVIBE_MODEL = 'from-env';
    try {
      const cfg = loadConfig(home);
      assert.equal(cfg.model, 'from-env');
      assert.equal(cfg.apiKey, 'secret-key');
      const space = new Workspace({ home, watch: false });
      const state = space.configState();
      assert.equal(state.hasKey, true);
      assert.ok(!JSON.stringify(state).includes('secret-key'));
    } finally {
      if (old === undefined) delete process.env.DEVIBE_MODEL; else process.env.DEVIBE_MODEL = old;
    }
  });
  test('the file size limit comes from env or file, is clamped, and rescans when it changes', async () => {
    const home = tmp('cfg');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ maxKB: 500 }));
    const old = process.env.DEVIBE_MAX_KB;
    try {
      delete process.env.DEVIBE_MAX_KB;
      assert.equal(loadConfig(tmp('cfg')).maxKB, 2000, 'default');
      assert.equal(loadConfig(home).maxKB, 500);
      process.env.DEVIBE_MAX_KB = '300';
      assert.equal(loadConfig(home).maxKB, 300, 'env wins');
      process.env.DEVIBE_MAX_KB = 'lots';
      assert.equal(loadConfig(home).maxKB, 500, 'a bad value falls back');
      delete process.env.DEVIBE_MAX_KB;
      const dir = tmp('size');
      fs.writeFileSync(path.join(dir, 'small.js'), 'function a() { return 1; }\n');
      fs.writeFileSync(path.join(dir, 'large.js'), 'function b() { return 2; }\n' + '// pad\n'.repeat(400));
      const space = new Workspace({ home, watch: false });
      await space.open(dir);
      const fact = (rel) => space.repos[0].facts.get(rel);
      assert.ok(fact('large.js').syms.length && !fact('large.js').big, 'under the limit: read');
      assert.equal(space.setConfig({ maxKB: 2 }), true);
      await space.scan();
      assert.ok(fact('large.js').big && !fact('large.js').syms.length, 'over the limit: listed, not read');
      assert.ok(fact('small.js').syms.length);
      assert.equal(space.repos[0].stats.big, 1);
      assert.equal(space.setConfig({ maxKB: 2 }), false, 'no change, no rescan');
      assert.equal(space.configState().maxKB, 2);
      assert.equal(loadConfig(home).maxKB, 2, 'saved');
      assert.equal(space.setConfig({ maxKB: 10 }), true);
      await space.scan();
      assert.ok(fact('large.js').syms.length && !fact('large.js').big, 'a higher limit reads it again');
      space.setConfig({ maxKB: -4 });
      assert.equal(space.configState().maxKB, 1, 'clamped');
      space.close();
    } finally {
      if (old === undefined) delete process.env.DEVIBE_MAX_KB; else process.env.DEVIBE_MAX_KB = old;
    }
  });
});

describe('server', () => {
  let app, dir;
  before(async () => {
    dir = await makeSample(path.join(tmp('srv'), 'shop'));
    app = await startServer({ port: 0, repos: [dir], home: tmp('home'), watch: true, quiet: true });
  });
  after(() => app.close());
  const connect = (headers = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(app.url.replace('http', 'ws') + '/ws', { headers: { origin: app.url, ...headers } });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const ask = (ws, type, data = {}) => new Promise((resolve) => {
    const id = Math.random();
    const onMsg = (raw) => { const msg = JSON.parse(raw); if (msg.re === id) { ws.off('message', onMsg); resolve(msg); } };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type, data, id }));
  });
  test('serves the client with a content security policy', async () => {
    const res = await fetch(app.url + '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
    assert.ok((await res.text()).includes('client.mjs'));
    assert.equal((await fetch(app.url + '/lib/three/three.module.js')).status, 200);
    assert.equal((await fetch(app.url + '/lib/three/addons/lines/LineMaterial.js')).status, 200);
    assert.equal((await fetch(app.url + '/lib/three/../../package.json')).status, 404);
    assert.equal((await fetch(app.url + '/server.mjs')).status, 404);
    assert.equal((await fetch(app.url + '/core_sets.mjs')).status, 200);
  });
  test('rejects foreign hosts and origins', async () => {
    const res = await new Promise((resolve) => http.get(app.url + '/', { headers: { host: 'evil.example' } }, resolve));
    assert.equal(res.statusCode, 403);
    await assert.rejects(() => connect({ origin: 'http://evil.example' }));
  });
  test('answers messages over the socket', async () => {
    const ws = await connect();
    const hello = await ask(ws, 'hello');
    assert.equal(hello.type, 'hello');
    assert.ok(hello.data.model.nodes.length > 100);
    assert.equal(hello.data.config.repos[0].name, 'shop');
    const file = await ask(ws, 'file.read', { key: 'shop/web/src/cart.ts' });
    assert.ok(file.data.text.includes('class Cart'));
    const hits = await ask(ws, 'text.find', { query: 'TODO' });
    assert.ok(hits.data.hits.some((h) => h.key === 'shop/web/src/checkout.ts'));
    const dirs = await ask(ws, 'dir.list', { path: dir });
    assert.ok(dirs.data.items.some((d) => d.name === 'server'));
    for (const key of ['shop/../../etc/passwd', 'shop/./../x', '../etc/passwd', 'shop//etc/passwd/..', 'shop/a/../../..']) {
      const bad = await ask(ws, 'file.read', { key });
      assert.ok(bad.type === 'note' || bad.data.text == null, `${key} must not be readable`);
    }
    const renamed = await ask(ws, 'stage.rename', { key: 'shop/web/src/utils.ts#clamp', name: 'limit' });
    assert.match(renamed.data.text, /Staged rename/);
    await ask(ws, 'stage.discard', {});
    assert.deepEqual(hello.data.acts.map((a) => a.id).slice(0, 2), ['explain', 'tidy']);
    assert.ok(!('prompt' in hello.data.acts[0]), 'prompts stay on the server');
    assert.ok(Array.isArray(hello.data.sets));
    const links = await ask(ws, 'file.links', { key: 'shop/web/src/cart.ts' });
    assert.equal(links.type, 'file.links');
    assert.ok(links.data.in.length > 0 && links.data.out.length > 0);
    const bad = await ask(ws, 'stage.edit', { key: 'shop/web/src/cart.ts', from: 900, to: 901, text: 'x' });
    assert.equal(bad.type, 'note');
    assert.match(bad.data.text, /outside/);
    const edit = await ask(ws, 'stage.edit', { key: 'shop/web/src/cart.ts', from: 1, to: 0, text: '// top' });
    assert.match(edit.data.text, /Staged edit/);
    const staged = await ask(ws, 'file.read', { key: 'shop/web/src/cart.ts', staged: true });
    assert.ok(staged.data.text.startsWith('// top\n') && staged.data.staged);
    const disk = await ask(ws, 'file.read', { key: 'shop/web/src/cart.ts' });
    assert.ok(!disk.data.text.startsWith('// top'));
    const hunk = await ask(ws, 'stage.hunk', { key: 'shop/web/src/cart.ts', index: 0 });
    assert.match(hunk.data.text, /Reverted/);
    const saved = await ask(ws, 'set.save', { set: { name: 'Cart', nodes: ['shop/web/src/cart.ts'] } });
    assert.equal(saved.type, 'sets.state');
    assert.ok(saved.data.sets.some((x) => x.id === saved.data.id && x.name === 'Cart'));
    const dropped = await ask(ws, 'set.drop', { id: saved.data.id });
    assert.ok(!dropped.data.sets.some((x) => x.id === saved.data.id));
    const busy = await ask(ws, 'agent.run', { act: 'nope' });
    assert.equal(busy.type, 'note');
    ws.close();
  });
  test('watches files and pushes a new model', async () => {
    const ws = await connect();
    await ask(ws, 'hello');
    const next = new Promise((resolve) => ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'repo.model' && m.data.nodes.some((n) => n.key === 'shop/web/src/fresh.ts')) resolve(m); }));
    await fsp.writeFile(path.join(dir, 'web/src/fresh.ts'), 'export const fresh = () => 1;\n');
    const msg = await Promise.race([next, new Promise((_, no) => setTimeout(() => no(new Error('no update')), 8000))]);
    assert.ok(msg.data.nodes.some((n) => n.key === 'shop/web/src/fresh.ts#fresh'));
    ws.close();
  });
});

describe('agent', () => {
  let llm, space, dir;
  before(async () => {
    llm = await mockModel([
      { tools: [{ name: 'find_refs', args: { name: 'slugify' } }, { name: 'read_file', args: { path: 'web/src/utils.ts' } }] },
      { tools: [{ name: 'edit_file', args: { path: 'web/src/utils.ts', find: 'export function slugify', replace: 'export function makeSlug' } }] },
      { text: 'Renamed `slugify` to `makeSlug`.\n\n- web/src/utils.ts: new name' },
    ]);
    dir = await makeSample(path.join(tmp('agent'), 'shop'));
    space = new Workspace({ home: tmp('home'), watch: false });
    space.setConfig({ endpoint: llm.url, model: 'mock-model', apiKey: 'test-key', style: 'Prefer short names.' });
    await space.open(dir);
  });
  after(() => llm.close());
  test('runs tools through the Agents SDK and stages the edit', async () => {
    const events = [];
    space.on((type, data) => events.push([type, data]));
    const text = await runAgent(space, { prompt: 'Rename slugify to makeSlug', focus: ['shop/web/src/utils.ts#slugify'] });
    assert.match(text, /makeSlug/);
    const staged = space.stage.read('shop/web/src/utils.ts');
    assert.ok(staged.includes('export function makeSlug'));
    assert.ok(!fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('makeSlug'), 'disk unchanged');
    const tools = events.filter(([t, d]) => t === 'agent.step' && d.kind === 'tool').map(([, d]) => d.name);
    assert.deepEqual(tools, ['find_refs', 'read_file', 'edit_file']);
    assert.ok(events.some(([t, d]) => t === 'agent.step' && d.kind === 'text'));
    assert.ok(events.some(([t]) => t === 'agent.done'));
    const first = llm.seen[0];
    const lastText = (m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''));
    assert.equal(first.model, 'mock-model');
    assert.ok(lastText(first.messages[0]).includes('Prefer short names.'));
    assert.ok(lastText(first.messages.at(-1)).includes('Selection (1 part)'), JSON.stringify(first.messages.at(-1)));
    assert.ok(first.tools.some((t) => t.function.name === 'edit_file'));
  });
  test('remembers the conversation and reports connection tests', async () => {
    assert.ok(space.agent.history.length > 3);
    const res = await testAgent(space.config);
    assert.equal(res.ok, true);
    const bad = await testAgent({ ...space.config, endpoint: 'http://127.0.0.1:9/v1' });
    assert.equal(bad.ok, false);
  });
});

describe('agent actions', () => {
  let llm, space;
  const lastText = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(''));
  before(async () => {
    llm = await mockModel([{ text: 'Done.' }]);
    const dir = await makeSample(path.join(tmp('acts'), 'shop'));
    space = new Workspace({ home: tmp('home'), watch: false });
    space.setConfig({ endpoint: llm.url, model: 'mock-model', apiKey: 'k' });
    await space.open(dir);
  });
  after(() => llm.close());
  test('actions are defined on the server', () => {
    assert.deepEqual(ACTS.map((a) => a.id), ['explain', 'tidy', 'split', 'fix', 'tests', 'docs', 'decouple', 'merge', 'extract']);
    assert.ok(ACTS.every((a) => a.prompt && a.name && a.takes));
  });
  test('read-only actions get read tools only', async () => {
    llm.seen.length = 0;
    await runAgent(space, { act: 'explain', set: { nodes: ['shop/web/src/cart.ts#Cart'] } });
    const names = llm.seen[0].tools.map((t) => t.function.name).sort();
    assert.deepEqual(names, ['find_refs', 'find_text', 'list_files', 'read_file', 'show_links', 'show_outline']);
    const ask = lastText(llm.seen[0].messages.at(-1));
    assert.ok(ask.startsWith('Explain what the selection does'));
    assert.match(ask, /Selection \(1 part\):\n- class Cart/);
    llm.seen.length = 0;
    await runAgent(space, { act: 'tidy', set: { nodes: ['shop/web/src/cart.ts#Cart'] } });
    assert.ok(llm.seen[0].tools.some((t) => t.function.name === 'edit_file'));
    await assert.rejects(() => runAgent(space, { act: 'nope' }), /Unknown action/);
    await assert.rejects(() => runAgent(space, {}), /Ask something/);
  });
  test('one by one: a run per item, fresh history, one summary in the conversation', async () => {
    const history = space.agent.history.length;
    llm.seen.length = 0;
    const events = [];
    const off = space.on((type, data) => events.push([type, data]));
    const set = { nodes: ['shop/web/src/cart.ts', 'shop/web/src/api.ts'], links: [['shop/web/src/cart.ts#Cart.pay', 'shop/web/src/checkout.ts#checkout', 'call']], ranges: [] };
    const text = await runAgent(space, { act: 'docs', set, mode: 'each' });
    off();
    assert.equal(llm.seen.length, 3, 'three runs');
    for (const req of llm.seen) assert.equal(req.messages.filter((m) => m.role === 'user').length, 1, 'fresh history per item');
    assert.match(lastText(llm.seen[2].messages.at(-1)), /- link: Cart\.pay → checkout/);
    const items = events.filter(([t, d]) => t === 'agent.step' && d.kind === 'item');
    assert.deepEqual(items.filter(([, d]) => d.state === 'run').map(([, d]) => d.index), [0, 1, 2]);
    assert.deepEqual(items.filter(([, d]) => d.state !== 'run').map(([, d]) => d.state), ['none', 'none', 'none']);
    assert.match(text, /Document, one by one: 3 of 3 items done/);
    const done = events.find(([t]) => t === 'agent.done')[1];
    assert.equal(done.batch.total, 3);
    assert.equal(space.agent.history.length, history + 2, 'only the summary joins the conversation');
  });
  test('stop finishes the current item, then stops', async () => {
    llm.seen.length = 0;
    const off = space.on((type, data) => { if (type === 'agent.step' && data.kind === 'item' && data.state === 'run' && data.index === 0) stopAgent(space); });
    const text = await runAgent(space, { act: 'docs', set: { nodes: ['shop/web/src/cart.ts', 'shop/web/src/api.ts', 'shop/web/src/utils.ts'] }, mode: 'each' });
    off();
    assert.equal(llm.seen.length, 1);
    assert.match(text, /1 of 3 items done \(stopped\)/);
    assert.equal(space.agent.busy, false);
  });
  test('show_links lists links with kinds and sites', async () => {
    const llm2 = await mockModel([{ tools: [{ name: 'show_links', args: { name_or_path: 'checkout', dir: 'both' } }] }, { text: 'ok' }]);
    space.setConfig({ endpoint: llm2.url });
    try {
      await runAgent(space, { prompt: 'What does checkout use?' });
      const out = llm2.seen[1].messages.find((m) => m.role === 'tool').content;
      const text = typeof out === 'string' ? out : out.map((p) => p.text).join('');
      assert.match(text, /^checkout \(function, shop\/web\/src\/checkout\.ts:6-63\)/);
      assert.match(text, /uses:\n/);
      assert.match(text, /- api\.post \(call, at shop\/web\/src\/checkout\.ts:49\)/);
      assert.match(text, /used by:\n/);
      assert.match(text, /- Cart\.pay \(call, at shop\/web\/src\/cart\.ts:28\)/);
    } finally {
      await llm2.close();
      space.setConfig({ endpoint: llm.url });
    }
  });
});

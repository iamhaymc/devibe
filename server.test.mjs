// Unit tests for the devibe server: parsing, linking, checks, diff, stage,
// ledger, sockets, and the agent loop (against a mock chat endpoint).
// Run: node --test server.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  maskCode, readSymbols, readImports, readFacts, langOf, findCopies, strongGroups, diffLines, makeHunks,
  Workspace, buildModel, startServer, makeSample, runAgent, testAgent, loadConfig, LINK_KINDS,
} from './server.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `devibe-${name}-`));
const syms = (text, lang) => readSymbols(text, maskCode(text, lang), lang).map((s) => `${s.kind}:${s.form}:${s.name}@${s.from}-${s.to}`);

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
  test('reads git history', () => {
    const f = byKey('shop/web/src/checkout.ts');
    assert.ok(f.churn >= 2, `churn ${f.churn}`);
    assert.ok(f.time > 0);
    assert.equal(byKey('shop').branch, 'main');
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
    assert.ok(lastText(first.messages.at(-1)).includes('Focus (selected in the map)'), JSON.stringify(first.messages.at(-1)));
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

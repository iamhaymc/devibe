// Unit tests for core_tree.mjs: Tree-sitter symbols and receiver facts in the
// built-in parser's shapes, and the workspace's parser setting. Skipped when
// the optional @vscode/tree-sitter-wasm package is not installed.
// Run: node --test test/tree.test.mjs

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTrees, GRAMMARS } from '../app/core_tree.mjs';
import { readSymbols, readFacts, maskCode, buildModel, makeSample, Workspace, LINK_KINDS } from '../app/server.mjs';

const trees = makeTrees();
const skip = trees.ready ? false : 'needs the optional @vscode/tree-sitter-wasm package';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `devibe-${name}-`));
const syms = (text, lang, rel = 'x') => readSymbols(text, maskCode(text, lang), lang, trees.read(text, lang, rel).syms).map((s) => `${s.kind}:${s.form}:${s.name}@${s.from}-${s.to}${s.args ? ' a' + s.args : ''}${s.bases?.length ? ' <' + s.bases.join(',') : ''}`);
const modelOf = (files) => buildModel([{ name: 'r', root: '/r', facts: new Map(Object.entries(files).map(([rel, text]) => [rel, readFacts(rel, text, { trees })])), texts: new Map(Object.entries(files)), git: null }]);
const targets = (m, from, kind = 'call') => m.links.filter(([s, , k]) => m.nodes[s].key === `r/${from}` && LINK_KINDS[k] === kind).map(([, t]) => m.nodes[t].key.slice(2)).sort();

describe('tree-sitter', { skip }, () => {
  before(async () => {
    const ok = await trees.load(Object.keys(GRAMMARS));
    assert.deepEqual([...ok].sort(), Object.keys(GRAMMARS).sort());
  });

  test('reads nothing for languages it does not cover', () => {
    assert.equal(trees.read('fun f() {}', 'kt', 'a.kt'), null);
  });

  test('Python: decorators stay off the name line, metaclass is not a base', () => {
    assert.deepEqual(syms('@app.route("/x")\n@cached\ndef handler(req, res):\n    return req\n\nclass A(Base, metaclass=Meta):\n    @property\n    def size(self) -> int:\n        return 1\n', 'py'),
      ['func:function:handler@3-4 a2', 'type:class:A@6-9 <Base', 'func:method:size@8-9']);
  });

  test('JavaScript and TypeScript: nested lambdas are not symbols; named ones are', () => {
    assert.deepEqual(syms('export const run = (xs) => xs.map((x) => () => x);\nfunction outer() {\n  const inner = function () { return 1; };\n  return [1].forEach((v) => inner(v));\n}\n', 'js'),
      ['func:function:run@1-1 a1', 'func:function:outer@2-5', 'func:function:inner@3-3']);
    assert.deepEqual(syms('export namespace N {\n  export interface I {\n    m(): void;\n    n: number;\n  }\n  export type T = { a: 1 };\n}\nexport abstract class C extends B implements I {\n  constructor(private s: Store) { super(); }\n  handle = (e: Event) => this.s.find(e);\n}\n', 'ts'),
      ['space:namespace:N@1-7', 'type:interface:I@2-5', 'func:method:m@3-3', 'type:type:T@6-6', 'type:class:C@8-11 <B,I', 'func:ctor:constructor@9-9 a1', 'func:method:handle@10-10 a1']);
  });

  test('C++: macros, templates, base classes, and out-of-class methods', () => {
    assert.deepEqual(syms('#define SQR(x) ((x) * (x))\ntemplate <typename T, typename U = std::vector<std::map<int, T>>>\nclass Box : public Base<T>, private Other {\npublic:\n  template <class F> auto apply(F&& f) const -> decltype(f(std::declval<T>())) { return f(v); }\n  T get() const;\nprivate:\n  T v;\n};\ntemplate <typename T, typename U>\nT Box<T, U>::get() const { return v; }\nstd::map<std::string, std::vector<int>> table(int n) { return {}; }\n', 'cpp'),
      ['func:macro:SQR@1-1 a1', 'type:class:Box@3-9 <Base,Other', 'func:method:apply@5-5 a1', 'func:method:get@6-6', 'func:method:Box::get@11-11', 'func:function:table@12-12 a1']);
  });

  test('Rust: macro_rules, unit structs, impl blocks with traits', () => {
    assert.deepEqual(syms('macro_rules! square {\n    ($x:expr) => { $x * $x };\n}\npub struct Store;\npub trait Find { fn find(&self, id: u32) -> u32; }\nimpl Find for Store {\n    fn find(&self, id: u32) -> u32 { let c = |x: u32| x + 1; c(id) }\n}\n', 'rs'),
      ['func:macro:square@1-3', 'type:struct:Store@4-4', 'type:trait:Find@5-5', 'func:method:find@5-5 a1', 'type:impl:Store@6-8 <Find', 'func:method:find@7-7 a1']);
  });

  test('C#, Java, Go, Ruby, PHP', () => {
    assert.deepEqual(syms('namespace N;\n[Serializable]\npublic partial class C<T> : Base, IFoo where T : class\n{\n    public C(IStore s) { }\n    public void Run(Func<int, int> f)\n    {\n        int Local(int y) => y * 2;\n    }\n}\n', 'cs'),
      ['space:namespace:N@1-10', 'type:class:C@3-10 <Base,IFoo', 'func:ctor:C@5-5 a1', 'func:method:Run@6-9 a1', 'func:function:Local@8-8 a1']);
    assert.deepEqual(syms('class A extends B implements I, J {\n  A(int x) {}\n  void m(String s) { Runnable r = () -> run(); }\n  interface In { void z(); }\n}\n', 'java'),
      ['type:class:A@1-5 <B,I,J', 'func:ctor:A@2-2 a1', 'func:method:m@3-3 a1', 'type:interface:In@4-4', 'func:method:z@4-4']);
    assert.deepEqual(syms('package p\n\ntype Store interface {\n\tFind(id int) error\n}\n\ntype S struct{ store Store }\n\nfunc (s *S) Run(a, b int) error { f := func() {}; f(); return nil }\n', 'go'),
      ['type:interface:Store@3-5', 'func:method:Find@4-4 a1', 'type:struct:S@7-7', 'func:method:Run@9-9 a2']);
    assert.deepEqual(syms('module M\n  class C < Base\n    def initialize(s)\n    end\n    def self.make; end\n  end\nend\n', 'rb'),
      ['type:module:M@1-7', 'type:class:C@2-6 <Base', 'func:method:initialize@3-4 a1', 'func:method:make@5-5']);
    assert.deepEqual(syms('<?php\nnamespace App;\nclass C extends B implements I {\n  public function m(Store $s, $x) {}\n}\nfunction top() {}\n', 'php'),
      ['space:namespace:App@2-6', 'type:class:C@3-5 <B,I', 'func:method:m@4-4 a2', 'func:function:top@6-6']);
  });

  test('receiver facts come from the tree', () => {
    const f = readFacts('S.cs', 'class S {\n  private readonly IOrderStore _store;\n  public void M(List<int> xs, Repo? r) {\n    var q = new Query<Order>();\n    _store.Find(1);\n    this._store.Save(q);\n    base.Run();\n  }\n}\n', { trees });
    assert.equal(f.parser, 'tree');
    assert.deepEqual(f.vars, [['_store', 'IOrderStore', 2], ['xs', 'List', 3], ['r', 'Repo', 3], ['q', 'Query', 4]]);
    assert.deepEqual(f.refs.map(String).sort(), ['_store,Find,5', 'super,Run,7', 'this,_store,6', 'this._store,Save,6']);
  });

  test('links calls by receiver type, as the built-in parser does', () => {
    const m = modelOf({
      'Data/Store.cs': 'namespace App.Data;\npublic interface IOrderStore { Order Find(int id); void Save(Order o); }\npublic class SqlStore : IOrderStore { public Order Find(int id) => null; public void Save(Order o) {} }\npublic class MemStore : IOrderStore { public Order Find(int id) => null; public void Save(Order o) {} }\npublic class Other { public void Find() {} }\npublic class More { public void Find() {} }\n',
      'Web/Service.cs': 'namespace App.Web;\npublic class Service\n{\n    private readonly IOrderStore _store;\n    private readonly List<int> _ids = new();\n    public void Run(MemStore mem)\n    {\n        _store.Find(1);\n        this._store.Save(null);\n        mem.Find(2);\n        _ids.Find(3);\n        Helper.Find(4);\n        Console.Find(5);\n    }\n}\npublic static class Helper { public static int Find(int x) => x; }\n',
      'store.py': 'class Base:\n    def save(self):\n        pass\n\nclass Store(Base):\n    def find(self, x):\n        return x\n\nclass Cache:\n    def find(self, x):\n        return x\n',
      'svc.py': 'from .store import Store, Cache\n\nclass Service:\n    def __init__(self):\n        self.store = Store()\n\n    def run(self, cache: Cache):\n        self.store.find(1)\n        self.store.save()\n        cache.find(2)\n        self.done()\n\n    def done(self):\n        pass\n',
      'a.go': 'package p\n\ntype Store struct{}\n\ntype Svc struct {\n\tstore Store\n}\n',
      'b.go': 'package p\n\nfunc (s *Store) Find(id int) {}\n\nfunc (s *Svc) Run() {\n\ts.store.Find(1)\n}\n',
      'c.go': 'package p\n\ntype Other struct{}\n\nfunc (o Other) Find(id int) {}\n',
    });
    assert.deepEqual(targets(m, 'Web/Service.cs#App.Web.Service.Run'), ['Data/Store.cs#App.Data.IOrderStore.Find', 'Data/Store.cs#App.Data.IOrderStore.Save', 'Data/Store.cs#App.Data.MemStore.Find', 'Web/Service.cs#App.Web.Helper.Find'], 'one-line interfaces parse exactly');
    assert.deepEqual(targets(m, 'svc.py#Service.run'), ['store.py#Base.save', 'store.py#Cache.find', 'store.py#Store.find', 'svc.py#Service.done']);
    assert.deepEqual(targets(m, 'b.go#Run'), ['b.go#Find']);
  });

  test('the workspace parses with the parser setting and reparses when it changes', async () => {
    const dir = await makeSample(path.join(tmp('trees'), 'shop'));
    const space = new Workspace({ home: tmp('home'), watch: false });
    await space.open(dir);
    assert.equal(space.repos[0].facts.get('web/src/cart.ts').parser, undefined);
    const before = space.model.stats;
    assert.equal(space.setConfig({ parser: 'tree-sitter' }), true);
    await space.scan();
    const facts = space.repos[0].facts;
    for (const rel of ['web/src/cart.ts', 'server/Orders/OrderService.cs', 'engine/pricing.go', 'core/src/money.rs', 'native/vec.cpp', 'tools/report.py']) assert.equal(facts.get(rel).parser, 'tree', rel);
    assert.equal(facts.get('README.md').parser, undefined, 'data files keep the built-in reader');
    assert.equal(space.model.stats.files, before.files);
    assert.ok(space.model.nodes.some((n) => n.key === 'shop/web/src/cart.ts#Cart.add'));
    assert.ok(space.repos[0].stats.tree.ts >= 0);
    assert.equal(space.configState().parser, 'tree-sitter');
    assert.equal(space.configState().trees.ready, true);
    assert.equal(space.setConfig({ parser: 'tree-sitter' }), false, 'no change, no reparse');
    space.setConfig({ parser: 'built-in' });
    await space.scan();
    assert.equal(space.repos[0].facts.get('web/src/cart.ts').parser, undefined);
    space.close();
  });
});

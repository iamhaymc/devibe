// Unit tests for core_sets.mjs: growth, paths, loops, copies, tests, boundaries,
// find queries, color classes, and recipes, on the demo repo's model.
// Run: node --test test/sets.test.mjs

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace, makeSample } from '../app/server.mjs';
import {
  index, liftTo, partsAt, liftGraph, levels, strongGroups, loopsAt, fanin, emptySet, grow, boundary, reach, parseQuery, matchQuery,
  classify, classMatches, replay, recipeName, linkIndices, seedIds, setSummary, cleanSet,
} from '../app/core_sets.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `devibe-${name}-`));

describe('sets', () => {
  let space, dir, I;
  const key = (k) => `shop/${k}`;
  const id = (k) => I.byKey.get(key(k));
  const names = (keys) => keys.map((k) => k.replace(/^shop\//, '')).sort();
  const seed = (...keys) => ({ ...emptySet(), nodes: keys.map(key), recipe: [{ seed: keys.map(key) }] });

  before(async () => {
    dir = await makeSample(path.join(tmp('sets'), 'shop'));
    space = new Workspace({ home: tmp('home'), watch: false });
    await space.open(dir);
    I = index(space.model);
  });

  test('indexes the model once per model', () => {
    assert.equal(index(space.model), I);
    assert.equal(I.N[id('web/src/cart.ts')].kind, 'file');
    assert.equal(I.fileOf[id('web/src/cart.ts#Cart.pay')], id('web/src/cart.ts'));
    assert.equal(liftTo(I, id('web/src/cart.ts#Cart.pay'), 3), id('web/src/cart.ts'));
    assert.equal(liftTo(I, id('web/src/cart.ts#Cart.pay'), 4), id('web/src/cart.ts#Cart'));
  });

  test('parts at a rank are the leaves lifted to it', () => {
    const files = partsAt(I, 3);
    assert.ok(files.every((x) => I.N[x].kind === 'file'));
    assert.equal(files.length, space.model.stats.files);
    const dirs = partsAt(I, 2).map((x) => I.N[x].key);
    assert.ok(dirs.includes(key('web/src')) && dirs.includes(key('server')));
    assert.ok(!dirs.includes(key('web')), 'folders without files of their own are not parts');
  });

  test('lifted graphs leave copies and changes-with out', () => {
    const g = liftGraph(I, 3);
    assert.ok(g.links.some((e) => e.a === id('web/src/cart.ts') && e.b === id('web/src/checkout.ts')));
    assert.ok(!g.links.some((e) => [e.a, e.b].includes(id('tools/report_copy.py')) && [e.a, e.b].includes(id('tools/report.py'))), 'no copy links');
    assert.ok(!g.links.some((e) => [e.a, e.b].includes(id('web/src/api.ts')) && [e.a, e.b].includes(id('server/Orders/OrderService.cs'))), 'no changes-with links');
    assert.equal(liftGraph(I, 3), g, 'cached per rank');
  });

  test('levels put strongly connected parts on one level, base at 0', () => {
    const L = levels([1, 2, 3, 4], [{ a: 1, b: 2 }, { a: 2, b: 1 }, { a: 3, b: 1 }, { a: 4, b: 3 }]);
    assert.equal(L.levelOf(1), 0);
    assert.equal(L.levelOf(2), 0);
    assert.equal(L.levelOf(3), 1);
    assert.equal(L.levelOf(4), 2);
    assert.equal(L.maxL, 2);
    assert.deepEqual(strongGroups(new Map([[1, [2]], [2, [1]], [3, [1]]])).map((g) => g.sort()), [[1, 2]]);
  });

  test('grow out and in, one hop and all hops, with hops recorded', () => {
    const one = grow(I, seed('web/src/app.ts'), 'out', { rank: 3 });
    assert.deepEqual(names(one.nodes), ['web/src/api.ts', 'web/src/app.ts', 'web/src/cart.ts', 'web/src/ui/render.ts', 'web/src/utils.ts']);
    assert.equal(one.hops[key('web/src/cart.ts')], 1);
    const two = grow(I, one, 'out', { rank: 3 });
    assert.equal(two.hops[key('web/src/checkout.ts')], 2, 'second press is hop 2');
    const all = grow(I, seed('web/src/app.ts'), 'out', { rank: 3, depth: Infinity });
    assert.ok(all.nodes.includes(key('web/src/checkout.ts')));
    assert.deepEqual(all.recipe.at(-1), { grow: 'out', depth: 'all', rank: 3 });
    const users = grow(I, seed('web/src/utils.ts'), 'in', { rank: 3 });
    assert.ok(users.nodes.includes(key('web/src/app.ts')) && users.nodes.includes(key('web/src/ui/render.ts')));
    assert.ok(!users.nodes.includes(key('web/src/api.ts')));
    const fn = grow(I, seed('web/src/cart.ts#Cart.pay'), 'out', { rank: 5 });
    assert.deepEqual(names(fn.nodes), ['web/src/cart.ts#Cart.pay', 'web/src/checkout.ts#checkout'], 'a member grows from its own links');
    const both = grow(I, seed('web/src/cart.ts'), 'both', { rank: 3 });
    assert.ok(both.nodes.includes(key('web/src/checkout.ts')) && both.nodes.includes(key('web/src/app.ts')));
  });

  test('path finds every node and link on the shortest paths both ways', () => {
    const p = grow(I, seed('web/src/app.ts', 'web/src/checkout.ts'), 'path', { rank: 3 });
    assert.ok(p.nodes.includes(key('web/src/cart.ts')), 'app → cart → checkout');
    assert.ok(p.links.some((l) => l[0] === key('web/src/app.ts') && l[1] === key('web/src/cart.ts') && l[2] === '*'));
    assert.ok(p.links.some((l) => l[0] === key('web/src/cart.ts') && l[1] === key('web/src/checkout.ts')));
    assert.ok(!p.nodes.includes(key('web/src/api.ts')), 'off-path parts stay out');
  });

  test('loops at a rank list the parts in a loop and every part above them', () => {
    const L = loopsAt(I, 3);
    assert.equal(loopsAt(I, 3), L, 'cached per model');
    assert.ok(L.inLoop.has(id('web/src/cart.ts')) && L.inLoop.has(id('web/src/checkout.ts')));
    assert.ok(!L.inLoop.has(id('web/src/api.ts')));
    assert.ok(L.above.has(id('web/src')) && L.above.has(id('web/src/cart.ts')));
    assert.ok(!L.above.has(id('server')));
  });

  test('loop adds the rest of the strongly connected group', () => {
    const s = grow(I, seed('web/src/cart.ts'), 'loop', { rank: 3 });
    assert.deepEqual(names(s.nodes), ['web/src/cart.ts', 'web/src/checkout.ts']);
    assert.equal(s.links.length, 2);
    const none = grow(I, seed('web/src/api.ts'), 'loop', { rank: 3 });
    assert.deepEqual(none.nodes, [key('web/src/api.ts')]);
  });

  test('copies follow raw copy links', () => {
    const s = grow(I, seed('tools/report.py'), 'copies', { rank: 3 });
    assert.ok(s.nodes.some((k) => k.startsWith(key('tools/report_copy.py'))));
    assert.ok(s.links.length >= 1 && s.links.every((l) => l[2] === 'copy'));
    const none = grow(I, seed('web/src/utils.ts'), 'copies', { rank: 3 });
    assert.equal(none.nodes.length, 1, 'blocks under 8 lines are not copies');
  });

  test('tests finds test files that link into the set', () => {
    const s = grow(I, seed('web/src/cart.ts'), 'tests', { rank: 3 });
    assert.deepEqual(names(s.nodes), ['web/src/cart.test.ts', 'web/src/cart.ts']);
    const none = grow(I, seed('engine'), 'tests', { rank: 3 });
    assert.equal(none.nodes.length, 1);
  });

  test('inside turns folders into their parts at the detail', () => {
    const s = grow(I, seed('web/src/ui'), 'inside', { rank: 3 });
    assert.deepEqual(names(s.nodes), ['web/src/ui/render.ts', 'web/src/ui/widgets.ts']);
    const fns = grow(I, seed('web/src/ui/widgets.ts'), 'inside', { rank: 5 });
    assert.deepEqual(names(fns.nodes), ['web/src/ui/widgets.ts#makeBadge', 'web/src/ui/widgets.ts#makeSpinner']);
    const up = grow(I, seed('web/src/ui/widgets.ts#makeBadge'), 'parent', { rank: 5 });
    assert.deepEqual(names(up.nodes), ['web/src/ui/widgets.ts']);
  });

  test('boundary splits inside, uses outside, and used from outside', () => {
    const b = boundary(I, seed('web/src/cart.ts', 'web/src/checkout.ts'), 3);
    assert.deepEqual(b.inside.map((e) => [I.N[e.a].name, I.N[e.b].name]).sort(), [['cart.ts', 'checkout.ts'], ['checkout.ts', 'cart.ts']]);
    assert.deepEqual([...new Set(b.out.map((e) => I.N[e.b].name))].sort(), ['api.ts', 'utils.ts']);
    assert.ok(b.out.some((e) => I.N[e.b].name === 'api.ts') && b.out.some((e) => I.N[e.b].name === 'utils.ts'));
    assert.ok(b.in.some((e) => I.N[e.a].name === 'app.ts') && b.in.some((e) => I.N[e.a].name === 'cart.test.ts'));
    assert.ok(b.out.every((e) => e.kinds.every((k) => ['import', 'call', 'use', 'base'].includes(k))));
    const fn = boundary(I, seed('web/src/cart.ts#Cart.add'), 3);
    assert.ok(fn.out.some((e) => I.N[e.b].key === key('web/src/utils.ts')), 'outside ends lift to the detail');
  });

  test('reach measures hops both ways', () => {
    const r = reach(I, seed('web/src/cart.ts'), 3);
    assert.ok(r.self.has(id('web/src/cart.ts')));
    assert.equal(r.out.get(id('web/src/utils.ts')), 1);
    assert.equal(r.in.get(id('web/src/app.ts')), 1);
    assert.ok(r.out.has(id('web/src/checkout.ts')) && r.in.has(id('web/src/checkout.ts')), 'a loop is reached both ways');
    assert.equal(r.out.get(id('web/src/api.ts')), 2);
    assert.ok(reach(I, emptySet(), 3).empty);
  });

  test('fanin counts distinct parts that link in', () => {
    const f = fanin(I, 3);
    assert.ok(f.count[id('web/src/utils.ts')] >= 3, `${f.count[id('web/src/utils.ts')]}`);
    assert.equal(f.count[id('web/src/app.ts')], 0);
    assert.ok(f.scale >= 3);
  });

  test('parses queries, with help for bad input', () => {
    const q = parseQuery('in:web/src uses:Cart kind:func cx>10 age<30d staged reviewed:no checkout');
    assert.deepEqual(q.filters.map((f) => f.type), ['in', 'uses', 'kind', 'measure', 'measure', 'staged', 'reviewed']);
    assert.deepEqual(q.words, ['checkout']);
    assert.deepEqual(q.filters[3], { type: 'measure', name: 'cx', op: '>', value: 10 });
    assert.deepEqual(q.errors, []);
    assert.equal(parseQuery('>tidy').actions, true);
    assert.equal(parseQuery('>tidy').words[0], 'tidy');
    for (const bad of ['foo:bar', 'kind:blob', 'size>3', 'reviewed:maybe', 'in:', 'a=b']) assert.ok(parseQuery(bad).errors.length, bad);
  });

  test('matches every filter, combined with AND', () => {
    const run = (text, rank = 3) => names(matchQuery({ I, rank }, parseQuery(text)).map((x) => I.N[x].key));
    assert.deepEqual(run('in:web/src uses:Cart'), ['web/src/app.ts', 'web/src/cart.test.ts', 'web/src/checkout.ts', 'web/src/ui/render.ts']);
    assert.deepEqual(run('kind:func cx>10'), ['server/Orders/OrderService.cs#Shop.Orders.OrderService.Quote', 'web/src/checkout.ts#checkout']);
    assert.deepEqual(run('usedby:checkout kind:func'), ['web/src/api.ts#post', 'web/src/cart.ts#Cart.total', 'web/src/utils.ts#formatPrice']);
    assert.deepEqual(run('lang:go'), ['engine/pricing.go', 'engine/tax.go']);
    assert.deepEqual(run('lang:Rust'), ['core/src/lib.rs', 'core/src/money.rs']);
    assert.deepEqual(run('rule:loop'), ['web/src/cart.ts', 'web/src/checkout.ts']);
    assert.ok(run('rule:high').includes('web/src/api.ts'));
    assert.deepEqual(run('kind:dir in:server'), ['server', 'server/Data', 'server/Legacy', 'server/Orders', 'server/Payments']);
    assert.deepEqual(run('test:yes'), ['web/src/cart.test.ts']);
    assert.ok(run('lines>100').includes('server/Orders/OrderService.cs'));
    assert.ok(!run('lines>100').includes('web/src/api.ts'));
    assert.deepEqual(run('kind:func nest>4'), ['web/src/checkout.ts#checkout']);
    assert.deepEqual(run('kind:func args>5'), ['server/Orders/OrderService.cs#Shop.Orders.OrderService.Quote', 'web/src/checkout.ts#checkout']);
    assert.ok(run('churn>3').includes('server/Orders/OrderService.cs'));
    assert.ok(run('fanin>2').includes('web/src/utils.ts'));
    assert.equal(run('age<0').length, 0);
    assert.ok(run('reviewed:no').length === space.model.stats.files);
    assert.deepEqual(run('report'), ['tools/report.py', 'tools/report_copy.py']);
    assert.deepEqual(run('dirty'), []);
    assert.deepEqual(matchQuery({ I, rank: 3, stageIndex: new Map([[key('web/src/api.ts'), 'edit']]) }, parseQuery('staged')).map((x) => I.N[x].name), ['api.ts']);
    assert.deepEqual(run('gen:no in:engine'), ['engine/go.mod', 'engine/pricing.go', 'engine/tax.go']);
  });

  test('classifies every paint, and legend picks match classes', () => {
    const ctx = { I, rank: 3, stageIndex: new Map([[key('web/src/api.ts'), 'edit']]) };
    assert.equal(classify(ctx, 'lang', id('web/src/cart.ts')), 'lang:ts');
    assert.equal(classify(ctx, 'lang', id('web/src/cart.ts#Cart')), 'lang:ts/type');
    assert.equal(classify(ctx, 'lang', id('web/src')), 'dir');
    assert.ok(classMatches(classify(ctx, 'lang', id('web/src/cart.ts#Cart.pay')), { key: 'lang:ts' }));
    assert.ok(!classMatches('lang:tsx', { key: 'lang:ts' }));
    assert.ok(classMatches('rev:some', { keys: ['rev:none', 'rev:some'] }));
    assert.ok(classMatches('lang:py/func', { keys: ['lang:go', 'lang:py'] }));
    assert.ok(!classMatches('rev:ok', { keys: ['rev:none', 'rev:some'] }));
    assert.ok(!classMatches(3, { keys: ['sev:3'] }));
    assert.equal(classify(ctx, 'issues', id('web/src/api.ts')), 'sev:3');
    assert.equal(classify(ctx, 'review', id('web/src/api.ts')), 'rev:none');
    assert.equal(classify(ctx, 'stage', id('web/src/api.ts#post')), 'stage:edit');
    assert.equal(classify(ctx, 'stage', id('web/src/cart.ts')), 'stage:none');
    for (const p of ['lines', 'cx', 'churn', 'age', 'fanin']) assert.equal(typeof classify(ctx, p, id('web/src/checkout.ts#checkout')), 'number', p);
    assert.equal(classify(ctx, 'cx', id('web/src/cart.ts#Cart')), 'none');
    assert.ok(classify(ctx, 'cx', id('web/src/checkout.ts#checkout')) > 1);
    assert.ok(classMatches(0.5, { lo: 0.4, hi: 0.6 }) && !classMatches(0.7, { lo: 0.4, hi: 0.6 }));
    const r = reach(I, seed('web/src/cart.ts'), 3);
    const rc = { ...ctx, reach: r };
    assert.equal(classify(rc, 'reach', id('web/src/cart.ts')), 'reach:self');
    assert.equal(classify(rc, 'reach', id('web/src/cart.ts#Cart.add')), 'reach:self');
    assert.equal(classify(rc, 'reach', id('web/src/utils.ts')), 'reach:out1');
    assert.equal(classify(rc, 'reach', id('web/src/app.ts')), 'reach:in1');
    assert.equal(classify(rc, 'reach', id('web/src/checkout.ts')), 'reach:both');
    assert.equal(classify(rc, 'reach', id('web/src/api.ts')), 'reach:out2');
    assert.equal(classify(rc, 'reach', id('engine/tax.go')), 'reach:none');
    assert.equal(classify({ ...ctx, reach: reach(I, emptySet(), 3) }, 'reach', id('engine/tax.go')), 'reach:empty');
  });

  test('link members expand to raw links; sets clean and summarize', () => {
    const list = linkIndices(I, [key('web/src/checkout.ts'), key('web/src/cart.ts'), '*']);
    assert.ok(list.length >= 2);
    assert.ok(linkIndices(I, [key('web/src/checkout.ts'), key('web/src/cart.ts'), 'import']).length === 1);
    const s = { ...emptySet(), nodes: [key('web/src/cart.ts'), 'shop/gone.ts'], links: [[key('web/src/cart.ts'), key('web/src/checkout.ts'), 'import']], ranges: [[key('web/src/api.ts'), 4, 7]] };
    assert.equal(setSummary(s), '2 parts · 1 link · 1 line range');
    assert.deepEqual(cleanSet(I, s).nodes, [key('web/src/cart.ts')]);
    assert.ok(seedIds(I, s).includes(id('web/src/api.ts#fetchProducts')), 'a range seeds from the symbol that holds it');
  });

  test('replays recipes on a rebuilt model', async () => {
    const recipe = [{ query: 'in:web/src uses:Cart', rank: 3 }, { grow: 'out', depth: 1, rank: 3 }];
    const before = replay({ I, rank: 3 }, recipe);
    assert.ok(before.nodes.includes(key('web/src/utils.ts')));
    fs.writeFileSync(path.join(dir, 'web/src/shop.ts'), "import { Cart } from './cart';\nexport const shop = new Cart();\n");
    await space.scan();
    const I2 = index(space.model);
    const after = replay({ I: I2, rank: 3 }, recipe, { ...emptySet(), name: 'Users of Cart', id: 'x1' });
    assert.ok(after.nodes.includes(key('web/src/shop.ts')), 'new code joins a live set');
    assert.equal(after.name, 'Users of Cart');
    assert.deepEqual(after.recipe, recipe);
    const rule = replay({ I: I2, rank: 3 }, [{ rule: 'copy' }]);
    assert.ok(rule.nodes.length >= 2);
    const legend = replay({ I: I2, rank: 3 }, [{ legend: { paint: 'issues', key: 'sev:3' }, rank: 3 }]);
    assert.ok(legend.nodes.includes(key('web/src/api.ts')) && legend.nodes.every((k) => I2.N[I2.byKey.get(k)].kind === 'file'));
    const level = replay({ I: I2, rank: 3 }, [{ level: 0, rank: 3 }]);
    assert.ok(level.nodes.includes(key('web/src/utils.ts')));
    const staged = replay({ I: I2, rank: 3, stageIndex: new Map([[key('web/src/cart.ts'), 'edit']]) }, [{ staged: true }]);
    assert.deepEqual(staged.nodes, [key('web/src/cart.ts')]);
    const frozen = replay({ I: I2, rank: 3 }, null, { ...emptySet(), nodes: [key('web/src/cart.ts'), 'shop/gone.ts'] });
    assert.deepEqual(frozen.nodes, [key('web/src/cart.ts')], 'a set without a recipe drops missing keys');
    assert.equal(recipeName(recipe), 'find "in:web/src uses:Cart" + uses');
    assert.equal(recipeName([{ rule: 'copy' }], [{ id: 'copy', name: 'Copied code' }]), 'rule Copied code');
    assert.equal(recipeName([{ seed: [] }, { grow: 'out' }, { grow: 'out' }, { grow: 'in', depth: 2 }, { grow: 'path' }]), 'selection + uses ×2 + used by ×2 + path');
    assert.equal(recipeName([{ seed: [] }, { grow: 'out', depth: 'all' }, { grow: 'out' }]), 'selection + uses (all) + uses');
  });
});

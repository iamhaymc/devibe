// Browser tests for the devibe client. Each test drives the real UI with
// Playwright and saves a screenshot to test/shots/, so every view and feature can
// be seen as an image. Run: node --test test/client.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer, makeSample } from '../app/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const DESKTOP = { width: 1440, height: 900 };

for (const k of Object.keys(process.env)) if (k.startsWith('DEVIBE_')) delete process.env[k];

// A small OpenAI-compatible endpoint that streams scripted steps. `script`
// is a list of steps (one per turn since the last user message) or a
// function (request, turn) → step. Every request is kept in `seen`.
function mockModel(initial) {
  const llm = { script: initial, seen: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      llm.seen.push(data);
      const lastUser = data.messages.findLastIndex((m) => m.role === 'user');
      const turn = data.messages.slice(lastUser).filter((m) => m.role === 'assistant').length;
      const step = typeof llm.script === 'function' ? llm.script(data, turn) : llm.script[Math.min(turn, llm.script.length - 1)];
      const chunk = (delta, finish = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      if (!data.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: data.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (step.tools) {
        send(chunk({ role: 'assistant', tool_calls: step.tools.map((t, i) => ({ index: i, id: `call_${turn}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) }));
        send(chunk({}, 'tool_calls'));
      } else {
        send(chunk({ role: 'assistant', content: '' }));
        for (const piece of step.text.match(/.{1,16}/gs)) send(chunk({ content: piece }));
        send(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(Object.assign(llm, { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) }))));
}

const userText = (data) => { const m = data.messages.findLast((x) => x.role === 'user'); return typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(''); };
const toolNames = (data) => (data.tools ?? []).map((t) => t.function.name).sort();
const WRITE_TOOLS = ['write_file', 'edit_file', 'move_file', 'delete_file'];

let llm, app, browser, page, dir, home;
const errors = [];

async function idle(p = page) {
  await p.evaluate(() => window.devibe.idle());
  await p.waitForTimeout(150);
}

async function shot(name, p = page) {
  await idle(p);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const center = (key, p = page) => p.evaluate((k) => window.devibe.centerOf(k), key);
const state = (fn, p = page) => p.evaluate(fn);

async function launch() {
  return chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

async function newPage(options) {
  const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: 'dark', ...options });
  await context.addInitScript(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(app.url);
  return p;
}

describe('devibe client', () => {
  before(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    llm = await mockModel([
      { tools: [{ name: 'find_refs', args: { name: 'slugify' } }, { name: 'read_file', args: { path: 'web/src/utils.ts' } }] },
      { tools: [{ name: 'edit_file', args: { path: 'web/src/utils.ts', find: 'export function slugify', replace: 'export function makeSlug' } }] },
      { text: 'Renamed `slugify` to `makeSlug` in **web/src/utils.ts**.\n\n- The function had no callers, so no other files changed.\n- Behavior is the same.' },
    ]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devibe-ui-'));
    dir = await makeSample(path.join(root, 'acme-shop'));
    home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ endpoint: llm.url, model: 'mock/deepseek-v4.1-flash', apiKey: 'test-key', recent: [] }));
    app = await startServer({ port: 0, repos: [], home, watch: false, quiet: true });
    browser = await launch();
    page = await newPage({ viewport: DESKTOP });
  });

  after(async () => {
    await browser?.close();
    await app?.close();
    await llm?.close();
  });

  test('shows a welcome dialog when nothing is open', async () => {
    const box = page.locator('#open-box');
    await box.waitFor({ state: 'visible' });
    assert.match(await box.textContent(), /Open a folder to begin/);
    await shot('01-welcome');
  });

  test('opens a repo from the dialog and draws the map', async () => {
    await page.locator('#open-box input[type="text"]').fill(dir);
    await page.locator('#open-box input[type="text"]').press('Enter');
    await page.locator('#open-box .btn.primary').click();
    await page.waitForFunction(() => window.devibe.state.model?.stats.files > 20);
    await idle();
    const stats = await state(() => window.devibe.state.model.stats);
    assert.ok(stats.files >= 30 && stats.lines > 600);
    assert.match(await page.locator('#status').textContent(), /files/);
    await shot('02-map');
  });

  test('zooms into a folder with a double-click', async () => {
    const [x, y] = await center('acme-shop/server/Orders');
    await page.mouse.dblclick(x, y);
    await idle();
    assert.equal(await state(() => window.devibe.state.set.nodes[0]), 'acme-shop/server/Orders');
    await shot('03-folder');
  });

  test('reads code inside a file at high zoom', async () => {
    await page.evaluate(() => { const d = window.devibe; const id = d.state.T.byKey.get('acme-shop/web/src/checkout.ts#checkout'); d.hub.emit('pick.set', { ids: [id] }); d.flyTo(id, 0); });
    await idle();
    assert.ok(await state(() => window.devibe.state.texts.has('acme-shop/web/src/checkout.ts')));
    await shot('04-code');
  });

  test('selects a file and shows its links and details', async () => {
    await page.keyboard.press('f');
    await idle();
    const [x, y] = await center('acme-shop/web/src/cart.ts');
    await page.mouse.click(x, y);
    await page.locator('#info').waitFor({ state: 'visible' });
    assert.match(await page.locator('#info').textContent(), /Used by/);
    assert.ok(await state(() => window.devibe.state.linkList.length > 0));
    await shot('05-links');
  });

  test('finds files and symbols by name', async () => {
    await page.keyboard.press('/');
    await page.keyboard.type('order');
    await page.locator('#find-list').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#find-list .hit').count() > 5);
    await shot('06-find');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await idle();
    assert.ok((await state(() => window.devibe.state.set.nodes.length)) === 1);
  });

  test('searches file contents', async () => {
    await page.locator('#find-box').fill('TODO');
    await page.locator('#find-list .hit', { hasText: 'Search file contents' }).click();
    await page.waitForFunction(() => window.devibe.state.findHits?.hits.length > 0);
    await page.locator('#find-box').focus();
    await page.locator('#find-list').waitFor({ state: 'visible' });
    await shot('07-find-text');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  test('graph layout pulls linked files together', async () => {
    await page.keyboard.press('2');
    await idle();
    assert.equal(await state(() => window.devibe.state.lay.kind), 'graph');
    await shot('08-graph');
    await page.locator('#tools select').first().selectOption('type');
    await idle();
    assert.ok(await state(() => [...window.devibe.state.lay.rect.keys()].some((id) => window.devibe.state.T.N[id].kind === 'type')));
    await shot('09-graph-types');
    await page.locator('#tools select').first().selectOption('file');
  });

  test('layers layout stacks files by dependency', async () => {
    await page.keyboard.press('3');
    await idle();
    assert.ok(await state(() => window.devibe.state.lay.bands.length >= 3));
    await shot('10-layers');
  });

  test('city layout shows the map in 3D', async () => {
    await page.keyboard.press('4');
    await idle();
    assert.equal(await state(() => window.devibe.state.lay.kind), 'city');
    await shot('11-city');
    await page.keyboard.press('1');
    await idle();
  });

  test('colors the map by complexity, issues, and age', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#tools select').nth(1).selectOption('cx');
    await shot('12-complexity');
    await page.locator('#tools select').nth(1).selectOption('issues');
    await shot('13-issues');
    await page.locator('#tools select').nth(1).selectOption('age');
    await shot('14-age');
    await page.locator('#tools select').nth(1).selectOption('lang');
  });

  test('check panel spotlights a rule on the map', async () => {
    await page.locator('#dock .rule-row', { hasText: 'Copied code' }).click();
    await idle();
    assert.equal(await state(() => window.devibe.state.spot), 'copy');
    assert.ok(await page.locator('#dock .item').count() >= 2);
    await shot('15-check');
    await page.locator('#dock .item', { hasText: 'report_copy.py' }).first().click();
    await idle();
    await page.locator('#dock .rule-row', { hasText: 'Copied code' }).click();
  });

  test('marks code reviewed and shows progress', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    await idle();
    await page.keyboard.down('Shift');
    for (const key of ['acme-shop/server/Orders', 'acme-shop/server/Data', 'acme-shop/web/src/checkout.ts']) {
      const [x, y] = await center(key);
      await page.mouse.click(x, y);
    }
    await page.keyboard.up('Shift');
    assert.equal(await state(() => window.devibe.state.set.nodes.length), 3);
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.devibe.state.model.marks['acme-shop/web/src/checkout.ts'] === 'ok');
    await page.locator('#tools select').nth(1).selectOption('review');
    assert.doesNotMatch(await page.locator('#dock .section h3').first().textContent(), /\b0%/);
    await shot('16-review');
    await page.keyboard.press('Escape');
    await page.locator('#tools select').nth(1).selectOption('lang');
  });

  test('asks the agent and stages its edit', async () => {
    await page.evaluate(() => { const d = window.devibe; d.hub.emit('pick.set', { ids: [d.state.T.byKey.get('acme-shop/web/src/utils.ts#slugify')] }); d.flyTo(d.state.T.byKey.get('acme-shop/web/src/utils.ts'), 0); });
    await page.locator('#dock .seg button', { hasText: 'Change' }).click();
    await page.locator('#prompt').fill('Rename slugify to makeSlug');
    await page.locator('#dock .btn.primary', { hasText: 'Send' }).click();
    await page.waitForFunction(() => !window.devibe.state.agent.busy && window.devibe.state.stage.items.length === 1);
    assert.match(await page.locator('#dock .log').textContent(), /makeSlug/);
    assert.ok(!fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('makeSlug'), 'nothing written yet');
    await shot('17-agent');
  });

  test('shows a staged change as a diff', async () => {
    await page.locator('#dock .change').first().click();
    await page.locator('#code').waitFor({ state: 'visible' });
    await page.locator('#code tr.add').first().waitFor();
    assert.ok(await page.locator('#code tr.add').count() >= 1);
    await shot('18-diff');
    await page.locator('#code button[aria-label="Close the Code sheet"]').click();
  });

  test('previews staged changes on the map, applies, and undoes', async () => {
    await page.locator('#dock button', { hasText: 'Preview' }).click();
    await page.waitForFunction(() => window.devibe.state.model.preview);
    await page.locator('#tools select').nth(1).selectOption('stage');
    await idle();
    assert.ok(await state(() => window.devibe.state.T.byKey.has('acme-shop/web/src/utils.ts#makeSlug')));
    await shot('19-preview');
    await page.locator('#dock button', { hasText: 'Previewing' }).click();
    await page.locator('#dock .btn.primary', { hasText: 'Apply all' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 0 && window.devibe.state.stage.undo === 1);
    assert.ok(fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('makeSlug'));
    await page.locator('#dock button', { hasText: 'Undo last apply' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.undo === 0);
    assert.ok(!fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('makeSlug'));
    await page.locator('#tools select').nth(1).selectOption('lang');
  });

  test('renames a function everywhere with F2', async () => {
    await page.evaluate(() => { const d = window.devibe; const id = d.state.T.byKey.get('acme-shop/web/src/utils.ts#formatPrice'); d.hub.emit('pick.set', { ids: [id] }); d.flyTo(id, 0); });
    await idle();
    await page.keyboard.press('F2');
    await page.locator('#ask input').fill('formatMoney');
    await shot('20-rename');
    await page.locator('#ask input').press('Enter');
    await page.waitForFunction(() => window.devibe.state.stage.items.length >= 4);
    await page.locator('#dock button', { hasText: 'Discard all' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 0);
  });

  test('moves a file by dragging its grip onto a folder', async () => {
    await page.keyboard.press('f');
    await idle();
    await page.evaluate(() => { const d = window.devibe; const id = d.state.T.byKey.get('acme-shop/web/src/ui/widgets.ts'); d.hub.emit('pick.set', { ids: [id] }); d.flyTo(d.state.T.byKey.get('acme-shop/web/src'), 0); });
    await idle();
    const grip = await state(() => window.devibe.grip());
    assert.ok(grip, 'grip is visible');
    const [tx, ty] = await center('acme-shop/web/src');
    await page.mouse.move(grip.x + grip.w / 2, grip.y + grip.h / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty + 6, { steps: 12 });
    await page.mouse.up();
    await page.locator('#ask').waitFor({ state: 'visible' });
    assert.match(await page.locator('#ask').textContent(), /Move widgets\.ts into/);
    await shot('21-move');
    await page.locator('#ask button', { hasText: 'Move only' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 2);
    await page.locator('#dock button', { hasText: 'Discard all' }).click();
  });

  test('settings test the model connection', async () => {
    await page.locator('#tools button[aria-label="Settings"]').click();
    await page.locator('#setup-box').waitFor({ state: 'visible' });
    await page.locator('#setup-box button', { hasText: 'Test' }).click();
    await page.locator('#setup-box', { hasText: 'Connected' }).waitFor();
    await shot('22-settings');
    await page.locator('#setup-box button', { hasText: 'Cancel' }).click();
  });

  test('help lists keys and gestures', async () => {
    await page.keyboard.press('?');
    await page.locator('#keys-box').waitFor({ state: 'visible' });
    await shot('23-help');
    await page.locator('#keys-box button', { hasText: 'Done' }).click();
  });

  test('light theme', async () => {
    await page.evaluate(() => window.devibe.hub.emit('view.theme', 'light'));
    await page.keyboard.press('f');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.resolved), 'light');
    await shot('24-light');
    await page.evaluate(() => window.devibe.hub.emit('view.theme', 'dark'));
  });

  test('phone layout uses bottom sheets', async () => {
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.waitForFunction(() => window.devibe.state.model);
    await idle(phone);
    assert.ok(await phone.locator('#tabs').isVisible());
    await shot('25-phone-map', phone);
    await phone.locator('#tabs button', { hasText: 'Check' }).tap();
    await shot('26-phone-check', phone);
    await phone.locator('#tabs button', { hasText: 'Check' }).tap();
    const [x, y] = await center('acme-shop/web/src/checkout.ts', phone);
    await phone.touchscreen.tap(x, y);
    await phone.locator('#info').waitFor({ state: 'visible' });
    await shot('27-phone-info', phone);
    await phone.locator('#tabs button', { hasText: 'View' }).tap();
    await shot('28-phone-view', phone);
    await phone.context().close();
  });

  test('tablet layout', async () => {
    const tablet = await newPage({ viewport: { width: 1024, height: 1366 }, hasTouch: true });
    await tablet.waitForFunction(() => window.devibe.state.model);
    await idle(tablet);
    await shot('29-tablet', tablet);
    await tablet.context().close();
  });

  // ───── City 2.0, sets, and Act ─────

  const S0 = 'acme-shop/';
  const emit = (type, data, p = page) => p.evaluate(([t, d]) => window.devibe.hub.emit(t, d), [type, data]);
  const pickKeys = (keys, p = page) => p.evaluate((ks) => { const d = window.devibe; d.hub.emit('pick.set', { ids: ks.map((k) => d.state.T.byKey.get(k)) }); }, keys);
  const setOf = (p = page) => p.evaluate(() => JSON.parse(JSON.stringify(window.devibe.setOf())));
  const cityOf = (p = page) => p.evaluate(() => { const c = window.devibe.city; return { open: c.open, glass: c.glass, towers: c.towers, flat: c.flat, ghosts: c.ghosts, cut: c.cut, instances: c.instances }; });
  const reset = async () => {
    await page.evaluate(() => { const d = window.devibe; d.hub.emit('pick.clear'); d.hub.emit('set.isolate', false); d.hub.emit('check.spot', null); d.hub.emit('code.close'); });
    await page.locator('#find-box').fill('');
    await emit('find.query', '');
    await page.evaluate(() => document.activeElement?.blur());
  };
  // Run something that starts the agent, and wait until that run is done.
  const untilDone = async (fn) => {
    const n = await state(() => window.devibe.state.agent.done ?? 0);
    await fn();
    await page.waitForFunction((x) => (window.devibe.state.agent.done ?? 0) > x && !window.devibe.state.agent.busy, n, { timeout: 20000 });
  };
  const docScript = (data, turn) => {
    if (turn > 0) return { text: 'Documented.' };
    const m = /- file (acme-shop\/\S+) \(/.exec(userText(data));
    if (!m) return { text: 'Nothing to document.' };
    const rel = m[1].slice(S0.length);
    const first = fs.readFileSync(path.join(dir, rel), 'utf8').split('\n')[0];
    return { tools: [{ name: 'edit_file', args: { path: rel, find: first, replace: `// Documented.\n${first}` } }] };
  };

  test('city opens buildings as you zoom in', async () => {
    await reset();
    await page.keyboard.press('4');
    await idle();
    await page.evaluate(() => { const d = window.devibe; d.flyTo(d.state.T.byKey.get('acme-shop/web/src/checkout.ts'), 0); });
    await idle();
    const c = await cityOf();
    assert.ok(c.open.includes(`${S0}web/src/checkout.ts`), JSON.stringify(c));
    assert.ok(c.glass.includes(`${S0}web/src/checkout.ts`), 'an open building has a glass shell');
    assert.ok(c.towers > 0);
    await shot('30-city-open');
  });

  test('city reading pose puts code on the roofs, and picks lines', async () => {
    await page.evaluate(() => { const d = window.devibe; const id = d.state.T.byKey.get('acme-shop/web/src/checkout.ts#checkout'); d.hub.emit('pick.set', { ids: [id] }); d.flyTo(id, 0); });
    await idle();
    await page.waitForTimeout(400);
    await idle();
    const c = await cityOf();
    assert.equal(c.flat, `${S0}web/src/checkout.ts`);
    assert.ok(Math.abs(await state(() => window.devibe.R.pitch) - 0.6) < 0.02);
    const p = await page.evaluate(() => window.devibe.linePoint('acme-shop/web/src/checkout.ts', 20));
    const hit = await page.evaluate(([x, y]) => { const d = window.devibe; const h = d.pickAt(x, y); return h && { key: d.state.T.N[h.id]?.key, line: h.line }; }, p);
    assert.deepEqual(hit, { key: `${S0}web/src/checkout.ts#checkout`, line: 20 });
    await shot('31-city-read');
  });

  test('city orbits around the view center and still picks roofs', async () => {
    const v = await page.evaluate(() => window.devibe.viewport());
    const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    const yaw0 = await state(() => window.devibe.R.yaw);
    await page.mouse.move(cx, cy);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move(cx + 110, cy - 15, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await idle();
    const after = await state(() => { const d = window.devibe; const p = d.R.pivot; return { yaw: d.R.yaw, at: d.toScreen(p[0], p[1], p[2]) }; });
    assert.ok(Math.abs(after.yaw - yaw0) > 0.5, `yaw ${yaw0} → ${after.yaw}`);
    assert.ok(Math.hypot(after.at[0] - cx, after.at[1] - cy) < 3, `pivot on screen at ${after.at}`);
    const c = await center(`${S0}web/src/checkout.ts#checkout`);
    const hit = await page.evaluate(([x, y]) => { const d = window.devibe; const h = d.pickAt(x, y); return h && { key: d.state.T.N[h.id]?.key, face: h.face }; }, c);
    assert.deepEqual(hit, { key: `${S0}web/src/checkout.ts#checkout`, face: 'top' });
    await shot('32-city-orbit');
  });

  test('city links run between towers, with arrowheads and set colors', async () => {
    await emit('view.angle', 'tilt');
    await emit('view.detail', 'func');
    await pickKeys([`${S0}web/src/checkout.ts#checkout`, `${S0}web/src/cart.ts#Cart.total`]);
    await page.keyboard.press('f');
    await idle();
    const links = await state(() => window.devibe.state.linkList.map((e) => ({ dir: e.dir, a: window.devibe.state.T.N[e.a].key, b: window.devibe.state.T.N[e.b].key, z: e.pts?.[2] ?? 0 })));
    assert.ok(links.some((e) => e.dir === 'inside' && e.a.endsWith('#checkout') && e.b.endsWith('#Cart.total')), JSON.stringify(links));
    assert.ok(links.some((e) => e.dir === 'out' && e.a.endsWith('#checkout') && e.b.includes('#')), 'function-level ends');
    assert.ok(links.some((e) => e.dir === 'in'));
    assert.ok(links.every((e) => e.z > 0), 'anchored on roofs');
    await shot('33-city-links');
    await emit('view.detail', 'file');
  });

  test('clicking a link in Map selects it and lists where it happens', async () => {
    await reset();
    await page.keyboard.press('1');
    await idle();
    await page.keyboard.press('f');
    await idle();
    const c = await center(`${S0}web/src/cart.ts`);
    await page.mouse.click(c[0], c[1]);
    await idle();
    const pt = await page.evaluate(() => {
      const d = window.devibe;
      const pts = d.linkPoints('acme-shop/web/src/cart.ts', 'acme-shop/web/src/checkout.ts');
      const ends = (e) => [d.state.T.N[e.a].name, d.state.T.N[e.b].name].sort().join();
      for (const [x, y] of pts ?? []) { const h = d.pickAt(x, y); if (h?.link && ends(h.link) === 'cart.ts,checkout.ts') return [x, y]; }
      return null;
    });
    assert.ok(pt, 'a clickable point on the link');
    await page.mouse.click(pt[0], pt[1]);
    await page.waitForFunction(() => window.devibe.state.set.links.length === 1 && !window.devibe.state.set.nodes.length);
    assert.deepEqual((await setOf()).links[0].slice(0, 2).sort(), [`${S0}web/src/cart.ts`, `${S0}web/src/checkout.ts`]);
    await page.locator('#info .site').first().waitFor();
    assert.match(await page.locator('#info').textContent(), /(cart|checkout)\.ts:1[^0-9][\s\S]*(cart\.ts:28|checkout\.ts:6)/);
    await shot('34-link-select');
  });

  test('grow adds what the set uses, hop by hop, and finds paths', async () => {
    await pickKeys([`${S0}web/src/app.ts`]);
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await idle();
    const s = await setOf();
    assert.equal(s.hops[`${S0}web/src/cart.ts`], 1);
    assert.equal(s.hops[`${S0}web/src/checkout.ts`], 2);
    assert.match(await page.locator('#info').textContent(), /\+2/);
    assert.match(await page.locator('#info .live').textContent(), /uses/);
    await shot('35-grow');
    await pickKeys([`${S0}web/src/app.ts`, `${S0}web/src/checkout.ts`]);
    await emit('set.grow', { op: 'path' });
    const p = await setOf();
    assert.ok(p.nodes.includes(`${S0}web/src/cart.ts`) && p.links.some((l) => l[0] === `${S0}web/src/app.ts` && l[1] === `${S0}web/src/cart.ts`));
  });

  test('a legend color selects that group at the current detail', async () => {
    await reset();
    await page.locator('#tools select').nth(1).selectOption('issues');
    await page.locator('#legend button.key', { hasText: 'High' }).click();
    const want = await state(() => { const T = window.devibe.state.T; return T.N.filter((n) => n.kind === 'file' && T.sev[n.id] === 3).map((n) => n.key).sort(); });
    const s = await setOf();
    assert.deepEqual([...s.nodes].sort(), want);
    assert.ok(want.length >= 2);
    assert.equal(s.recipe[0].legend.key, 'sev:3');
    await shot('36-legend-select');
    await page.locator('#tools select').nth(1).selectOption('lang');
  });

  test('find runs queries, selects all with Alt+Enter, and lists actions after >', async () => {
    await reset();
    await page.keyboard.press('/');
    await page.keyboard.type('kind:func cx>10');
    await page.locator('#find-list').waitFor({ state: 'visible' });
    assert.match(await page.locator('#find-list').textContent(), /2 parts match/);
    await shot('37-find-query');
    await page.keyboard.press('Alt+Enter');
    const s = await setOf();
    assert.deepEqual([...s.nodes].sort(), [`${S0}server/Orders/OrderService.cs#Shop.Orders.OrderService.Quote`, `${S0}web/src/checkout.ts#checkout`]);
    assert.equal(s.recipe[0].query, 'kind:func cx>10');
    await page.keyboard.press('a');
    await page.locator('#find-list .hit', { hasText: 'Explain' }).first().waitFor();
    const list = await page.locator('#find-list').textContent();
    assert.match(list, /Decouple.*Needs a selected link/);
    await page.keyboard.press('Escape');
  });

  test('Explain from the Act bar runs read-only', async () => {
    await reset();
    llm.script = [{ text: 'It draws the product list and the cart summary.' }];
    llm.seen.length = 0;
    await pickKeys([`${S0}web/src/ui/render.ts`]);
    await untilDone(() => page.locator('#act button[data-act="explain"]').click());
    const req = llm.seen.at(-1);
    assert.ok(!toolNames(req).some((t) => WRITE_TOOLS.includes(t)), toolNames(req).join());
    assert.ok(toolNames(req).includes('show_links'));
    assert.match(userText(req), /^Explain what the selection does[\s\S]*Selection \(1 part\):/);
    await page.locator('#dock .msg.agent', { hasText: 'product list' }).waitFor();
    await shot('38-act-explain');
  });

  test('one by one runs an action per item and stages each result', async () => {
    llm.script = docScript;
    llm.seen.length = 0;
    await pickKeys([`${S0}web/src/utils.ts`, `${S0}web/src/api.ts`, `${S0}web/src/ui/widgets.ts`]);
    await page.locator('#act .act-mode').click();
    assert.equal(await state(() => window.devibe.state.mode), 'each');
    await page.keyboard.press('a');
    await page.keyboard.type('Document');
    await untilDone(() => page.keyboard.press('Enter'));
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 3);
    assert.equal(await page.locator('#dock .batch-item.staged').count(), 3);
    assert.match(await page.locator('#dock .batch-head').last().textContent(), /Document · one by one · 3 of 3/);
    assert.equal(llm.seen.filter((r) => r.messages.filter((m) => m.role === 'user').length === 1).length, llm.seen.length, 'fresh history per item');
    await shot('39-act-each');
    await page.locator('#act .act-mode').click();
    await page.locator('#dock button', { hasText: 'Discard all' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 0);
  });

  test('the Code sheet edits a range in place, then reverts a hunk', async () => {
    await reset();
    await pickKeys([`${S0}web/src/utils.ts#clamp`]);
    await page.keyboard.press('Shift+Enter');
    await page.locator('#code').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#code tr.hl').count(), 3);
    await page.locator('#code button', { hasText: 'Edit 13–15' }).click();
    const area = page.locator('#code textarea.code-edit');
    await area.fill('export function clamp(n: number, lo = 0, hi = 1): number {\n  return Math.max(lo, Math.min(hi, n));\n}');
    await area.press('Control+s');
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 1);
    assert.ok(!fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('lo = 0'), 'staged, not written');
    await page.locator('#code .tabs-code button', { hasText: 'Diff' }).click();
    await page.locator('#code tr.add').first().waitFor();
    await shot('40-code-edit');
    await page.locator('#code button', { hasText: 'Revert' }).first().click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 0);
    await emit('code.close');
  });

  test('preview keeps the layout still, shows deleted files, and morphs the city', async () => {
    await reset();
    await page.evaluate(async () => {
      const d = window.devibe;
      await d.wire.ask('stage.delete', { keys: ['acme-shop/web/src/ui/widgets.ts'] });
      await d.wire.ask('stage.edit', { key: 'acme-shop/web/src/checkout.ts', from: 9, to: 27, text: '  // Coupons moved to the server.' });
    });
    await page.keyboard.press('1');
    await idle();
    const rectOf = (key) => page.evaluate((k) => { const d = window.devibe; const r = d.state.lay.rect.get(d.state.T.byKey.get(k)); return r && [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 1000) / 1000); }, key);
    const before = await rectOf(`${S0}web/src/cart.ts`);
    await page.evaluate(() => window.devibe.wire.ask('stage.preview', { on: true }));
    await page.waitForFunction(() => window.devibe.state.model.preview);
    await idle();
    assert.deepEqual(await rectOf(`${S0}web/src/cart.ts`), before, 'nothing moves');
    assert.ok(await state(() => window.devibe.state.lay.ghosts.some((g) => g.key === 'acme-shop/web/src/ui/widgets.ts' && g.ghost === 'gone')));
    await page.keyboard.press('4');
    await idle();
    const high = await state(() => window.devibe.city.heightOf('acme-shop/web/src/checkout.ts'));
    assert.ok((await cityOf()).ghosts > 0, 'the deleted file is a ghost');
    await shot('41-city-preview');
    await page.evaluate(() => window.devibe.wire.ask('stage.preview', { on: false }));
    await page.waitForFunction(() => !window.devibe.state.model.preview);
    await idle();
    const full = await state(() => window.devibe.city.heightOf('acme-shop/web/src/checkout.ts'));
    assert.ok(full > high, `the shorter file stands lower in preview: ${high} < ${full}`);
    await page.evaluate(() => window.devibe.wire.ask('stage.discard', {}));
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 0);
    await idle();
  });

  test('city drags move files into folders and towers into files', async () => {
    await reset();
    await pickKeys([`${S0}web/src/ui/widgets.ts`]);
    await page.evaluate(() => { const d = window.devibe; d.flyTo(d.state.T.byKey.get('acme-shop/web/src'), 0); });
    await idle();
    let grip = await state(() => window.devibe.grip());
    assert.ok(grip, 'a file shows a grip on its sign');
    let [tx, ty] = await center(`${S0}web/src/cart.ts`);
    await page.mouse.move(grip.x + grip.w / 2, grip.y + grip.h / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 12 });
    await page.mouse.up();
    await page.locator('#ask').waitFor({ state: 'visible' });
    assert.match(await page.locator('#ask').textContent(), /Move widgets\.ts into web\/src\//);
    await page.locator('#ask button', { hasText: 'Cancel' }).click();
    await pickKeys([`${S0}web/src/utils.ts#clamp`]);
    await page.evaluate(() => { const d = window.devibe; d.flyTo(d.state.T.byKey.get('acme-shop/web/src/utils.ts'), 0); });
    await idle();
    grip = await state(() => window.devibe.grip());
    assert.ok(grip, 'a tower shows a grip on its roof');
    const v = await page.evaluate(() => window.devibe.viewport());
    let target = null;
    for (const key of ['web/src/api.ts', 'web/src/utils_v2.ts', 'web/src/cart.test.ts', 'web/src/app.ts', 'web/src/cart.ts']) {
      const c = await center(S0 + key);
      if (c && c[0] > v.x + 10 && c[0] < v.x + v.w - 10 && c[1] > v.y + 10 && c[1] < v.y + v.h - 10) { target = [key, c]; break; }
    }
    assert.ok(target, 'another file is on screen');
    [tx, ty] = target[1];
    await page.mouse.move(grip.x + grip.w / 2, grip.y + grip.h / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 12 });
    await page.mouse.up();
    await page.locator('#ask').waitFor({ state: 'visible' });
    assert.match(await page.locator('#ask').textContent(), new RegExp(`Move clamp\\(\\) from utils\\.ts to ${path.basename(target[0]).replace('.', '\\.')}`));
    await shot('42-city-move');
    await page.locator('#ask button', { hasText: 'Move only' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 2);
    await page.evaluate(() => window.devibe.wire.ask('stage.discard', {}));
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 0);
  });

  test('isolate ghosts the rest of the city; cutaway clears the view to a member', async () => {
    await reset();
    await emit('view.angle', 'low');
    await idle();
    await page.keyboard.press('f');
    await idle();
    let found = null;
    const files = await state(() => window.devibe.state.T.N.filter((n) => n.kind === 'file').map((n) => n.key));
    for (const key of files) {
      await pickKeys([key]);
      await idle();
      if ((await cityOf()).cut > 0) { found = key; break; }
    }
    assert.ok(found, 'some member is hidden behind a building, and cutaway clears it');
    const plain = (await cityOf()).ghosts;
    await page.keyboard.press('i');
    await idle();
    assert.ok((await cityOf()).ghosts > plain + 5, 'isolate ghosts everything outside the set');
    await shot('43-isolate');
    await page.keyboard.press('i');
    await emit('view.angle', 'tilt');
    await reset();
    await page.keyboard.press('1');
    await idle();
  });

  test('phone shows the Act bar and the Selection sheet', async () => {
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.waitForFunction(() => window.devibe.state.model);
    await idle(phone);
    const [x, y] = await center(`${S0}web/src/cart.ts`, phone);
    await phone.touchscreen.tap(x, y);
    await phone.locator('#act').waitFor({ state: 'visible' });
    await phone.locator('#info').waitFor({ state: 'visible' });
    assert.ok(await phone.locator('#act button[data-act="explain"]').isVisible());
    await shot('44-phone-act', phone);
    await phone.context().close();
  });

  // ───── Acceptance: the seven workflows, end to end ─────

  test('workflows W1–W7', async () => {
    const stageCount = () => state(() => window.devibe.state.stage.items.length);
    const openDock = async (which) => { await emit('dock.show', which); await idle(); };
    const clean = async () => {
      await page.evaluate(async () => { const d = window.devibe; if (d.state.model.preview) await d.wire.ask('stage.preview', { on: false }); await d.wire.ask('stage.discard', {}); });
      await page.waitForFunction(() => window.devibe.state.stage.items.length === 0 && !window.devibe.state.model.preview);
      await reset();
      await idle();
    };
    const lastAsk = () => userText(llm.seen.at(-1));

    // W1: what breaks if I change Cart.total? Reach → Used by within 2 hops → Add tests.
    await clean();
    await page.keyboard.press('1');
    await idle();
    await pickKeys([`${S0}web/src/cart.ts#Cart.total`]);
    await page.locator('#tools select').nth(1).selectOption('reach');
    await page.locator('#legend button[data-key="reach:in2"]').click();
    let s = await setOf();
    assert.ok(s.nodes.includes(`${S0}web/src/cart.ts#Cart.total`) && s.nodes.includes(`${S0}web/src/checkout.ts`) && s.nodes.includes(`${S0}web/src/app.ts`), JSON.stringify(s.nodes));
    assert.ok(Object.values(s.hops).includes(2));
    llm.script = [{ text: 'Tests would cover checkout and the app.' }];
    llm.seen.length = 0;
    await untilDone(() => page.locator('#act button[data-act="tests"]').click());
    assert.match(lastAsk(), /^Add focused unit tests[\s\S]*Selection \(\d+ parts\)/);
    await page.locator('#tools select').nth(1).selectOption('lang');

    // W2: clean up the checkout flow: query → Select all → City → isolate →
    // Tidy one by one → Preview → Code sheet diff → Apply.
    await clean();
    await page.keyboard.press('/');
    await page.keyboard.type('in:web/src uses:Cart');
    await page.keyboard.press('Alt+Enter');
    s = await setOf();
    assert.equal(s.nodes.length, 4);
    await page.keyboard.press('4');
    await idle();
    await page.keyboard.press('i');
    assert.ok(await state(() => window.devibe.state.isolate));
    llm.script = docScript;
    llm.seen.length = 0;
    await emit('act.mode', 'each');
    await untilDone(() => page.locator('#act button[data-act="tidy"]').click());
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 4);
    assert.equal(new Set(llm.seen.map(userText).filter((t) => /^Tidy the selection/.test(t))).size, 4, 'one run per member');
    await emit('act.mode', 'together');
    await openDock('change');
    await page.locator('#dock button', { hasText: 'Preview' }).click();
    await page.waitForFunction(() => window.devibe.state.model.preview);
    await idle();
    await page.locator('#dock .change').first().click();
    await page.locator('#code tr.add').first().waitFor();
    await page.locator('#code button', { hasText: 'Apply' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 3);
    s = await setOf();
    assert.equal(s.nodes.length, 4, 'the live set survives the rescan');
    await page.evaluate(() => window.devibe.wire.ask('stage.undo'));
    await clean();
    await page.keyboard.press('1');
    await idle();

    // W3: why do two folders depend on each other? Folder loops → Select all →
    // Interface → the bundle → Decouple.
    await openDock('check');
    await page.locator('#dock .rule-row', { hasText: 'Folder loops' }).click();
    await page.locator('#dock .rule button', { hasText: 'Select all' }).click();
    s = await setOf();
    assert.deepEqual([...s.nodes].sort(), [`${S0}server/Orders`, `${S0}server/Payments`]);
    await page.locator('#info .ref', { hasText: 'Orders → Payments' }).first().click();
    s = await setOf();
    assert.deepEqual(s.links, [[`${S0}server/Orders`, `${S0}server/Payments`, '*']]);
    llm.script = [{ text: 'Pass the gateway in.' }];
    llm.seen.length = 0;
    await untilDone(() => page.locator('#act button[data-act="decouple"]').click());
    assert.match(lastAsk(), /^Remove the dependency[\s\S]*- link: server\/Orders\/ → server\/Payments\/ \(/);
    await emit('check.spot', null);

    // W4: read and fix the most complex function in 3D: Height Complexity →
    // double-click the tallest tower → lines 40–55 → Tidy → Preview drops it.
    await clean();
    await page.keyboard.press('4');
    await emit('view.height', 'cx');
    await page.evaluate(() => { const d = window.devibe; d.flyTo(d.state.T.byKey.get('acme-shop/web/src/checkout.ts'), 0); });
    await idle();
    const tallest = await state(() => {
      const d = window.devibe;
      const funcs = d.state.T.N.filter((n) => n.kind === 'func' && d.city.open.includes(d.state.T.N[d.state.T.fileOf[n.id]].key));
      const hs = funcs.map((n) => [d.city.heightOf(n.key) ?? 0, n.key]);
      const top = Math.max(...hs.map((x) => x[0]));
      return hs.filter((x) => x[0] >= top - 1e-6).map((x) => x[1]);
    });
    assert.ok(tallest.includes(`${S0}web/src/checkout.ts#checkout`), `tallest: ${tallest}`);
    const before = await state(() => window.devibe.city.heightOf('acme-shop/web/src/checkout.ts#checkout'));
    const [tx, ty] = await center(`${S0}web/src/checkout.ts#checkout`);
    await page.mouse.dblclick(tx, ty);
    await idle();
    await page.waitForTimeout(400);
    await idle();
    assert.equal((await cityOf()).flat, `${S0}web/src/checkout.ts`, 'reading pose');
    const a = await page.evaluate(() => window.devibe.linePoint('acme-shop/web/src/checkout.ts', 40, 4));
    const b = await page.evaluate(() => window.devibe.linePoint('acme-shop/web/src/checkout.ts', 55, 4));
    await page.keyboard.down('Shift');
    await page.mouse.move(a[0], a[1]);
    await page.mouse.down();
    await page.mouse.move(b[0], b[1], { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    s = await setOf();
    assert.deepEqual(s.ranges, [[`${S0}web/src/checkout.ts`, 40, 55]]);
    const lines = fs.readFileSync(path.join(dir, 'web/src/checkout.ts'), 'utf8').split('\n');
    const tidy = "  total = applyRules(cart, total, { coupon, region, rush, gift });\n  const res = await post('/api/checkout', { card, total });\n  if (!res.ok) throw new Error('Checkout failed');";
    llm.script = (data, turn) => (turn ? { text: 'Moved the pricing rules out and simplified the error handling.' } : { tools: [{ name: 'edit_file', args: { path: 'web/src/checkout.ts', find: lines.slice(8, 58).join('\n'), replace: tidy } }] });
    await untilDone(() => page.locator('#act button[data-act="tidy"]').click());
    assert.equal(await stageCount(), 1);
    assert.match(lastAsk(), /- lines acme-shop\/web\/src\/checkout\.ts:40-55/);
    await page.evaluate(() => window.devibe.wire.ask('stage.preview', { on: true }));
    await page.waitForFunction(() => window.devibe.state.model.preview);
    await idle();
    await page.waitForTimeout(500);
    await idle();
    const after = await state(() => window.devibe.city.heightOf('acme-shop/web/src/checkout.ts#checkout'));
    assert.ok(after < before, `the tower drops: ${before} → ${after}`);
    await emit('view.height', 'same');
    await clean();

    // W5: move a function where it belongs, in Map: drag its grip onto a file → Move + fix.
    await page.keyboard.press('1');
    await idle();
    await pickKeys([`${S0}web/src/utils.ts#slugify`]);
    await page.evaluate(() => { const d = window.devibe; d.flyTo(d.state.T.byKey.get('acme-shop/web/src'), 0); });
    await idle();
    const grip = await state(() => window.devibe.grip());
    assert.ok(grip, 'the function shows a grip');
    const [wx, wy] = await center(`${S0}web/src/ui/widgets.ts`);
    llm.script = [{ text: 'Updated the imports.' }];
    llm.seen.length = 0;
    await page.mouse.move(grip.x + grip.w / 2, grip.y + grip.h / 2);
    await page.mouse.down();
    await page.mouse.move(wx, wy + 20, { steps: 10 });
    await page.mouse.up();
    await page.locator('#ask').waitFor({ state: 'visible' });
    assert.match(await page.locator('#ask').textContent(), /Move slugify\(\) from utils\.ts to widgets\.ts/);
    await untilDone(() => page.locator('#ask button', { hasText: 'Move + fix' }).click());
    assert.equal(await stageCount(), 2);
    assert.match(lastAsk(), /I moved slugify from acme-shop\/web\/src\/utils\.ts to acme-shop\/web\/src\/ui\/widgets\.ts/);
    assert.match(lastAsk(), /Selection \(2 parts\)/);
    await clean();

    // W6: merge copies: Copied code → a copy link → Merge copies.
    await page.keyboard.press('f');
    await idle();
    await openDock('check');
    await page.locator('#dock .rule-row', { hasText: 'Copied code' }).click();
    await page.locator('#dock .item', { hasText: 'report_copy.py' }).first().click();
    await idle();
    const copy = await page.evaluate(() => {
      const d = window.devibe;
      for (const e of d.state.linkList) {
        if (!e.kinds.has('copy') || !e.pts) continue;
        const pts = d.linkPoints(d.state.T.N[e.a].key, d.state.T.N[e.b].key) ?? [];
        for (const [x, y] of pts) { const h = d.pickAt(x, y); if (h?.link?.kinds.has('copy')) return [x, y]; }
      }
      return null;
    });
    assert.ok(copy, 'a copy link to click');
    await page.mouse.click(copy[0], copy[1]);
    await page.waitForFunction(() => window.devibe.state.set.links.length === 1);
    llm.script = [{ text: 'Merged into one report module.' }];
    llm.seen.length = 0;
    await untilDone(() => page.locator('#act button[data-act="merge"]').click());
    assert.match(lastAsk(), /^The selected places hold copied code[\s\S]*- link: .*report.* ↔ .*report_copy/);
    await emit('check.spot', null);
    await clean();

    // W7: review what changed as a group: Select changed → Explain → Code
    // sheet → revert one hunk → Apply.
    await page.evaluate(async () => {
      const d = window.devibe;
      await d.wire.ask('stage.edit', { key: 'acme-shop/web/src/utils.ts', from: 1, to: 1, text: 'export function formatPrice(value: number, sign = "$"): string {' });
      await d.wire.ask('stage.edit', { key: 'acme-shop/web/src/utils.ts', from: 13, to: 13, text: 'export function clamp(n: number, lo = 0, hi = 1): number {' });
      await d.wire.ask('stage.edit', { key: 'acme-shop/web/src/api.ts', from: 1, to: 1, text: "const BASE = '/api/v2';" });
    });
    await openDock('change');
    await page.locator('#dock button', { hasText: 'Select changed' }).click();
    s = await setOf();
    assert.deepEqual([...s.nodes].sort(), [`${S0}web/src/api.ts`, `${S0}web/src/utils.ts`]);
    assert.deepEqual(s.recipe, [{ staged: true }]);
    llm.script = [{ text: 'Two small API changes.' }];
    llm.seen.length = 0;
    await untilDone(() => page.locator('#act button[data-act="explain"]').click());
    assert.ok(!toolNames(llm.seen.at(-1)).some((t) => WRITE_TOOLS.includes(t)));
    await page.locator('#dock .change', { hasText: 'utils.ts' }).click();
    await page.locator('#code tr.add').first().waitFor();
    assert.equal(await page.locator('#code button', { hasText: 'Revert' }).count(), 2);
    await page.locator('#code button', { hasText: 'Revert' }).first().click();
    await page.waitForFunction(() => window.devibe.state.stage.items.find((it) => it.key === 'acme-shop/web/src/utils.ts')?.adds === 1);
    await page.locator('#code button', { hasText: 'Revert' }).first().waitFor();
    await page.locator('#code button.primary', { hasText: 'Apply' }).click();
    await page.waitForFunction(() => window.devibe.state.stage.items.length === 1);
    const utils = fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8');
    assert.ok(utils.includes('lo = 0') && !utils.includes('sign = "$"'), 'only the kept hunk was applied');
    await page.evaluate(() => window.devibe.wire.ask('stage.undo'));
    await page.waitForTimeout(300);
    await clean();
    assert.ok(!fs.readFileSync(path.join(dir, 'web/src/utils.ts'), 'utf8').includes('lo = 0'), 'undone');
  });

  test('no script errors', () => {
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
  });
});

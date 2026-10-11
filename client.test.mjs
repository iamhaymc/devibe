// Browser tests for the devibe client. Each test drives the real UI with
// Playwright and saves a screenshot to shots/, so every view and feature can
// be seen as an image. Run: node --test client.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer, makeSample } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const DESKTOP = { width: 1440, height: 900 };

for (const k of Object.keys(process.env)) if (k.startsWith('DEVIBE_')) delete process.env[k];

// A small OpenAI-compatible endpoint that streams scripted steps.
function mockModel(script) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      const lastUser = data.messages.findLastIndex((m) => m.role === 'user');
      const turn = data.messages.slice(lastUser).filter((m) => m.role === 'assistant').length;
      const step = script[Math.min(turn, script.length - 1)];
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) })));
}

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

  test('no script errors', () => {
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
  });
});

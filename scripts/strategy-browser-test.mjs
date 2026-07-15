import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const screenshotDir = process.env.BROWSER_SCREENSHOT_DIR;
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

const externalUrl = process.env.BROWSER_TEST_URL;
const expectSingleFile = process.env.BROWSER_EXPECT_SINGLE_FILE === '1';
const server = externalUrl
  ? null
  : await createServer({
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 4173,
      },
    });

let browser;

try {
  await server?.listen();
  const url = externalUrl ?? server?.resolvedUrls?.local[0];
  assert.ok(url, 'Vite did not expose a local test URL');

  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${String(error)}`));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#cm-strategy-new').click();

  const textState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.ok(textState.commander?.id, 'strategic text state must expose the commander identity');
  assert.equal(textState.commander.alive, true, 'new strategic commander must begin alive');

  const screen = page.locator('.strategic-screen');
  await screen.waitFor({ state: 'visible' });
  const before = await screen.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
  }));

  assert.equal(before.clientHeight, 720, 'strategic screen must be bounded to the viewport height');
  assert.ok(before.scrollHeight > before.clientHeight, 'strategic screen must contain vertically scrollable content');
  assert.equal(before.scrollTop, 0, 'strategic screen must start at the top');
  assert.equal(before.overflowY, 'auto', 'strategic screen must own vertical scrolling');

  await screen.hover();
  await page.mouse.wheel(0, before.scrollHeight);
  await page.waitForFunction(() => {
    const element = document.querySelector('.strategic-screen');
    return element instanceof HTMLElement && element.scrollTop > 0;
  });

  const after = await screen.evaluate((element) => ({
    scrollTop: element.scrollTop,
    maxScroll: element.scrollHeight - element.clientHeight,
  }));
  const managementVisible = await page.locator('.strategic-management').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });

  assert.ok(after.scrollTop > 0, 'mouse wheel must move the strategic scroll container');
  assert.ok(after.scrollTop <= after.maxScroll, 'strategic scroll position must remain within bounds');
  assert.equal(managementVisible, true, 'lower strategic management content must become visible after scrolling');
  await page.locator('.strategic-commander').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.strategic-commander').isVisible(), true, 'commander card must be reachable in the management area');
  assert.ok((await page.locator('.strategic-commander').innerText()).includes(textState.commander.name), 'commander UI and text state must agree');
  assert.deepEqual(errors, [], `browser console must stay clean:\n${errors.join('\n')}`);

  console.log(
    `[PASS] strategic browser scroll: viewport=${before.clientHeight}, content=${before.scrollHeight}, scrollTop=${after.scrollTop}`,
  );

  const battlePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const battleErrors = [];
  const loadedResources = [];
  battlePage.on('console', (message) => {
    if (message.type() === 'error') battleErrors.push(`console: ${message.text()}`);
  });
  battlePage.on('pageerror', (error) => battleErrors.push(`page: ${String(error)}`));
  battlePage.on('requestfinished', (request) => loadedResources.push(request.url()));

  await battlePage.goto(url, { waitUntil: 'networkidle' });
  await battlePage.locator('#cm-single').click();
  if (!externalUrl) {
    assert.equal(
      loadedResources.some((resource) => resource.includes('/src/render/threeScene.ts') || resource.includes('/src/render/shipPreview.ts')),
      false,
      'setup screen must not eagerly load Three.js render entry modules',
    );
  }

  await battlePage.locator('#previewBtn').click();
  await battlePage.locator('#previewCanvas canvas').waitFor({ state: 'visible' });
  if (screenshotDir) await battlePage.screenshot({ path: path.join(screenshotDir, 'ship-preview.png') });
  if (!externalUrl) {
    assert.ok(
      loadedResources.some((resource) => resource.includes('/src/render/shipPreview.ts')),
      'opening the ship preview must load its Three.js renderer on demand',
    );
  } else if (!expectSingleFile) {
    assert.ok(
      loadedResources.some((resource) => resource.includes('/assets/shipPreview-')),
      'production build must fetch the ship preview chunk on demand',
    );
  }
  await battlePage.locator('#previewClose').click();
  assert.equal(await battlePage.locator('.preview-overlay').isVisible(), false, 'ship preview must still close normally');

  await battlePage.locator('#startBtn').click();
  await battlePage.locator('#canvas-root canvas').waitFor({ state: 'visible' });
  if (!externalUrl) {
    assert.ok(
      loadedResources.some((resource) => resource.includes('/src/render/threeScene.ts')),
      'starting a battle must load the battle renderer on demand',
    );
  } else if (expectSingleFile) {
    assert.equal(
      loadedResources.some((resource) => resource.includes('/assets/')),
      false,
      'single-file static build must not request external asset chunks',
    );
  } else {
    assert.ok(
      loadedResources.some((resource) => resource.includes('/assets/threeScene-')),
      'production build must fetch the battle renderer chunk on demand',
    );
  }
  assert.equal(await battlePage.locator('#battle-root').isVisible(), true, 'battle root must become visible');
  await battlePage.waitForTimeout(300);
  if (screenshotDir) await battlePage.screenshot({ path: path.join(screenshotDir, 'battle.png') });
  assert.deepEqual(battleErrors, [], `lazy renderer flows must keep the browser console clean:\n${battleErrors.join('\n')}`);

  console.log(
    expectSingleFile
      ? '[PASS] single-file static renderers: preview=loaded, battle=loaded, external assets=0'
      : externalUrl
        ? '[PASS] production chunks: preview=lazy, battle=lazy'
        : '[PASS] lazy Three.js renderers: setup=eager-free, preview=loaded, battle=loaded',
  );
} finally {
  await browser?.close();
  await server?.close();
}

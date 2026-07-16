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

  // 固定新远征 seed，使真实玩家路径可稳定覆盖第二据点，而不向应用添加测试专用入口。
  await page.addInitScript(() => { Date.now = () => 2036; });
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

  await page.locator('[data-strategy-base]').click();
  const suppliesBeforeRecruitment = JSON.parse(await page.evaluate(() => window.render_game_to_text())).resources.supplies;
  await page.locator('#strategy-open-recruitment').click();
  await page.locator('[data-strategy-recruit-candidate]').first().waitFor({ state: 'visible' });
  const recruitmentState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(recruitmentState.commander.pendingRecruitment?.candidates.length, 2, 'recruitment must expose exactly two deterministic candidates');
  assert.equal(recruitmentState.commander.recruitmentUsedThisSector, true, 'opening recruitment must consume the sector opportunity');
  assert.equal(await page.locator('#strategy-next-turn').isDisabled(), true, 'pending recruitment must lock turn advancement');
  assert.equal(await page.locator('[data-strategy-recruit-candidate]').count(), 2, 'recruitment UI must render both candidates');
  await page.locator('.strategic-commander').scrollIntoViewIfNeeded();
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'commander-recruitment.png'), fullPage: true });

  const recruitmentCost = recruitmentState.commander.pendingRecruitment.supplyCost;
  const recruitedId = recruitmentState.commander.pendingRecruitment.candidates[0].id;
  await page.locator('[data-strategy-recruit-candidate]').first().click();
  await page.waitForFunction((candidateId) => {
    const state = JSON.parse(window.render_game_to_text());
    return state.commander?.reserves?.some((commander) => commander.id === candidateId);
  }, recruitedId);
  const recruitedState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(recruitedState.commander.pendingRecruitment, null, 'accepting a candidate must close recruitment');
  assert.equal(recruitedState.commander.reserves.length, 1, 'accepted candidate must join the reserve roster');
  assert.equal(recruitedState.commander.reserves[0].id, recruitedId, 'UI selection and strategic state must agree');
  assert.equal(recruitedState.resources.supplies, suppliesBeforeRecruitment - recruitmentCost, 'recruitment must deduct the authoritative supply cost');
  assert.equal(await page.locator('#strategy-next-turn').isDisabled(), false, 'turn advancement must unlock after recruitment resolves');
  assert.ok((await page.locator('.commander-roster').innerText()).includes(recruitedState.commander.reserves[0].name), 'reserve roster must render the accepted commander');
  await page.locator('.strategic-commander').scrollIntoViewIfNeeded();
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'commander-roster.png'), fullPage: true });

  // seed 2036 的安全次级空间站位于 s1-sys-6：真实航行、测绘并建立运输前哨。
  await page.locator('[data-strategy-system="s1-sys-6"]').click();
  await page.locator('[data-strategy-travel="s1-sys-6"]').click();
  await page.locator('[data-strategy-survey="s1-sys-6-e3"]').click();
  await page.locator('[data-strategy-outpost="s1-sys-6-e3"]').click();
  const networkState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(networkState.network.outposts.length, 2, 'player flow must create a main base and one secondary outpost');
  assert.equal(networkState.network.outposts.filter((outpost) => outpost.main).length, 1, 'network must retain exactly one main base');
  const secondaryOutpost = networkState.network.outposts.find((outpost) => !outpost.main);
  assert.equal(secondaryOutpost?.transport, 'active', 'new secondary outpost transport must begin active before the raider reaches the base');
  assert.equal(networkState.enemyOperations.taskForces.length, 1, 'the strategic state must expose the persisted moving raider');
  assert.equal(await page.locator('[data-strategy-outpost-card]').count(), 2, 'network UI must render both outpost cards');
  const outpostBuild = page.locator('[data-strategy-build-entity="s1-sys-6-e3"]').first();
  assert.equal(await outpostBuild.isDisabled(), false, 'local outpost construction must be available while fleet is present');
  await outpostBuild.click();
  const queuedNetworkState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(queuedNetworkState.network.outposts.find((outpost) => !outpost.main)?.queue.length, 1, 'outpost build action must enter that outpost queue');
  await page.locator('#strategy-next-turn').click();
  const siegeState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(siegeState.enemyOperations.sieges.length, 1, 'advancing the real strategic turn must let the raider begin an outpost siege');
  assert.ok((await page.locator('.siege-warning').innerText()).includes('围攻中'), 'the live UI must render the siege countdown');
  await page.locator('.strategic-layout').scrollIntoViewIfNeeded();
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'outpost-map.png'), fullPage: true });
  await page.locator('.strategic-network').scrollIntoViewIfNeeded();
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'outpost-network.png'), fullPage: true });

  // 舰队用一回合返回被围攻的主基地；到达后倒计时暂停并可进入现有真实战斗场景。
  await page.locator('[data-strategy-system="s1-sys-0"]').click();
  await page.locator('[data-strategy-travel="s1-sys-0"]').click();
  const defendedSiegeState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  assert.equal(defendedSiegeState.fleetSystem, 's1-sys-0', 'player fleet must return to the besieged main base');
  assert.equal(defendedSiegeState.enemyOperations.sieges[0].turnsRemaining, 2, 'fleet arrival must pause the siege countdown before combat');
  assert.equal(await page.locator('#strategy-engage').isVisible(), true, 'besieged base must expose the real battle action');
  await page.locator('#strategy-engage').click();
  await page.locator('#canvas-root canvas').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#battle-root').isVisible(), true, 'outpost defense must enter the existing Three.js battle screen');
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'outpost-defense-battle.png') });
  await page.waitForTimeout(300);
  assert.deepEqual(errors, [], `browser console must stay clean:\n${errors.join('\n')}`);

  console.log(
    `[PASS] strategic browser scroll: viewport=${before.clientHeight}, content=${before.scrollHeight}, scrollTop=${after.scrollTop}`,
  );
  console.log(`[PASS] commander recruitment browser loop: candidates=2, reserve=1, supplies=-${recruitmentCost}`);
  console.log('[PASS] strategic outpost browser loop: outposts=2, transport=active, local queue=1, siege=1, defense battle=Three.js');

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
  await battlePage.close();

  // C.5 独立浏览器闭环：所有操作均点击正式 UI；六场战斗均进入现有 Three.js 场景并以 4x 实时完成。
  const releasePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const releaseErrors = [];
  releasePage.on('console', (message) => {
    if (message.type() === 'error') releaseErrors.push(`console: ${message.text()}`);
  });
  releasePage.on('pageerror', (error) => releaseErrors.push(`page: ${String(error)}`));
  await releasePage.addInitScript(() => { Date.now = () => 2036; });
  await releasePage.goto(url, { waitUntil: 'domcontentloaded' });
  await releasePage.locator('#cm-strategy-new').click();

  const releasePlans = [
    {
      sector: 1,
      waitTurns: 4,
      path: ['s1-sys-7', 's1-sys-5', 's1-sys-1', 's1-sys-3', 's1-sys-4', 's1-sys-8'],
      gateEntityId: 's1-sys-8-e4',
      recruit: true,
    },
    {
      sector: 2,
      waitTurns: 1,
      path: ['s2-sys-5', 's2-sys-6', 's2-sys-4'],
      gateEntityId: 's2-sys-4-e5',
      recruit: false,
    },
    {
      sector: 3,
      waitTurns: 2,
      path: ['s3-sys-1', 's3-sys-7', 's3-sys-2', 's3-sys-5'],
      gateEntityId: 's3-sys-5-e4',
      recruit: false,
    },
  ];

  let renderedBattles = 0;
  const finishVisibleBattle = async (label) => {
    await releasePage.locator('#battle-root').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await releasePage.locator('#canvas-root canvas').isVisible(), true, `${label} must render the existing Three.js canvas`);
    await releasePage.locator('[data-speed="4"]').click();
    renderedBattles++;
    if (screenshotDir && (renderedBattles === 1 || label.includes('gate'))) {
      await releasePage.screenshot({ path: path.join(screenshotDir, `c5-${label}.png`) });
    }
    await releasePage.locator('#strategy-root').waitFor({ state: 'visible', timeout: 20000 });
    await releasePage.locator('.strategic-screen').waitFor({ state: 'visible' });
  };

  for (const plan of releasePlans) {
    const openingState = JSON.parse(await releasePage.evaluate(() => window.render_game_to_text()));
    assert.equal(openingState.sector, plan.sector, `browser flow must enter sector ${plan.sector}`);
    assert.equal(openingState.status, 'active', `sector ${plan.sector} must begin active`);
    assert.equal(openingState.finalTurn, 17, `sector ${plan.sector} must expose the C.5 action window`);

    await releasePage.locator('[data-strategy-base]').click();
    await releasePage.locator('[data-strategy-research="routeAnalysis"]').click();
    await releasePage.locator('#strategy-open-recruitment').click();
    if (plan.recruit) await releasePage.locator('[data-strategy-recruit-candidate]').first().click();
    else await releasePage.locator('#strategy-recruit-decline').click();
    for (let index = 0; index < plan.waitTurns; index++) {
      await releasePage.locator('#strategy-next-turn').click();
    }

    await releasePage.locator('#strategy-engage').click();
    await finishVisibleBattle(`sector-${plan.sector}-raider`);
    for (const systemId of plan.path) {
      const system = releasePage.locator(`[data-strategy-system="${systemId}"]`);
      await system.click();
      const travel = releasePage.locator(`[data-strategy-travel="${systemId}"]`);
      assert.equal(await travel.isDisabled(), false, `${systemId} must be a visible legal next hop`);
      await travel.click();
    }

    await releasePage.locator(`[data-strategy-survey="${plan.gateEntityId}"]`).click();
    await releasePage.locator('#strategy-calibrate').click();
    await releasePage.locator('#strategy-calibrate').click();
    await finishVisibleBattle(`sector-${plan.sector}-gate`);
    const defended = JSON.parse(await releasePage.evaluate(() => window.render_game_to_text()));
    assert.equal(defended.extraction.gateDefense, 'resolved', `sector ${plan.sector} gate defense must write back to strategy`);
    assert.ok(defended.turn <= defended.finalTurn, `sector ${plan.sector} must finish within its action window`);
    await releasePage.locator('#strategy-extract-emergency').click();
  }

  const victoryState = JSON.parse(await releasePage.evaluate(() => window.render_game_to_text()));
  assert.equal(victoryState.status, 'victory', 'real browser flow must finish the third sector in victory');
  assert.equal(victoryState.sector, 3, 'victory must remain on the third-sector result state');
  assert.equal(renderedBattles, 6, 'browser flow must render all three raider and three gate battles');
  assert.equal(await releasePage.locator('#strategy-next-turn').isDisabled(), true, 'victory must lock strategic turn advancement');
  assert.ok((await releasePage.locator('.strategy-end.victory').innerText()).includes('已连续穿越 3 个星域'), 'victory settlement must explain the completed run');
  await releasePage.locator('.strategy-end.victory').scrollIntoViewIfNeeded();
  if (screenshotDir) await releasePage.screenshot({ path: path.join(screenshotDir, 'c5-three-sector-victory.png'), fullPage: true });
  assert.deepEqual(releaseErrors, [], `C.5 browser release flow must keep the console clean:\n${releaseErrors.join('\n')}`);
  console.log('[PASS] C.5 browser release loop: sectors=3, core-v4/Three.js battles=6, result=victory');
  await releasePage.close();
} finally {
  await browser?.close();
  await server?.close();
}

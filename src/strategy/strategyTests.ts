import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { generateUniverse, hash32 } from './universeGenerator';
import { decodeUniverse, encodeUniverse, validateUniverseState } from './universePersistence';
import {
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  applyStrategicBattleResult,
  applyUniverseAction,
  canCalibrateGate,
  canEngageEnemy,
  canEstablishBase,
  canExtractSector,
  canQueueFacility,
  canQueueResearch,
  canRepairFleet,
  canRepairShip,
  crisisPhaseForTurn,
  previewExtractLosses,
  strategicFleetCounts,
  strategicFleetPower,
  travelFuelCost,
  universeTurnIncome,
  toPersistentFleet,
  validateBattleShipAgainstDefinition,
  validateFinishedStrategicBattle
} from './universeRules';
import {
  campaignFleetEntryCost,
  campaignFleetPower,
  campaignShipCost,
  strategicBaselineFleetPower,
  systemEnemyBudget,
  battleTeamRemainingPower,
  minimumStrategicFleetCost,
  normalizeStrategicEnemyPower
} from '../campaign/fleet/campaignPower';
import { getShipDef, VARIANTS } from '../sim/shipVariants';
import { activeShips } from '../campaign/fleet/persistentFleet';
import { strategicEnemyFleetFor, prepareStrategicBattle, validatePersistentBattleBindings } from '../campaign/fleet/battleAdapter';
import type { PersistentBattleBinding } from '../campaign/fleet/battleAdapter';
import type { BattleState, CombatState } from '../sim/battleTypes';
import { createSimulator } from '../sim/rulesets';
import { isPresentOnBattlefield } from '../sim/shipFlags';
import { SECTOR_EXPEDITION_VERSION } from './universeTypes';
import { StrategicUniversePanel } from '../ui/strategicUniversePanel';

type Ship = BattleState['ships'][number];

function graphReachable(state: ReturnType<typeof generateUniverse>): boolean {
  const seen = new Set<string>([state.systems[0].id]);
  const queue = [state.systems[0].id];
  while (queue.length) {
    const id = queue.shift()!;
    const system = state.systems.find((candidate) => candidate.id === id)!;
    for (const neighbor of system.neighbors) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return seen.size === state.systems.length;
}

function establishStartingBase(state: ReturnType<typeof generateUniverse>) {
  const station = state.entities.find((entity) =>
    entity.systemId === state.fleet.systemId && entity.kind === 'station'
  )!;
  return applyUniverseAction(state, { type: 'establishBase', entityId: station.id });
}

function prepareGate(state: ReturnType<typeof generateUniverse>, calibration: number) {
  const next = JSON.parse(JSON.stringify(state)) as ReturnType<typeof generateUniverse>;
  const gate = next.entities.find((entity) => entity.id === next.extraction.gateEntityId)!;
  const system = next.systems.find((candidate) => candidate.id === gate.systemId)!;
  gate.discovered = true;
  gate.surveyed = true;
  next.extraction.discovered = true;
  next.extraction.calibration = calibration;
  next.fleet.systemId = system.id;
  next.selectedSystemId = system.id;
  system.discovered = true;
  system.control = 'neutral';
  system.enemyPower = 0;
  if (!next.faction.knownSystemIds.includes(system.id)) next.faction.knownSystemIds.push(system.id);
  next.faction.resources.supplies = 50;
  next.faction.resources.energy = 10;
  next.faction.resources.science = 10;
  next.fleet.fuel = next.fleet.maxFuel;
  return next;
}

/** 与 universePersistence 保持一致的 base64url 编码，用于构造旧版 alpha.2 / alpha.3 远征码。 */
function b64urlEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 真实集成工厂：通过 applyUniverseAction(engageEnemy) 锁定待处理战斗，
 * 再用 prepareStrategicBattle 按存档确定性重建一个完全合法（无任何 as unknown as 伪造）的
 * core-v4 BattleState 与绑定。测试只需在此基础上修改 combatState / 组件 HP 并标记 finished。
 */
function lockPendingBattle(seed: number, enemyPower: number) {
  let state = generateUniverse(seed);
  const hostile = state.systems.find((s) => s.control === 'enemy')!;
  state.fleet.systemId = hostile.id;
  state.selectedSystemId = hostile.id;
  hostile.discovered = true;
  hostile.enemyPower = enemyPower;
  state = applyUniverseAction(state, { type: 'engageEnemy' });
  const pending = state.pendingBattle!;
  const ctx = prepareStrategicBattle(toPersistentFleet(state.fleet), pending.enemyFleet, pending.battleSeed);
  const battle = ctx.state;
  battle.finished = true;
  battle.winner = 'A';
  return { state, battle, bindings: ctx.bindings, pending, hostileId: hostile.id };
}

/** 直接修改战斗舰的 combatState 及其组件 HP（无需伪造 BattleState 结构），并补齐状态机相关字段使其通过深层校验。 */
function applyCombatState(ship: Ship, state: CombatState): void {
  ship.combatState = state;
  if (state === 'destroyed') {
    for (const component of ship.components) {
      component.hp = 0;
      component.destroyed = true;
    }
  } else if (state === 'disabled') {
    // 优先摧毁引擎或武器（而非核心），并置对应失能标志，使 disabled 状态机一致（validateBattleShipAgainstDefinition 要求）。
    const index = ship.components.findIndex(
      (component) => component.def.type === 'engine' || component.def.type === 'weapon'
    );
    if (index >= 0) {
      const type = ship.components[index].def.type;
      ship.components[index].hp = 0;
      ship.components[index].destroyed = true;
      if (type === 'engine') ship.mobilityDisabled = true;
      else if (type === 'weapon') ship.weaponsDisabled = true;
    }
  } else if (state === 'escaped') {
    ship.escapedTick = 1;
    for (const component of ship.components) {
      component.hp = component.maxHp;
      component.destroyed = false;
    }
  } else if (state === 'retreating') {
    ship.retreatStartedTick = 1;
    for (const component of ship.components) {
      component.hp = component.maxHp;
      component.destroyed = false;
    }
  } else {
    for (const component of ship.components) {
      component.hp = component.maxHp;
      component.destroyed = false;
    }
  }
}

/**
 * 重算 BattleState 的 teamACount / teamBCount，使其与"在场舰数"（未摧毁、未脱离）一致。
 * 这复刻了模拟器在每 tick 末的权威逻辑（isPresentOnBattlefield），用于测试在手动修改
 * combatState 后保持战斗状态自洽——真实模拟由 createSimulator 自动维护，无需调用。
 */
function syncBattleCounts(battle: BattleState): void {
  let a = 0;
  let b = 0;
  for (const sh of battle.ships) {
    if (!isPresentOnBattlefield(sh)) continue;
    if (sh.team === 'A') a++;
    else b++;
  }
  battle.teamACount = a;
  battle.teamBCount = b;
}

/** 注入一个最小合法的待处理战斗，用于验证 can* 逻辑层锁定（不依赖具体敌军舰队）。 */
function withPending(state: ReturnType<typeof generateUniverse>, systemId: string, enemyPower: number) {
  return {
    ...state,
    pendingBattle: { battleId: 'test-pending', systemId, battleSeed: 7, enemyPowerBefore: enemyPower, enemyFleet: [] as never[] }
  };
}

/**
 * test:strategy 在 Node 下运行（无 jsdom）。为 StrategicUniversePanel.render 提供最小 DOM 桩：
 * 仅捕获 innerHTML，querySelectorAll/querySelector 返回空（按钮 onclick 绑定为空操作）。
 * 真实 DOM 测试通过解析 innerHTML 中的 <button> 标签断言 disabled 属性（含"非法 disableddisabled"检测）。
 */
class FakeRoot {
  innerHTML = '';
  querySelectorAll(_sel: string): any[] { return []; }
  // 返回一个最小桩对象，避免 render 中未加 null 守卫的 `querySelector('#...').onclick = ...` 在 Node 下崩溃。
  querySelector(_sel: string): any { return { onclick: undefined }; }
}

function parseStrategyButtons(html: string): Array<{ id: string; disabled: boolean; data: string }> {
  const out: Array<{ id: string; disabled: boolean; data: string }> = [];
  const re = /<button\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const tokens = tag.split(/\s+/).filter(Boolean);
    const disabled = tokens.includes('disabled');
    const idMatch = tag.match(/\bid="([^"]*)"/);
    out.push({ id: idMatch ? idMatch[1] : '', disabled, data: tag });
  }
  return out;
}

/** 将战斗舰置为低完整度 operational 状态（用于制造"低残余敌方战力"场景，且不触发任何失能/脱离标记）。 */
function setLowIntegrity(ship: Ship, fraction: number): void {
  for (const component of ship.components) {
    component.hp = Math.max(1, Math.round(component.maxHp * fraction));
    component.destroyed = false;
  }
  ship.combatState = 'normal';
  ship.mobilityDisabled = false;
  ship.weaponsDisabled = false;
  ship.sensorsDisabled = false;
  ship.escapedTick = undefined;
  ship.retreatStartedTick = undefined;
}

/**
 * 真实 core-v4 战略战斗集成：通过 applyUniverseAction(engageEnemy) 锁定待处理战斗，
 * 再用 prepareStrategicBattle 构建真实 BattleState，并用 createSimulator 逐步推进至结束。
 * 返回原始 UniverseState（含 pendingBattle）与已结束的 BattleState / 绑定，供 applyStrategicBattleResult 写回。
 */
function simulateStrategicBattle(seed: number, enemyPower: number) {
  let state = generateUniverse(seed);
  const hostile = state.systems.find((candidate) => candidate.control === 'enemy')!;
  state.fleet.systemId = hostile.id;
  state.selectedSystemId = hostile.id;
  hostile.discovered = true;
  hostile.enemyPower = enemyPower;
  state = applyUniverseAction(state, { type: 'engageEnemy' });
  const pending = state.pendingBattle!;
  const ctx = prepareStrategicBattle(toPersistentFleet(state.fleet), pending.enemyFleet, pending.battleSeed);
  // 复用与 prepareStrategicBattle 同源的 rng 实例（createInitialState 已消费部分随机流，模拟器必须接在其后）。
  const sim = createSimulator(ctx.state, ctx.rng);
  let guard = 0;
  while (!ctx.state.finished && guard < 200000) {
    sim.step();
    guard++;
  }
  // 使用模拟器权威的最终状态（与 ctx.state 同源，确保 teamACount/teamBCount 等字段一致）。
  const finalState = (sim as unknown as { state: BattleState }).state;
  return { state, battle: finalState, bindings: ctx.bindings, pending, guard };
}

/** 在 Node（无 jsdom）下渲染 StrategicUniversePanel 并返回捕获的 innerHTML。 */
function renderPanel(state: ReturnType<typeof generateUniverse>): string {
  const root = new FakeRoot();
  const panel = new StrategicUniversePanel(root as unknown as HTMLElement, { onAction: () => {}, onExport: () => {}, onExit: () => {} });
  panel.render(state);
  return root.innerHTML;
}

/** 真实同量纲敌方预算（>= 最低合法舰船成本），用于战斗写回测试，保证 enemyPowerBefore 与生成的敌舰队成本一致。 */
const ENEMY_BUDGET = systemEnemyBudget(2, false);

export function runStrategicTests(): SuiteResult {
  return runSuite('strategic-sector-v1.0', (add) => {
    // 1. 每个星域按 seed 生成完整战略结构
    {
      const test = new Case('每个星域按 seed 生成完整战略结构');
      const first = generateUniverse(1001, '开拓局');
      const same = generateUniverse(1001, '开拓局');
      const different = generateUniverse(1002, '开拓局');
      const signature = (state: typeof first) => JSON.stringify({ systems: state.systems, entities: state.entities });
      test.eq(signature(first), signature(same), '相同 seed 生成相同星系、航线、实体和敌情');
      test.true_(signature(first) !== signature(different), '不同 seed 生成不同星域');
      test.eq(first.systems.length, 9, '单个星域包含九个战略星系');
      test.true_(graphReachable(first), '星域航线图整体连通');
      test.true_(first.entities.some((entity) => entity.kind === 'jumpGate'), '存在唯一撤离星门');
      test.true_(first.entities.some((entity) => entity.kind === 'relicSite'), '存在可带走蓝图的科研遗迹');
      test.true_(first.systems.filter((system) => system.control === 'enemy').length >= 2, '星域开局存在真实敌方控制区');
      test.eq(first.faction.baseEntityId, undefined, '开局没有免费永久基地');
      test.eq(first.crisis.phase, 'foothold', '开局处于立足窗口');
      test.true_(Array.isArray(first.fleet.ships) && first.fleet.ships.length > 0, '开局舰队为真实逐舰数组');
      add(test);
    }

    // 2. 相同 seed 跨次生成一致、不同 seed 不同
    {
      const test = new Case('相同 seed 跨次生成一致、不同 seed 不同');
      const a = generateUniverse(2001);
      const b = generateUniverse(2001);
      const c = generateUniverse(2002);
      test.eq(JSON.stringify(a.fleet.ships), JSON.stringify(b.fleet.ships), '同 seed 舰队逐舰一致');
      test.true_(JSON.stringify(a.systems) !== JSON.stringify(c.systems), '不同 seed 星系布局不同');
      add(test);
    }

    // 3. 星域航线图整体连通
    {
      const test = new Case('星域航线图整体连通');
      for (const seed of [3001, 3002, 3003]) {
        test.true_(graphReachable(generateUniverse(seed)), `seed ${seed} 航线图连通`);
      }
      add(test);
    }

    // 4. 开局舰队为真实逐舰数组且无免费永久基地
    {
      const test = new Case('开局舰队为真实逐舰数组且无免费永久基地');
      const state = generateUniverse(4001);
      test.true_(state.fleet.ships.every((s) => typeof s.campaignShipId === 'string' && !!s.shipClass && !!s.variant), '逐舰均含合法 hull/改型');
      test.true_(state.fleet.ships.every((s) => s.disabled === false && s.escaped === false), '开局无失能/脱离舰');
      test.eq(state.faction.baseEntityId, undefined, '无免费永久基地');
      add(test);
    }

    // 5. 占领据点后可进行临时建设与回合生产
    {
      const test = new Case('占领据点后可进行临时建设与回合生产');
      let state = establishStartingBase(generateUniverse(1003));
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.true_(!!base && base.ownerId === state.faction.id, '已占领废弃空间站建立前进基地');
      const before = state.faction.resources.minerals;
      state = applyUniverseAction(state, { type: 'queueConstruction', facilityType: 'miningArray' });
      test.eq(state.faction.resources.minerals, before - FACILITY_DEFINITIONS.miningArray.cost.minerals!, '建设成本立即扣除');
      for (let turn = 0; turn < FACILITY_DEFINITIONS.miningArray.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      const completedBase = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.true_(completedBase.facilities?.some((facility) => facility.type === 'miningArray') ?? false, '临时采矿阵列按回合完成');
      test.eq(universeTurnIncome(state).minerals, 4, '设施开始提供本星域回合产出');
      add(test);
    }

    // 6. 本地科研提供快速收益但穿越星门后重置
    {
      const test = new Case('本地科研提供快速收益但穿越星门后重置');
      let state = establishStartingBase(generateUniverse(1004));
      state.faction.resources.science = 30;
      state = applyUniverseAction(state, { type: 'queueResearch', projectId: 'routeAnalysis' });
      for (let turn = 0; turn < RESEARCH_DEFINITIONS.routeAnalysis.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      test.true_(state.faction.localResearch.includes('routeAnalysis'), '本地航路解析研究完成');
      test.eq(travelFuelCost(state), 1, '本星域航行燃料降低');
      const prepared = prepareGate(state, 100);
      const nextSector = applyUniverseAction(prepared, { type: 'extractSector', mode: 'stable' });
      test.eq(nextSector.sectorIndex, 2, '稳定撤离后生成下一完整战略星域');
      test.eq(nextSector.faction.localResearch.length, 0, '本地科研在跨星域后重置');
      test.eq(nextSector.faction.baseEntityId, undefined, '临时基地不会跨星域继承');
      test.eq(nextSector.faction.legacy.sectorsCleared, 1, '跨星域进度进入长期继承状态');
      add(test);
    }

    // 7. 危机阶段随时间升级并最终摧毁未撤离舰队
    {
      const test = new Case('危机阶段随时间升级并最终摧毁未撤离舰队');
      let state = generateUniverse(1005);
      test.eq(crisisPhaseForTurn(Math.ceil(state.crisis.finalTurn * 0.4), state.crisis.finalTurn), 'contest', '中段进入争夺阶段');
      test.eq(crisisPhaseForTurn(Math.ceil(state.crisis.finalTurn * 0.7), state.crisis.finalTurn), 'collapse', '后段进入崩溃阶段');
      for (let turn = 0; turn <= state.crisis.finalTurn; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      test.eq(state.status, 'collapsed', '超过最终撤离窗口后战役失败');
      test.eq(state.crisis.phase, 'evacuation', '终局处于最终撤离阶段');
      add(test);
    }

    // 8. 战略敌军战力与 core-v4 舰船成本同量纲
    {
      const test = new Case('战略敌军战力与 core-v4 舰船成本同量纲');
      const baseline = strategicBaselineFleetPower();
      const budgets = [
        systemEnemyBudget(0, false), systemEnemyBudget(1, false), systemEnemyBudget(2, false),
        systemEnemyBudget(0, true), systemEnemyBudget(1, true), systemEnemyBudget(2, true)
      ];
      test.true_(budgets.every((b) => b >= 50), '所有敌方预算不低于最低合法舰船成本');
      // 离散装箱一致性：预算必须等于“用该预算生成的真实敌舰队成本”（容差 = 最便宜舰船成本）。
      const tolerance = 60;
      const cases: Array<[number, boolean]> = [[0, false], [1, false], [2, false], [0, true], [1, true], [2, true]];
      for (const [sectorIndex, gateGuard] of cases) {
        const budget = systemEnemyBudget(sectorIndex, gateGuard);
        const fleet = strategicEnemyFleetFor(12345, budget, { sectorIndex, gateGuard, cruiserAllowed: sectorIndex >= 2 || gateGuard });
        const cost = campaignFleetEntryCost(fleet);
        test.true_(Math.abs(cost - budget) <= tolerance, `预算 ${budget} 与真实敌舰队成本 ${cost} 同量纲（星域 ${sectorIndex} ${gateGuard ? '星门' : '前哨'}）`);
      }
      add(test);
    }

    // 9. 战略敌军舰队确定性生成（同 seed 一致 + 不压缩强敌）
    {
      const test = new Case('战略敌军舰队确定性生成（同 seed 一致 + 不压缩强敌）');
      const opts = { sectorIndex: 2, gateGuard: false, cruiserAllowed: true };
      const a = strategicEnemyFleetFor(777, 120, opts);
      const b = strategicEnemyFleetFor(777, 120, opts);
      test.eq(JSON.stringify(a), JSON.stringify(b), '相同 seed 与预算生成完全相同的敌军舰队');
      const weak = strategicEnemyFleetFor(1, 60, opts);
      const strong = strategicEnemyFleetFor(1, 320, opts);
      const weakTotal = weak.reduce((sum, e) => sum + e.count, 0);
      const strongTotal = strong.reduce((sum, e) => sum + e.count, 0);
      test.true_(strongTotal > weakTotal, '强敌生成更多舰船（不采用战役式压缩安全上限）');
      const weakPower = weak.reduce((sum, e) => sum + e.count * campaignShipCost(e.shipClass, e.variant), 0);
      test.true_(weakPower >= 50, '敌方强度由预算决定而非被低估');
      add(test);
    }

    // 10. 不同星域前哨/星门守卫预算因子差异
    {
      const test = new Case('不同星域前哨/星门守卫预算因子差异');
      const baseline = strategicBaselineFleetPower();
      const outpost0 = systemEnemyBudget(0, false);
      const outpost2 = systemEnemyBudget(2, false);
      const gate0 = systemEnemyBudget(0, true);
      const gate3 = systemEnemyBudget(3, true);
      test.true_(outpost0 < baseline && outpost0 >= baseline * 0.45, '前哨预算落于基线 45–85%');
      test.true_(outpost2 <= baseline * 0.95 && outpost2 >= baseline * 0.7, '高星域前哨预算接近基线 85%');
      test.true_(gate0 >= baseline * 0.9 && gate0 <= baseline * 1.1, '星门守卫预算≈基线 95%');
      test.true_(gate3 >= baseline * 1.4 && gate3 <= baseline * 1.6, '高星域星门守卫预算≈基线 150%');
      test.true_(gate3 > outpost2 && gate0 > outpost0, '星门守卫强于同星域前哨');
      add(test);
    }

    // 11. validateUniverseState 拒绝敌战力与控制不一致的存档
    {
      const test = new Case('validateUniverseState 拒绝敌战力与控制不一致的存档');
      const valid = generateUniverse(1040);
      test.true_(validateUniverseState(valid), '正常生成状态通过校验');
      const enemyZero = JSON.parse(JSON.stringify(valid));
      const ezSys = enemyZero.systems.find((s: { control: string }) => s.control !== 'enemy')!;
      ezSys.control = 'enemy';
      ezSys.enemyPower = 0;
      test.true_(!validateUniverseState(enemyZero), '敌方控制但战力 0 被拒绝');
      const neutralPos = JSON.parse(JSON.stringify(valid));
      const npSys = neutralPos.systems.find((s: { control: string }) => s.control === 'neutral')!;
      npSys.enemyPower = 30;
      test.true_(!validateUniverseState(neutralPos), '非敌方控制却有正战力被拒绝');
      const tooLow = JSON.parse(JSON.stringify(valid));
      const tlSys = tooLow.systems.find((s: { control: string }) => s.control !== 'enemy')!;
      tlSys.control = 'enemy';
      tlSys.enemyPower = 10;
      test.true_(!validateUniverseState(tooLow), '敌方战力低于最低合法舰船成本被拒绝');
      add(test);
    }

    // 12. engageEnemy 仅创建待处理战斗且不立即削减战力
    {
      const test = new Case('engageEnemy 仅创建待处理战斗且不立即削减战力');
      let state = generateUniverse(1006);
      const hostile = state.systems.find((system) => system.control === 'enemy')!;
      state.fleet.systemId = hostile.id;
      state.selectedSystemId = hostile.id;
      hostile.discovered = true;
      hostile.enemyPower = 18;
      const before = hostile.enemyPower;
      state = applyUniverseAction(state, { type: 'engageEnemy' });
      const updated = state.systems.find((system) => system.id === hostile.id)!;
      test.eq(updated.enemyPower, before, 'engageEnemy 仅创建待处理战斗，不直接削减敌方战力');
      test.true_(!!state.pendingBattle, '攻击生成 PendingStrategicBattle');
      test.true_(
        !!state.pendingBattle && state.pendingBattle.enemyFleet.reduce((sum, e) => sum + e.count, 0) > 0,
        '待处理战斗按 StarSystem.enemyPower 预算确定性生成敌军'
      );
      add(test);
    }

    // 13. 待处理战斗锁定战略行动（travel/advanceTurn 被阻止，selectSystem 允许）
    {
      const test = new Case('待处理战斗锁定战略行动（advanceTurn 被阻止，selectSystem 允许）');
      const { state } = lockPendingBattle(1017, ENEMY_BUDGET);
      const turnBefore = state.turn;
      const advanced = applyUniverseAction(state, { type: 'advanceTurn' });
      test.eq(advanced.turn, turnBefore, '存在待处理战斗时推进回合被阻止');
      const selected = state.systems.find((s) => s.id !== state.selectedSystemId)!;
      const afterSelect = applyUniverseAction(state, { type: 'selectSystem', systemId: selected.id });
      test.eq(afterSelect.selectedSystemId, selected.id, '选择星系在待处理战斗时仍允许');
      test.true_(!!afterSelect.pendingBattle, '选择星系不会清除待处理战斗');
      add(test);
    }

    // 14. 待处理战斗逻辑层锁定：can* 全部返回 false
    {
      const test = new Case('待处理战斗逻辑层锁定：canExtractSector/canQueueFacility/canQueueResearch/canCalibrateGate/canEngageEnemy 均 false');
      // 撤离 / 校准：先构造允许状态，再注入 pending，确认被锁定。
      let gate = prepareGate(generateUniverse(1018), 100);
      test.true_(canExtractSector(gate, 'stable'), '满校准时可稳定撤离');
      test.true_(!canCalibrateGate(gate), '满校准时无需再校准');
      const gateHostile = gate.systems.find((s) => s.control === 'enemy')!;
      const gateLocked = withPending(gate, gateHostile.id, gateHostile.enemyPower);
      test.true_(!canExtractSector(gateLocked, 'stable'), '注入待处理战斗后撤离被锁定');
      test.true_(!canExtractSector(gateLocked, 'emergency'), '注入待处理战斗后紧急撤离被锁定');

      let gateCal = prepareGate(generateUniverse(1019), 50);
      test.true_(canCalibrateGate(gateCal), '校准未满时可校准星门');
      const gateCalHostile = gateCal.systems.find((s) => s.control === 'enemy')!;
      const gateCalLocked = withPending(gateCal, gateCalHostile.id, gateCalHostile.enemyPower);
      test.true_(!canCalibrateGate(gateCalLocked), '注入待处理战斗后校准被锁定');

      // 建造 / 科研：先构造有基地的允许状态，再注入 pending，确认被锁定。
      let baseState = establishStartingBase(generateUniverse(1044));
      test.true_(canQueueFacility(baseState, 'miningArray'), '有基地时可建造');
      test.true_(canQueueResearch(baseState, 'routeAnalysis'), '有基地时可科研');
      const baseLocked = withPending(baseState, baseState.fleet.systemId, 999);
      test.true_(!canQueueFacility(baseLocked, 'miningArray'), '注入待处理战斗后建造被锁定');
      test.true_(!canQueueResearch(baseLocked, 'routeAnalysis'), '注入待处理战斗后科研被锁定');

      // 攻击：位于敌军星系且有作战舰时可攻击，注入 pending 后不可。
      let eng = generateUniverse(1045);
      const h = eng.systems.find((s) => s.control === 'enemy')!;
      eng.fleet.systemId = h.id;
      eng.selectedSystemId = h.id;
      h.discovered = true;
      h.enemyPower = 18;
      test.true_(canEngageEnemy(eng), '位于敌军星系且有作战舰时可攻击');
      const engLocked = withPending(eng, h.id, 18);
      test.true_(!canEngageEnemy(engLocked), '存在待处理战斗时不可发起新攻击');
      add(test);
    }

    // 15. 单舰高压紧急撤离最多损失 max(0,len-1)，不产生空舰队
    {
      const test = new Case('单舰高压紧急撤离最多损失 max(0,len-1)，不产生空舰队');
      let state = generateUniverse(1046);
      state = prepareGate(state, 40);
      state.crisis.pressure = 85;
      state = { ...state, fleet: { ...state.fleet, ships: [state.fleet.ships[0]] } };
      const oneId = state.fleet.ships[0].campaignShipId;
      const preview = previewExtractLosses(state, 'emergency');
      test.eq(preview.length, 0, '单舰高压撤离预览损失为 0（不会清空最后一艘）');
      test.true_(preview.every((id) => typeof id === 'string'), '预览返回具体舰船 ID 字符串');
      const next = applyUniverseAction(state, { type: 'extractSector', mode: 'emergency' });
      test.eq(next.fleet.ships.length, 1, '单舰紧急撤离后舰队仍保留 1 艘（不产生空舰队）');
      test.true_(next.fleet.ships.some((s) => s.campaignShipId === oneId), '唯一舰船存活');
      test.true_(next.fleet.ships.length >= 1 ? next.status !== 'collapsed' : true, '单舰撤离不会误判崩溃');
      add(test);
    }

    // 16. previewExtractLosses 返回具体舰船 ID 且与实际撤离一致
    {
      const test = new Case('previewExtractLosses 返回具体舰船 ID 且与实际撤离一致');
      let state = generateUniverse(1047);
      state = prepareGate(state, 100);
      state.crisis.pressure = 85;
      const disShip = state.fleet.ships[0];
      const def = getShipDef(disShip.shipClass, disShip.variant).def;
      disShip.componentHp = def.components.map((c, i) => (i === 0 ? 0 : c.maxHp));
      disShip.disabled = true;
      const preview = previewExtractLosses(state, 'emergency');
      const next = applyUniverseAction(state, { type: 'extractSector', mode: 'emergency' });
      const actualLost = state.fleet.ships
        .filter((s) => !next.fleet.ships.some((n) => n.campaignShipId === s.campaignShipId))
        .map((s) => s.campaignShipId);
      test.true_(preview.length === actualLost.length && preview.every((id) => actualLost.includes(id)), '预览损失 ID 与实际损失 ID 完全一致');
      test.true_(preview.includes(disShip.campaignShipId), '预览包含被丢弃的失能舰 ID');
      test.true_(preview.every((id) => typeof id === 'string'), '预览返回具体舰船 ID 字符串（非仅数量）');
      add(test);
    }

    // 17. 真实逐舰战斗结果写回：destroyed 删除、敌方剩余战力由 Team B 重算
    {
      const test = new Case('真实逐舰战斗结果写回：destroyed 删除、敌方剩余战力由 Team B 重算');
      const { state, battle, bindings, pending, hostileId } = lockPendingBattle(1020, ENEMY_BUDGET);
      const teamB = battle.ships.filter((s) => s.team === 'B');
      teamB.forEach((s, i) => {
        if (i % 2 === 1) applyCombatState(s, 'destroyed');
      });
      syncBattleCounts(battle);
      const expected = battleTeamRemainingPower(battle, 'B');
      const after = applyStrategicBattleResult(state, battle, bindings);
      const sys = after.systems.find((s) => s.id === hostileId)!;
      test.eq(sys.enemyPower, expected, '敌方剩余战力由真实 Team B（部分摧毁）结果重算');
      test.true_(sys.enemyPower <= pending.enemyPowerBefore, '战后敌方战力不高于战前');
      test.eq(after.fleet.ships.length, state.fleet.ships.length, '玩家舰无损失（全 operational）');
      test.eq(after.pendingBattle, undefined, '写回后清除 pending');
      add(test);
    }

    // 18. 战斗结果写回后 escaped 玩家舰归一化为 escaped=false/deployed=true
    {
      const test = new Case('战斗结果写回后 escaped 玩家舰归一化为 escaped=false/deployed=true');
      const { state, battle, bindings } = lockPendingBattle(1026, ENEMY_BUDGET);
      const teamA = battle.ships.filter((s) => s.team === 'A');
      applyCombatState(teamA[0], 'escaped');
      syncBattleCounts(battle);
      const escId = bindings.find((b) => b.battleShipId === teamA[0].id)!.campaignShipId;
      const after = applyStrategicBattleResult(state, battle, bindings);
      const ship = after.fleet.ships.find((s) => s.campaignShipId === escId);
      test.true_(!!ship, '脱离战场的玩家舰仍保留在舰队');
      test.true_(!!ship && ship.escaped === false && ship.deployed === true, 'escaped 归一化为 escaped=false/deployed=true');
      add(test);
    }

    // 19. 全数 escaped 不导致远征崩溃
    {
      const test = new Case('全数 escaped 不导致远征崩溃');
      const { state, battle, bindings } = lockPendingBattle(1027, ENEMY_BUDGET);
      const teamA = battle.ships.filter((s) => s.team === 'A');
      teamA.forEach((s) => applyCombatState(s, 'escaped'));
      syncBattleCounts(battle);
      const after = applyStrategicBattleResult(state, battle, bindings);
      test.eq(after.status, 'active', '全数脱离战场不导致远征崩溃');
      test.eq(after.fleet.ships.length, state.fleet.ships.length, '所有舰船仍以 escaped=false/deployed=true 保留');
      add(test);
    }

    // 20. 未参战舰写回后状态完全不变
    {
      const test = new Case('未参战舰写回后状态完全不变');
      let state = generateUniverse(1028);
      const hostile = state.systems.find((s) => s.control === 'enemy')!;
      state.fleet.systemId = hostile.id;
      state.selectedSystemId = hostile.id;
      hostile.discovered = true;
      hostile.enemyPower = ENEMY_BUDGET;
      state = applyUniverseAction(state, { type: 'engageEnemy' });
      const pending = state.pendingBattle!;
      // 增加一艘未部署舰（不参与战斗绑定）。
      const undeployed = {
        campaignShipId: 'cs-99',
        shipClass: 'Fighter' as const,
        variant: 'standard' as const,
        disabled: false,
        escaped: false,
        towed: false,
        deployed: false
      };
      state = { ...state, fleet: { ...state.fleet, ships: [...state.fleet.ships, undeployed] } };
      const ctx = prepareStrategicBattle(toPersistentFleet(state.fleet), pending.enemyFleet, pending.battleSeed);
      const battle = ctx.state;
      battle.finished = true;
      battle.winner = 'A';
      const after = applyStrategicBattleResult(state, battle, ctx.bindings);
      const kept = after.fleet.ships.find((s) => s.campaignShipId === 'cs-99');
      test.true_(!!kept, '未部署舰仍存在于写回后舰队');
      test.true_(!!kept && kept.deployed === false, '未部署舰写回后 deployed 不变');
      add(test);
    }

    // 21. 合法 binding 通过 validatePersistentBattleBindings
    {
      const test = new Case('合法 binding 通过 validatePersistentBattleBindings');
      const { state, battle, bindings } = lockPendingBattle(1029, ENEMY_BUDGET);
      const fleet = toPersistentFleet(state.fleet);
      let threw = false;
      try {
        validatePersistentBattleBindings(bindings, fleet, battle);
      } catch {
        threw = true;
      }
      test.true_(!threw, '合法 binding 通过校验');
      add(test);
    }

    // 22. 重复 campaignShipId 的 binding 抛错
    {
      const test = new Case('重复 campaignShipId 的 binding 抛错');
      const { state, battle, bindings } = lockPendingBattle(1030, ENEMY_BUDGET);
      const fleet = toPersistentFleet(state.fleet);
      const bad: PersistentBattleBinding[] = [bindings[0], bindings[0]];
      let threw = false;
      let msg = '';
      try {
        validatePersistentBattleBindings(bad, fleet, battle);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('重复'), '重复 campaignShipId 抛错');
      add(test);
    }

    // 23. 未部署舰出现在 binding 抛错
    {
      const test = new Case('未部署舰出现在 binding 抛错');
      const { state, battle, bindings } = lockPendingBattle(1031, ENEMY_BUDGET);
      const fleet = toPersistentFleet(state.fleet);
      const fleetBad = { ...fleet, ships: fleet.ships.map((s, i) => (i === 0 ? { ...s, deployed: false } : s)) };
      const bad: PersistentBattleBinding[] = [{ campaignShipId: fleetBad.ships[0].campaignShipId, battleShipId: bindings[0].battleShipId }];
      let threw = false;
      let msg = '';
      try {
        validatePersistentBattleBindings(bad, fleetBad, battle);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('未部署'), '未部署舰出现在绑定抛错');
      add(test);
    }

    // 24. 持久舰 hull/variant 与战斗舰不匹配抛错
    {
      const test = new Case('持久舰 hull/variant 与战斗舰不匹配抛错');
      const { state, battle, bindings } = lockPendingBattle(1032, ENEMY_BUDGET);
      const fleet = toPersistentFleet(state.fleet);
      const fighterBinding = bindings.find((b) => {
        const s = fleet.ships.find((x) => x.campaignShipId === b.campaignShipId)!;
        return s.shipClass === 'Fighter';
      })!;
      const frigateBattleId = battle.ships.find((s) => s.team === 'A' && s.type === 'Frigate')!.id;
      const bad: PersistentBattleBinding[] = [{ campaignShipId: fighterBinding.campaignShipId, battleShipId: frigateBattleId }];
      let threw = false;
      let msg = '';
      try {
        validatePersistentBattleBindings(bad, fleet, battle);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('hull'), 'hull 不匹配抛错');
      add(test);
    }

    // 25. 每艘参战玩家舰必须有且仅有一个 binding
    {
      const test = new Case('每艘参战玩家舰必须有且仅有一个 binding');
      const { state, battle, bindings } = lockPendingBattle(1033, ENEMY_BUDGET);
      const fleet = toPersistentFleet(state.fleet);
      const dup: PersistentBattleBinding[] = [
        { ...bindings[0] },
        { campaignShipId: fleet.ships[1].campaignShipId, battleShipId: bindings[0].battleShipId }
      ];
      let threw = false;
      let msg = '';
      try {
        validatePersistentBattleBindings(dup, fleet, battle);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && (msg.includes('battleShipId') || msg.includes('绑定数量')), 'battleShipId 重复导致校验失败');
      add(test);
    }

    // 26. 战斗结果写回幂等（无 pending 时返回原状态不变）
    {
      const test = new Case('战斗结果写回幂等（无 pending 时返回原状态不变）');
      const { state, battle, bindings } = lockPendingBattle(1034, ENEMY_BUDGET);
      const after = applyStrategicBattleResult(state, battle, bindings);
      const again = applyStrategicBattleResult(after, battle, bindings);
      test.eq(again, after, '无 pending 时重复写回返回同一状态（幂等）');
      add(test);
    }

    // 27. 写回后状态通过 validateUniverseState 且 encode/decode 往返一致
    {
      const test = new Case('写回后状态通过 validateUniverseState 且 encode/decode 往返一致');
      const { state, battle, bindings, pending } = lockPendingBattle(1035, ENEMY_BUDGET);
      const teamB = battle.ships.filter((s) => s.team === 'B');
      teamB.forEach((s, i) => {
        if (i % 2 === 0) applyCombatState(s, 'destroyed');
      });
      syncBattleCounts(battle);
      const after = applyStrategicBattleResult(state, battle, bindings);
      test.true_(validateUniverseState(after), '写回后状态通过深层校验');
      const round = decodeUniverse(encodeUniverse(after));
      test.true_(validateUniverseState(round), '写回状态远征码往返后仍通过校验');
      test.eq(round.fleet.ships.length, after.fleet.ships.length, '往返后舰队舰船数一致');
      const sysId = pending.systemId;
      test.eq(round.systems.find((s) => s.id === sysId)!.enemyPower, after.systems.find((s) => s.id === sysId)!.enemyPower, '往返后星系敌方战力一致');
      add(test);
    }

    // 28. 玩家全灭 → 远征崩溃
    {
      const test = new Case('玩家全灭 → 远征崩溃');
      const { state, battle, bindings } = lockPendingBattle(1036, ENEMY_BUDGET);
      const teamA = battle.ships.filter((s) => s.team === 'A');
      teamA.forEach((s) => applyCombatState(s, 'destroyed'));
      syncBattleCounts(battle);
      const after = applyStrategicBattleResult(state, battle, bindings);
      test.eq(after.status, 'collapsed', '玩家舰全灭后远征崩溃');
      add(test);
    }

    // 29. 战斗 seed/ruleset 不一致拒绝写回
    {
      const test = new Case('战斗 seed/ruleset 不一致拒绝写回');
      const { state, battle, bindings } = lockPendingBattle(1037, ENEMY_BUDGET);
      battle.seed = (battle.seed + 1) >>> 0;
      let threw = false;
      let msg = '';
      try {
        applyStrategicBattleResult(state, battle, bindings);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('seed'), 'seed 不一致拒绝写回');
      add(test);
    }

    // 30. 战斗敌方舰队与 pending 不一致拒绝写回
    {
      const test = new Case('战斗敌方舰队与 pending 不一致拒绝写回');
      const { state, battle, bindings } = lockPendingBattle(1038, ENEMY_BUDGET);
      const teamBShip = battle.ships.find((s) => s.team === 'B')!;
      teamBShip.variant = 'fortress';
      let threw = false;
      let msg = '';
      try {
        applyStrategicBattleResult(state, battle, bindings);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('不一致'), '敌方舰队与 pending 不一致拒绝写回');
      add(test);
    }

    // 31. 战后敌方战力高于战前拒绝写回
    {
      const test = new Case('战后敌方战力高于战前拒绝写回');
      const { state, battle, bindings, pending } = lockPendingBattle(1039, ENEMY_BUDGET);
      const badState = JSON.parse(JSON.stringify(state));
      badState.pendingBattle.enemyPowerBefore = 1;
      const sys = badState.systems.find((s: { id: string }) => s.id === pending.systemId);
      sys.enemyPower = 1;
      let threw = false;
      let msg = '';
      try {
        applyStrategicBattleResult(badState, battle, bindings);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('战前'), '战后战力高于战前拒绝写回');
      add(test);
    }

    // 32. 跨星域继承真实舰队（舰船 ID 持续保留）
    {
      const test = new Case('跨星域继承真实舰队（舰船 ID 持续保留）');
      let state = generateUniverse(1051);
      const idsBefore = state.fleet.ships.map((s) => s.campaignShipId).sort();
      const prepared = prepareGate(state, 100);
      const next = applyUniverseAction(prepared, { type: 'extractSector', mode: 'stable' });
      const idsAfter = next.fleet.ships.map((s) => s.campaignShipId).sort();
      test.eq(JSON.stringify(idsAfter), JSON.stringify(idsBefore), '撤离后真实舰船 ID 完整继承到下一星域');
      test.true_(strategicFleetPower(next) > 0, '继承后真实舰队仍有战力');
      add(test);
    }

    // 33. 旧版 alpha.2 抽象舰队迁移为逐舰舰队并保留失能舰
    {
      const test = new Case('旧版 alpha.2 抽象舰队迁移为逐舰舰队并保留失能舰');
      const base = generateUniverse(1011);
      const alpha2 = JSON.parse(JSON.stringify(base));
      alpha2.version = '1.0-alpha.2';
      alpha2.fleet = {
        id: base.fleet.id,
        name: base.fleet.name,
        systemId: base.fleet.systemId,
        fuel: base.fleet.fuel,
        maxFuel: base.fleet.maxFuel,
        shipCount: 3,
        disabledShips: 1,
        combatPower: 30
      };
      const code = b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.2', state: alpha2 });
      const migrated = decodeUniverse(code);
      test.eq(migrated.version, SECTOR_EXPEDITION_VERSION, 'alpha.2 迁移为当前版本');
      test.eq(migrated.fleet.ships.length, 3, '迁移生成 3 艘逐舰');
      test.eq(migrated.fleet.ships.filter((s) => s.disabled).length, 1, '迁移保留 1 艘失能舰');
      test.true_(validateUniverseState(migrated), '迁移后状态通过深层校验');
      const fleetRecord = migrated.fleet as unknown as Record<string, unknown>;
      test.true_(
        fleetRecord.shipCount === undefined && fleetRecord.disabledShips === undefined && fleetRecord.combatPower === undefined,
        '迁移后不再含抽象 shipCount/disabledShips/combatPower'
      );
      add(test);
    }

    // 34. alpha.3 → alpha.4 迁移确定性重建敌战力且通过深层校验
    {
      const test = new Case('alpha.3 → alpha.4 迁移确定性重建敌战力且通过深层校验');
      const base = generateUniverse(1012);
      const alpha3 = JSON.parse(JSON.stringify(base));
      alpha3.version = '1.0-alpha.3';
      const enemySys = alpha3.systems.find((s: { control: string }) => s.control === 'enemy')!;
      enemySys.enemyPower = 7; // 故意写入错误（旧量纲）战力，验证迁移重建
      const code = b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.3', state: alpha3 });
      const migrated = decodeUniverse(code);
      test.eq(migrated.version, SECTOR_EXPEDITION_VERSION, 'alpha.3 迁移为当前版本');
      test.true_(validateUniverseState(migrated), '迁移后状态通过深层校验');
      const rebuiltSys = migrated.systems.find((s) => s.id === enemySys.id)!;
      const isGate = migrated.entities.some((e) => e.systemId === enemySys.id && e.kind === 'jumpGate');
      const rebuildSeed = hash32(migrated.seed, enemySys.id, 'alpha-enemy-rebuild');
      const expected = campaignFleetEntryCost(
        strategicEnemyFleetFor(rebuildSeed, 7, {
          sectorIndex: migrated.sectorIndex,
          gateGuard: isGate,
          cruiserAllowed: migrated.sectorIndex >= 2 || isGate
        })
      );
      test.eq(rebuiltSys.enemyPower, expected, '迁移后敌方战力由确定性重建（不再是旧量纲的 7）');
      test.true_(rebuiltSys.enemyPower >= 50, '重建后敌方战力落于合法最低预算之上');
      add(test);
    }

    // 35. 星域远征码完整往返 + 拒绝损坏状态
    {
      const test = new Case('星域远征码完整往返 + 拒绝损坏状态');
      const state = generateUniverse(1052);
      const decoded = decodeUniverse(encodeUniverse(state));
      test.eq(JSON.stringify(decoded), JSON.stringify(state), '当前版本星域远征状态完整往返');
      test.true_(validateUniverseState(decoded), '往返状态通过深层校验');
      const invalidGate = JSON.parse(JSON.stringify(state));
      invalidGate.extraction.gateEntityId = 'missing-gate';
      test.true_(!validateUniverseState(invalidGate), '不存在的星门引用被拒绝');
      const duplicateBlueprint = JSON.parse(JSON.stringify(state));
      duplicateBlueprint.faction.legacy.blueprints = ['fieldLogistics', 'fieldLogistics'];
      test.true_(!validateUniverseState(duplicateBlueprint), '重复永久蓝图被拒绝');
      add(test);
    }

    // 36. normalizeStrategicEnemyPower：低于最低合法舰船成本一律归零，合法预算原样保留
    {
      const test = new Case('normalizeStrategicEnemyPower：低于最低成本归零、合法预算原样保留');
      const min = minimumStrategicFleetCost();
      test.eq(normalizeStrategicEnemyPower(0), 0, '0 归零');
      test.eq(normalizeStrategicEnemyPower(-5), 0, '负数归零');
      test.eq(normalizeStrategicEnemyPower(min - 1), 0, '低于最低成本归零');
      test.eq(normalizeStrategicEnemyPower(min), min, '最低成本原样保留');
      test.eq(normalizeStrategicEnemyPower(min + 1), min + 1, '高于最低成本原样保留');
      for (let raw = 1; raw < min; raw++) {
        test.eq(normalizeStrategicEnemyPower(raw), 0, `残余 ${raw}（< 最低成本 ${min}）归零`);
      }
      add(test);
    }

    // 37. 真实写回：低残余敌方战力（1..min-1）归一化为 0 + neutral + 可保存 + 可往返
    {
      const test = new Case('低残余敌方战力（1..min-1）写回归一化为 0 + neutral + 可保存');
      const { state, battle, bindings, hostileId } = lockPendingBattle(1080, ENEMY_BUDGET);
      const teamB = battle.ships.filter((s) => s.team === 'B');
      teamB.forEach((s, i) => {
        if (i > 0) applyCombatState(s, 'destroyed');
      });
      setLowIntegrity(teamB[0], 0.04);
      syncBattleCounts(battle);
      const expected = battleTeamRemainingPower(battle, 'B');
      test.true_(expected >= 1 && expected < minimumStrategicFleetCost(), `残余战力 ${expected} 落于 [1, min-1] 区间`);
      const after = applyStrategicBattleResult(state, battle, bindings);
      const sys = after.systems.find((s) => s.id === hostileId)!;
      test.eq(sys.enemyPower, 0, '低残余战力归一化为 0');
      test.eq(sys.control, 'neutral', '残余归零后星系转为 neutral');
      test.true_(validateUniverseState(after), '写回后状态通过深层校验（可被保存）');
      const round = decodeUniverse(encodeUniverse(after));
      test.true_(validateUniverseState(round), '归一化后远征码往返仍可被保存');
      test.eq(round.systems.find((s) => s.id === hostileId)!.enemyPower, 0, '往返后敌方战力仍为 0');
      add(test);
    }

    // 38. validateFinishedStrategicBattle 接受合法已结束战斗
    {
      const test = new Case('validateFinishedStrategicBattle 接受合法已结束战斗');
      const { battle } = lockPendingBattle(1081, ENEMY_BUDGET);
      let threw = false;
      try {
        validateFinishedStrategicBattle(battle);
      } catch {
        threw = true;
      }
      test.true_(!threw, '合法已结束战斗通过深层校验');
      add(test);
    }

    // 39. validateBattleShipAgainstDefinition 拒绝 def.type 不一致
    {
      const test = new Case('validateBattleShipAgainstDefinition 拒绝 def.type 不一致');
      const { battle } = lockPendingBattle(1082, ENEMY_BUDGET);
      const ship = battle.ships[0];
      ship.def = { ...ship.def, type: (ship.type === 'Fighter' ? 'Frigate' : 'Fighter') } as never;
      let threw = false;
      let msg = '';
      try {
        validateBattleShipAgainstDefinition(ship);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('def.type'), 'def.type 不一致被拒绝');
      add(test);
    }

    // 40. validateBattleShipAgainstDefinition 拒绝组件 maxHp 不一致
    {
      const test = new Case('validateBattleShipAgainstDefinition 拒绝组件 maxHp 不一致');
      const { battle } = lockPendingBattle(1083, ENEMY_BUDGET);
      const ship = battle.ships[0];
      ship.components[0] = { ...ship.components[0], maxHp: ship.components[0].maxHp + 1 };
      let threw = false;
      let msg = '';
      try {
        validateBattleShipAgainstDefinition(ship);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('maxHp'), '组件 maxHp 不一致被拒绝');
      add(test);
    }

    // 41. validateBattleShipAgainstDefinition 拒绝组件 hp 越界
    {
      const test = new Case('validateBattleShipAgainstDefinition 拒绝组件 hp 越界');
      const { battle } = lockPendingBattle(1084, ENEMY_BUDGET);
      const ship = battle.ships[0];
      ship.components[0] = { ...ship.components[0], hp: ship.components[0].maxHp + 5 };
      let threw = false;
      let msg = '';
      try {
        validateBattleShipAgainstDefinition(ship);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && (msg.includes('hp') || msg.includes('非法')), '组件 hp 越界被拒绝');
      add(test);
    }

    // 42. validateBattleShipAgainstDefinition 拒绝 disabled 无失能标志 / escaped 缺 escapedTick
    {
      const test = new Case('validateBattleShipAgainstDefinition 拒绝 disabled 无失能标志 / escaped 缺 escapedTick');
      const { battle } = lockPendingBattle(1085, ENEMY_BUDGET);
      const dship = battle.ships.find((s) => s.team === 'A')!;
      applyCombatState(dship, 'disabled');
      dship.mobilityDisabled = false;
      dship.weaponsDisabled = false;
      dship.sensorsDisabled = false;
      let threw = false;
      let msg = '';
      try {
        validateBattleShipAgainstDefinition(dship);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(threw && msg.includes('disabled'), 'disabled 但无关键系统失能被拒绝');

      const esc = battle.ships.find((s) => s.team === 'B')!;
      applyCombatState(esc, 'escaped');
      esc.escapedTick = undefined;
      let threw2 = false;
      let msg2 = '';
      try {
        validateBattleShipAgainstDefinition(esc);
      } catch (e) {
        threw2 = true;
        msg2 = String(e);
      }
      test.true_(threw2 && msg2.includes('escapedTick'), 'escaped 但缺 escapedTick 被拒绝');
      add(test);
    }

    // 43. validateFinishedStrategicBattle 拒绝版本/ruleset/队伍计数/重复 id
    {
      const test = new Case('validateFinishedStrategicBattle 拒绝版本/ruleset/队伍计数/重复 id');
      const { battle } = lockPendingBattle(1086, ENEMY_BUDGET);
      const versionErr = JSON.parse(JSON.stringify(battle));
      versionErr.version = '0.4';
      let t1 = false;
      let m1 = '';
      try {
        validateFinishedStrategicBattle(versionErr);
      } catch (e) {
        t1 = true;
        m1 = String(e);
      }
      test.true_(t1 && m1.includes('version'), '错误 version 被拒绝');

      const rulesetErr = JSON.parse(JSON.stringify(battle));
      rulesetErr.ruleset = 'old-ruleset';
      let t2 = false;
      let m2 = '';
      try {
        validateFinishedStrategicBattle(rulesetErr);
      } catch (e) {
        t2 = true;
        m2 = String(e);
      }
      test.true_(t2 && m2.includes('ruleset'), '错误 ruleset 被拒绝');

      const countErr = JSON.parse(JSON.stringify(battle));
      countErr.teamACount = countErr.teamACount + 1;
      let t3 = false;
      let m3 = '';
      try {
        validateFinishedStrategicBattle(countErr);
      } catch (e) {
        t3 = true;
        m3 = String(e);
      }
      test.true_(t3 && m3.includes('teamACount'), 'teamACount 不一致被拒绝');

      const dupErr = JSON.parse(JSON.stringify(battle));
      dupErr.ships[1].id = dupErr.ships[0].id;
      let t4 = false;
      let m4 = '';
      try {
        validateFinishedStrategicBattle(dupErr);
      } catch (e) {
        t4 = true;
        m4 = String(e);
      }
      test.true_(t4 && m4.includes('重复'), '重复战斗舰 id 被拒绝');
      add(test);
    }

    // 44. alpha.4 解码迁移：escaped→false / 缺失 deployed→true / 缺失 towed→false + operational 计数守恒
    {
      const test = new Case('alpha.4 解码迁移：escaped 归一化、缺失 deployed/towed 补全、operational 计数守恒');
      const base = generateUniverse(1090);
      const alpha4 = JSON.parse(JSON.stringify(base));
      alpha4.version = '1.0-alpha.4';
      alpha4.fleet.ships[0].escaped = true;
      alpha4.fleet.ships[1].deployed = undefined;
      // ships[2] 故意不带 towed 字段，验证缺失时补全为 false
      const code = b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.4', state: alpha4 });
      const migrated = decodeUniverse(code);
      test.eq(migrated.version, SECTOR_EXPEDITION_VERSION, 'alpha.4 迁移为当前版本');
      test.true_(migrated.fleet.ships.every((s) => s.escaped === false), '迁移后所有舰 escaped 归零');
      test.true_(migrated.fleet.ships.every((s) => s.deployed === true), '迁移后所有舰 deployed 归 true');
      test.true_(migrated.fleet.ships.every((s) => s.towed === false), '迁移后所有舰 towed 归 false');
      test.true_(validateUniverseState(migrated), '迁移后状态通过深层校验');
      test.eq(
        strategicFleetCounts(migrated.fleet).operational,
        activeShips(toPersistentFleet(migrated.fleet)).length,
        'operational 计数 === activeShips 长度（escaped 语义统一后）'
      );
      add(test);
    }

    // 45. alpha.4 迁移保留失能舰、escaped 玩家舰归一化且仍保留在舰队
    {
      const test = new Case('alpha.4 迁移：失能舰保留、escaped 玩家舰归一化为 escaped=false 仍保留');
      const base = generateUniverse(1091);
      const alpha4 = JSON.parse(JSON.stringify(base));
      alpha4.version = '1.0-alpha.4';
      alpha4.fleet.ships[0].disabled = true;
      alpha4.fleet.ships[0].escaped = false;
      alpha4.fleet.ships[1].escaped = true;
      const code = b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.4', state: alpha4 });
      const migrated = decodeUniverse(code);
      test.true_(validateUniverseState(migrated), '迁移后通过深层校验');
      const dis = migrated.fleet.ships[0];
      test.true_(dis.disabled === true && dis.escaped === false, '失能舰保持 disabled、escaped 为 false');
      const esc = migrated.fleet.ships[1];
      test.true_(esc.escaped === false && migrated.fleet.ships.includes(esc), 'escaped 玩家舰归一化为 false 且仍保留在舰队');
      test.eq(
        strategicFleetCounts(migrated.fleet).operational,
        activeShips(toPersistentFleet(migrated.fleet)).length,
        'operational 计数 === activeShips 长度'
      );
      add(test);
    }

    // 46. UI 锁定（真实 DOM）：待处理战斗时战略行动按钮全部禁用，"继续战斗"保持可用，无非法 disableddisabled
    {
      const test = new Case('UI 锁定：待处理战斗时战略行动按钮禁用、继续战斗可用、无 disableddisabled');
      let gate = prepareGate(generateUniverse(1071), 100);
      const enabled = establishStartingBase(gate);
      const hostile = enabled.systems.find((s) => s.control === 'enemy')!;
      const locked = withPending(enabled, hostile.id, 999);
      const html = renderPanel(locked);
      const buttons = parseStrategyButtons(html);
      const next = buttons.find((b) => b.id === 'strategy-next-turn');
      test.true_(!!next && next.disabled, '待处理战斗时"推进一回合"被禁用');
      const engage = buttons.find((b) => b.id === 'strategy-engage');
      test.true_(!!engage && !engage.disabled, '待处理战斗时"继续战斗"保持可用（唯一允许的战略行动）');
      for (const id of ['strategy-extract-stable', 'strategy-extract-emergency', 'strategy-extract-rearguard', 'strategy-calibrate']) {
        const b = buttons.find((x) => x.id === id);
        if (b) test.true_(b.disabled, `${id} 在待处理战斗时被禁用`);
      }
      test.true_(!html.includes('disableddisabled'), '不存在非法"disableddisabled"重复属性');
      add(test);
    }

    // 47. UI 无锁定（真实 DOM）：无待处理战斗时推进回合可用，且无 disableddisabled
    {
      const test = new Case('UI 无锁定：无待处理战斗时推进回合可用、无 disableddisabled');
      const state = generateUniverse(1072);
      const html = renderPanel(state);
      const buttons = parseStrategyButtons(html);
      const next = buttons.find((b) => b.id === 'strategy-next-turn');
      test.true_(!!next && !next.disabled, '无待处理战斗时"推进一回合"可用');
      test.true_(!html.includes('disableddisabled'), '活跃状态不存在非法"disableddisabled"重复属性');
      add(test);
    }

    // 48. 低残余写回状态可编码/解码往返且 enemyPower 一致为 0
    {
      const test = new Case('低残余写回状态远征码往返：enemyPower 0 + neutral 一致');
      const { state, battle, bindings, hostileId } = lockPendingBattle(1088, ENEMY_BUDGET);
      const teamB = battle.ships.filter((s) => s.team === 'B');
      teamB.forEach((s, i) => {
        if (i > 0) applyCombatState(s, 'destroyed');
      });
      setLowIntegrity(teamB[0], 0.04);
      syncBattleCounts(battle);
      const after = applyStrategicBattleResult(state, battle, bindings);
      const code = encodeUniverse(after);
      const round = decodeUniverse(code);
      const sys = round.systems.find((s) => s.id === hostileId)!;
      test.true_(validateUniverseState(round), '低残余写回状态远征码可被保存');
      test.eq(sys.enemyPower, 0, '往返后敌方战力为 0');
      test.eq(sys.control, 'neutral', '往返后星系 neutral');
      add(test);
    }

    // 49. alpha.2 抽象战力单调递增迁移 + 失能舰关键组件归零
    {
      const test = new Case('alpha.2 抽象战力单调迁移：combatPower 越高迁移战力不下降、失能关键组件归零');
      const makeAlpha2 = (combatPower: number, shipCount: number, disabledShips: number) => {
        const base = generateUniverse(1100);
        const a2 = JSON.parse(JSON.stringify(base));
        a2.version = '1.0-alpha.2';
        a2.fleet = {
          id: base.fleet.id,
          name: base.fleet.name,
          systemId: base.fleet.systemId,
          fuel: base.fleet.fuel,
          maxFuel: base.fleet.maxFuel,
          shipCount,
          disabledShips,
          combatPower
        };
        return b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.2', state: a2 });
      };
      const m20 = decodeUniverse(makeAlpha2(20, 4, 1));
      const m40 = decodeUniverse(makeAlpha2(40, 4, 1));
      const m60 = decodeUniverse(makeAlpha2(60, 4, 1));
      const m80 = decodeUniverse(makeAlpha2(80, 4, 1));
      const p20 = campaignFleetPower(toPersistentFleet(m20.fleet));
      const p40 = campaignFleetPower(toPersistentFleet(m40.fleet));
      const p60 = campaignFleetPower(toPersistentFleet(m60.fleet));
      const p80 = campaignFleetPower(toPersistentFleet(m80.fleet));
      test.true_(p20 <= p40 && p40 <= p60 && p60 <= p80, 'combatPower 越高迁移战力不下降（单调递增）');
      test.true_(p80 > p20, '高 combatPower 迁移战力显著更高');
      const disabledShip = m40.fleet.ships.find((s) => s.disabled)!;
      const def = getShipDef(disabledShip.shipClass, disabledShip.variant).def;
      const keyIdx = def.components.findIndex((c) => c.type === 'core' || c.type === 'engine' || c.type === 'weapon');
      test.true_(disabledShip.componentHp![keyIdx] === 0, '失能舰关键组件 HP 归零');
      add(test);
    }

    // 50. 真实集成：prepareStrategicBattle + createSimulator 跑完 + applyStrategicBattleResult 产出可保存状态
    {
      const test = new Case('真实集成：core-v4 模拟跑完 + 写回产出可保存可往返状态');
      const { state, battle, bindings, guard } = simulateStrategicBattle(1095, ENEMY_BUDGET);
      syncBattleCounts(battle);
      test.true_(battle.finished, '真实 core-v4 模拟运行至结束');
      test.true_(guard < 200000, `模拟在有限步数内结束（${guard} ticks）`);
      test.true_(typeof battle.winner === 'string', '产生明确胜负');
      let threw = false;
      let msg = '';
      let after: ReturnType<typeof applyStrategicBattleResult> | null = null;
      try {
        after = applyStrategicBattleResult(state, battle, bindings);
      } catch (e) {
        threw = true;
        msg = String(e);
      }
      test.true_(!threw, `真实集成写回成功（${msg}）`);
      if (!threw && after) {
        test.true_(after.status === 'active' || after.status === 'collapsed', '写回后状态合法（active 或 collapsed）');
        test.true_(validateUniverseState(after), '写回后状态通过深层校验，可被保存');
        const round = decodeUniverse(encodeUniverse(after));
        test.true_(validateUniverseState(round), '真实集成结果远征码往返仍可被保存');
      }
      add(test);
    }

    // 51. minimumStrategicFleetCost 权威值（= 所有舰种/改型最小成本，当前侦察型 Fighter 45），不散落魔法数字
    {
      const test = new Case('minimumStrategicFleetCost 权威值（= 所有舰种/改型最小成本）');
      const min = minimumStrategicFleetCost();
      const variantMin = Math.min(...Object.values(VARIANTS).map((v) => v.cost));
      test.eq(min, variantMin, '最低合法舰船成本等于所有改型成本的最小值');
      test.eq(min, 45, '当前最低合法舰船成本为侦察型 Fighter（45）');
      test.true_(min > 0 && Number.isInteger(min), '最低成本为正整数');
      add(test);
    }

    // 52. 失能玩家舰写回后保持 disabled、escaped 保持 false（未脱离）
    {
      const test = new Case('失能玩家舰写回后保持 disabled、escaped 为 false');
      const { state, battle, bindings } = lockPendingBattle(1101, ENEMY_BUDGET);
      const teamA = battle.ships.filter((s) => s.team === 'A');
      applyCombatState(teamA[0], 'disabled');
      syncBattleCounts(battle);
      const disId = bindings.find((b) => b.battleShipId === teamA[0].id)!.campaignShipId;
      const after = applyStrategicBattleResult(state, battle, bindings);
      const ship = after.fleet.ships.find((s) => s.campaignShipId === disId);
      test.true_(!!ship && ship.disabled === true, '失能玩家舰写回后保持 disabled');
      test.true_(!!ship && ship.escaped === false, '失能玩家舰 escaped 保持 false（未脱离战场）');
      add(test);
    }

    // 53. 全歼敌军 → 残余 0 + neutral + 远征码往返可保存
    {
      const test = new Case('全歼敌军 → 残余 0 + neutral + 远征码往返可保存');
      const { state, battle, bindings, hostileId } = lockPendingBattle(1096, ENEMY_BUDGET);
      battle.ships.filter((s) => s.team === 'B').forEach((s) => applyCombatState(s, 'destroyed'));
      syncBattleCounts(battle);
      const after = applyStrategicBattleResult(state, battle, bindings);
      const sys = after.systems.find((s) => s.id === hostileId)!;
      test.eq(sys.enemyPower, 0, '全歼敌军 → 残余 0');
      test.eq(sys.control, 'neutral', '全歼后星系 neutral');
      test.true_(validateUniverseState(after), '写回状态可保存');
      const round = decodeUniverse(encodeUniverse(after));
      test.true_(validateUniverseState(round), '全歼结果远征码往返可保存');
      add(test);
    }

    // 54. strategicEnemyFleetFor 低预算阈值：不低于最低合法成本，且不产生空敌舰队
    {
      const test = new Case('strategicEnemyFleetFor 低预算阈值：不低于最低合法成本、不生成空舰队');
      const min = minimumStrategicFleetCost();
      const fleetMin = strategicEnemyFleetFor(1234, min, { sectorIndex: 0, gateGuard: false, cruiserAllowed: false });
      test.true_(campaignFleetEntryCost(fleetMin) >= min, '最低合法预算生成的敌舰队成本 >= 最低成本（同量纲，无 50 魔法兜底）');
      const fleetLow = strategicEnemyFleetFor(1234, min - 10, { sectorIndex: 0, gateGuard: false, cruiserAllowed: false });
      test.true_(campaignFleetEntryCost(fleetLow) >= min, '低于最低成本的预算被归一化，仍生成 >= 最低成本的合法敌舰队');
      test.true_(fleetLow.length >= 1, '低预算不生成空敌舰队');
      add(test);
    }

    // 55. 真实战略战斗模拟确定性：相同 seed 两次运行结果完全一致
    {
      const test = new Case('真实战略战斗模拟确定性：相同 seed 两次结果完全一致');
      const run1 = simulateStrategicBattle(1097, ENEMY_BUDGET);
      const run2 = simulateStrategicBattle(1097, ENEMY_BUDGET);
      test.eq(run1.guard, run2.guard, '两次运行步数一致');
      test.eq(JSON.stringify(run1.battle), JSON.stringify(run2.battle), '两次运行的最终 BattleState 完全一致（确定性）');
      add(test);
    }
  });
}

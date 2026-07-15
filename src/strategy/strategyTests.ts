import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { generateUniverse, hash32 } from './universeGenerator';
import { decodeUniverse, encodeUniverse, legacyAbstractPowerToCoreBudget, validateUniverseState } from './universePersistence';
import {
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  applyStrategicBattleResult,
  applyUniverseAction,
  advanceUniverseTurn,
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
import {
  activeShips,
  computePersistentDisableFlags,
  isPersistentShipDisabled,
  isShipDeployable
} from '../campaign/fleet/persistentFleet';
import { defaultDeployment, deploymentFleet, toggleDeploymentShip } from '../campaign/deployment/deploymentSystem';
import { boxStrategicEnemyFleet, strategicEnemyFleetFor, prepareStrategicBattle, validatePersistentBattleBindings } from '../campaign/fleet/battleAdapter';
import type { PersistentBattleBinding } from '../campaign/fleet/battleAdapter';
import type { BattleState, CombatState } from '../sim/battleTypes';
import { createSimulator } from '../sim/rulesets';
import { isPresentOnBattlefield, isStructurallyAlive } from '../sim/shipFlags';
import { computeCombatState } from '../sim/combatState';
import { SECTOR_EXPEDITION_VERSION } from './universeTypes';
import type { UniverseAction } from './universeTypes';
import { StrategicUniversePanel } from '../ui/strategicUniversePanel';
import { JSDOM } from 'jsdom';

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

/** 直接修改战斗舰的 combatState 及其组件 HP（无需伪造 BattleState 结构），并补齐状态机相关字段使其通过深层校验。
 *  修饰后的状态与真实模拟器 recomputeDerivedV4 / 死亡规则完全一致：
 *  - destroyed：全组件摧毁 ⇒ alive=false 且三个失能标志均为 true，且不残留 tick；
 *  - disabled：完整摧毁一个关键系统（全部引擎或全部武器）⇒ 对应失能标志为 true、alive=true；
 *  - escaped/retreating：组件满血未摧毁 ⇒ 三个失能标志均为 false、alive=true，且仅保留对应 tick；
 *  - 其余状态：组件满血未摧毁 ⇒ 失能标志均为 false、alive=true。 */
function applyCombatState(ship: Ship, state: CombatState): void {
  ship.combatState = state;
  ship.escapedTick = undefined;
  ship.retreatStartedTick = undefined;
  if (state === 'destroyed') {
    for (const component of ship.components) {
      component.hp = 0;
      component.destroyed = true;
    }
    ship.alive = false;
    ship.mobilityDisabled = true;
    ship.weaponsDisabled = true;
    ship.sensorsDisabled = true;
  } else if (state === 'disabled') {
    // 优先选择引擎或武器（而非核心），并摧毁该类型的全部组件，使其与 core-v4 的“全系统损毁”规则一致。
    const target = ship.components.find(
      (component) => component.def.type === 'engine' || component.def.type === 'weapon'
    );
    ship.mobilityDisabled = false;
    ship.weaponsDisabled = false;
    if (target) {
      const type = target.def.type;
      for (const component of ship.components) {
        if (component.def.type !== type) continue;
        component.hp = 0;
        component.destroyed = true;
      }
      if (type === 'engine') ship.mobilityDisabled = true;
      if (type === 'weapon') ship.weaponsDisabled = true;
    }
    ship.alive = true;
    ship.sensorsDisabled = false;
  } else if (state === 'escaped') {
    ship.escapedTick = 1;
    for (const component of ship.components) {
      component.hp = component.maxHp;
      component.destroyed = false;
    }
    ship.alive = true;
    ship.mobilityDisabled = false;
    ship.weaponsDisabled = false;
    ship.sensorsDisabled = false;
  } else if (state === 'retreating') {
    ship.retreatStartedTick = 1;
    for (const component of ship.components) {
      component.hp = component.maxHp;
      component.destroyed = false;
    }
    ship.alive = true;
    ship.mobilityDisabled = false;
    ship.weaponsDisabled = false;
    ship.sensorsDisabled = false;
  } else {
    for (const component of ship.components) {
      component.hp = component.maxHp;
      component.destroyed = false;
    }
    ship.alive = true;
    ship.mobilityDisabled = false;
    ship.weaponsDisabled = false;
    ship.sensorsDisabled = false;
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

/** 将战斗舰置为低完整度 operational 状态（用于制造"低残余敌方战力"场景，且不触发任何失能/脱离标记）。 */
function setLowIntegrity(ship: Ship, fraction: number): void {
  for (const component of ship.components) {
    component.hp = Math.max(1, Math.round(component.maxHp * fraction));
    component.destroyed = false;
  }
  ship.mobilityDisabled = false;
  ship.weaponsDisabled = false;
  ship.sensorsDisabled = false;
  ship.escapedTick = undefined;
  ship.retreatStartedTick = undefined;
  ship.combatState = computeCombatState(ship, false);
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
  // 直接使用模拟器权威输出：getState() 返回与传入 ctx.state 同一引用（构造时 this.state = state），
  // 模拟器已在每 tick 末维护 teamACount/teamBCount 等字段，无需 syncBattleCounts 手工回写，也不经 as unknown as 伪造。
  return { state, battle: sim.getState(), bindings: ctx.bindings, pending, guard };
}

/** 使用 jsdom 的真实 HTMLElement / button disabled 行为渲染战略面板。 */
function renderPanelToRoot(state: ReturnType<typeof generateUniverse>): {
  root: HTMLDivElement;
  html: string;
  calls: { actions: number; exports: number; exits: number; actionLog: UniverseAction[] };
} {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const root = dom.window.document.createElement('div');
  const calls = { actions: 0, exports: 0, exits: 0, actionLog: [] as UniverseAction[] };
  const panel = new StrategicUniversePanel(root, {
    onAction: (action) => {
      calls.actions++;
      calls.actionLog.push(action);
    },
    onExport: () => {
      calls.exports++;
    },
    onExit: () => {
      calls.exits++;
    },
  });
  panel.render(state);
  return { root, html: root.innerHTML, calls };
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
      test.true_(budgets.every((b) => b >= minimumStrategicFleetCost()), '所有敌方预算不低于最低合法舰船成本');
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
      test.true_(weakPower >= minimumStrategicFleetCost(), '敌方强度由预算决定（不低于最低合法舰船成本）而非被低估');
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
      hostile.enemyPower = minimumStrategicFleetCost();
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
      // pending 必须来自真实 engageEnemy 流程，不能使用空 enemyFleet 手写测试桩。
      const { state: locked } = lockPendingBattle(1018, ENEMY_BUDGET);
      test.true_(locked.pendingBattle!.enemyFleet.length > 0, 'pending 由真实敌军交战流程生成');
      test.true_(!canExtractSector(locked, 'stable'), '真实 pending 时稳定撤离被锁定');
      test.true_(!canExtractSector(locked, 'emergency'), '真实 pending 时紧急撤离被锁定');
      test.true_(!canCalibrateGate(locked), '真实 pending 时星门校准被锁定');
      test.true_(!canQueueFacility(locked, 'miningArray'), '真实 pending 时建造被锁定');
      test.true_(!canQueueResearch(locked, 'routeAnalysis'), '真实 pending 时科研被锁定');
      test.true_(!canEngageEnemy(locked), '真实 pending 时不可发起新攻击');
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
      test.true_(threw && msg.includes('参战资格'), '未部署舰出现在绑定抛错');
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
      test.true_(migrated.log[0].text.includes(`迁移至 ${SECTOR_EXPEDITION_VERSION}`), 'alpha.3 迁移日志报告真实目标版本');
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
      test.eq(rebuiltSys.enemyPower, 0, '低于最低合法成本的旧战力（7）归一化为 0，不再膨胀成整舰');
      test.eq(rebuiltSys.control, 'neutral', '归一化为 0 后系统转为 neutral（无敌军）');
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
      // applyCombatState('disabled') 已制造真实关键系统损毁并置对应失能标志；此处再手动清掉标志，
      // 构造"标记 disabled 却与真实组件损毁不一致"的状态——校验层必须拒绝（两种拒绝口径任一均可）。
      test.true_(threw && (msg.includes('disabled') || msg.includes('不一致')), 'disabled 但无关键系统失能（或与真实损毁不一致）被拒绝');

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
      test.true_(migrated.log[0].text.includes(`迁移至 ${SECTOR_EXPEDITION_VERSION}`), 'alpha.4 迁移日志报告真实目标版本');
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

    // 46. UI 锁定（jsdom 真实 DOM）：禁用按钮真实 disabled===true 且 click() 不触发回调；继续战斗/导出/返回真实可用
    {
      const test = new Case('UI 锁定：真实 DOM——禁用按钮 disabled 且不触发回调、继续/导出/返回可用');
      const { state: locked } = lockPendingBattle(1071, ENEMY_BUDGET);
      test.true_(locked.pendingBattle!.enemyFleet.length > 0, 'pending 来自真实 engageEnemy 流程');
      const { root, html, calls } = renderPanelToRoot(locked);
      // 禁用按钮：推进一回合
      const next = root.querySelector<HTMLButtonElement>('#strategy-next-turn');
      test.true_(!!next, '存在"推进一回合"按钮');
      if (next) {
        test.true_(next.disabled === true, '待处理战斗时"推进一回合"真实 disabled===true');
        const before = calls.actions;
        next.click();
        test.eq(calls.actions, before, '点击禁用按钮不触发 onAction 回调');
      }
      // 继续战斗：保持可用且点击触发 onAction
      const engage = root.querySelector<HTMLButtonElement>('#strategy-engage');
      test.true_(!!engage, '存在"继续战斗"按钮');
      if (engage) {
        test.true_(engage.disabled === false, '待处理战斗时"继续战斗"真实 disabled===false');
        const before = calls.actions;
        engage.click();
        test.eq(calls.actions, before + 1, '点击"继续战斗"触发 onAction 回调');
      }
      // 导出/返回：真实可用且点击触发各自回调
      const exportBtn = root.querySelector<HTMLButtonElement>('#strategy-export');
      test.true_(!!exportBtn && exportBtn.disabled === false, '导出按钮真实可用');
      if (exportBtn) {
        const before = calls.exports;
        exportBtn.click();
        test.eq(calls.exports, before + 1, '点击"导出"触发 onExport 回调');
      }
      const exitBtn = root.querySelector<HTMLButtonElement>('#strategy-exit');
      test.true_(!!exitBtn && exitBtn.disabled === false, '返回按钮真实可用');
      if (exitBtn) {
        const before = calls.exits;
        exitBtn.click();
        test.eq(calls.exits, before + 1, '点击"返回"触发 onExit 回调');
      }
      // 选择系统按钮真实可用（未被锁定）
      const systemBtns = root.querySelectorAll<HTMLButtonElement>('[data-strategy-system]');
      test.true_(systemBtns.length > 0, '存在可选系统按钮');
      test.true_(Array.from(systemBtns).every((b) => b.disabled === false), '可选系统按钮均未被禁用');
      test.true_(!html.includes('disableddisabled'), '不存在非法"disableddisabled"重复属性');
      add(test);
    }

    // 47. UI 无锁定（jsdom 真实 DOM）：每类战略按钮都在自身合法状态下可点击并发出正确 action。
    {
      const test = new Case('UI 无锁定：真实合法状态覆盖全部战略行动按钮');
      const assertEnabled = (
        state: ReturnType<typeof generateUniverse>, selector: string, label: string, expectedType: UniverseAction['type']
      ) => {
        test.true_(validateUniverseState(state), `${label} 的 UI fixture 可保存`);
        const { root, calls } = renderPanelToRoot(state);
        const button = Array.from(root.querySelectorAll<HTMLButtonElement>(selector)).find((candidate) => !candidate.disabled);
        test.true_(!!button && button.disabled === false, `${label} 真实 disabled===false`);
        if (button) {
          const before = calls.actionLog.length;
          button.click();
          test.eq(calls.actionLog.length, before + 1, `${label} click 触发一次 onAction`);
          test.eq(calls.actionLog[calls.actionLog.length - 1]?.type, expectedType, `${label} 发出 ${expectedType}`);
        }
      };

      const start = generateUniverse(1072);
      assertEnabled(start, '#strategy-next-turn', 'next turn', 'advanceTurn');

      const travelState = generateUniverse(1074);
      const current = travelState.systems.find((system) => system.id === travelState.fleet.systemId)!;
      const destination = travelState.systems.find((system) => current.neighbors.includes(system.id))!;
      destination.discovered = true;
      if (!travelState.faction.knownSystemIds.includes(destination.id)) travelState.faction.knownSystemIds.push(destination.id);
      travelState.selectedSystemId = destination.id;
      assertEnabled(travelState, '[data-strategy-travel]', 'travel', 'travel');

      const surveyState = generateUniverse(1075);
      const surveyTarget = surveyState.entities.find((entity) =>
        entity.systemId === surveyState.fleet.systemId && entity.discovered && !entity.surveyed
      )!;
      assertEnabled(surveyState, `[data-strategy-survey="${surveyTarget.id}"]`, 'survey', 'surveyEntity');

      const asteroidState = generateUniverse(1076);
      const asteroid = asteroidState.entities.find((entity) =>
        entity.systemId === asteroidState.fleet.systemId && entity.kind === 'asteroidField'
      )!;
      const surveyedAsteroidState = asteroid.surveyed
        ? asteroidState
        : applyUniverseAction(asteroidState, { type: 'surveyEntity', entityId: asteroid.id });
      assertEnabled(surveyedAsteroidState, `[data-strategy-extract="${asteroid.id}"]`, 'asteroid extract', 'extractAsteroid');

      const baseState = generateUniverse(1077);
      const station = baseState.entities.find((entity) =>
        entity.systemId === baseState.fleet.systemId && entity.kind === 'station'
      )!;
      assertEnabled(baseState, `[data-strategy-base="${station.id}"]`, 'establish base', 'establishBase');

      const managementState = establishStartingBase(generateUniverse(1078));
      managementState.faction.resources = { minerals: 100, energy: 100, science: 100, supplies: 100 };
      assertEnabled(managementState, '[data-strategy-build]', 'build', 'queueConstruction');
      assertEnabled(managementState, '[data-strategy-research]', 'research', 'queueResearch');

      const repairState = JSON.parse(JSON.stringify(managementState)) as ReturnType<typeof generateUniverse>;
      const repairBase = repairState.entities.find((entity) => entity.id === repairState.faction.baseEntityId)!;
      repairBase.facilities = [{ id: 'ui-repair', type: 'repairDock', level: 1 }];
      const damaged = repairState.fleet.ships.find((ship) => ship.shipClass === 'Frigate')!;
      const damagedDef = getShipDef(damaged.shipClass, damaged.variant).def;
      damaged.componentHp = damagedDef.components.map((component) => component.maxHp);
      damagedDef.components.forEach((component, index) => {
        if (component.type === 'engine') damaged.componentHp![index] = 0;
      });
      damaged.disabled = isPersistentShipDisabled(damaged);
      assertEnabled(repairState, `[data-strategy-repair="${damaged.campaignShipId}"]`, 'repair', 'repairShip');

      const calibrateState = prepareGate(generateUniverse(1079), 50);
      assertEnabled(calibrateState, '#strategy-calibrate', 'calibrate', 'calibrateGate');
      const extractionState = prepareGate(generateUniverse(1080), 100);
      assertEnabled(extractionState, '#strategy-extract-stable', 'stable extraction', 'extractSector');
      assertEnabled(extractionState, '#strategy-extract-emergency', 'emergency extraction', 'extractSector');
      assertEnabled(extractionState, '#strategy-extract-rearguard', 'rearguard extraction', 'extractSector');
      add(test);
    }

    // 47.1 pending 必须来自真实 engageEnemy。DOM 只检查真实可渲染按钮；全部行动另由 reducer 锁兜底。
    {
      const test = new Case('UI 锁定：合法真实 pending 的 DOM 与 reducer 行动锁');
      let pendingState = establishStartingBase(generateUniverse(1081));
      pendingState.faction.resources = { minerals: 100, energy: 100, science: 100, supplies: 100 };
      const hostile = pendingState.systems.find((system) => system.control === 'enemy')!;
      pendingState.fleet.systemId = hostile.id;
      pendingState.selectedSystemId = hostile.id;
      hostile.discovered = true;
      if (!pendingState.faction.knownSystemIds.includes(hostile.id)) pendingState.faction.knownSystemIds.push(hostile.id);
      pendingState = applyUniverseAction(pendingState, { type: 'engageEnemy' });
      const selectedNeighbor = pendingState.systems.find((system) => hostile.neighbors.includes(system.id))!;
      selectedNeighbor.discovered = true;
      if (!pendingState.faction.knownSystemIds.includes(selectedNeighbor.id)) pendingState.faction.knownSystemIds.push(selectedNeighbor.id);
      pendingState = applyUniverseAction(pendingState, { type: 'selectSystem', systemId: selectedNeighbor.id });
      test.true_(validateUniverseState(pendingState), 'pending UI fixture 来自真实流程且可保存');
      test.true_((pendingState.pendingBattle?.enemyFleet.length ?? 0) > 0, '真实 pending 包含合法敌军');

      const rendered = renderPanelToRoot(pendingState);
      const assertLocked = (selector: string, label: string) => {
        const buttons = Array.from(rendered.root.querySelectorAll<HTMLButtonElement>(selector));
        test.true_(buttons.length > 0 && buttons.every((button) => button.disabled), `${label} 在 pending 时真实 disabled===true`);
        for (const button of buttons) {
          const before = rendered.calls.actions;
          button.click();
          test.eq(rendered.calls.actions, before, `${label} 的禁用 click 不触发 onAction`);
        }
      };
      assertLocked('#strategy-next-turn', 'next turn');
      assertLocked('[data-strategy-travel]', 'travel');
      assertLocked('[data-strategy-build]', 'build');
      assertLocked('[data-strategy-research]', 'research');

      const pendingActions: UniverseAction[] = [
        { type: 'advanceTurn' },
        { type: 'travel', systemId: selectedNeighbor.id },
        { type: 'surveyEntity', entityId: pendingState.entities[0].id },
        { type: 'extractAsteroid', entityId: pendingState.entities.find((entity) => entity.kind === 'asteroidField')!.id },
        { type: 'establishBase', entityId: pendingState.entities.find((entity) => entity.kind === 'station')!.id },
        { type: 'queueConstruction', facilityType: 'solarArray' },
        { type: 'queueResearch', projectId: 'routeAnalysis' },
        { type: 'repairShip', campaignShipId: pendingState.fleet.ships[0].campaignShipId },
        { type: 'calibrateGate' },
        { type: 'extractSector', mode: 'stable' },
        { type: 'extractSector', mode: 'emergency' },
        { type: 'extractSector', mode: 'emergency', rearguardShips: 1 },
      ];
      for (const action of pendingActions) {
        test.true_(applyUniverseAction(pendingState, action) === pendingState, `pending reducer 拒绝 ${action.type}`);
      }

      const continueBattle = rendered.root.querySelector<HTMLButtonElement>('#strategy-engage');
      test.true_(!!continueBattle && !continueBattle.disabled, 'continue battle 保持可用');
      if (continueBattle) {
        const before = rendered.calls.actions;
        continueBattle.click();
        test.eq(rendered.calls.actions, before + 1, 'continue battle click 触发回调');
        test.eq(rendered.calls.actionLog[rendered.calls.actionLog.length - 1]?.type, 'engageEnemy', 'continue battle 发出 engageEnemy');
      }
      const systemButton = rendered.root.querySelector<HTMLButtonElement>('[data-strategy-system]');
      test.true_(!!systemButton && !systemButton.disabled, 'system selection 保持可用');
      if (systemButton) {
        const before = rendered.calls.actions;
        systemButton.click();
        test.eq(rendered.calls.actions, before + 1, 'system selection click 触发回调');
      }
      const exportButton = rendered.root.querySelector<HTMLButtonElement>('#strategy-export');
      const exitButton = rendered.root.querySelector<HTMLButtonElement>('#strategy-exit');
      test.true_(!!exportButton && !exportButton.disabled && !!exitButton && !exitButton.disabled, 'export 与 exit 保持可用');
      if (exportButton) { const before = rendered.calls.exports; exportButton.click(); test.eq(rendered.calls.exports, before + 1, 'export click 触发回调'); }
      if (exitButton) { const before = rendered.calls.exits; exitButton.click(); test.eq(rendered.calls.exits, before + 1, 'exit click 触发回调'); }
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
      const m35 = decodeUniverse(makeAlpha2(35, 4, 1));
      const m55 = decodeUniverse(makeAlpha2(55, 4, 1));
      const m75 = decodeUniverse(makeAlpha2(75, 4, 1));
      const m90 = decodeUniverse(makeAlpha2(90, 4, 1));
      const p35 = campaignFleetPower(toPersistentFleet(m35.fleet));
      const p55 = campaignFleetPower(toPersistentFleet(m55.fleet));
      const p75 = campaignFleetPower(toPersistentFleet(m75.fleet));
      const p90 = campaignFleetPower(toPersistentFleet(m90.fleet));
      test.true_(p35 <= p55 && p55 <= p75 && p75 <= p90, 'combatPower 越高迁移战力不下降（单调递增）');
      test.true_(p90 > p35, '高 combatPower 迁移战力显著更高');
      // 真实 campaignFleetPower 校准：迁移后舰队真实战力应逼近 legacyAbstractPowerToCoreBudget 目标（离散取整误差有界）。
      // 采用中段 combatPower，使目标落在"可作战舰 35% 下限 ~ 满血上限"的可达区间内（极_low/极_high 会被钳到下限/上限，属正常）。
      const calTarget = (cp: number) => legacyAbstractPowerToCoreBudget(4, cp);
      const calTol = (exp: number) => Math.max(8, Math.round(exp * 0.05));
      test.true_(Math.abs(p35 - calTarget(35)) <= calTol(calTarget(35)), 'combatPower=35 迁移战力经真实 campaignFleetPower 校准逼近目标');
      test.true_(Math.abs(p55 - calTarget(55)) <= calTol(calTarget(55)), 'combatPower=55 迁移战力经真实 campaignFleetPower 校准逼近目标');
      test.true_(Math.abs(p75 - calTarget(75)) <= calTol(calTarget(75)), 'combatPower=75 迁移战力经真实 campaignFleetPower 校准逼近目标');
      test.true_(Math.abs(p90 - calTarget(90)) <= calTol(calTarget(90)), 'combatPower=90 迁移战力经真实 campaignFleetPower 校准逼近目标');
      const disabledShip = m55.fleet.ships.find((s) => s.disabled)!;
      const def = getShipDef(disabledShip.shipClass, disabledShip.variant).def;
      const keyIdx = def.components.findIndex((c) => c.type === 'engine' || c.type === 'weapon' || c.type === 'sensor');
      test.true_(disabledShip.componentHp![keyIdx] === 0, '失能舰非核心关键组件 HP 归零（核心保持正值）');
      add(test);
    }

    // 50. 真实集成：prepareStrategicBattle + createSimulator 跑完 + applyStrategicBattleResult 产出可保存状态
    {
      const test = new Case('真实集成：core-v4 模拟跑完 + 写回产出可保存可往返状态');
      const { state, battle, bindings, guard } = simulateStrategicBattle(1095, ENEMY_BUDGET);
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

    // 54. strategicEnemyFleetFor 低预算阈值：等于最低合法成本生成最小合法舰队；低于最低成本归一化为 0 → 空舰队（不再膨胀成整舰）
    {
      const test = new Case('strategicEnemyFleetFor 低预算阈值：等于最低成本生成最小舰队、低于最低成本归一化为空舰队');
      const min = minimumStrategicFleetCost();
      const fleetMin = strategicEnemyFleetFor(1234, min, { sectorIndex: 0, gateGuard: false, cruiserAllowed: false });
      test.true_(campaignFleetEntryCost(fleetMin) >= min, '最低合法预算生成的敌舰队成本 >= 最低成本（同量纲，无 50 魔法兜底）');
      test.true_(fleetMin.length >= 1, '最低合法预算生成非空敌舰队');
      const fleetLow = strategicEnemyFleetFor(1234, min - 10, { sectorIndex: 0, gateGuard: false, cruiserAllowed: false });
      test.eq(fleetLow.length, 0, '低于最低成本的预算归一化为 0 → 空敌舰队（不再膨胀成整舰 / 标准战斗机兜底）');
      test.eq(campaignFleetEntryCost(fleetLow), 0, '低于最低成本的预算生成舰队成本为 0');
      const fleetZero = strategicEnemyFleetFor(1234, 0, { sectorIndex: 0, gateGuard: false, cruiserAllowed: false });
      test.eq(fleetZero.length, 0, '零预算也生成空敌舰队');
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

    // 56. pending deployment 的保存边界必须与战略参战资格一致。
    {
      const test = new Case('pending deployment 严格拒绝非法集合');
      const { state } = lockPendingBattle(1201, ENEMY_BUDGET);
      const id = state.fleet.ships[0].campaignShipId;
      const rejected = (ids: string[], mutate?: (copy: any) => void) => {
        const copy = JSON.parse(JSON.stringify(state));
        copy.pendingBattle.deployment = { selectedShipIds: ids };
        mutate?.(copy);
        return !validateUniverseState(copy);
      };
      test.true_(rejected([]), '空 deployment 被拒绝');
      test.true_(rejected([id, id]), '重复 ID 被拒绝');
      test.true_(rejected(['missing']), '不存在 ID 被拒绝');
      test.true_(rejected([id], (copy) => { copy.fleet.ships[0].deployed = false; }), 'deployed=false 舰被拒绝');
      test.true_(rejected([id], (copy) => {
        const ship = copy.fleet.ships[0];
        const def = getShipDef(ship.shipClass, ship.variant).def;
        ship.componentHp = def.components.map((c) => c.maxHp);
        ship.componentHp[def.components.findIndex((c) => c.type === 'engine')] = 0;
        ship.disabled = true;
      }), 'disabled 舰被拒绝');
      add(test);
    }

    // 57. binding 必须精确覆盖 deployment，且组件状态不能伪装。
    {
      const test = new Case('deployment binding 精确集合与组件 combatState 不变量');
      const { state, battle, bindings } = lockPendingBattle(1202, ENEMY_BUDGET);
      const fleet = toPersistentFleet(state.fleet);
      const deployment = { selectedShipIds: [bindings[0].campaignShipId] };
      const ctx = prepareStrategicBattle(fleet, state.pendingBattle!.enemyFleet, state.pendingBattle!.battleSeed, deployment);
      let exact = true; try { validatePersistentBattleBindings(ctx.bindings, fleet, ctx.state, deployment); } catch { exact = false; }
      test.true_(exact, 'deployment 子集与 Team A/binding 精确一致');
      let missing = false; try { validatePersistentBattleBindings([], fleet, ctx.state, deployment); } catch { missing = true; }
      test.true_(missing, '少 binding 被拒绝');
      let extra = false; try { validatePersistentBattleBindings([...ctx.bindings, bindings[1]], fleet, ctx.state, deployment); } catch { extra = true; }
      test.true_(extra, '多 binding 被拒绝');
      const ship = battle.ships.find((candidate) => candidate.team === 'A')!;
      applyCombatState(ship, 'disabled'); ship.combatState = 'normal';
      let engine = false; try { validateBattleShipAgainstDefinition(ship); } catch { engine = true; }
      test.true_(engine, '引擎全毁但 combatState=normal 被拒绝');
      for (const component of ship.components) {
        component.hp = component.maxHp;
        component.destroyed = false;
      }
      for (const component of ship.components.filter((component) => component.def.type === 'weapon')) {
        component.hp = 0;
        component.destroyed = true;
      }
      ship.alive = true;
      ship.mobilityDisabled = false;
      ship.weaponsDisabled = true;
      ship.sensorsDisabled = false;
      ship.escapedTick = undefined;
      ship.retreatStartedTick = undefined;
      ship.combatState = 'damaged';
      let weapon = false; try { validateBattleShipAgainstDefinition(ship); } catch { weapon = true; }
      test.true_(weapon, '武器全毁但 combatState=damaged 被拒绝');
      const corrupted: any = JSON.parse(JSON.stringify(state));
      const persistent = corrupted.fleet.ships[0]; const def = getShipDef(persistent.shipClass, persistent.variant).def;
      persistent.componentHp = def.components.map((c) => c.maxHp);
      persistent.componentHp[def.components.findIndex((c) => c.type === 'engine')] = 0;
      test.true_(!validateUniverseState(corrupted), 'disabled=false 但关键组件全毁的持久舰被拒绝');
      add(test);
    }

    // 58. alpha.2 的极低目标只能钳制到最近合法状态，永不生成零组件 operational 舰。
    {
      const test = new Case('alpha.2 极低 combatPower 迁移合法且单调');
      let previous = -1;
      for (const combatPower of [1, 5, 10, 20, 40, 60, 80, 112]) {
        const base: any = JSON.parse(JSON.stringify(generateUniverse(1203)));
        base.version = '1.0-alpha.2';
        base.fleet = { id: base.fleet.id, name: base.fleet.name, systemId: base.fleet.systemId, fuel: base.fleet.fuel, maxFuel: base.fleet.maxFuel, shipCount: 4, disabledShips: 1, combatPower };
        const migrated = decodeUniverse(b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.2', state: base }));
        const actual = campaignFleetPower(toPersistentFleet(migrated.fleet));
        test.true_(actual >= previous, `combatPower=${combatPower} 实际战力单调不下降`); previous = actual;
        test.true_(migrated.fleet.ships.filter((ship) => !ship.disabled).every((ship) => ship.componentHp!.every((hp) => hp > 0)), `combatPower=${combatPower} 的 operational 舰无零组件`);
        test.true_(validateUniverseState(migrated), `combatPower=${combatPower} 迁移后可保存`);
      }
      add(test);
    }

    // 59. escaped 结构/在场语义、pending 控制权迁移和敌军装箱后置条件。
    {
      const test = new Case('escaped 语义、pending 迁移控制权与敌军装箱后置条件');
      const { state, battle } = lockPendingBattle(1204, ENEMY_BUDGET);
      const escaped = battle.ships.find((ship) => ship.team === 'A')!; applyCombatState(escaped, 'escaped');
      test.true_(isStructurallyAlive(escaped) && !isPresentOnBattlefield(escaped), 'escaped 结构存活但不在战场');
      const alpha4: any = JSON.parse(JSON.stringify(state)); alpha4.version = '1.0-alpha.4';
      const system = alpha4.systems.find((s: any) => s.id === alpha4.pendingBattle.systemId); system.enemyPower = 1; system.control = 'neutral';
      const migrated4 = decodeUniverse(b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.4', state: alpha4 }));
      test.true_(migrated4.systems.find((s) => s.id === migrated4.pendingBattle!.systemId)!.control === 'enemy', 'alpha.4 非空 pending 恢复 enemy control');
      const alpha3: any = JSON.parse(JSON.stringify(state)); alpha3.version = '1.0-alpha.3'; const before = JSON.stringify(alpha3.pendingBattle.enemyFleet);
      test.eq(JSON.stringify(decodeUniverse(b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.3', state: alpha3 })).pendingBattle!.enemyFleet), before, 'alpha.3 pending 不重抽');
      const pool = [{ shipClass: 'Fighter' as const, variant: 'standard' as const, count: 1 }, { shipClass: 'Fighter' as const, variant: 'scout' as const, count: 1 }];
      const min = Math.min(...pool.map((entry) => campaignShipCost(entry.shipClass, entry.variant)));
      const boxed = boxStrategicEnemyFleet(1204, 137, { sectorIndex: 1, gateGuard: false, cruiserAllowed: false }, pool);
      const cost = campaignFleetEntryCost(boxed);
      test.true_(cost > 0 && cost <= 137 && 137 - cost < min, '敌军装箱满足剩余预算后置条件');
      add(test);
    }

    // 60. deployed 是“当前部署”而不是“是否可被重新选择”；战略作战资格仅承认当前可用舰。
    {
      const test = new Case('deployed=false 不计 operational，取消部署后可重新选择');
      const fleet = toPersistentFleet(generateUniverse(1301).fleet);
      const id = fleet.ships[0].campaignShipId;
      let selection = defaultDeployment(fleet);
      selection = toggleDeploymentShip(fleet, selection, id);
      test.true_(fleet.ships.find((ship) => ship.campaignShipId === id)!.deployed === false, '取消选择会写入 deployed=false');
      selection = toggleDeploymentShip(fleet, selection, id);
      test.true_(selection.selectedShipIds.includes(id) && fleet.ships.find((ship) => ship.campaignShipId === id)!.deployed === true, '取消部署后仍可重新选择并恢复 deployed=true');

      const state = generateUniverse(1302);
      state.fleet.ships.forEach((ship) => { ship.deployed = false; });
      const hostile = state.systems.find((system) => system.control === 'enemy')!;
      state.fleet.systemId = hostile.id;
      state.selectedSystemId = hostile.id;
      test.eq(strategicFleetCounts(state.fleet).operational, 0, 'deployed=false 舰不计 strategic operational');
      test.true_(state.fleet.ships.every((ship) => !isShipDeployable(ship)), 'deployed=false 舰均不具备当前战斗资格');
      test.true_(!canEngageEnemy(state), '全体 deployed=false 时不能创建无法启动的 pending battle');
      add(test);
    }

    // 60.1 战斗适配器必须严格拒绝畸形显式部署，不能回退为默认舰队。
    {
      const test = new Case('deploymentFleet 严格拒绝非法显式部署');
      const fleet = toPersistentFleet(generateUniverse(1306).fleet);
      const first = fleet.ships[0].campaignShipId;
      const rejects = (selection: { selectedShipIds: string[] }, mutate?: (copy: typeof fleet) => void) => {
        const copy = JSON.parse(JSON.stringify(fleet)) as typeof fleet;
        mutate?.(copy);
        try {
          deploymentFleet(copy, selection);
          return false;
        } catch {
          return true;
        }
      };
      test.true_(rejects({ selectedShipIds: [] }), '显式空 deployment 被战斗入口拒绝');
      test.true_(rejects({ selectedShipIds: [first, first] }), '重复 ID 被战斗入口拒绝');
      test.true_(rejects({ selectedShipIds: ['missing-ship'] }), '不存在 ID 被战斗入口拒绝');
      test.true_(rejects({ selectedShipIds: [first] }, (copy) => { copy.ships[0].deployed = false; }), 'deployed=false 舰被战斗入口拒绝');
      test.true_(rejects({ selectedShipIds: [first] }, (copy) => { copy.ships[0].disabled = true; }), 'disabled 舰被战斗入口拒绝');
      const subset = deploymentFleet(fleet, { selectedShipIds: [first] });
      test.eq(subset.ships.length, 1, '合法子集只生成一艘 Team A 舰船');
      test.eq(subset.ships[0].campaignShipId, first, '合法子集保持选中舰 ID');
      let adapterRejected = false;
      try {
        prepareStrategicBattle(fleet, [{ shipClass: 'Fighter', variant: 'standard', count: 1 }], 1306, { selectedShipIds: [] });
      } catch {
        adapterRejected = true;
      }
      test.true_(adapterRejected, 'prepareStrategicBattle 不会把空 deployment 静默转换为默认舰队');
      add(test);
    }

    // 61. 持久舰失能严格复用 core-v4 的“同类组件全部毁坏”语义。
    {
      const test = new Case('持久舰组件失能、敌袭与维修全过程保持可保存');
      let state = establishStartingBase(generateUniverse(1303));
      const frigate = state.fleet.ships.find((ship) => ship.shipClass === 'Frigate')!;
      const def = getShipDef(frigate.shipClass, frigate.variant).def;
      frigate.componentHp = def.components.map((component) => component.maxHp);
      const engines = def.components.map((component, index) => component.type === 'engine' ? index : -1).filter((index) => index >= 0);
      frigate.componentHp[engines[0]] = 0;
      test.true_(!computePersistentDisableFlags(frigate).mobilityDisabled && !isPersistentShipDisabled(frigate), '仅损毁一个多引擎组件不会误判 disabled');
      frigate.componentHp[engines[1]] = 0;
      frigate.disabled = isPersistentShipDisabled(frigate);
      test.true_(computePersistentDisableFlags(frigate).mobilityDisabled && frigate.disabled, '全部引擎损毁才产生 mobility disabled');
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      base.facilities = [{ id: 'test-repair', type: 'repairDock', level: 1 }];
      state.faction.resources.supplies = 30;
      state.faction.resources.minerals = 30;
      state = applyUniverseAction(state, { type: 'repairShip', campaignShipId: frigate.campaignShipId });
      let repaired = state.fleet.ships.find((ship) => ship.campaignShipId === frigate.campaignShipId)!;
      test.true_(!repaired.disabled && validateUniverseState(state), '修复一个引擎即按 core-v4 真实组件规则解除 disabled');
      state = applyUniverseAction(state, { type: 'repairShip', campaignShipId: frigate.campaignShipId });
      repaired = state.fleet.ships.find((ship) => ship.campaignShipId === frigate.campaignShipId)!;
      test.true_(!repaired.disabled && validateUniverseState(state), '继续维修保持可作战且状态仍合法');

      // 让敌方只能袭击基地；真实 advanceUniverseTurn 必须把组件伤害同步写入可保存状态。
      const raid = establishStartingBase(generateUniverse(1304));
      const raidBase = raid.entities.find((entity) => entity.id === raid.faction.baseEntityId)!;
      const baseSystem = raid.systems.find((system) => system.id === raidBase.systemId)!;
      for (const system of raid.systems) {
        if (system.id === baseSystem.id) {
          system.control = 'player';
          system.enemyPower = 0;
        } else {
          system.control = 'enemy';
          system.enemyPower = minimumStrategicFleetCost();
        }
      }
      raid.turn = 3;
      const afterRaid = advanceUniverseTurn(raid, 'B.5 敌袭验证');
      const disabled = afterRaid.fleet.ships.find((ship) => ship.disabled);
      test.true_(!!disabled && isPersistentShipDisabled(disabled), '敌袭通过真实组件损伤产生 disabled');
      test.true_(validateUniverseState(afterRaid), '敌袭后的真实状态可保存');
      const round = decodeUniverse(encodeUniverse(afterRaid));
      test.true_(validateUniverseState(round), '敌袭状态编码/解码后仍合法');
      add(test);
    }

    // 62. alpha.2 极端战力迁移必须完全确定，不产生非法 operational 舰。
    {
      const test = new Case('alpha.2 极端 combatPower 迁移完全确定且合法');
      for (const combatPower of [0, 1, 5, 10, 999]) {
        const source: any = JSON.parse(JSON.stringify(generateUniverse(1305)));
        source.version = '1.0-alpha.2';
        source.fleet = {
          id: source.fleet.id, name: source.fleet.name, systemId: source.fleet.systemId,
          fuel: source.fleet.fuel, maxFuel: source.fleet.maxFuel,
          shipCount: 4, disabledShips: 1, combatPower
        };
        const code = b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.2', state: source });
        const left = decodeUniverse(code);
        const right = decodeUniverse(code);
        test.eq(JSON.stringify(left.fleet), JSON.stringify(right.fleet), `combatPower=${combatPower} 迁移结果完全确定`);
        test.true_(left.fleet.ships.filter((ship) => !ship.disabled).every((ship) => ship.componentHp!.every((hp) => hp > 0)), `combatPower=${combatPower} 不生成零组件 operational 舰`);
        test.true_(validateUniverseState(left), `combatPower=${combatPower} 迁移后通过深层校验`);
      }
      add(test);
    }

    // V1.0-C.1：战略状态直接复用 V0.8 指挥官档案，并为 alpha.5 提供确定性迁移。
    {
      const test = new Case('战略指挥官确定生成、持久化、跨星域继承与 alpha.5 迁移');
      const first = generateUniverse(1401, '指挥官测试团');
      const same = generateUniverse(1401, '指挥官测试团');
      test.eq(JSON.stringify(first.commander), JSON.stringify(same.commander), '相同 seed 生成完全一致的指挥官档案');
      test.eq(first.version, SECTOR_EXPEDITION_VERSION, '新远征使用当前 alpha.6 版本');
      test.true_(validateUniverseState(first), '含指挥官的新战略状态通过深层校验');

      const roundTrip = decodeUniverse(encodeUniverse(first));
      test.eq(JSON.stringify(roundTrip.commander), JSON.stringify(first.commander), '指挥官档案编码解码往返一致');
      const rendered = renderPanelToRoot(first);
      test.true_(!!rendered.root.querySelector('.strategic-commander'), '战略 UI 显示远征指挥官卡片');
      test.true_(rendered.html.includes(first.commander.name), '指挥官姓名显示在战略 UI');
      test.true_(rendered.html.includes('状态：可履职'), '健康指挥官显示可履职');

      const malformed: any = JSON.parse(JSON.stringify(first));
      malformed.commander.attributes.command = 99;
      test.true_(!validateUniverseState(malformed), '非法指挥官属性被战略存档校验拒绝');

      const legacy: any = JSON.parse(JSON.stringify(first));
      legacy.version = '1.0-alpha.5';
      delete legacy.commander;
      delete legacy.reserveCommanders;
      delete legacy.pendingSuccession;
      const migrated = decodeUniverse(b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.5', state: legacy }));
      test.eq(migrated.version, SECTOR_EXPEDITION_VERSION, 'alpha.5 存档迁移到 alpha.6');
      test.true_(validateUniverseState(migrated), 'alpha.5 迁移补齐合法指挥官档案');
      test.eq(migrated.commander.id, first.commander.id, 'alpha.5 迁移按原 seed 确定生成同一指挥官 ID');

      const extraction = prepareGate(first, 100);
      extraction.faction.resources.supplies = 20;
      extraction.fleet.fuel = extraction.fleet.maxFuel;
      const nextSector = applyUniverseAction(extraction, { type: 'extractSector', mode: 'stable' });
      test.eq(nextSector.commander.id, first.commander.id, '指挥官 ID 跨星域保持稳定');
      test.eq(JSON.stringify(nextSector.commander), JSON.stringify(first.commander), '完整指挥官档案跨星域继承');
      add(test);
    }

    // V1.0-C.1 收尾：继任状态必须与现任真实可用性一致，且继任期间不得推进战略状态。
    {
      const test = new Case('战略指挥官继任不变量、持久化往返与行动锁');
      const base = generateUniverse(1402, '继任测试团');
      const reserve = generateUniverse(2402, '候补测试团').commander;
      const throws = (fn: () => unknown): boolean => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };

      const deadWithoutSuccession = JSON.parse(JSON.stringify(base)) as typeof base;
      deadWithoutSuccession.commander.alive = false;
      test.true_(!validateUniverseState(deadWithoutSuccession), '现任阵亡但未进入继任时拒绝存档');
      test.true_(throws(() => encodeUniverse(deadWithoutSuccession)), '现任阵亡但未继任时编码直接失败');
      test.true_(throws(() => decodeUniverse(b64urlEncode({
        type: 'spacewar-sector-expedition',
        v: SECTOR_EXPEDITION_VERSION,
        state: deadWithoutSuccession,
      }))), '导入现任阵亡但未继任的远征码直接失败');

      const incapacitatedWithoutSuccession = JSON.parse(JSON.stringify(base)) as typeof base;
      incapacitatedWithoutSuccession.commander.injuries = [{
        id: 'trauma', severity: 3, acquiredTurn: 0, permanent: false, cause: '继任不变量测试'
      }];
      test.true_(!validateUniverseState(incapacitatedWithoutSuccession), '现任重伤无法履职但未进入继任时拒绝存档');

      const healthyPending = JSON.parse(JSON.stringify(base)) as typeof base;
      healthyPending.reserveCommanders = [reserve];
      healthyPending.pendingSuccession = true;
      test.true_(!validateUniverseState(healthyPending), '现任可履职却等待继任时拒绝存档');

      const deadWithoutReserve = JSON.parse(JSON.stringify(deadWithoutSuccession)) as typeof base;
      deadWithoutReserve.pendingSuccession = true;
      test.true_(!validateUniverseState(deadWithoutReserve), '没有可用候补的继任状态拒绝存档');

      const endedPending = JSON.parse(JSON.stringify(base)) as typeof base;
      endedPending.status = 'collapsed';
      endedPending.reserveCommanders = [reserve];
      endedPending.pendingSuccession = true;
      test.true_(!validateUniverseState(endedPending), '已结束远征不得残留继任流程');

      const succession = JSON.parse(JSON.stringify(base)) as typeof base;
      succession.commander.alive = false;
      succession.reserveCommanders = [reserve];
      succession.pendingSuccession = true;
      test.true_(validateUniverseState(succession), '现任不可履职且有可用候补时继任状态合法');
      const round = decodeUniverse(encodeUniverse(succession));
      test.true_(validateUniverseState(round), '合法继任状态编码解码往返后仍有效');
      test.eq(round.pendingSuccession, true, '往返保持继任标记');
      test.eq(round.commander.alive, false, '往返保持现任不可履职事实');

      const incapacitatedSuccession = JSON.parse(JSON.stringify(incapacitatedWithoutSuccession)) as typeof base;
      incapacitatedSuccession.reserveCommanders = [reserve];
      incapacitatedSuccession.pendingSuccession = true;
      test.true_(validateUniverseState(incapacitatedSuccession), '现任重伤无法履职且有候补时继任状态合法');
      const incapacitatedRendered = renderPanelToRoot(incapacitatedSuccession);
      test.true_(incapacitatedRendered.html.includes('状态：无法履职'), '重伤指挥官卡片与行动锁一致显示无法履职');
      test.true_(incapacitatedRendered.html.includes('伤势：严重创伤 3'), '指挥官卡片使用中文标签显示真实伤势');
      test.true_(!incapacitatedRendered.html.includes('状态：可履职'), '重伤指挥官不会错误显示可履职');

      const deadRendered = renderPanelToRoot(succession);
      test.true_(deadRendered.html.includes('状态：阵亡'), '阵亡指挥官显示阵亡状态');

      const selected = succession.systems.find((system) => system.discovered && system.id !== succession.selectedSystemId);
      if (selected) {
        const selectedState = applyUniverseAction(succession, { type: 'selectSystem', systemId: selected.id });
        test.eq(selectedState.selectedSystemId, selected.id, '继任期间仍允许只读星系选择');
      }
      const lockedActions: UniverseAction[] = [
        { type: 'advanceTurn' },
        { type: 'travel', systemId: succession.systems[0].id },
        { type: 'surveyEntity', entityId: succession.entities[0].id },
        { type: 'extractAsteroid', entityId: succession.entities.find((entity) => entity.kind === 'asteroidField')!.id },
        { type: 'establishBase', entityId: succession.entities.find((entity) => entity.kind === 'station')!.id },
        { type: 'queueConstruction', facilityType: 'solarArray' },
        { type: 'queueResearch', projectId: 'routeAnalysis' },
        { type: 'engageEnemy' },
        { type: 'repairShip', campaignShipId: succession.fleet.ships[0].campaignShipId },
        { type: 'calibrateGate' },
        { type: 'extractSector', mode: 'stable' },
      ];
      for (const action of lockedActions) {
        test.true_(applyUniverseAction(succession, action) === succession, `继任 reducer 拒绝 ${action.type}`);
      }
      test.eq(succession.turn, base.turn, '继任行动锁不会推进回合');
      test.true_(!canEngageEnemy(succession), '继任期间 canEngageEnemy=false');
      test.true_(!canQueueResearch(succession, 'routeAnalysis'), '继任期间 canQueueResearch=false');

      const rendered = renderPanelToRoot(succession);
      const nextTurn = rendered.root.querySelector<HTMLButtonElement>('#strategy-next-turn');
      test.true_(!!nextTurn && nextTurn.disabled, '继任期间推进回合按钮真实 disabled');
      if (nextTurn) {
        const before = rendered.calls.actions;
        nextTurn.click();
        test.eq(rendered.calls.actions, before, '点击继任锁定按钮不触发回调');
      }
      test.true_(rendered.html.includes('完成继任前'), '战略界面明确显示继任行动锁原因');
      const systemButton = rendered.root.querySelector<HTMLButtonElement>('[data-strategy-system]');
      test.true_(!!systemButton && !systemButton.disabled, '继任期间系统选择保持可用');
      const exportButton = rendered.root.querySelector<HTMLButtonElement>('#strategy-export');
      const exitButton = rendered.root.querySelector<HTMLButtonElement>('#strategy-exit');
      test.true_(!!exportButton && !exportButton.disabled && !!exitButton && !exitButton.disabled, '继任期间导出与返回保持可用');
      add(test);
    }
  });
}

// core-v4 终态/价值/目标/状态机 校验测试（纯 sim，无渲染 / DOM）。
// 覆盖：舰数守恒、舰队价值守恒、状态机（终态与优先级）、点数判定（Escaped/Disabled 价值公式）、
//   目标系统（escaped/destroyed 不可锁定、disabled 仍可被攻击）、CombatState 语义一致性。
// 浏览器中可用 window.runCoreV4ValidationTests() 运行（经 runAcceptanceTests 统一调度）。

import { createPRNG } from './prng';
import { createInitialState, createSimulator } from './rulesets';
import {
  ReplayConfig,
  FleetEntry,
  ShipClass,
  ShipVariant,
  FormationType,
  DoctrineType,
  Team,
  CombatState,
  Ship,
  BattleState
} from './battleTypes';
import { SIM_VERSION_V5, RULESET_V4 } from './battleConfig';
import { getVariantDef } from './shipVariants';
import {
  getShipCost,
  getShipOperationalValue,
  getShipDecisionValue,
  getShipPointValue,
  computeCombatState,
  decideVictory,
  isCombatCapable
} from './combatState';
import {
  isPresentOnBattlefield,
  isStructurallyAlive,
  isTargetable,
  isDestroyed,
  isEscaped,
  isDisabled,
  isRetreating,
  combatStatePriority
} from './shipFlags';
import { summarizeStats } from './battleStats';
import { runSuite, Case, SuiteResult } from './testHarness';

// ---------------- 测试脚手架 ----------------

function fleet(entries: { shipClass: ShipClass; variant: ShipVariant; count: number }[]): FleetEntry[] {
  return entries.map((e) => ({ shipClass: e.shipClass, variant: e.variant, count: e.count }));
}
function mkReplay(
  seed: number,
  aFleet: FleetEntry[],
  bFleet: FleetEntry[],
  aForm: FormationType,
  aDoc: DoctrineType,
  bForm: FormationType,
  bDoc: DoctrineType
): ReplayConfig {
  return {
    v: SIM_VERSION_V5,
    ruleset: RULESET_V4,
    seed: seed >>> 0,
    budget: { mode: 'unlimited', limit: 999999 },
    teamA: { fleet: aFleet, formation: aForm, doctrine: aDoc },
    teamB: { fleet: bFleet, formation: bForm, doctrine: bDoc }
  };
}

/** 构造一艘用于 combatState 计算的 mock 舰船（只填充 computeCombatState 读取的字段） */
function mkShip(over: Partial<Ship> = {}): Ship {
  const mkComp = (type: string, hp: number): any => ({
    id: 0,
    def: { type, name: type, maxHp: 100, offset: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, shape: 'box' },
    hp,
    maxHp: 100,
    destroyed: hp <= 0
  });
  const base: any = {
    id: 0,
    team: 'A' as Team,
    type: 'Fighter' as ShipClass,
    variant: 'standard' as ShipVariant,
    variantMods: {},
    def: { type: 'Fighter', maxSpeed: 1, turnRate: 0.1, baseRange: 100, scale: 1, components: [] },
    pos: { x: 0, y: 0, z: 0 },
    heading: 0,
    alive: true,
    combatState: 'normal' as CombatState,
    hp: 100,
    maxHp: 100,
    components: [mkComp('core', 100), mkComp('engine', 100), mkComp('weapon', 100), mkComp('sensor', 100)],
    targetId: null,
    shield: 0,
    maxShield: 0,
    shieldRegen: 0,
    mobilityDisabled: false,
    weaponsDisabled: false,
    sensorsDisabled: false,
    destroyed: false,
    escapedTick: undefined as number | undefined,
    retreatStartedTick: undefined as number | undefined
  };
  return { ...base, ...over } as unknown as Ship;
}

/** 以给定总血量比例构造组件（用于 critical/damaged/normal 判定） */
function compsAt(ratio: number): any[] {
  const mk = (type: string) => ({
    id: 0,
    def: { type, name: type, maxHp: 100, offset: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, shape: 'box' },
    hp: Math.max(0, Math.round(100 * ratio)),
    maxHp: 100,
    destroyed: 100 * ratio <= 0
  });
  return [mk('core'), mk('engine'), mk('weapon'), mk('sensor')];
}

function runBattle(cfg: ReplayConfig, maxTicks?: number): BattleState {
  const rng = createPRNG(cfg.seed);
  const state = createInitialState(cfg, rng);
  if (maxTicks && maxTicks > 0) state.maxTicks = maxTicks;
  const sim = createSimulator(state, rng);
  let g = 0;
  while (!state.finished && g <= state.maxTicks + 1) {
    sim.step();
    g++;
  }
  return state;
}

// 固定测试配置（均为 core-v4 合法战斗）
const CFG = {
  smallBalanced: () =>
    mkReplay(
      1001,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 3 }, { shipClass: 'Frigate', variant: 'standard', count: 2 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 3 }, { shipClass: 'Frigate', variant: 'standard', count: 2 }]),
      'wedge', 'balanced', 'wedge', 'balanced'
    ),
  defensiveRetreat: () =>
    mkReplay(
      6006,
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Frigate', variant: 'support', count: 3 }, { shipClass: 'Fighter', variant: 'scout', count: 5 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 18 }]),
      'wall', 'defensive', 'wedge', 'aggressive'
    ),
  antiCapital: () =>
    mkReplay(
      8008,
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 3 }, { shipClass: 'Fighter', variant: 'standard', count: 6 }]),
      fleet([{ shipClass: 'Frigate', variant: 'carrier', count: 3 }, { shipClass: 'Fighter', variant: 'scout', count: 12 }]),
      'wedge', 'antiCapital', 'swarm', 'kite'
    ),
  largeMixed: () =>
    mkReplay(
      2002,
      fleet([{ shipClass: 'Cruiser', variant: 'standard', count: 2 }, { shipClass: 'Frigate', variant: 'support', count: 3 }, { shipClass: 'Fighter', variant: 'scout', count: 5 }]),
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Frigate', variant: 'carrier', count: 2 }, { shipClass: 'Fighter', variant: 'interceptor', count: 5 }]),
      'wall', 'defensive', 'line', 'aggressive'
    )
};

// ---------------- 1. 舰数守恒 ----------------

export function shipCountConservationTests(): SuiteResult {
  return runSuite('shipCountConservation', (add) => {
    const c = new Case('ship-count-conservation');
    const configs: [string, () => ReplayConfig][] = [
      ['smallBalanced', CFG.smallBalanced],
      ['defensiveRetreat', CFG.defensiveRetreat],
      ['antiCapital', CFG.antiCapital],
      ['largeMixed', CFG.largeMixed]
    ];
    for (const [name, make] of configs) {
      const state = runBattle(make());
      const st = summarizeStats(state);
      for (const team of ['A', 'B'] as Team[]) {
        const init = state.ships.filter((s) => s.team === team).length;
        const sum =
          st.counts[team].normal +
          st.counts[team].damaged +
          st.counts[team].critical +
          st.counts[team].disabled +
          st.counts[team].retreating +
          st.counts[team].escaped +
          st.counts[team].destroyed;
        c.eq(sum, init, `[${name}] 7 状态计数之和 = 初始舰数 (${team})`);
      }
    }
    add(c);
  });
}

// ---------------- 2. 舰队价值守恒 ----------------

export function fleetValueConservationTests(): SuiteResult {
  return runSuite('fleetValueConservation', (add) => {
    const c = new Case('fleet-value-conservation');
    const configs: [string, () => ReplayConfig][] = [
      ['smallBalanced', CFG.smallBalanced],
      ['defensiveRetreat', CFG.defensiveRetreat],
      ['antiCapital', CFG.antiCapital],
      ['largeMixed', CFG.largeMixed]
    ];
    for (const [name, make] of configs) {
      const state = runBattle(make());
      const st = summarizeStats(state);
      for (const team of ['A', 'B'] as Team[]) {
        const fv = st.fleetValue[team];
        const sumComponents = fv.destroyedValue + fv.disabledValue + fv.escapedValue + fv.remainingOperationalValue;
        c.close(sumComponents, fv.initialFleetCost, 6, `[${name}] 价值守恒: destroyed+disabled+escaped+operational = 初始成本 (${team})`);
        // 决策价值 = 失能*0.5 + 脱战*1 + 作战*1（destroyed=0）
        const expectedDecision = fv.disabledValue * 0.5 + fv.escapedValue + fv.remainingOperationalValue;
        c.close(fv.remainingDecisionValue, expectedDecision, 6, `[${name}] 决策价值 = 失能*0.5+脱战+作战 (${team})`);
        // 原始成本口径：initialFleetCost 必为各舰成本之和（非负整数）
        c.true_(fv.initialFleetCost >= 0, `[${name}] initialFleetCost 非负 (${team})`);
      }
    }
    add(c);
  });
}

// ---------------- 3. 状态机（终态 + 优先级） ----------------

export function stateMachineTests(): SuiteResult {
  return runSuite('stateMachine', (add) => {
    const c = new Case('state-transitions');

    // destroyed 为终态：即便 escapedTick 已设也仍为 destroyed（拒绝 escaped→destroyed / destroyed→normal）
    c.eq(computeCombatState(mkShip({ combatState: 'destroyed', escapedTick: 123, mobilityDisabled: true }), false), 'destroyed', 'destroyed 终态：不受 escapedTick/失能影响');

    // escaped 为终态：即便全失能也仍为 escaped（拒绝 disabled→escaped / destroyed→escaped）
    c.eq(computeCombatState(mkShip({ combatState: 'escaped', escapedTick: 50, mobilityDisabled: true, weaponsDisabled: true }), false), 'escaped', 'escaped 终态：不受失能影响');

    // 优先级：disabled 优先于 retreating / critical
    c.eq(computeCombatState(mkShip({ combatState: 'retreating', retreatStartedTick: 1, mobilityDisabled: true }), false), 'disabled', '撤退中引擎失能 → disabled 优先于 retreating');

    // retreating：已启动撤退且无失能
    c.eq(computeCombatState(mkShip({ combatState: 'normal', retreatStartedTick: 5 }), false), 'retreating', 'retreatStartedTick 已设且无失能 → retreating');

    // critical / damaged / normal 由血量决定
    c.eq(computeCombatState(mkShip({ combatState: 'normal', components: compsAt(0.2) }), false), 'critical', '低总血量(0.2) → critical');
    c.eq(computeCombatState(mkShip({ combatState: 'normal', components: compsAt(0.5) }), false), 'damaged', '中总血量(0.5) → damaged');
    c.eq(computeCombatState(mkShip({ combatState: 'normal', components: compsAt(1.0) }), false), 'normal', '满血 → normal');

    // 传感器失能：无近敌 → disabled；有近敌 → 仍 normal（传感器失能不致命）
    c.eq(computeCombatState(mkShip({ combatState: 'normal', sensorsDisabled: true }), false), 'disabled', '传感器失能且无近敌 → disabled');
    c.eq(computeCombatState(mkShip({ combatState: 'normal', sensorsDisabled: true }), true), 'normal', '传感器失能有近敌 → 仍 normal');

    // 非法组合：同时标记 destroyed 与 escaped 时，destroyed 优先级最高
    c.eq(computeCombatState(mkShip({ combatState: 'destroyed', escapedTick: 9, mobilityDisabled: true, weaponsDisabled: true, sensorsDisabled: true }), false), 'destroyed', '多失能+escaped+destroyed → destroyed 优先级最高');

    add(c);
  });
}

// ---------------- 4. 点数判定（Escaped/Disabled 价值公式 + Victory） ----------------

export function pointsDecisionTests(): SuiteResult {
  return runSuite('pointsDecision', (add) => {
    const c = new Case('points-decision');
    const cost = getVariantDef('standard').cost;
    const states: CombatState[] = ['normal', 'damaged', 'critical', 'retreating', 'escaped', 'disabled', 'destroyed'];

    for (const cs of states) {
      const ship = mkShip({ variant: 'standard', combatState: cs });
      const dv = getShipDecisionValue(ship);
      const ov = getShipOperationalValue(ship);
      const expectedDV = cs === 'destroyed' ? 0 : cs === 'disabled' ? cost * 0.5 : cost;
      c.approx(dv, expectedDV, 1e-6, `decision value(${cs}) = ${expectedDV}`);
      const expectedOV = cs === 'normal' || cs === 'damaged' || cs === 'critical' || cs === 'retreating' ? cost : 0;
      c.approx(ov, expectedOV, 1e-6, `operational value(${cs}) = ${expectedOV}`);
      // 旧版 getShipPointValue 必须与 decision value 完全一致（冻结兼容）
      c.approx(getShipPointValue(ship), dv, 1e-6, `getShipPointValue === decision value(${cs})`);
    }

    // 真实战斗：decideVictory 与 state.winner / state.victoryReason 一致（combatDisabled 战）
    const dr = runBattle(CFG.defensiveRetreat());
    const vr = decideVictory(dr);
    c.eq(vr.winner, dr.winner, 'decideVictory.winner === state.winner (combatDisabled 战)');
    c.eq(vr.reason, dr.victoryReason, 'decideVictory.reason === state.victoryReason');

    // timeout / pointsDecision：胜方决策价值更高（或平局相等）
    const lm = runBattle(CFG.largeMixed());
    const vr2 = decideVictory(lm);
    if (vr2.reason === 'timeout' || vr2.reason === 'pointsDecision') {
      let dA = 0;
      let dB = 0;
      for (const s of lm.ships) {
        if (s.team === 'A') dA += getShipDecisionValue(s);
        else dB += getShipDecisionValue(s);
      }
      if (vr2.winner === 'A') c.true_(dA >= dB - 1e-6, 'timeout/pointsDecision：A 胜 → 决策价值 A>=B');
      else if (vr2.winner === 'B') c.true_(dB >= dA - 1e-6, 'timeout/pointsDecision：B 胜 → 决策价值 B>=A');
      else c.true_(Math.abs(dA - dB) < 1e-6, 'timeout/pointsDecision：平局 → 决策价值相等');
    } else {
      c.ok(true, `(${vr2.reason} 非点数裁决，跳过价值比较)`);
    }

    add(c);
  });
}

// ---------------- 5. 目标系统校验 ----------------

export function targetValidationTests(): SuiteResult {
  return runSuite('targetValidation', (add) => {
    const c = new Case('target-validation');

    // 直接语义：isTargetable = 非 destroyed 且非 escaped
    const expect: Record<CombatState, boolean> = {
      normal: true,
      damaged: true,
      critical: true,
      retreating: true,
      disabled: true, // 失能仍可被攻击（瘫痪≠离场）
      escaped: false,
      destroyed: false
    };
    for (const cs of Object.keys(expect) as CombatState[]) {
      c.eq(isTargetable(mkShip({ combatState: cs })), expect[cs], `isTargetable(${cs}) = ${expect[cs]}`);
    }

    // 真实战斗终态：所有 ship 的 isTargetable 与 combatState 一致
    const state = runBattle(CFG.antiCapital());
    for (const s of state.ships) {
      const exp = s.combatState !== 'destroyed' && s.combatState !== 'escaped';
      c.eq(isTargetable(s), exp, `终态 isTargetable 与 combatState 一致 (id=${s.id}, ${s.combatState})`);
    }
    // escaped / destroyed 在终态绝不可被锁定
    const badTargets = state.ships.filter((s) => (s.combatState === 'destroyed' || s.combatState === 'escaped') && isTargetable(s));
    c.eq(badTargets.length, 0, '终态：destroyed/escaped 均不可被锁定');
    // disabled 在终态仍可被锁定（仍攻击able）
    const disabledShips = state.ships.filter((s) => s.combatState === 'disabled');
    const disabledTargetable = disabledShips.filter((s) => isTargetable(s));
    c.eq(disabledTargetable.length, disabledShips.length, '终态：disabled 仍可被锁定（仍攻击able）');

    add(c);
  });
}

// ---------------- 6. CombatState 语义一致性 ----------------

export function combatStateValidationTests(): SuiteResult {
  return runSuite('combatStateValidation', (add) => {
    const c = new Case('combat-state-validation');
    const valid: CombatState[] = ['normal', 'damaged', 'critical', 'disabled', 'retreating', 'escaped', 'destroyed'];

    const state = runBattle(CFG.defensiveRetreat());
    for (const s of state.ships) {
      // 每个 combatState 都是合法值
      c.true_(valid.includes(s.combatState), `combatState 合法 (id=${s.id}, ${s.combatState})`);
      // helper 与 combatState 一致
      c.eq(isDestroyed(s), s.combatState === 'destroyed', `isDestroyed(id=${s.id})`);
      c.eq(isEscaped(s), s.combatState === 'escaped', `isEscaped(id=${s.id})`);
      c.eq(isDisabled(s), s.combatState === 'disabled', `isDisabled(id=${s.id})`);
      c.eq(isRetreating(s), s.combatState === 'retreating', `isRetreating(id=${s.id})`);
      // isPresentOnBattlefield / isStructurallyAlive 等价（非 destroyed 且非 escaped）
      const onField = s.combatState !== 'destroyed' && s.combatState !== 'escaped';
      c.eq(isPresentOnBattlefield(s), onField, `isPresentOnBattlefield(id=${s.id})`);
      c.eq(isStructurallyAlive(s), onField, `isStructurallyAlive(id=${s.id})`);
      // isCombatCapable 与 combatState 一致
      const capable = s.combatState === 'normal' || s.combatState === 'damaged' || s.combatState === 'critical' || s.combatState === 'retreating';
      c.eq(isCombatCapable(s), capable, `isCombatCapable(id=${s.id})`);
      // escaped 必有 escapedTick；destroyed 必 alive=false
      if (s.combatState === 'escaped') c.true_(s.escapedTick !== undefined, `escaped 必有 escapedTick (id=${s.id})`);
      if (s.combatState === 'destroyed') c.true_(s.alive === false, `destroyed 必 alive=false (id=${s.id})`);
    }

    // 优先级数值单调
    c.true_(combatStatePriority('destroyed') > combatStatePriority('escaped'), 'priority: destroyed > escaped');
    c.true_(combatStatePriority('escaped') > combatStatePriority('disabled'), 'priority: escaped > disabled');
    c.true_(combatStatePriority('disabled') > combatStatePriority('retreating'), 'priority: disabled > retreating');
    c.true_(combatStatePriority('retreating') > combatStatePriority('critical'), 'priority: retreating > critical');
    c.true_(combatStatePriority('critical') > combatStatePriority('damaged'), 'priority: critical > damaged');
    c.true_(combatStatePriority('damaged') > combatStatePriority('normal'), 'priority: damaged > normal');

    add(c);
  });
}

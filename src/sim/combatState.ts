// core-v4 战斗状态机与战斗结束判定。
// 纯函数（不消耗 PRNG，不读取渲染/真实时间），供模拟器在每 tick 末调用。

import { Ship, CombatState, VictoryReason, BattleState, Team } from './battleTypes';
import { hpRatio } from './componentTargeting';
import { getVariantDef } from './shipVariants';

/** 计算单艘舰船当前战斗状态（normal/damaged/critical/disabled/retreating/escaped/destroyed）。
 *  状态优先级（高→低）：destroyed > escaped > disabled > retreating > critical > damaged > normal。
 *  说明：已 mobilityDisabled / weaponsDisabled 的舰船不能再保持 retreating（必须先转入 disabled）；
 *  只有真正抵达边界（escapedTick 已设置）才进入 escaped；核心/全组件摧毁由调用方显式置 destroyed。
 *  hasCloseEnemy：是否存在处于交火范围附近的敌方单位（用于传感器失效判定）。 */
export function computeCombatState(ship: Ship, hasCloseEnemy: boolean): CombatState {
  if (ship.combatState === 'destroyed') return 'destroyed';
  if (ship.escapedTick !== undefined) return 'escaped';
  // disabled 优先于 retreating：撤退途中若引擎/武器/传感器全毁，立即转入 disabled。
  const disabledByMobility = ship.mobilityDisabled;
  const disabledByWeapons = ship.weaponsDisabled;
  const disabledBySensors = ship.sensorsDisabled && !hasCloseEnemy;
  if (disabledByMobility || disabledByWeapons || disabledBySensors) return 'disabled';
  if (ship.retreatStartedTick !== undefined) return 'retreating';

  const total = hpRatio(ship);
  const core = ship.components.find((c) => c.def.type === 'core');
  const coreRatio = core ? core.hp / core.maxHp : 1;
  if (total <= 0.25 || coreRatio <= 0.3) return 'critical';
  if (total <= 0.6 || coreRatio <= 0.5) return 'damaged';
  return 'normal';
}

/** 单舰在点数判定中的价值权重（core-v4 冻结规则）：
 *  normal / damaged / critical / retreating = 100% cost（仍在场且具潜在战斗力）
 *  escaped = 100% cost（已保存下来的舰队价值，但不计入战场剩余战力）
 *  disabled = 50% cost（失去战斗能力，按半价计入）
 *  destroyed = 0% cost（已损失）
 * 该函数用于 timeout / pointsDecision 的胜负判定与战后价值统计，影响 core-v4 结果。 */
export function getShipPointValue(ship: Ship): number {
  const cost = getVariantDef(ship.variant).cost;
  if (ship.combatState === 'destroyed') return 0;
  if (ship.combatState === 'escaped') return cost;
  if (ship.combatState === 'disabled') return cost * 0.5;
  return cost;
}

/** 单舰原始建造成本（用于价值守恒校验）。 */
export function getShipCost(ship: Ship): number {
  return getVariantDef(ship.variant).cost;
}

/** 战场剩余作战价值（operational value）：
 *  仅 normal / damaged / critical / retreating 计入全额 cost（仍在场且具战斗力）；
 *  escaped / disabled / destroyed 均不计入战场作战价值（escaped 见 decision value）。 */
export function getShipOperationalValue(ship: Ship): number {
  switch (ship.combatState) {
    case 'normal':
    case 'damaged':
    case 'critical':
    case 'retreating':
      return getVariantDef(ship.variant).cost;
    default:
      return 0;
  }
}

/** 点数判定价值（decision value）：
 *  normal / damaged / critical / retreating / escaped = 100% cost（保存下来的舰队价值）；
 *  disabled = 50% cost（失去战斗能力，按半价计入）；
 *  destroyed = 0% cost（已损失）。 */
export function getShipDecisionValue(ship: Ship): number {
  switch (ship.combatState) {
    case 'destroyed':
      return 0;
    case 'disabled':
      return getVariantDef(ship.variant).cost * 0.5;
    default:
      return getVariantDef(ship.variant).cost;
  }
}

/** 是否仍有战斗能力（用于结束判定）。
 *  normal/damaged/critical/retreating 视为可战斗单位；
 *  disabled/escaped/destroyed 不计。 */
export function isCombatCapable(ship: Ship): boolean {
  switch (ship.combatState) {
    case 'disabled':
    case 'escaped':
    case 'destroyed':
      return false;
    default:
      return true;
  }
}

/** 战斗结束判定结果 */
export interface VictoryResult {
  winner: Team | null;
  reason: VictoryReason;
  capableA: number;
  capableB: number;
  destroyedA: number;
  destroyedB: number;
  escapedA: number;
  escapedB: number;
  /** 非摧毁舰船（存活或已撤离）的剩余点数价值 */
  valueA: number;
  valueB: number;
  /** 各舰船最终状态（shipId -> CombatState），供战后面板 */
  finalStates: Record<number, CombatState>;
}

function teamCounts(state: BattleState, team: Team) {
  let capable = 0;
  let destroyed = 0;
  let escaped = 0;
  let value = 0;
  const finalStates: Record<number, CombatState> = {};
  for (const s of state.ships) {
    if (s.team !== team) continue;
    finalStates[s.id] = s.combatState;
    if (s.combatState === 'escaped') {
      escaped++;
    } else if (s.combatState === 'destroyed') {
      destroyed++;
    } else if (isCombatCapable(s)) {
      capable++;
    }
    // 价值统一按冻结公式（disabled=50%、escaped=100% 等）累计
    value += getShipPointValue(s);
  }
  return { capable, destroyed, escaped, value, finalStates };
}

/** 依据双方 combatCapable 与剩余价值判定胜负与原因（core-v4）。 */
export function decideVictory(state: BattleState): VictoryResult {
  const a = teamCounts(state, 'A');
  const b = teamCounts(state, 'B');
  const totalA = state.ships.filter((s) => s.team === 'A').length;
  const totalB = state.ships.filter((s) => s.team === 'B').length;

  let winner: Team | null = null;
  let reason: VictoryReason = 'draw';

  if (a.capable === 0 && b.capable === 0) {
    if (a.value === b.value) {
      winner = null;
      reason = 'draw';
    } else {
      winner = a.value > b.value ? 'A' : 'B';
      reason = 'pointsDecision';
    }
  } else if (a.capable === 0) {
    winner = 'B';
    if (a.destroyed >= totalA && totalA > 0) reason = 'annihilation';
    else if (a.escaped > 0) reason = 'retreat';
    else reason = 'combatDisabled';
  } else if (b.capable === 0) {
    winner = 'A';
    if (b.destroyed >= totalB && totalB > 0) reason = 'annihilation';
    else if (b.escaped > 0) reason = 'retreat';
    else reason = 'combatDisabled';
  } else {
    // 双方仍有战斗力（仅可能在达到 maxTicks 时到达）
    if (a.value === b.value) {
      winner = null;
      reason = 'draw';
    } else {
      winner = a.value > b.value ? 'A' : 'B';
      reason = 'timeout';
    }
  }

  return {
    winner,
    reason,
    capableA: a.capable,
    capableB: b.capable,
    destroyedA: a.destroyed,
    destroyedB: b.destroyed,
    escapedA: a.escaped,
    escapedB: b.escaped,
    valueA: a.value,
    valueB: b.value,
    finalStates: { ...a.finalStates, ...b.finalStates }
  };
}

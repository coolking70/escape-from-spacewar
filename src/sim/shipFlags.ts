// 舰船"存活 / 在场 / 可锁定 / 可战斗 / 在模拟中"语义的单一事实来源。
//
// 背景：core-v4 之前 `alive` 同时被用来表达多种含义（未被摧毁 / 仍在场 / 仍可行动 /
// 仍可作目标）。V0.5.2 起明确拆分语义，并规定：
//   alive = 结构未被摧毁。escaped 舰仍 alive=true，只是不再位于战场。
// 其余行为一律由 combatState 或下列辅助函数判定，避免歧义。
//
// 注意：结构存活与在场刻意分离：escaped 是结构存活但不在场，destroyed 才是结构死亡。

import { Ship, CombatState } from './battleTypes';
import { isCombatCapable as _isCombatCapable } from './combatState';
import { engineRatioFrom, weaponSystemFrom, sensorSystemFrom } from './derivedStats';

/** 结构存活：仅 destroyed 为 false。escaped 舰结构仍在，只是已经离场。 */
export function isStructurallyAlive(ship: Ship): boolean {
  return ship.combatState !== 'destroyed';
}

/** 仍在战场上（可被渲染/物理处理）：escaped 已脱离战场、destroyed 已爆毁。 */
export function isPresentOnBattlefield(ship: Ship): boolean {
  return ship.combatState !== 'destroyed' && ship.combatState !== 'escaped';
}

/** 仍可作目标（可被敌方锁定开火）：在场且非 destroyed / escaped。
 *  注意 disabled 仍可被攻击（瘫痪≠离场），escaped 不可被攻击。 */
export function isTargetable(ship: Ship): boolean {
  const cs = ship.combatState;
  return cs !== 'destroyed' && cs !== 'escaped';
}

/** 仍在模拟循环中参与推进（未爆毁、未脱离）。 */
export function isActiveInSimulation(ship: Ship): boolean {
  return ship.combatState !== 'destroyed' && ship.combatState !== 'escaped';
}

/** 是否仍有战斗能力（用于结束判定）：normal/damaged/critical/retreating 视为可战斗；
 *  disabled/escaped/destroyed 不计。权威实现见 combatState.ts（与 v3 共用）。 */
export const isCombatCapable = _isCombatCapable;

/** 已摧毁：无论 alive 字段如何，仅由 combatState 判定。 */
export function isDestroyed(ship: Ship): boolean {
  return ship.combatState === 'destroyed';
}

/** 已脱离战场（成功撤离）：纯 combatState 判定，不涉及 alive。 */
export function isEscaped(ship: Ship): boolean {
  return ship.combatState === 'escaped';
}

/** 已瘫痪（引擎/武器/传感器全失能）：纯 combatState 判定。 */
export function isDisabled(ship: Ship): boolean {
  return ship.combatState === 'disabled';
}

/** 正在撤退（已启动撤退但尚未抵达边界）：纯 combatState 判定。 */
export function isRetreating(ship: Ship): boolean {
  return ship.combatState === 'retreating';
}

/** 给定战斗状态，返回其优先级数值（越大越"高级"，用于比较/排序）。 */
export function combatStatePriority(cs: CombatState): number {
  switch (cs) {
    case 'destroyed':
      return 7;
    case 'escaped':
      return 6;
    case 'disabled':
      return 5;
    case 'retreating':
      return 4;
    case 'critical':
      return 3;
    case 'damaged':
      return 2;
    case 'normal':
    default:
      return 1;
  }
}

/**
 * 结构死亡判定（与模拟器 dealDamage 的权威规则完全一致）：
 * 核心组件已摧毁 或 全部组件已摧毁 ⇒ 该舰结构死亡，combatState 必须为 'destroyed'。
 * 供模拟器（可选复用）与校验器共同使用，避免两套不一致的死亡判定。
 */
export function isStructurallyDestroyed(ship: Ship): boolean {
  const core = ship.components.find((component) => component.def.type === 'core');
  const coreDead = core ? core.destroyed : true;
  const allDead = ship.components.length > 0 && ship.components.every((component) => component.destroyed);
  return coreDead || allDead;
}

/** 由组件真实损毁推导的失能标志（与模拟器 recomputeDerivedV4 的引擎/武器/传感器规则一致）。 */
export interface DisableFlags {
  mobilityDisabled: boolean;
  weaponsDisabled: boolean;
  sensorsDisabled: boolean;
}

export function expectedDisableFlags(ship: Ship): DisableFlags {
  const eng = engineRatioFrom(ship.components.filter((component) => component.def.type === 'engine'));
  const wpn = weaponSystemFrom(ship.components.filter((component) => component.def.type === 'weapon'));
  const sen = sensorSystemFrom(ship.components.filter((component) => component.def.type === 'sensor'));
  return {
    mobilityDisabled: eng.mobilityDisabled,
    weaponsDisabled: wpn.weaponsDisabled,
    sensorsDisabled: sen.sensorsDisabled
  };
}

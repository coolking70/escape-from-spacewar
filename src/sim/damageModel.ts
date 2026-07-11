// 伤害模型与性能派生。
// 所有"随机"行为都必须来自传入的 PRNG，确保确定性。

import { BattleState, Ship, ShipComponent } from './battleTypes';
import { PRNG } from './prng';

/** applyDamage 的结果，供模拟器发射视觉事件（不影响判定本身） */
export interface DamageResult {
  /** 被选中组件的 ship.components 下标 */
  compIndex: number;
  /** 受损后的 HP 比例 0~1 */
  hpRatio: number;
  /** 该组件是否被摧毁 */
  destroyed: boolean;
  /** 受损前该组件 HP */
  oldHp: number;
  /** 本次伤害是否导致飞船整体被摧毁 */
  shipDestroyed: boolean;
  /** 实际扣除的总伤害（护盾 + 船体，上限为可用值，不含溢出） */
  applied: number;
  /** 其中来自护盾的部分 */
  shieldDamage: number;
}

/** 重新计算飞船的派生属性（速度/射程/命中/护盾），依赖组件损毁情况 */
export function recomputeDerived(ship: Ship): void {
  const def = ship.def;

  const engines = ship.components.filter((c) => c.def.type === 'engine');
  const intactEng = engines.filter((c) => !c.destroyed).length;
  const engFactor = engines.length > 0 ? 0.25 + 0.75 * (intactEng / engines.length) : 1;

  const sensors = ship.components.filter((c) => c.def.type === 'sensor');
  const intactSen = sensors.filter((c) => !c.destroyed).length;
  const senFactor = sensors.length > 0 ? intactSen / sensors.length : 1;

  const shields = ship.components.filter((c) => c.def.type === 'shield');
  const intactShields = shields.filter((c) => !c.destroyed);
  ship.maxShield = intactShields.reduce((s, c) => s + c.maxHp, 0);
  ship.shieldRegen = ship.maxShield * 0.004;

  ship.effectiveSpeed = def.maxSpeed * engFactor;
  ship.effectiveRange = def.baseRange * (0.5 + 0.5 * senFactor);
  ship.accuracy = 0.5 + 0.45 * senFactor;

  if (ship.shield > ship.maxShield) ship.shield = ship.maxShield;
}

/** 返回当前仍可开火的武器组件（带组件下标） */
export function getIntactWeapons(ship: Ship): { comp: ShipComponent; index: number }[] {
  const out: { comp: ShipComponent; index: number }[] = [];
  ship.components.forEach((c, i) => {
    if (c.def.weapon && !c.destroyed) out.push({ comp: c, index: i });
  });
  return out;
}

function weightedPick<T>(items: T[], weights: number[], rng: PRNG): T {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function checkDeath(state: BattleState, ship: Ship): boolean {
  if (!ship.alive) return false;
  const core = ship.components.find((c) => c.def.type === 'core');
  const coreDead = core ? core.destroyed : true;
  const allDead = ship.components.every((c) => c.destroyed);
  if (coreDead || allDead) {
    ship.alive = false;
    ship.shield = 0;
    state.explosions.push({
      shipId: ship.id,
      pos: { ...ship.pos },
      tick: state.tick
    });
    return true;
  }
  return false;
}

/**
 * 对目标飞船施加伤害。先扣护盾，剩余伤害按组件 HP 加权随机选一个未摧毁组件。
 * 命中致命后记录爆炸。所有随机性来自 rng。
 * 返回被命中组件与飞船死亡信息（供模拟器派发视觉事件，不影响判定）。
 */
export function applyDamage(
  state: BattleState,
  ship: Ship,
  dmg: number,
  rng: PRNG
): DamageResult | null {
  let remaining = dmg;
  let result: DamageResult | null = null;
  let absorbed = 0;

  if (ship.shield > 0) {
    absorbed = Math.min(ship.shield, remaining);
    ship.shield -= absorbed;
    remaining -= absorbed;
  }

  let hullRemoved = 0;
  if (remaining > 0) {
    const candidates = ship.components.filter((c) => !c.destroyed);
    if (candidates.length > 0) {
      const weights = candidates.map((c) => c.maxHp);
      const chosen = weightedPick(candidates, weights, rng);
      const idx = ship.components.indexOf(chosen);
      const before = chosen.hp;
      chosen.hp -= remaining;
      if (chosen.hp <= 0) {
        chosen.hp = 0;
        chosen.destroyed = true;
      }
      hullRemoved = before - chosen.hp;
      result = {
        compIndex: idx,
        hpRatio: chosen.hp / chosen.maxHp,
        destroyed: chosen.destroyed,
        oldHp: before,
        shipDestroyed: false,
        applied: absorbed + hullRemoved,
        shieldDamage: absorbed
      };
    }
  }

  recomputeDerived(ship);
  const died = checkDeath(state, ship);
  if (result) result.shipDestroyed = died;
  return result;
}

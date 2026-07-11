// core-v4 组件命中模型：基于攻击方向的方位筛选 + 护盾/装甲保护 + 确定性加权选择。
// 纯函数（仅消耗传入 PRNG，且 selectHitComponent 的 PRNG 调用次数恒为 1），
// 不读取任何渲染 / 真实时间状态，保证相同输入恒得相同输出。

import { Ship, HitZone, ShipComponent, DamageType, Vec3 } from './battleTypes';
import { PRNG } from './prng';

export interface WeightedCandidate {
  comp: ShipComponent;
  index: number;
  weight: number;
}

/** 由攻击者相对目标的位置，判定攻击来自目标的哪个方位。
 * 与开火弧同一约定：前向 = (cos h, 0, -sin h)，右舷 = (sin h, 0, cos h)。
 * 前向投影 >= 0.5 → front；<= -0.5 → rear；否则按右舷投影正负判 left/right。 */
export function getIncomingHitZone(attackerPos: Vec3, target: Ship): HitZone {
  const fx = Math.cos(target.heading);
  const fz = -Math.sin(target.heading);
  const rx = Math.sin(target.heading);
  const rz = Math.cos(target.heading);
  let dx = attackerPos.x - target.pos.x;
  let dz = attackerPos.z - target.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const f = dx * fx + dz * fz;
  const r = dx * rx + dz * rz;
  if (f >= 0.5) return 'front';
  if (f <= -0.5) return 'rear';
  return r >= 0 ? 'right' : 'left';
}

/** 由武器角色推导伤害类型（drone 由调用方单独传入） */
export function weaponDamageType(role?: 'laser' | 'cannon' | 'pd'): DamageType {
  if (role === 'pd') return 'pointDefense';
  if (role === 'cannon') return 'cannon';
  return 'laser';
}

/** 伤害类型对各类组件的倍率（装甲保护）：core-v4 建议值。
 * 仅 armor 有抗性差异；其余组件恒为 1.0。 */
export function getDamageMultiplier(dmgType: DamageType, compType: string): number {
  if (compType === 'armor') {
    switch (dmgType) {
      case 'laser':
        return 0.8;
      case 'cannon':
        return 1.15;
      case 'heavy':
        return 1.3;
      case 'pointDefense':
        return 0.5;
      case 'drone':
      case 'kinetic':
      default:
        return 1.0;
    }
  }
  return 1.0;
}

/** 依据攻击方位筛选并加权候选组件（确定性）。
 *  - 仅未摧毁组件参与；
 *  - 若组件定义了 hitZones 且不含当前方位，则跳过（方位过滤）；
 *  - 未摧毁护盾/装甲覆盖本方位且保护该组件类型时，降权（装甲比护盾更强保护）；
 *  - 已摧毁的护盾/装甲曾覆盖本方位且保护该组件类型时，提权（暴露）；
 *  - 候选按组件 index 升序输出（稳定，保证加权选择可复现）。 */
export function buildComponentHitCandidates(ship: Ship, zone: HitZone): WeightedCandidate[] {
  const comps = ship.components
    .map((c, i) => ({ c, i }))
    .filter((x) => !x.c.destroyed)
    .sort((a, b) => a.i - b.i);

  const out: WeightedCandidate[] = [];
  for (const { c, i } of comps) {
    const def = c.def;
    const zones = def.hitZones;
    if (zones && !zones.includes(zone)) continue;
    let w = def.hitWeight ?? 1;

    for (const armor of ship.components) {
      const az = armor.def.hitZones;
      const prot = armor.def.protects;
      if (!az || !prot) continue;
      const covers = az.includes(zone) && prot.includes(c.def.type);
      if (!covers) continue;
      if (!armor.destroyed) {
        // 未摧毁保护：降权
        w *= armor.def.type === 'shield' ? 0.5 : 0.35;
      } else {
        // 已摧毁：暴露，提权
        w *= 2.2;
      }
    }
    out.push({ comp: c, index: i, weight: w });
  }
  return out;
}

/** 用确定性 PRNG 从权重中选出被命中的组件。
 * PRNG 调用次数恒为 1（与候选数量无关），保证确定性。候选按 index 顺序遍历。 */
export function selectHitComponent(cand: WeightedCandidate[], rng: PRNG): WeightedCandidate | null {
  if (cand.length === 0) return null;
  let total = 0;
  for (const c of cand) total += c.weight;
  let r = rng.next() * total;
  for (const c of cand) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return cand[cand.length - 1];
}

/** 计算飞船总 HP 比例（0~1） */
export function hpRatio(ship: Ship): number {
  let hp = 0;
  let max = 0;
  for (const c of ship.components) {
    hp += c.hp;
    max += c.maxHp;
  }
  return max > 0 ? hp / max : 0;
}

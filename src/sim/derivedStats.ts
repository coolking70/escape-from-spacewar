// 派生属性（引擎/武器/传感器效率、护盾、转向）的纯函数实现。
// 这些函数无随机、无渲染/时间依赖，供 simulatorV4.recomputeDerivedV4 与单元测试共用，
// 保证"武器/引擎/传感器损伤效率"规则可独立验证且冻结后稳定。

import { ShipComponent } from './battleTypes';

/** 引擎综合完好率 = 存活引擎 HP 和 / 引擎最大 HP 和（0~1）。
 *  全部引擎摧毁 => mobilityDisabled=true。多引擎舰只损失一个引擎时按总 HP 比例计算。 */
export function engineRatioFrom(engines: ShipComponent[]): { ratio: number; mobilityDisabled: boolean } {
  const max = engines.reduce((s, c) => s + c.maxHp, 0);
  const intact = engines.filter((c) => !c.destroyed);
  const cur = intact.reduce((s, c) => s + c.hp, 0);
  const ratio = max > 0 ? cur / max : 1;
  return {
    ratio: Math.min(1, Math.max(0, ratio)),
    mobilityDisabled: engines.length > 0 && intact.length === 0
  };
}

/** 武器综合效率 = 0.4 + 0.6 × 武器 HP 率均值（0.4~1，不超出 1）。
 *  全部武器摧毁 => weaponsDisabled=true。 */
export function weaponSystemFrom(weapons: ShipComponent[]): {
  ratio: number;
  weaponsDisabled: boolean;
  efficiency: number;
} {
  const max = weapons.reduce((s, c) => s + c.maxHp, 0);
  const intact = weapons.filter((c) => !c.destroyed);
  const cur = intact.reduce((s, c) => s + c.hp, 0);
  const ratio = max > 0 ? cur / max : 1;
  const eff = 0.4 + 0.6 * ratio;
  return {
    ratio: Math.min(1, Math.max(0, ratio)),
    weaponsDisabled: weapons.length > 0 && intact.length === 0,
    efficiency: Math.min(1, Math.max(0, eff))
  };
}

/** 传感器综合完好率 = 存活传感器 HP 和 / 传感器最大 HP 和（0~1）。
 *  全部传感器摧毁 => sensorsDisabled=true。 */
export function sensorSystemFrom(sensors: ShipComponent[]): { ratio: number; sensorsDisabled: boolean } {
  const max = sensors.reduce((s, c) => s + c.maxHp, 0);
  const intact = sensors.filter((c) => !c.destroyed);
  const cur = intact.reduce((s, c) => s + c.hp, 0);
  const ratio = max > 0 ? cur / max : 1;
  return {
    ratio: Math.min(1, Math.max(0, ratio)),
    sensorsDisabled: sensors.length > 0 && intact.length === 0
  };
}

/** 由武器效率推导有效冷却（tick）。冷却最低为 1，不随效率低于此值。 */
export function effectiveCooldown(baseCooldown: number, weaponEfficiency: number): number {
  return Math.max(1, Math.round(baseCooldown / weaponEfficiency));
}

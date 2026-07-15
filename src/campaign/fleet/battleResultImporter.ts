import { BattleState } from '../../sim/battleTypes';
import { PersistentFleet, persistentShipHasCriticalDamage } from './persistentFleet';
import { PersistentBattleBinding } from './battleAdapter';

export function importBattleResult(
  fleet: PersistentFleet,
  state: BattleState,
  bindings: ReadonlyArray<PersistentBattleBinding>
): PersistentFleet {
  const boundIds = new Set(bindings.map((binding) => binding.campaignShipId));
  if (boundIds.size !== bindings.length) {
    throw new Error('战役战斗绑定包含重复 campaignShipId。');
  }

  // 未参战舰保持 deployed / escaped / disabled / towed / componentHp 原样不变；
  // 只有 binding 中实际参战的舰船会被修改（见下方循环）。
  const next = fleet.ships.map((ship) => ({
    ...ship,
    componentHp: ship.componentHp ? [...ship.componentHp] : undefined
  }));

  for (const binding of bindings) {
    const persistent = next.find((ship) => ship.campaignShipId === binding.campaignShipId);
    const battle = state.ships.find(
      (ship) => ship.id === binding.battleShipId && ship.team === 'A'
    );
    if (!persistent || !battle) {
      throw new Error(
        `战役战斗绑定 ${binding.campaignShipId} / #${binding.battleShipId} 无效。`
      );
    }
    if (battle.combatState === 'destroyed') {
      next.splice(next.indexOf(persistent), 1);
      continue;
    }
    persistent.deployed = true;
    persistent.escaped = battle.combatState === 'escaped';
    persistent.towed = persistent.disabled ? persistent.towed : false;
    persistent.componentHp = battle.components.map((component) => component.hp);
    // 真实模拟器会让 disabled 与关键组件损伤同源；保留 combatState 兜底以兼容旧战役结果导入，
    // 同时绝不允许真实关键损伤被写回为 disabled=false。
    persistent.disabled = battle.combatState === 'disabled' || persistentShipHasCriticalDamage(persistent);
    persistent.towed = persistent.disabled ? persistent.towed : false;
  }

  return { ...fleet, ships: next };
}

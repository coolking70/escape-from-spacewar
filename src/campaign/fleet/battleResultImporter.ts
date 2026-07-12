import { BattleState } from '../../sim/battleTypes';
import { PersistentFleet } from './persistentFleet';
import { CampaignBattleBinding } from './battleAdapter';
export function importBattleResult(fleet: PersistentFleet, state: BattleState, bindings: CampaignBattleBinding[]): PersistentFleet {
  const boundIds = new Set(bindings.map((binding) => binding.campaignShipId));
  if (boundIds.size !== bindings.length) throw new Error('战役战斗绑定包含重复 campaignShipId。');
  const next = fleet.ships.map((ship) => ({ ...ship, componentHp: ship.componentHp ? [...ship.componentHp] : undefined }));
  for (const binding of bindings) { const persistent = next.find((ship) => ship.campaignShipId === binding.campaignShipId); const battle = state.ships.find((ship) => ship.id === binding.battleShipId && ship.team === 'A'); if (!persistent || !battle) throw new Error(`战役战斗绑定 ${binding.campaignShipId} / #${binding.battleShipId} 无效。`); if (battle.combatState === 'destroyed') { next.splice(next.indexOf(persistent), 1); continue; } persistent.disabled = battle.combatState === 'disabled'; persistent.escaped = battle.combatState === 'escaped'; persistent.componentHp = battle.components.map((component) => component.hp); }
  return { ...fleet, ships: next };
}

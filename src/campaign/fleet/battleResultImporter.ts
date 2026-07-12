import { BattleState } from '../../sim/battleTypes';
import { PersistentFleet } from './persistentFleet';
export function importBattleResult(fleet: PersistentFleet, state: BattleState): PersistentFleet {
  const ordered = fleet.ships.filter((s) => !s.disabled); const combatants = state.ships.filter((s) => s.team === 'A').sort((a, b) => a.id - b.id);
  const next = fleet.ships.map((ship) => ({ ...ship, componentHp: ship.componentHp ? [...ship.componentHp] : undefined }));
  for (let i = 0; i < ordered.length; i++) { const persistent = next.find((s) => s.campaignShipId === ordered[i].campaignShipId)!; const battle = combatants[i]; if (!battle || battle.combatState === 'destroyed') { next.splice(next.indexOf(persistent), 1); continue; } persistent.disabled = battle.combatState === 'disabled'; persistent.escaped = battle.combatState === 'escaped'; persistent.componentHp = battle.components.map((c) => c.hp); }
  return { ...fleet, ships: next };
}

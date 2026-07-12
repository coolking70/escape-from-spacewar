import { BattleState } from '../../sim/battleTypes';
import { hash32 } from '../sector/sectorGenerator';
import { PendingSalvage, SalvageOption } from './salvageTypes';

function countEnemy(battle: BattleState, state: 'destroyed' | 'disabled'): number {
  return battle.ships.filter((ship) => ship.team === 'B' && ship.combatState === state).length;
}

export function generatePendingSalvage(
  campaignSeed: number,
  sectorIndex: number,
  nodeId: string,
  battleIndex: number,
  battle: BattleState,
  ownShipsBefore: number,
  ownShipsAfter: number
): PendingSalvage {
  const enemyDestroyed = countEnemy(battle, 'destroyed');
  const enemyDisabled = countEnemy(battle, 'disabled');
  const ownDestroyed = Math.max(0, ownShipsBefore - ownShipsAfter);
  const score = Math.max(1, enemyDestroyed * 3 + enemyDisabled * 2 + sectorIndex);
  const seed = hash32(campaignSeed, sectorIndex, nodeId, battleIndex, 'salvage');

  const quickParts = Math.max(1, Math.floor(score / 4));
  const quickFuel = seed % 3 === 0 ? 1 : 0;
  const thoroughParts = quickParts + 1 + (seed % 3);
  const thoroughSupplies = 1 + ((seed >>> 4) % 2);
  const thoroughFuel = 1 + ((seed >>> 8) % 2);
  const relic = score >= 7 && (seed >>> 12) % 3 !== 0 ? 1 : 0;

  const options: SalvageOption[] = [
    {
      id: 'quick',
      label: '快速搜刮',
      description: '只取最容易回收的物资，减少在残骸区停留的时间。',
      turns: 1,
      threat: 1,
      items: [
        { type: 'repairParts', quantity: quickParts },
        ...(quickFuel ? [{ type: 'fuelCell' as const, quantity: quickFuel }] : [])
      ]
    },
    {
      id: 'thorough',
      label: '完整打捞',
      description: '拆解残骸并搜索货舱，收益更高，但需要更长时间。',
      turns: 2,
      threat: 3,
      items: [
        { type: 'repairParts', quantity: thoroughParts },
        { type: 'supplyCrate', quantity: thoroughSupplies },
        { type: 'fuelCell', quantity: thoroughFuel },
        ...(relic ? [{ type: 'relic' as const, quantity: relic }] : [])
      ]
    },
    {
      id: 'leave',
      label: '立即离开',
      description: '放弃战利品，不在残骸区继续暴露。',
      turns: 0,
      threat: 0,
      items: []
    }
  ];

  return {
    nodeId,
    battleIndex,
    summary: { enemyDestroyed, enemyDisabled, ownDestroyed },
    options
  };
}

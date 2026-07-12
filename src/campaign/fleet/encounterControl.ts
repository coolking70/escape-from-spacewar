import { getShipDef } from '../../sim/shipVariants';
import { CampaignState } from '../campaignTypes';
import { hash32 } from '../sector/sectorGenerator';
import { deriveBattleSeed, enemyFleetFor } from './battleAdapter';
import { assessEncounter, campaignFleetEntryCost, campaignFleetPower, EncounterAssessment } from './campaignPower';

export interface CampaignEncounterPreview {
  seed: number;
  assessment: EncounterAssessment;
  evadeChance: number;
  evadeRoll: number;
  canEvade: boolean;
  canWithdraw: boolean;
}

function sensorReadiness(state: CampaignState): number {
  const ships = state.fleet.ships.filter((ship) => !ship.disabled && ship.deployed !== false);
  if (!ships.length) return 0;
  return ships.reduce((sum, ship) => {
    const def = getShipDef(ship.shipClass, ship.variant).def;
    const sensorIndexes = def.components
      .map((component, index) => ({ component, index }))
      .filter(({ component }) => component.type === 'sensor');
    if (!sensorIndexes.length || !ship.componentHp) return sum + 1;
    const current = sensorIndexes.reduce((value, { component, index }) => value + Math.max(0, ship.componentHp![index] ?? component.maxHp), 0);
    const max = sensorIndexes.reduce((value, { component }) => value + component.maxHp, 0);
    return sum + (max > 0 ? current / max : 0);
  }, 0) / ships.length;
}

export function buildEncounterPreview(state: CampaignState): CampaignEncounterPreview | null {
  const pending = state.pendingBattle;
  if (!pending) return null;
  const seed = deriveBattleSeed(state.campaignSeed, state.sectorIndex, pending.nodeId, pending.battleIndex);
  const playerPower = campaignFleetPower(state.fleet, pending.deployment);
  const enemy = enemyFleetFor(
    seed,
    state.sectorIndex,
    state.sector.threat.level,
    pending.reason === '星门守卫',
    playerPower
  );
  const enemyPower = campaignFleetEntryCost(enemy);
  const assessment = assessEncounter(playerPower, enemyPower);
  const scouts = state.fleet.ships.filter(
    (ship) => !ship.disabled && ship.deployed !== false && ship.variant === 'scout'
  ).length;
  const chance = Math.max(
    10,
    Math.min(
      85,
      Math.round(30 + scouts * 18 + sensorReadiness(state) * 15 - state.sector.threat.level * 6 + (assessment.ratio > 1.2 ? 10 : 0))
    )
  );
  const roll = hash32(state.campaignSeed, state.sectorIndex, pending.nodeId, pending.battleIndex, 'evade') % 100;
  return {
    seed,
    assessment,
    evadeChance: chance,
    evadeRoll: roll,
    canEvade: roll < chance,
    canWithdraw: !!pending.originNodeId && pending.originNodeId !== pending.nodeId && state.resources.fuel > 0
  };
}

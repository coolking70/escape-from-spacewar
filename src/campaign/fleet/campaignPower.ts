import { FleetEntry, ShipClass, ShipVariant } from '../../sim/battleTypes';
import { getShipDef, getVariantDef } from '../../sim/shipVariants';
import { DeploymentSelection } from '../deployment/deploymentSystem';
import { PersistentFleet, PersistentShip } from './persistentFleet';

const STANDARD_COST: Record<ShipClass, number> = {
  Fighter: 50,
  Frigate: 150,
  Cruiser: 360
};

export type EncounterDanger = 'favorable' | 'even' | 'dangerous' | 'overwhelming';

export interface EncounterAssessment {
  playerPower: number;
  enemyPower: number;
  ratio: number;
  danger: EncounterDanger;
  label: string;
}

export function campaignShipCost(shipClass: ShipClass, variant: ShipVariant): number {
  return variant === 'standard' ? STANDARD_COST[shipClass] : getVariantDef(variant).cost;
}

export function campaignFleetEntryCost(entries: FleetEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + campaignShipCost(entry.shipClass, entry.variant) * Math.max(0, Math.floor(entry.count)),
    0
  );
}

function componentIntegrity(ship: PersistentShip): number {
  if (!ship.componentHp?.length) return 1;
  const def = getShipDef(ship.shipClass, ship.variant).def;
  const max = def.components.reduce((sum, component) => sum + component.maxHp, 0);
  const current = ship.componentHp.reduce((sum, hp, index) => {
    const cap = def.components[index]?.maxHp ?? 0;
    return sum + Math.max(0, Math.min(cap, hp));
  }, 0);
  return max > 0 ? current / max : 0;
}

export function persistentShipPower(ship: PersistentShip): number {
  if (ship.disabled) return 0;
  return Math.round(campaignShipCost(ship.shipClass, ship.variant) * (0.35 + componentIntegrity(ship) * 0.65));
}

export function campaignFleetPower(
  fleet: PersistentFleet,
  deployment?: DeploymentSelection
): number {
  const selected = deployment ? new Set(deployment.selectedShipIds) : null;
  return fleet.ships.reduce((sum, ship) => {
    if (selected && !selected.has(ship.campaignShipId)) return sum;
    if (!selected && ship.deployed === false) return sum;
    return sum + persistentShipPower(ship);
  }, 0);
}

export function assessEncounter(playerPower: number, enemyPower: number): EncounterAssessment {
  const ratio = playerPower > 0 ? enemyPower / playerPower : Number.POSITIVE_INFINITY;
  const danger: EncounterDanger =
    ratio <= 0.8 ? 'favorable' : ratio <= 1.1 ? 'even' : ratio <= 1.35 ? 'dangerous' : 'overwhelming';
  const label = {
    favorable: '优势',
    even: '势均力敌',
    dangerous: '危险',
    overwhelming: '极度危险'
  }[danger];
  return { playerPower, enemyPower, ratio, danger, label };
}

import { FleetEntry, ShipClass, ShipVariant } from '../../sim/battleTypes';
import { assertValidFleet } from '../../sim/fleetValidator';
import { getShipDef } from '../../sim/shipVariants';

export interface PersistentShip {
  campaignShipId: string;
  shipClass: ShipClass;
  variant: ShipVariant;
  componentHp?: number[];
  disabled: boolean;
  escaped: boolean;
  towed: boolean;
  deployed?: boolean;
}

export interface PersistentFleet {
  ships: PersistentShip[];
  formation: 'line' | 'wedge' | 'wall' | 'swarm' | 'random';
  doctrine: 'balanced' | 'aggressive' | 'defensive' | 'kite' | 'focusFire' | 'antiCapital' | 'screen';
}

/**
 * 战略层唯一的参战资格判断。失能舰与明确标记为未部署的舰船均不得进入 Team A、
 * deployment 或 persistent battle binding。
 */
export function isStrategicShipEligible(ship: PersistentShip): boolean {
  return !ship.disabled && ship.deployed !== false;
}

/** 持久舰组件损伤的权威失能判定，和模拟器的关键系统语义一致。 */
export function persistentShipHasCriticalDamage(ship: PersistentShip): boolean {
  if (!ship.componentHp) return false;
  const components = getShipDef(ship.shipClass, ship.variant).def.components;
  return components.some((component, index) =>
    (component.type === 'core' || component.type === 'engine' || component.type === 'weapon' || component.type === 'sensor') &&
    ship.componentHp![index] <= 0
  );
}

export function createStarterFleet(): PersistentFleet {
  return {
    ships: [
      { campaignShipId: 'cs-0', shipClass: 'Fighter', variant: 'standard', disabled: false, escaped: false, towed: false, deployed: true },
      { campaignShipId: 'cs-1', shipClass: 'Fighter', variant: 'interceptor', disabled: false, escaped: false, towed: false, deployed: true },
      { campaignShipId: 'cs-2', shipClass: 'Frigate', variant: 'standard', disabled: false, escaped: false, towed: false, deployed: true }
    ],
    formation: 'line',
    doctrine: 'balanced'
  };
}

export function activeShips(fleet: PersistentFleet): PersistentShip[] {
  return fleet.ships.filter(isStrategicShipEligible);
}

export function disabledShips(fleet: PersistentFleet): PersistentShip[] {
  return fleet.ships.filter((ship) => ship.disabled);
}

export function towedShipCount(fleet: PersistentFleet): number {
  return fleet.ships.filter((ship) => ship.disabled && ship.towed).length;
}

export function movementFuelCost(fleet: PersistentFleet): number {
  return 1 + towedShipCount(fleet);
}

export function fleetEntries(fleet: PersistentFleet): FleetEntry[] {
  const grouped = new Map<string, FleetEntry>();
  for (const ship of activeShips(fleet)) {
    const key = `${ship.shipClass}:${ship.variant}`;
    const entry = grouped.get(key);
    if (entry) entry.count++;
    else grouped.set(key, { shipClass: ship.shipClass, variant: ship.variant, count: 1 });
  }
  const entries = [...grouped.values()];
  assertValidFleet(entries);
  return entries;
}

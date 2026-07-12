import { FleetEntry, ShipClass, ShipVariant } from '../../sim/battleTypes';
import { assertValidFleet } from '../../sim/fleetValidator';

export interface PersistentShip {
  campaignShipId: string;
  shipClass: ShipClass;
  variant: ShipVariant;
  componentHp?: number[];
  disabled: boolean;
  escaped: boolean;
  towed: boolean;
}

export interface PersistentFleet {
  ships: PersistentShip[];
  formation: 'line' | 'wedge' | 'wall' | 'swarm' | 'random';
  doctrine: 'balanced' | 'aggressive' | 'defensive' | 'kite' | 'focusFire' | 'antiCapital' | 'screen';
}

export function createStarterFleet(): PersistentFleet {
  return {
    ships: [
      {
        campaignShipId: 'cs-0',
        shipClass: 'Fighter',
        variant: 'standard',
        disabled: false,
        escaped: false,
        towed: false
      },
      {
        campaignShipId: 'cs-1',
        shipClass: 'Fighter',
        variant: 'interceptor',
        disabled: false,
        escaped: false,
        towed: false
      },
      {
        campaignShipId: 'cs-2',
        shipClass: 'Frigate',
        variant: 'standard',
        disabled: false,
        escaped: false,
        towed: false
      }
    ],
    formation: 'line',
    doctrine: 'balanced'
  };
}

export function activeShips(fleet: PersistentFleet): PersistentShip[] {
  return fleet.ships.filter((ship) => !ship.disabled);
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

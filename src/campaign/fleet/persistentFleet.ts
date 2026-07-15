import { FleetEntry, ShipClass, ShipVariant } from '../../sim/battleTypes';
import { assertValidFleet } from '../../sim/fleetValidator';
import { getShipDef } from '../../sim/shipVariants';
import { computeDisableFlagsFromComponents, DisableFlags } from '../../sim/shipFlags';

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

/** 当前战略层可使用的舰：失能、逃脱、明确留守舰均不计 operational。 */
export function isShipDeployable(ship: PersistentShip): boolean {
  return !ship.disabled && !ship.escaped && ship.deployed !== false;
}

/** 可被玩家选择加入部署的舰。取消部署不应取消其再次选择资格。 */
export function isShipEligibleForDeployment(ship: PersistentShip): boolean {
  return !ship.disabled && !ship.escaped;
}

/** B.4 兼容名：表示当前已部署的参战资格，而非可选择部署资格。 */
export const isStrategicShipEligible = isShipDeployable;

function persistentComponents(ship: PersistentShip) {
  const def = getShipDef(ship.shipClass, ship.variant).def;
  return def.components.map((component, index) => {
    const hp = ship.componentHp?.[index] ?? component.maxHp;
    return { id: index, def: component, hp, maxHp: component.maxHp, destroyed: hp <= 0 };
  });
}

/** 与 core-v4 simulator 同源的持久舰失能标志。 */
export function computePersistentDisableFlags(ship: PersistentShip): DisableFlags & { disabled: boolean } {
  const flags = computeDisableFlagsFromComponents(persistentComponents(ship));
  return { ...flags, disabled: flags.mobilityDisabled || flags.weaponsDisabled || flags.sensorsDisabled };
}

/** 核心归零为结构摧毁；战略写回应删除该舰，不能将其持久化为 disabled。 */
export function isPersistentShipDestroyed(ship: PersistentShip): boolean {
  const coreIndex = getShipDef(ship.shipClass, ship.variant).def.components.findIndex((component) => component.type === 'core');
  return coreIndex >= 0 && (ship.componentHp?.[coreIndex] ?? Number.POSITIVE_INFINITY) <= 0;
}

export function isPersistentShipDisabled(ship: PersistentShip): boolean {
  return computePersistentDisableFlags(ship).disabled;
}

/** 对持久舰施加真实系统失能：完整摧毁一个关键系统，并从组件事实重算 disabled。 */
export function disablePersistentShip(ship: PersistentShip): void {
  const def = getShipDef(ship.shipClass, ship.variant).def;
  if (!ship.componentHp) ship.componentHp = def.components.map((component) => component.maxHp);
  const targetType = ['engine', 'weapon', 'sensor'].find((type) => def.components.some((component) => component.type === type));
  if (!targetType) throw new Error(`舰船 ${ship.campaignShipId} 不含可失能的关键系统。`);
  def.components.forEach((component, index) => {
    if (component.type === targetType) ship.componentHp![index] = 0;
  });
  ship.disabled = isPersistentShipDisabled(ship);
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
  return fleet.ships.filter(isShipDeployable);
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

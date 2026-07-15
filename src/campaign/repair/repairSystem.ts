import { getShipDef } from '../../sim/shipVariants';
import { isPersistentShipDisabled, PersistentShip } from '../fleet/persistentFleet';

export interface FieldRepairResult {
  ship: PersistentShip;
  componentIndex: number;
  restoredHp: number;
  reactivated: boolean;
}

export function ensurePersistentComponentHp(ship: PersistentShip): number[] {
  if (ship.componentHp) return [...ship.componentHp];
  const { def } = getShipDef(ship.shipClass, ship.variant);
  return def.components.map((component) => component.maxHp);
}

export function canFieldRepair(ship: PersistentShip): boolean {
  const { def } = getShipDef(ship.shipClass, ship.variant);
  if (!ship.componentHp || ship.componentHp.length !== def.components.length) return false;
  return ship.componentHp.some((hp, index) => hp >= 0 && hp < def.components[index].maxHp);
}

export function fieldRepairShip(ship: PersistentShip): FieldRepairResult | null {
  const { def } = getShipDef(ship.shipClass, ship.variant);
  if (!ship.componentHp || ship.componentHp.length !== def.components.length) return null;

  let componentIndex = -1;
  let largestDeficit = 0;
  for (let index = 0; index < ship.componentHp.length; index++) {
    const hp = ship.componentHp[index];
    const deficit = def.components[index].maxHp - hp;
    const critical = def.components[index].type === 'engine' || def.components[index].type === 'weapon' || def.components[index].type === 'sensor';
    const priority = critical && hp <= 0 ? 1 : 0;
    const currentPriority = componentIndex >= 0 &&
      (def.components[componentIndex].type === 'engine' || def.components[componentIndex].type === 'weapon' || def.components[componentIndex].type === 'sensor') &&
      ship.componentHp[componentIndex] <= 0 ? 1 : 0;
    if (deficit > 0 && (priority > currentPriority || (priority === currentPriority && deficit > largestDeficit))) {
      largestDeficit = deficit;
      componentIndex = index;
    }
  }
  if (componentIndex < 0) return null;

  const next = { ...ship, componentHp: [...ship.componentHp] };
  const maxHp = def.components[componentIndex].maxHp;
  const amount = Math.max(1, Math.ceil(maxHp * 0.2));
  const before = next.componentHp[componentIndex];
  next.componentHp[componentIndex] = Math.min(maxHp, before + amount);
  const reactivated = !!next.disabled && !isPersistentShipDisabled(next);
  next.disabled = isPersistentShipDisabled(next);
  if (reactivated) {
    next.towed = false;
    next.escaped = false;
    next.deployed = true;
  }
  return {
    ship: next,
    componentIndex,
    restoredHp: next.componentHp[componentIndex] - before,
    reactivated
  };
}

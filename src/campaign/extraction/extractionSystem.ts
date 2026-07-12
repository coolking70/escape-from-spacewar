import { cargoQuantity, cargoUsed, removeCargo } from '../cargo/cargoSystem';
import { CargoItemType, CargoStack } from '../cargo/cargoTypes';
import { CampaignState } from '../campaignTypes';
import { disabledShips, towedShipCount } from '../fleet/persistentFleet';
import { getShipDef } from '../../sim/shipVariants';
import { hash32 } from '../sector/sectorGenerator';

export type ExtractionMode = 'normal' | 'emergency';
export type ExtractionRisk = 'low' | 'medium' | 'high' | 'critical';

export interface ExtractionPlan {
  prepared: boolean;
  fuelCost: number;
  safeCargoCapacity: number;
  cargoUsed: number;
  overload: number;
  untowedDisabled: number;
  towedDisabled: number;
  damagedShips: number;
  riskScore: number;
  risk: ExtractionRisk;
  factors: string[];
  canNormalExtract: boolean;
  emergencyDamageEvents: number;
}

export interface ExtractionResolution {
  state: CampaignState;
  jettisoned: CargoStack[];
  damagedShipIds: string[];
}

function damagedShipCount(state: CampaignState): number {
  let damaged = 0;
  for (const ship of state.fleet.ships) {
    if (!ship.componentHp) continue;
    const def = getShipDef(ship.shipClass, ship.variant).def;
    if (ship.componentHp.some((hp, index) => hp < def.components[index].maxHp)) damaged++;
  }
  return damaged;
}

function riskName(score: number): ExtractionRisk {
  if (score <= 2) return 'low';
  if (score <= 5) return 'medium';
  if (score <= 8) return 'high';
  return 'critical';
}

export function buildExtractionPlan(state: CampaignState): ExtractionPlan {
  const untowedDisabled = disabledShips(state.fleet).filter((ship) => !ship.towed).length;
  const towedDisabled = towedShipCount(state.fleet);
  const damagedShips = damagedShipCount(state);
  const safeCargoCapacity = Math.max(0, state.cargo.capacity - towedDisabled * 3 - damagedShips);
  const used = cargoUsed(state.cargo);
  const overload = Math.max(0, used - safeCargoCapacity);
  const prepared = !!state.extractionPrepared;
  const fuelCost = 1 + towedDisabled;
  const riskScore = Math.max(
    0,
    state.sector.threat.level + towedDisabled * 2 + damagedShips + overload * 2 + untowedDisabled * 5 - (prepared ? 2 : 0)
  );
  const factors: string[] = [];
  if (state.sector.threat.level >= 3) factors.push(`星域威胁 L${state.sector.threat.level}`);
  if (towedDisabled) factors.push(`拖曳失能舰 ${towedDisabled}`);
  if (damagedShips) factors.push(`受损舰船 ${damagedShips}`);
  if (overload) factors.push(`超出安全载荷 ${overload}`);
  if (untowedDisabled) factors.push(`未处理失能舰 ${untowedDisabled}`);
  if (prepared) factors.push('已完成跃迁准备');
  if (!factors.length) factors.push('舰队状态稳定');
  return {
    prepared,
    fuelCost,
    safeCargoCapacity,
    cargoUsed: used,
    overload,
    untowedDisabled,
    towedDisabled,
    damagedShips,
    riskScore,
    risk: riskName(riskScore),
    factors,
    canNormalExtract: untowedDisabled === 0 && overload === 0 && state.resources.fuel >= fuelCost,
    emergencyDamageEvents: Math.max(0, Math.ceil(riskScore / 4))
  };
}

const JETTISON_PRIORITY: CargoItemType[] = ['supplyCrate', 'fuelCell', 'repairParts', 'relic'];

export function jettisonCargo(
  state: CampaignState,
  type: CargoItemType,
  quantity = 1
): CampaignState | null {
  const cargo = removeCargo(state.cargo, type, quantity);
  if (!cargo) return null;
  return {
    ...state,
    cargo,
    history: [...state.history, { turn: state.turn, text: `抛弃货物：${type} ×${quantity}。` }]
  };
}

function autoJettison(state: CampaignState, overload: number): { state: CampaignState; stacks: CargoStack[] } {
  let next = state;
  let remaining = overload;
  const stacks: CargoStack[] = [];
  for (const type of JETTISON_PRIORITY) {
    while (remaining > 0 && cargoQuantity(next.cargo, type) > 0) {
      const removed = jettisonCargo(next, type, 1);
      if (!removed) break;
      next = removed;
      stacks.push({ type, quantity: 1 });
      remaining = Math.max(0, remaining - (type === 'relic' ? 3 : 1));
    }
  }
  return { state: next, stacks };
}

function applyEmergencyDamage(state: CampaignState, events: number): { state: CampaignState; damaged: string[] } {
  const next: CampaignState = {
    ...state,
    fleet: {
      ...state.fleet,
      ships: state.fleet.ships.map((ship) => ({
        ...ship,
        componentHp: ship.componentHp ? [...ship.componentHp] : undefined
      }))
    }
  };
  const candidates = next.fleet.ships.filter((ship) => !ship.disabled);
  const damaged: string[] = [];
  for (let index = 0; index < events && candidates.length; index++) {
    const ship = candidates[
      hash32(state.campaignSeed, state.sectorIndex, state.turn, index, 'jump-damage') % candidates.length
    ];
    const def = getShipDef(ship.shipClass, ship.variant).def;
    if (!ship.componentHp) ship.componentHp = def.components.map((component) => component.maxHp);
    const componentIndex =
      hash32(state.campaignSeed, ship.campaignShipId, index, 'jump-component') % ship.componentHp.length;
    ship.componentHp[componentIndex] = Math.max(1, ship.componentHp[componentIndex] - 1);
    damaged.push(ship.campaignShipId);
  }
  return { state: next, damaged };
}

export function resolveExtraction(
  state: CampaignState,
  mode: ExtractionMode
): ExtractionResolution | null {
  const plan = buildExtractionPlan(state);
  if (plan.untowedDisabled > 0 || state.resources.fuel < plan.fuelCost) return null;
  if (mode === 'normal' && !plan.canNormalExtract) return null;

  let next: CampaignState = {
    ...state,
    resources: { ...state.resources, fuel: state.resources.fuel - plan.fuelCost },
    cargo: { ...state.cargo, items: state.cargo.items.map((item) => ({ ...item })) },
    history: [...state.history]
  };
  const jettison = mode === 'emergency'
    ? autoJettison(next, plan.overload)
    : { state: next, stacks: [] };
  next = jettison.state;
  const damage = mode === 'emergency'
    ? applyEmergencyDamage(next, plan.emergencyDamageEvents)
    : { state: next, damaged: [] };
  next = damage.state;
  return { state: next, jettisoned: jettison.stacks, damagedShipIds: damage.damaged };
}

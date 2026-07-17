import { isShipDeployable } from '../campaign/fleet/persistentFleet';
import type {
  StrategicModuleId,
  StrategicResources,
  StrategicShipFitting,
  UniverseState
} from './universeTypes';
import { strategicMaxFuel } from './strategicBlueprints';

export interface StrategicModuleDefinition {
  label: string;
  description: string;
  cost: Partial<StrategicResources>;
}

/** 模块只提供战略效果；不得进入 ReplayConfig、BattleState 或 core-v4 舰船定义。 */
export const STRATEGIC_MODULE_DEFINITIONS: Record<StrategicModuleId, StrategicModuleDefinition> = {
  auxiliaryTank: {
    label: '辅助燃料舱',
    description: '所在舰存续时，战略舰队最大燃料 +1。',
    cost: { minerals: 8, energy: 4 }
  },
  surveyArray: {
    label: '远程测绘阵列',
    description: '所在舰可作战时，实体测绘科学收益 +2。',
    cost: { minerals: 6, energy: 6 }
  },
  fieldWorkshop: {
    label: '舰载维修工坊',
    description: '维修该舰时矿物消耗 -2、补给消耗 -1。',
    cost: { minerals: 10, supplies: 3 }
  }
};

export const STRATEGIC_MODULE_IDS = Object.keys(STRATEGIC_MODULE_DEFINITIONS) as StrategicModuleId[];

export function fittingForShip(state: UniverseState, campaignShipId: string): StrategicShipFitting | undefined {
  return state.fleet.fittings.find((fitting) => fitting.campaignShipId === campaignShipId);
}

export function validateStrategicFittings(state: UniverseState): boolean {
  if (!Array.isArray(state.fleet.fittings)) return false;
  const shipIds = new Set(state.fleet.ships.map((ship) => ship.campaignShipId));
  const fittedIds = new Set<string>();
  for (const fitting of state.fleet.fittings) {
    if (!fitting || !shipIds.has(fitting.campaignShipId) || fittedIds.has(fitting.campaignShipId)) return false;
    if (!STRATEGIC_MODULE_IDS.includes(fitting.moduleId)) return false;
    fittedIds.add(fitting.campaignShipId);
  }
  return true;
}

export function expectedStrategicMaxFuel(state: UniverseState): number {
  const auxiliaryTanks = state.fleet.fittings.filter((fitting) => fitting.moduleId === 'auxiliaryTank').length;
  return strategicMaxFuel(state.faction.legacy.blueprints) + auxiliaryTanks;
}

export function strategicSurveyScienceBonus(state: UniverseState): number {
  const deployable = new Set(state.fleet.ships.filter(isShipDeployable).map((ship) => ship.campaignShipId));
  return state.fleet.fittings.filter((fitting) => fitting.moduleId === 'surveyArray' && deployable.has(fitting.campaignShipId)).length * 2;
}

export function strategicRepairCost(state: UniverseState, campaignShipId: string): StrategicResources {
  const workshop = fittingForShip(state, campaignShipId)?.moduleId === 'fieldWorkshop';
  return { minerals: workshop ? 2 : 4, energy: 0, science: 0, supplies: workshop ? 4 : 5 };
}

export function pruneStrategicFittings(state: UniverseState): void {
  const shipIds = new Set(state.fleet.ships.map((ship) => ship.campaignShipId));
  state.fleet.fittings = state.fleet.fittings.filter((fitting) => shipIds.has(fitting.campaignShipId));
  state.fleet.maxFuel = expectedStrategicMaxFuel(state);
  state.fleet.fuel = Math.min(state.fleet.fuel, state.fleet.maxFuel);
}

import type { PermanentBlueprintId, StrategicResources } from './universeTypes';

export interface StrategicBlueprintEffect {
  label: string;
  description: string;
}

/** D.3 永久蓝图只改变战略层派生量；不得改写冻结的 core-v4 舰船定义、组件或战斗数值。 */
export const STRATEGIC_BLUEPRINT_EFFECTS: Record<PermanentBlueprintId, StrategicBlueprintEffect> = {
  fieldLogistics: {
    label: '远征后勤核心',
    description: '跨域激活后最大燃料 +2，星际航行燃料消耗 -1（最低 1）。'
  },
  hardenedBulkheads: {
    label: '强化舰体蓝图',
    description: '跨域激活后免除高压紧急撤离的额外舰损；不修改 core-v4 舰体或组件 HP。'
  },
  compactFoundry: {
    label: '紧凑工业核心',
    description: '跨域激活后设施与舰船生产的矿物成本 -4（最低 0）。'
  }
};

export const STRATEGIC_BASE_MAX_FUEL = 8;

export function hasStrategicBlueprint(
  blueprints: readonly PermanentBlueprintId[],
  blueprint: PermanentBlueprintId
): boolean {
  return blueprints.includes(blueprint);
}

export function strategicMaxFuel(blueprints: readonly PermanentBlueprintId[]): number {
  return STRATEGIC_BASE_MAX_FUEL + (hasStrategicBlueprint(blueprints, 'fieldLogistics') ? 2 : 0);
}

export function strategicTravelFuelDiscount(blueprints: readonly PermanentBlueprintId[]): number {
  return hasStrategicBlueprint(blueprints, 'fieldLogistics') ? 1 : 0;
}

export function strategicIndustryMineralDiscount(blueprints: readonly PermanentBlueprintId[]): number {
  return hasStrategicBlueprint(blueprints, 'compactFoundry') ? 4 : 0;
}

export function strategicEmergencyPressureProtected(blueprints: readonly PermanentBlueprintId[]): boolean {
  return hasStrategicBlueprint(blueprints, 'hardenedBulkheads');
}

export function applyStrategicMineralDiscount<T extends Partial<StrategicResources>>(
  cost: T,
  blueprints: readonly PermanentBlueprintId[]
): T {
  return {
    ...cost,
    minerals: Math.max(0, (cost.minerals ?? 0) - strategicIndustryMineralDiscount(blueprints))
  };
}

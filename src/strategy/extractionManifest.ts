import { isShipDeployable } from '../campaign/fleet/persistentFleet';
import type {
  ExtractionAssignmentRole,
  ExtractionMode,
  StrategicExtractionManifest,
  UniverseState
} from './universeTypes';

export interface StrategicExtractionPlan {
  manifest: StrategicExtractionManifest;
  valid: boolean;
  error?: string;
  evacuatedShipIds: string[];
  towedShipIds: string[];
  rearguardShipIds: string[];
  abandonedShipIds: string[];
  pressureLossShipIds: string[];
  survivingShipIds: string[];
  lostShipIds: string[];
  fuelCost: number;
  suppliesCost: number;
  carriedMaterials: number;
  carriedSupplies: number;
  risk: 'stable' | 'controlled' | 'emergency' | 'critical';
}

const ROLES: ExtractionAssignmentRole[] = ['evacuate', 'tow', 'rearguard', 'abandon'];

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export function createDefaultExtractionManifest(
  state: UniverseState,
  mode: ExtractionMode
): StrategicExtractionManifest {
  return {
    mode,
    assignments: [...state.fleet.ships]
      .sort((left, right) => left.campaignShipId.localeCompare(right.campaignShipId))
      .map((ship) => ({
        campaignShipId: ship.campaignShipId,
        role: ship.disabled ? (mode === 'stable' ? 'tow' : 'abandon') : 'evacuate'
      }))
  };
}

/** D.2 清单结构权威：精确覆盖舰队，并让角色与真实舰船状态、撤离模式一致。 */
export function validateStrategicExtractionManifest(
  state: UniverseState,
  manifest: StrategicExtractionManifest
): { valid: boolean; error?: string } {
  if (!manifest || !['stable', 'emergency'].includes(manifest.mode) || !Array.isArray(manifest.assignments)) {
    return { valid: false, error: '撤离清单缺少合法模式或逐舰任务。' };
  }
  const fleetIds = sortedIds(state.fleet.ships.map((ship) => ship.campaignShipId));
  const assignmentIds = manifest.assignments.map((assignment) => assignment.campaignShipId);
  if (assignmentIds.some((id) => typeof id !== 'string' || !id)) {
    return { valid: false, error: '撤离清单包含空舰船 ID。' };
  }
  if (new Set(assignmentIds).size !== assignmentIds.length) {
    return { valid: false, error: '撤离清单包含重复舰船 ID。' };
  }
  if (JSON.stringify(sortedIds(assignmentIds)) !== JSON.stringify(fleetIds)) {
    return { valid: false, error: '撤离清单必须精确覆盖当前舰队。' };
  }

  let operationalEvacuees = 0;
  for (const assignment of manifest.assignments) {
    if (!ROLES.includes(assignment.role)) return { valid: false, error: `舰船 ${assignment.campaignShipId} 的撤离任务非法。` };
    const ship = state.fleet.ships.find((candidate) => candidate.campaignShipId === assignment.campaignShipId)!;
    if (ship.disabled) {
      if (assignment.role !== 'tow' && assignment.role !== 'abandon') {
        return { valid: false, error: `失能舰 ${ship.campaignShipId} 只能拖曳或放弃。` };
      }
    } else if (isShipDeployable(ship)) {
      if (assignment.role !== 'evacuate' && assignment.role !== 'rearguard' && assignment.role !== 'abandon') {
        return { valid: false, error: `可作战舰 ${ship.campaignShipId} 不能执行拖曳任务。` };
      }
      if (assignment.role === 'evacuate') operationalEvacuees++;
    } else if (assignment.role !== 'abandon') {
      return { valid: false, error: `不可用舰 ${ship.campaignShipId} 只能放弃。` };
    }
    if (manifest.mode === 'stable' && assignment.role === 'rearguard') {
      return { valid: false, error: '稳定撤离不允许留下断后舰。' };
    }
  }
  if (operationalEvacuees < 1) return { valid: false, error: '撤离清单必须保留至少一艘可作战舰。' };
  return { valid: true };
}

export function buildStrategicExtractionPlan(
  state: UniverseState,
  manifest: StrategicExtractionManifest
): StrategicExtractionPlan {
  const validation = validateStrategicExtractionManifest(state, manifest);
  const byRole = (role: ExtractionAssignmentRole) => sortedIds(
    manifest.assignments.filter((assignment) => assignment.role === role).map((assignment) => assignment.campaignShipId)
  );
  const evacuatedShipIds = byRole('evacuate');
  const towedShipIds = byRole('tow');
  const rearguardShipIds = byRole('rearguard');
  const abandonedShipIds = byRole('abandon');
  const pressureCandidates = evacuatedShipIds.filter((id) =>
    state.fleet.ships.find((ship) => ship.campaignShipId === id && isShipDeployable(ship))
  );
  const hardened = state.faction.legacy.blueprints.includes('hardenedBulkheads');
  const pressureLossShipIds = validation.valid && manifest.mode === 'emergency' && state.crisis.pressure >= 70 &&
    rearguardShipIds.length === 0 && !hardened && pressureCandidates.length > 1
    ? [pressureCandidates[0]]
    : [];
  const survivingShipIds = sortedIds([
    ...evacuatedShipIds.filter((id) => !pressureLossShipIds.includes(id)),
    ...towedShipIds
  ]);
  const lostShipIds = sortedIds(new Set([...rearguardShipIds, ...abandonedShipIds, ...pressureLossShipIds]));
  const emergencyTowCount = manifest.mode === 'emergency' ? towedShipIds.length : 0;
  const fuelCost = manifest.mode === 'stable' ? 2 : emergencyTowCount;
  const suppliesCost = manifest.mode === 'stable' ? 8 : 4 + emergencyTowCount * 2;
  const carriedMaterials = manifest.mode === 'stable'
    ? Math.min(30, Math.floor(state.faction.resources.minerals * 0.5))
    : Math.min(12, Math.floor(state.faction.resources.minerals * 0.25));
  const carriedSupplies = manifest.mode === 'stable'
    ? Math.min(12, Math.max(0, state.faction.resources.supplies - suppliesCost))
    : Math.min(5, Math.max(0, state.faction.resources.supplies - suppliesCost));
  const risk = manifest.mode === 'stable'
    ? 'stable'
    : pressureLossShipIds.length > 0
      ? 'critical'
      : rearguardShipIds.length > 0
        ? 'controlled'
        : 'emergency';
  return {
    manifest,
    valid: validation.valid,
    error: validation.error,
    evacuatedShipIds,
    towedShipIds,
    rearguardShipIds,
    abandonedShipIds,
    pressureLossShipIds,
    survivingShipIds,
    lostShipIds,
    fuelCost,
    suppliesCost,
    carriedMaterials,
    carriedSupplies,
    risk
  };
}

export function extractionManifestWithRole(
  state: UniverseState,
  manifest: StrategicExtractionManifest,
  campaignShipId: string,
  role: ExtractionAssignmentRole
): StrategicExtractionManifest | null {
  const next: StrategicExtractionManifest = {
    mode: manifest.mode,
    assignments: manifest.assignments.map((assignment) =>
      assignment.campaignShipId === campaignShipId ? { ...assignment, role } : { ...assignment }
    )
  };
  return validateStrategicExtractionManifest(state, next).valid ? next : null;
}

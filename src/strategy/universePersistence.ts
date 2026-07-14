import { generateUniverse } from './universeGenerator';
import { FACILITY_DEFINITIONS, RESEARCH_DEFINITIONS } from './universeRules';
import type {
  CrisisPhase,
  FacilityType,
  PermanentBlueprintId,
  ResearchProjectId,
  SpaceEntityKind,
  StarType,
  SystemControl,
  UniverseState
} from './universeTypes';

const STORAGE_KEY = 'spacewar.strategic-universe.current.v1';
const FACILITIES = Object.keys(FACILITY_DEFINITIONS) as FacilityType[];
const RESEARCH = Object.keys(RESEARCH_DEFINITIONS) as ResearchProjectId[];
const BLUEPRINTS: PermanentBlueprintId[] = ['fieldLogistics', 'hardenedBulkheads', 'compactFoundry'];
const ENTITY_KINDS: SpaceEntityKind[] = ['planet', 'moon', 'station', 'asteroidField', 'relicSite', 'jumpGate'];
const STAR_TYPES: StarType[] = ['yellowDwarf', 'redDwarf', 'blueGiant', 'whiteDwarf', 'binary'];
const CONTROLS: SystemControl[] = ['unknown', 'neutral', 'player', 'enemy'];
const CRISIS_PHASES: CrisisPhase[] = ['foothold', 'contest', 'collapse', 'evacuation'];

interface UniverseEnvelope {
  type: 'spacewar-sector-expedition';
  v: '1.0-alpha.2';
  state: UniverseState;
}

function b64(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(source: string): string {
  let value = source.replace(/-/g, '+').replace(/_/g, '/');
  value += '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function uniqueValid<T>(items: unknown, allowed: readonly T[]): items is T[] {
  return Array.isArray(items) && new Set(items).size === items.length && items.every((item) => allowed.includes(item as T));
}

function migrateAlpha1(raw: any): UniverseState | null {
  if (!raw || raw.version !== '1.0-alpha.1' || !nonNegativeInteger(raw.seed)) return null;
  const factionName = typeof raw.faction?.name === 'string' ? raw.faction.name : '深空远征团';
  const migrated = generateUniverse(raw.seed, factionName);
  migrated.log.unshift({
    turn: 0,
    text: '旧版永久战略宇宙实验存档已重置为“单星域高速 SLG + 星门撤离”模式。'
  });
  return migrated;
}

export function validateUniverseState(value: unknown): value is UniverseState {
  const state = value as UniverseState;
  if (
    !state || state.version !== '1.0-alpha.2' || !nonNegativeInteger(state.seed) ||
    !positiveInteger(state.sectorIndex) || !positiveInteger(state.targetSectorCount) ||
    state.sectorIndex > state.targetSectorCount || !nonNegativeInteger(state.turn)
  ) return false;
  if (!['active', 'victory', 'collapsed'].includes(state.status) || !Array.isArray(state.systems) || state.systems.length < 6) return false;
  if (!Array.isArray(state.entities) || !state.faction || !state.fleet || !Array.isArray(state.log)) return false;
  if (
    !state.crisis || !CRISIS_PHASES.includes(state.crisis.phase) || !nonNegativeInteger(state.crisis.pressure) ||
    state.crisis.pressure > 100 || !positiveInteger(state.crisis.finalTurn)
  ) return false;
  if (
    !state.extraction || !positiveInteger(state.extraction.requiredCalibration) ||
    !nonNegativeInteger(state.extraction.calibration) || state.extraction.calibration > state.extraction.requiredCalibration ||
    !nonNegativeInteger(state.extraction.emergencyThreshold) ||
    state.extraction.emergencyThreshold > state.extraction.requiredCalibration ||
    typeof state.extraction.discovered !== 'boolean'
  ) return false;

  const systemIds = new Set(state.systems.map((system) => system.id));
  if (systemIds.size !== state.systems.length || !systemIds.has(state.selectedSystemId) || !systemIds.has(state.fleet.systemId)) return false;
  for (const system of state.systems) {
    if (!system.id || !system.name || !STAR_TYPES.includes(system.starType) || !CONTROLS.includes(system.control)) return false;
    if (
      !Number.isFinite(system.x) || !Number.isFinite(system.y) || !Array.isArray(system.entityIds) ||
      !Array.isArray(system.neighbors) || !nonNegativeInteger(system.enemyPower) ||
      typeof system.discovered !== 'boolean' || typeof system.surveyed !== 'boolean'
    ) return false;
    if (new Set(system.neighbors).size !== system.neighbors.length || system.neighbors.includes(system.id)) return false;
    for (const neighborId of system.neighbors) {
      const neighbor = state.systems.find((candidate) => candidate.id === neighborId);
      if (!neighbor || !neighbor.neighbors.includes(system.id)) return false;
    }
  }

  const entityIds = new Set(state.entities.map((entity) => entity.id));
  if (
    entityIds.size !== state.entities.length || !entityIds.has(state.extraction.gateEntityId) ||
    state.entities.find((entity) => entity.id === state.extraction.gateEntityId)?.kind !== 'jumpGate'
  ) return false;
  for (const system of state.systems) {
    if (new Set(system.entityIds).size !== system.entityIds.length || system.entityIds.some((id) => !entityIds.has(id))) return false;
  }
  for (const entity of state.entities) {
    if (
      !entity.id || !entity.name || !systemIds.has(entity.systemId) || !ENTITY_KINDS.includes(entity.kind) ||
      !nonNegativeInteger(entity.orbit) || typeof entity.discovered !== 'boolean' || typeof entity.surveyed !== 'boolean'
    ) return false;
    const system = state.systems.find((candidate) => candidate.id === entity.systemId)!;
    if (!system.entityIds.includes(entity.id)) return false;
    if (entity.deposits && (!nonNegativeInteger(entity.deposits.minerals) || !nonNegativeInteger(entity.deposits.energy))) return false;
    if (entity.blueprint && !BLUEPRINTS.includes(entity.blueprint)) return false;
    if (entity.facilitySlots !== undefined && !positiveInteger(entity.facilitySlots)) return false;
    if (
      entity.facilities && entity.facilities.some((facility) =>
        !facility.id || !FACILITIES.includes(facility.type) || !positiveInteger(facility.level)
      )
    ) return false;
    if (
      entity.constructionQueue && (
        entity.constructionQueue.length > 2 ||
        entity.constructionQueue.some((order) =>
          !order.id || !FACILITIES.includes(order.facilityType) || !positiveInteger(order.turnsRemaining) ||
          !positiveInteger(order.totalTurns) || order.turnsRemaining > order.totalTurns
        )
      )
    ) return false;
    if ((entity.facilities || entity.constructionQueue) && entity.kind !== 'station') return false;
    if (
      entity.kind === 'station' && entity.facilitySlots !== undefined &&
      (entity.facilities?.length ?? 0) + (entity.constructionQueue?.length ?? 0) > entity.facilitySlots
    ) return false;
  }

  if (!state.faction.id || !state.faction.name || !state.faction.resources || !Array.isArray(state.faction.researchQueue)) return false;
  if (
    [
      state.faction.resources.minerals,
      state.faction.resources.energy,
      state.faction.resources.science,
      state.faction.resources.supplies
    ].some((amount) => !nonNegativeInteger(amount))
  ) return false;
  if (!uniqueValid(state.faction.localResearch, RESEARCH)) return false;
  if (
    state.faction.researchQueue.length > 2 ||
    state.faction.researchQueue.some((order) =>
      !order.id || !RESEARCH.includes(order.projectId) || !positiveInteger(order.turnsRemaining) ||
      !positiveInteger(order.totalTurns) || order.turnsRemaining > order.totalTurns ||
      state.faction.localResearch.includes(order.projectId)
    ) ||
    new Set(state.faction.researchQueue.map((order) => order.projectId)).size !== state.faction.researchQueue.length
  ) return false;
  if (
    !Array.isArray(state.faction.knownSystemIds) ||
    new Set(state.faction.knownSystemIds).size !== state.faction.knownSystemIds.length ||
    state.faction.knownSystemIds.some((id) => !systemIds.has(id))
  ) return false;
  if (!uniqueValid(state.faction.recoveredBlueprints, BLUEPRINTS)) return false;
  if (
    !state.faction.legacy || !nonNegativeInteger(state.faction.legacy.sectorsCleared) ||
    !nonNegativeInteger(state.faction.legacy.portableMaterials) || !nonNegativeInteger(state.faction.legacy.reserveSupplies) ||
    !nonNegativeInteger(state.faction.legacy.shipsLost) || !uniqueValid(state.faction.legacy.blueprints, BLUEPRINTS)
  ) return false;
  if (state.faction.baseEntityId) {
    const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId);
    if (
      !base || base.kind !== 'station' || base.ownerId !== state.faction.id ||
      !Array.isArray(base.facilities) || !Array.isArray(base.constructionQueue)
    ) return false;
  }

  if (
    !state.fleet.id || !state.fleet.name || !positiveInteger(state.fleet.shipCount) ||
    !nonNegativeInteger(state.fleet.disabledShips) || state.fleet.disabledShips >= state.fleet.shipCount ||
    !positiveInteger(state.fleet.combatPower) || !nonNegativeInteger(state.fleet.fuel) ||
    !positiveInteger(state.fleet.maxFuel) || state.fleet.fuel > state.fleet.maxFuel
  ) return false;
  return true;
}

export function encodeUniverse(state: UniverseState): string {
  if (!validateUniverseState(state)) throw new Error('星域战略远征状态无效。');
  const envelope: UniverseEnvelope = { type: 'spacewar-sector-expedition', v: '1.0-alpha.2', state };
  return b64(JSON.stringify(envelope));
}

export function decodeUniverse(code: string): UniverseState {
  let envelope: any;
  try {
    envelope = JSON.parse(unb64(code.trim()));
  } catch {
    throw new Error('星域远征码无法解析。');
  }
  if (envelope?.type === 'spacewar-strategic-universe' && envelope?.v === '1.0-alpha.1') {
    const migrated = migrateAlpha1(envelope.state);
    if (migrated) return migrated;
  }
  if (
    envelope?.type !== 'spacewar-sector-expedition' || envelope?.v !== '1.0-alpha.2' ||
    !validateUniverseState(envelope.state)
  ) throw new Error('星域远征码版本或结构无效。');
  return envelope.state;
}

export function saveUniverse(state: UniverseState): void {
  if (!validateUniverseState(state)) throw new Error('无法保存无效的星域战略远征。');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadUniverse(): UniverseState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const state = validateUniverseState(parsed) ? parsed : migrateAlpha1(parsed);
    if (!state) throw new Error('结构无效');
    if (parsed.version === '1.0-alpha.1') localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  } catch {
    throw new Error('星域战略远征存档损坏或不兼容。');
  }
}

export function clearUniverse(): void {
  localStorage.removeItem(STORAGE_KEY);
}

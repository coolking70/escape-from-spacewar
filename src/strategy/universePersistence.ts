import { FACILITY_DEFINITIONS, RESEARCH_DEFINITIONS } from './universeRules';
import type {
  FacilityType,
  ResearchProjectId,
  SpaceEntityKind,
  StarType,
  UniverseState
} from './universeTypes';

const STORAGE_KEY = 'spacewar.strategic-universe.current.v1';
const FACILITIES = Object.keys(FACILITY_DEFINITIONS) as FacilityType[];
const RESEARCH = Object.keys(RESEARCH_DEFINITIONS) as ResearchProjectId[];
const ENTITY_KINDS: SpaceEntityKind[] = ['planet', 'moon', 'station', 'asteroidField', 'jumpGate'];
const STAR_TYPES: StarType[] = ['yellowDwarf', 'redDwarf', 'blueGiant', 'whiteDwarf', 'binary'];

interface UniverseEnvelope {
  type: 'spacewar-strategic-universe';
  v: '1.0-alpha.1';
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

export function validateUniverseState(value: unknown): value is UniverseState {
  const state = value as UniverseState;
  if (!state || state.version !== '1.0-alpha.1' || !nonNegativeInteger(state.seed) || !nonNegativeInteger(state.turn)) return false;
  if (!['active', 'collapsed'].includes(state.status) || !Array.isArray(state.systems) || state.systems.length < 2) return false;
  if (!Array.isArray(state.entities) || !state.faction || !state.fleet || !Array.isArray(state.log)) return false;

  const systemIds = new Set(state.systems.map((system) => system.id));
  if (systemIds.size !== state.systems.length || !systemIds.has(state.selectedSystemId) || !systemIds.has(state.fleet.systemId)) return false;
  for (const system of state.systems) {
    if (!system.id || !system.name || !STAR_TYPES.includes(system.starType)) return false;
    if (!Number.isFinite(system.x) || !Number.isFinite(system.y) || !Array.isArray(system.entityIds) || !Array.isArray(system.neighbors)) return false;
    if (new Set(system.neighbors).size !== system.neighbors.length) return false;
    for (const neighborId of system.neighbors) {
      const neighbor = state.systems.find((candidate) => candidate.id === neighborId);
      if (!neighbor || !neighbor.neighbors.includes(system.id)) return false;
    }
  }

  const entityIds = new Set(state.entities.map((entity) => entity.id));
  if (entityIds.size !== state.entities.length || !entityIds.has(state.faction.baseEntityId)) return false;
  for (const system of state.systems) {
    if (new Set(system.entityIds).size !== system.entityIds.length || system.entityIds.some((id) => !entityIds.has(id))) return false;
  }
  for (const entity of state.entities) {
    if (!entity.id || !systemIds.has(entity.systemId) || !ENTITY_KINDS.includes(entity.kind) || !nonNegativeInteger(entity.orbit)) return false;
    const system = state.systems.find((candidate) => candidate.id === entity.systemId)!;
    if (!system.entityIds.includes(entity.id)) return false;
    if (entity.deposits && (!nonNegativeInteger(entity.deposits.minerals) || !nonNegativeInteger(entity.deposits.energy))) return false;
    if (entity.facilities && entity.facilities.some((facility) => !FACILITIES.includes(facility.type) || !nonNegativeInteger(facility.level) || facility.level < 1)) return false;
    if (entity.constructionQueue && entity.constructionQueue.some((order) => !FACILITIES.includes(order.facilityType) || !nonNegativeInteger(order.turnsRemaining) || order.turnsRemaining < 1)) return false;
  }

  const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
  if (base.kind !== 'station' || base.ownerId !== state.faction.id || !Array.isArray(base.facilities) || !Array.isArray(base.constructionQueue)) return false;
  if ((base.constructionQueue?.length ?? 0) > 2) return false;
  if (!state.faction.id || !state.faction.name || !state.faction.resources || !Array.isArray(state.faction.researched) || !Array.isArray(state.faction.researchQueue)) return false;
  if ([state.faction.resources.minerals, state.faction.resources.energy, state.faction.resources.science].some((amount) => !nonNegativeInteger(amount))) return false;
  if (state.faction.researched.some((project) => !RESEARCH.includes(project)) || new Set(state.faction.researched).size !== state.faction.researched.length) return false;
  if (
    state.faction.researchQueue.length > 2 ||
    state.faction.researchQueue.some((order) =>
      !RESEARCH.includes(order.projectId) ||
      !nonNegativeInteger(order.turnsRemaining) ||
      order.turnsRemaining < 1 ||
      state.faction.researched.includes(order.projectId)
    ) ||
    new Set(state.faction.researchQueue.map((order) => order.projectId)).size !== state.faction.researchQueue.length
  ) return false;
  if (
    !Array.isArray(state.faction.knownSystemIds) ||
    new Set(state.faction.knownSystemIds).size !== state.faction.knownSystemIds.length ||
    state.faction.knownSystemIds.some((id) => !systemIds.has(id))
  ) return false;
  if (!state.fleet.id || !state.fleet.name || !nonNegativeInteger(state.fleet.fuel) || !nonNegativeInteger(state.fleet.maxFuel) || state.fleet.fuel > state.fleet.maxFuel) return false;
  return true;
}

export function encodeUniverse(state: UniverseState): string {
  if (!validateUniverseState(state)) throw new Error('战略宇宙状态无效。');
  const envelope: UniverseEnvelope = { type: 'spacewar-strategic-universe', v: '1.0-alpha.1', state };
  return b64(JSON.stringify(envelope));
}

export function decodeUniverse(code: string): UniverseState {
  let envelope: UniverseEnvelope;
  try {
    envelope = JSON.parse(unb64(code.trim())) as UniverseEnvelope;
  } catch {
    throw new Error('战略宇宙码无法解析。');
  }
  if (envelope.type !== 'spacewar-strategic-universe') throw new Error('这不是战略宇宙码。');
  if (envelope.v !== '1.0-alpha.1' || !validateUniverseState(envelope.state)) throw new Error('战略宇宙码版本或结构无效。');
  return envelope.state;
}

export function saveUniverse(state: UniverseState): void {
  if (!validateUniverseState(state)) throw new Error('无法保存无效的战略宇宙。');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadUniverse(): UniverseState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as UniverseState;
    if (!validateUniverseState(state)) throw new Error('结构无效');
    return state;
  } catch {
    throw new Error('战略宇宙存档损坏或不兼容。');
  }
}

export function clearUniverse(): void {
  localStorage.removeItem(STORAGE_KEY);
}

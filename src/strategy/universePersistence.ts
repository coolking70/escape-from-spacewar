import { generateUniverse } from './universeGenerator';
import { FACILITY_DEFINITIONS, RESEARCH_DEFINITIONS } from './universeRules';
import { getShipDef, VARIANTS, VARIANTS_BY_CLASS } from '../sim/shipVariants';
import { validateFleet } from '../sim/fleetValidator';
import type { FleetEntry, ShipClass, ShipVariant } from '../sim/battleTypes';
import type { PersistentShip } from '../campaign/fleet/persistentFleet';
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
  v: '1.0-alpha.3';
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

const SHIP_CLASSES: ShipClass[] = ['Fighter', 'Frigate', 'Cruiser'];
const ALL_VARIANTS: ShipVariant[] = Object.keys(VARIANTS) as ShipVariant[];
/** 旧抽象舰队迁移用的确定性初始舰船模板（前 3 艘保留新游戏的初始舰种/改型）。 */
const STRATEGIC_STARTER_TEMPLATE: Array<{ shipClass: ShipClass; variant: ShipVariant }> = [
  { shipClass: 'Fighter', variant: 'standard' },
  { shipClass: 'Fighter', variant: 'interceptor' },
  { shipClass: 'Frigate', variant: 'standard' }
];

function validShipClass(value: unknown): value is ShipClass {
  return typeof value === 'string' && (SHIP_CLASSES as string[]).includes(value);
}

function validVariant(value: unknown): value is ShipVariant {
  return typeof value === 'string' && (ALL_VARIANTS as string[]).includes(value);
}

function validateStrategicShips(ships: unknown): ships is PersistentShip[] {
  if (!Array.isArray(ships) || ships.length === 0) return false;
  const ids = new Set<string>();
  for (const ship of ships) {
    if (!ship || typeof ship !== 'object') return false;
    const record = ship as Record<string, unknown>;
    if (typeof record.campaignShipId !== 'string' || !record.campaignShipId) return false;
    if (ids.has(record.campaignShipId)) return false;
    ids.add(record.campaignShipId);
    if (!validShipClass(record.shipClass)) return false;
    if (!validVariant(record.variant)) return false;
    if (!VARIANTS_BY_CLASS[record.shipClass as ShipClass].includes(record.variant as ShipVariant)) return false;
    if (typeof record.disabled !== 'boolean' || typeof record.escaped !== 'boolean' || typeof record.towed !== 'boolean') return false;
    if (record.deployed !== undefined && typeof record.deployed !== 'boolean') return false;
    if (record.componentHp !== undefined) {
      if (!Array.isArray(record.componentHp)) return false;
      const def = getShipDef(record.shipClass as ShipClass, record.variant as ShipVariant).def;
      if (record.componentHp.length !== def.components.length) return false;
      for (let i = 0; i < def.components.length; i++) {
        const hp = record.componentHp[i];
        if (typeof hp !== 'number' || !Number.isFinite(hp) || hp < 0 || hp > def.components[i].maxHp) return false;
      }
    }
  }
  return true;
}

function validatePendingBattle(pending: unknown, systemIds: Set<string>): boolean {
  if (!pending || typeof pending !== 'object') return false;
  const record = pending as Record<string, unknown>;
  if (typeof record.battleId !== 'string' || !record.battleId) return false;
  if (typeof record.systemId !== 'string' || !systemIds.has(record.systemId)) return false;
  if (!nonNegativeInteger(record.battleSeed)) return false;
  if (!nonNegativeInteger(record.enemyPowerBefore)) return false;
  if (!Array.isArray(record.enemyFleet)) return false;
  if (!validateFleet(record.enemyFleet).valid) return false;
  if (record.deployment !== undefined) {
    const dep = record.deployment as Record<string, unknown>;
    if (!dep || typeof dep !== 'object' || !Array.isArray(dep.selectedShipIds)) return false;
    if (!dep.selectedShipIds.every((id) => typeof id === 'string')) return false;
  }
  return true;
}

/** 旧抽象舰队（alpha.2）→ 真实逐舰舰队（alpha.3）的确定性迁移。 */
function migrateAlpha2(raw: any): UniverseState | null {
  if (!raw || raw.version !== '1.0-alpha.2' || !nonNegativeInteger(raw.seed)) return null;
  const fleet = raw.fleet;
  if (!fleet || !positiveInteger(fleet.shipCount) || !nonNegativeInteger(fleet.disabledShips) || !positiveInteger(fleet.combatPower)) {
    return null;
  }
  const shipCount = fleet.shipCount as number;
  const disabledShips = Math.min(shipCount - 1, Math.max(0, fleet.disabledShips as number));
  const ships: PersistentShip[] = [];
  for (let i = 0; i < shipCount; i++) {
    const template = STRATEGIC_STARTER_TEMPLATE[i] ?? { shipClass: 'Fighter' as ShipClass, variant: 'standard' as ShipVariant };
    ships.push({
      campaignShipId: `cs-${i}`,
      shipClass: template.shipClass,
      variant: template.variant,
      disabled: i >= shipCount - disabledShips,
      escaped: false,
      towed: false,
      deployed: true
    });
  }
  const migrated: any = JSON.parse(JSON.stringify(raw));
  migrated.version = '1.0-alpha.3';
  migrated.pendingBattle = undefined;
  migrated.fleet = {
    id: fleet.id,
    name: fleet.name,
    systemId: fleet.systemId,
    fuel: fleet.fuel,
    maxFuel: fleet.maxFuel,
    ships,
    formation: 'line',
    doctrine: 'balanced'
  };
  if (!validateUniverseState(migrated)) return null;
  migrated.log.unshift({
    turn: 0,
    text: `旧版抽象舰队已转换为逐舰状态（${shipCount} 艘，其中 ${disabledShips} 艘失能）。`
  });
  return migrated as UniverseState;
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
    !state || state.version !== '1.0-alpha.3' || !nonNegativeInteger(state.seed) ||
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
    !state.fleet.id || !state.fleet.name || !nonNegativeInteger(state.fleet.fuel) ||
    !positiveInteger(state.fleet.maxFuel) || state.fleet.fuel > state.fleet.maxFuel ||
    !['line', 'wedge', 'wall', 'swarm', 'random'].includes(state.fleet.formation) ||
    !['balanced', 'aggressive', 'defensive', 'kite', 'focusFire', 'antiCapital', 'screen'].includes(state.fleet.doctrine) ||
    !validateStrategicShips(state.fleet.ships)
  ) return false;
  if (state.pendingBattle && !validatePendingBattle(state.pendingBattle, systemIds)) return false;
  return true;
}

export function encodeUniverse(state: UniverseState): string {
  if (!validateUniverseState(state)) throw new Error('星域战略远征状态无效。');
  const envelope: UniverseEnvelope = { type: 'spacewar-sector-expedition', v: '1.0-alpha.3', state };
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
  if (envelope?.type === 'spacewar-sector-expedition' && envelope?.v === '1.0-alpha.2') {
    const migrated = migrateAlpha2(envelope.state);
    if (migrated) return migrated;
  }
  if (
    envelope?.type !== 'spacewar-sector-expedition' || envelope?.v !== '1.0-alpha.3' ||
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
    if (validateUniverseState(parsed)) return parsed;
    if (parsed && parsed.version === '1.0-alpha.2') {
      const migrated = migrateAlpha2(parsed);
      if (migrated) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
    const migrated = migrateAlpha1(parsed);
    if (!migrated) throw new Error('结构无效');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    throw new Error('星域战略远征存档损坏或不兼容。');
  }
}

export function clearUniverse(): void {
  localStorage.removeItem(STORAGE_KEY);
}

import { createPRNG } from '../sim/prng';
import type {
  SpaceEntity,
  SpaceEntityKind,
  StarSystem,
  StarType,
  UniverseState
} from './universeTypes';

const STAR_TYPES: StarType[] = ['yellowDwarf', 'redDwarf', 'blueGiant', 'whiteDwarf', 'binary'];
const SYSTEM_PREFIX = ['阿尔法', '塞勒涅', '奥尔特', '赫利俄斯', '织女', '卡戎', '天苑', '伊卡洛斯', '苍穹', '远岬'];
const ENTITY_SUFFIX: Record<SpaceEntityKind, string[]> = {
  planet: ['主星', '新陆', '荒原', '云海', '赤土'],
  moon: ['伴月', '冰月', '灰月'],
  station: ['轨道站', '中继站', '废弃站'],
  asteroidField: ['矿带', '碎星带', '残骸带'],
  jumpGate: ['跃迁门', '古门', '航路锚点']
};

function hash32(...values: Array<number | string>): number {
  let hash = 2166136261;
  for (const value of values) {
    for (const char of String(value)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function addRoute(left: StarSystem, right: StarSystem): void {
  if (!left.neighbors.includes(right.id)) left.neighbors.push(right.id);
  if (!right.neighbors.includes(left.id)) right.neighbors.push(left.id);
}

function distanceSq(left: StarSystem, right: StarSystem): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function connectSystems(systems: StarSystem[], seed: number): void {
  const connected = new Set<string>([systems[0].id]);
  while (connected.size < systems.length) {
    let best: { left: StarSystem; right: StarSystem; distance: number } | null = null;
    for (const left of systems.filter((system) => connected.has(system.id))) {
      for (const right of systems.filter((system) => !connected.has(system.id))) {
        const distance = distanceSq(left, right);
        if (!best || distance < best.distance) best = { left, right, distance };
      }
    }
    if (!best) break;
    addRoute(best.left, best.right);
    connected.add(best.right.id);
  }
  for (let index = 0; index < systems.length; index++) {
    const left = systems[index];
    const candidates = systems
      .filter((candidate) => candidate.id !== left.id && !left.neighbors.includes(candidate.id))
      .sort((a, b) => distanceSq(left, a) - distanceSq(left, b));
    if (candidates[0] && hash32(seed, left.id, 'extra-route') % 2 === 0) addRoute(left, candidates[0]);
  }
}

function makeEntity(
  seed: number,
  system: StarSystem,
  serial: number,
  kind: SpaceEntityKind,
  orbit: number,
  discovered: boolean,
  ownerId?: string
): SpaceEntity {
  const rng = createPRNG(hash32(seed, system.id, serial, kind));
  const entity: SpaceEntity = {
    id: `${system.id}-e${serial}`,
    systemId: system.id,
    kind,
    name: `${system.name}${ENTITY_SUFFIX[kind][rng.int(ENTITY_SUFFIX[kind].length)]}`,
    orbit,
    discovered,
    surveyed: discovered && kind === 'station',
    ownerId
  };
  if (kind === 'planet' || kind === 'moon') {
    entity.habitability = kind === 'planet' ? 20 + rng.int(76) : rng.int(46);
    entity.deposits = { minerals: 25 + rng.int(76), energy: 10 + rng.int(51) };
  }
  if (kind === 'asteroidField') {
    entity.deposits = { minerals: 60 + rng.int(121), energy: rng.int(31) };
  }
  if (kind === 'station') {
    entity.deposits = { minerals: 0, energy: 0 };
    entity.facilities = [];
    entity.constructionQueue = [];
  }
  return entity;
}

export function generateUniverse(seed: number, factionName = '深空开拓局'): UniverseState {
  const normalizedSeed = seed >>> 0;
  const rng = createPRNG(hash32(normalizedSeed, 'strategic-universe-v1'));
  const systems: StarSystem[] = [];
  for (let index = 0; index < 7; index++) {
    systems.push({
      id: `sys-${index}`,
      name: `${SYSTEM_PREFIX[(index + rng.int(SYSTEM_PREFIX.length)) % SYSTEM_PREFIX.length]}-${String.fromCharCode(65 + index)}`,
      x: 10 + rng.int(81),
      y: 10 + rng.int(81),
      starType: STAR_TYPES[rng.int(STAR_TYPES.length)],
      entityIds: [],
      neighbors: [],
      discovered: index === 0,
      surveyed: index === 0
    });
  }
  connectSystems(systems, normalizedSeed);
  const factionId = `faction-${normalizedSeed}`;
  const entities: SpaceEntity[] = [];
  for (let systemIndex = 0; systemIndex < systems.length; systemIndex++) {
    const system = systems[systemIndex];
    const home = systemIndex === 0;
    const kinds: SpaceEntityKind[] = home
      ? ['station', 'planet', 'asteroidField', 'jumpGate']
      : ['planet', rng.int(2) ? 'moon' : 'asteroidField', 'asteroidField', 'jumpGate'];
    if (!home && rng.int(3) === 0) kinds.push('station');
    kinds.forEach((kind, entityIndex) => {
      const entity = makeEntity(normalizedSeed, system, entityIndex, kind, entityIndex + 1, home, home && kind === 'station' ? factionId : undefined);
      entities.push(entity);
      system.entityIds.push(entity.id);
    });
  }
  const base = entities.find((entity) => entity.systemId === systems[0].id && entity.kind === 'station')!;
  base.name = `${factionName}轨道基地`;
  base.facilities = [
    { id: `${base.id}-solar-0`, type: 'solarArray', level: 1 },
    { id: `${base.id}-lab-0`, type: 'researchLab', level: 1 }
  ];
  base.constructionQueue = [];
  for (const neighborId of systems[0].neighbors) {
    const neighbor = systems.find((system) => system.id === neighborId)!;
    neighbor.discovered = true;
  }
  return {
    version: '1.0-alpha.1',
    seed: normalizedSeed,
    turn: 0,
    status: 'active',
    systems,
    entities,
    faction: {
      id: factionId,
      name: factionName.trim() || '深空开拓局',
      resources: { minerals: 60, energy: 45, science: 12 },
      researched: [],
      researchQueue: [],
      knownSystemIds: systems.filter((system) => system.discovered).map((system) => system.id),
      baseEntityId: base.id
    },
    fleet: {
      id: `strategic-fleet-${normalizedSeed}`,
      name: '第一远征舰队',
      systemId: systems[0].id,
      fuel: 8,
      maxFuel: 8
    },
    selectedSystemId: systems[0].id,
    log: [{ turn: 0, text: `${factionName}在${systems[0].name}建立长期战略基地。` }]
  };
}

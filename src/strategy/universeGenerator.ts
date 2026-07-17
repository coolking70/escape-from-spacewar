import { createPRNG } from '../sim/prng';
import { createStarterFleet, PersistentFleet } from '../campaign/fleet/persistentFleet';
import { campaignFleetEntryCost, campaignFleetPower, systemEnemyBudget } from '../campaign/fleet/campaignPower';
import { strategicEnemyFleetFor } from '../campaign/fleet/battleAdapter';
import { SECTOR_EXPEDITION_VERSION } from './universeTypes';
import { createCommander } from '../campaign/commander/commanderSystem';
import type { CampaignCommander } from '../campaign/campaignTypes';
import type {
  PermanentBlueprintId,
  SectorLegacy,
  SpaceEntity,
  SpaceEntityKind,
  StarSystem,
  StarType,
  StrategicShipFitting,
  UniverseState
} from './universeTypes';
import { strategicMobileEnemyBudget, strategicPressureAtStart } from './universePacing';
import { strategicMaxFuel } from './strategicBlueprints';

const STAR_TYPES: StarType[] = ['yellowDwarf', 'redDwarf', 'blueGiant', 'whiteDwarf', 'binary'];
const SYSTEM_PREFIX = ['阿尔法', '塞勒涅', '奥尔特', '赫利俄斯', '织女', '卡戎', '天苑', '伊卡洛斯', '苍穹', '远岬'];
const BLUEPRINTS: PermanentBlueprintId[] = ['fieldLogistics', 'hardenedBulkheads', 'compactFoundry'];
const ENTITY_SUFFIX: Record<SpaceEntityKind, string[]> = {
  planet: ['主星', '新陆', '荒原', '云海', '赤土'],
  moon: ['伴月', '冰月', '灰月'],
  station: ['轨道站', '中继站', '废弃站'],
  asteroidField: ['矿带', '碎星带', '残骸带'],
  relicSite: ['先驱遗迹', '失落档案库', '古代观测站'],
  jumpGate: ['星门', '古门', '跃迁锚点']
};

export interface SectorGenerationOptions {
  sectorIndex?: number;
  targetSectorCount?: number;
  legacy?: SectorLegacy;
  /** 跨星域继承的真实逐舰舰队；首星域缺省使用三艘初始舰船。 */
  fleet?: PersistentFleet;
  fittings?: StrategicShipFitting[];
  commander?: CampaignCommander;
  reserveCommanders?: CampaignCommander[];
  pendingSuccession?: boolean;
}

export function hash32(...values: Array<number | string>): number {
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
  for (const left of systems) {
    const candidates = systems
      .filter((candidate) => candidate.id !== left.id && !left.neighbors.includes(candidate.id))
      .sort((a, b) => distanceSq(left, a) - distanceSq(left, b));
    if (candidates[0] && hash32(seed, left.id, 'extra-route') % 3 !== 0) addRoute(left, candidates[0]);
  }
}

function graphDistances(systems: StarSystem[], originId: string): Map<string, number> {
  const distances = new Map<string, number>([[originId, 0]]);
  const queue = [originId];
  while (queue.length) {
    const id = queue.shift()!;
    const system = systems.find((candidate) => candidate.id === id)!;
    for (const neighbor of system.neighbors) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, (distances.get(id) ?? 0) + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

function makeEntity(
  seed: number,
  system: StarSystem,
  serial: number,
  kind: SpaceEntityKind,
  orbit: number,
  discovered: boolean
): SpaceEntity {
  const rng = createPRNG(hash32(seed, system.id, serial, kind));
  const entity: SpaceEntity = {
    id: `${system.id}-e${serial}`,
    systemId: system.id,
    kind,
    name: `${system.name}${ENTITY_SUFFIX[kind][rng.int(ENTITY_SUFFIX[kind].length)]}`,
    orbit,
    discovered,
    surveyed: discovered && kind === 'station'
  };
  if (kind === 'planet' || kind === 'moon') {
    entity.habitability = kind === 'planet' ? 20 + rng.int(76) : rng.int(46);
    entity.deposits = { minerals: 25 + rng.int(76), energy: 10 + rng.int(51) };
  }
  if (kind === 'asteroidField') {
    entity.deposits = { minerals: 55 + rng.int(126), energy: rng.int(31) };
  }
  if (kind === 'station') {
    entity.facilitySlots = 3 + (serial % 2);
    entity.facilities = [];
    entity.constructionQueue = [];
    entity.shipProductionQueue = [];
  }
  if (kind === 'relicSite') {
    entity.blueprint = BLUEPRINTS[rng.int(BLUEPRINTS.length)];
  }
  return entity;
}

function defaultLegacy(): SectorLegacy {
  return {
    sectorsCleared: 0,
    portableMaterials: 0,
    reserveSupplies: 0,
    blueprints: [],
    shipsLost: 0
  };
}

export function generateUniverse(
  seed: number,
  factionName = '深空远征团',
  options: SectorGenerationOptions = {}
): UniverseState {
  const normalizedSeed = seed >>> 0;
  const sectorIndex = Math.max(1, Math.floor(options.sectorIndex ?? 1));
  const targetSectorCount = Math.max(sectorIndex, Math.floor(options.targetSectorCount ?? 3));
  const legacy = options.legacy ? JSON.parse(JSON.stringify(options.legacy)) as SectorLegacy : defaultLegacy();
  const rng = createPRNG(hash32(normalizedSeed, sectorIndex, 'strategic-sector-v2'));
  const systems: StarSystem[] = [];

  for (let index = 0; index < 9; index++) {
    systems.push({
      id: `s${sectorIndex}-sys-${index}`,
      name: `${SYSTEM_PREFIX[(index + rng.int(SYSTEM_PREFIX.length)) % SYSTEM_PREFIX.length]}-${String.fromCharCode(65 + index)}`,
      x: index === 0 ? 8 : 16 + rng.int(77),
      y: 10 + rng.int(81),
      starType: STAR_TYPES[rng.int(STAR_TYPES.length)],
      entityIds: [],
      neighbors: [],
      discovered: index === 0,
      surveyed: index === 0,
      control: index === 0 ? 'neutral' : 'unknown',
      enemyPower: 0
    });
  }

  connectSystems(systems, hash32(normalizedSeed, sectorIndex));
  const start = systems[0];
  const distances = graphDistances(systems, start.id);
  const orderedByDistance = [...systems].sort((left, right) =>
    (distances.get(right.id) ?? 0) - (distances.get(left.id) ?? 0)
  );
  const gateSystem = orderedByDistance[0];
  const enemyOutpost = orderedByDistance.find((system) => system.id !== gateSystem.id && system.id !== start.id)!;
  // 星门的唯一强制遭遇在校准达到启动阈值时生成。C 阶段没有造舰系统，
  // 不再在同一地点叠加一支固定高预算驻军和一支机动拦截队。
  gateSystem.control = 'neutral';
  gateSystem.enemyPower = 0;
  enemyOutpost.control = 'enemy';
  enemyOutpost.enemyPower = systemEnemyBudget(sectorIndex, false);

  const entities: SpaceEntity[] = [];
  let gateEntityId = '';
  for (let index = 0; index < systems.length; index++) {
    const system = systems[index];
    const home = system.id === start.id;
    const kinds: SpaceEntityKind[] = home
      ? ['station', 'planet', 'asteroidField']
      : ['planet', rng.int(2) ? 'moon' : 'asteroidField', 'asteroidField'];
    if (!home && (index === 3 || index === 6 || system.id === gateSystem.id)) kinds.push('station');
    if (index === 4) kinds.push('relicSite');
    if (system.id === gateSystem.id) kinds.push('jumpGate');
    kinds.forEach((kind, entityIndex) => {
      const entity = makeEntity(normalizedSeed, system, entityIndex, kind, entityIndex + 1, home);
      if (home && kind === 'station') {
        entity.name = `${factionName}可用前进站`;
        entity.facilitySlots = 4;
      }
      if (kind === 'jumpGate') gateEntityId = entity.id;
      entities.push(entity);
      system.entityIds.push(entity.id);
    });
  }

  for (const neighborId of start.neighbors) {
    const neighbor = systems.find((system) => system.id === neighborId)!;
    neighbor.discovered = true;
    if (neighbor.control === 'unknown') neighbor.control = 'neutral';
  }

  const inherited = options.fleet ?? createStarterFleet();
  const commander = options.commander
    ? JSON.parse(JSON.stringify(options.commander)) as CampaignCommander
    : createCommander(normalizedSeed, `${factionName.trim() || '深空远征团'}指挥官`, 'balanced');
  const raiderSeed = hash32(normalizedSeed, sectorIndex, enemyOutpost.id, 'initial-raider');
  const raiderFleet = strategicEnemyFleetFor(
    raiderSeed,
    strategicMobileEnemyBudget(sectorIndex, campaignFleetPower(inherited), 'raider'),
    {
    sectorIndex,
    gateGuard: false,
    cruiserAllowed: sectorIndex >= 2
    }
  );

  return {
    version: SECTOR_EXPEDITION_VERSION,
    seed: normalizedSeed,
    sectorIndex,
    targetSectorCount,
    turn: 0,
    status: 'active',
    systems,
    entities,
    faction: {
      id: `faction-${normalizedSeed}`,
      name: factionName.trim() || '深空远征团',
      resources: {
        minerals: 32 + legacy.portableMaterials,
        energy: 24,
        science: 10,
        supplies: 18 + legacy.reserveSupplies
      },
      localResearch: [],
      researchQueue: [],
      knownSystemIds: systems.filter((system) => system.discovered).map((system) => system.id),
      recoveredBlueprints: [],
      legacy
    },
    commander,
    reserveCommanders: options.reserveCommanders
      ? JSON.parse(JSON.stringify(options.reserveCommanders)) as CampaignCommander[]
      : [],
    recruitmentUsedThisSector: false,
    pendingSuccession: options.pendingSuccession ?? false,
    transportLinks: [],
    enemyTaskForces: [{
      id: `enemy-task-force-${normalizedSeed}-${sectorIndex}-0`,
      systemId: enemyOutpost.id,
      power: campaignFleetEntryCost(raiderFleet),
      role: 'raider',
      spawnedTurn: 0
    }],
    sieges: [],
    fleet: {
      id: `strategic-fleet-${normalizedSeed}-${sectorIndex}`,
      name: '远征舰队',
      systemId: start.id,
      fuel: 8,
      maxFuel: strategicMaxFuel(legacy.blueprints) + (options.fittings ?? []).filter((fitting) => fitting.moduleId === 'auxiliaryTank').length,
      ships: inherited.ships.map((ship) => ({
        ...ship,
        componentHp: ship.componentHp ? [...ship.componentHp] : undefined
      })),
      formation: inherited.formation,
      doctrine: inherited.doctrine,
      fittings: (options.fittings ?? []).map((fitting) => ({ ...fitting }))
    },
    crisis: {
      phase: 'foothold',
      pressure: strategicPressureAtStart(sectorIndex),
      // 敌军目标与危机压力仍逐域上升；D.1 仍保持单一玩家舰队，
      // 三个星域共享同一 17 回合行动预算，避免图拓扑本身令第三星域无解。
      finalTurn: 17
    },
    extraction: {
      gateEntityId,
      discovered: false,
      calibration: 0,
      requiredCalibration: 100,
      emergencyThreshold: 40,
      gateDefense: 'dormant'
    },
    selectedSystemId: start.id,
    log: [
      {
        turn: 0,
        text: `进入第 ${sectorIndex} 星域。必须在第 17 回合前找到并启动星门。`
      },
      {
        turn: 0,
        text: '本星域设施与临时科研无法直接带走；舰船、蓝图和压缩物资可在撤离时继承。'
      }
    ]
  };
}

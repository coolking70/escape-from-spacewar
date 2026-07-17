import { generateUniverse, hash32 } from './universeGenerator';
import {
  battleTeamRemainingPower,
  campaignFleetEntryCost,
  campaignFleetPower,
  campaignShipCost,
  normalizeStrategicEnemyPower,
  systemEnemyBudget
} from '../campaign/fleet/campaignPower';
import { disablePersistentShip, isPersistentShipDisabled, isShipDeployable, PersistentFleet, PersistentShip } from '../campaign/fleet/persistentFleet';
import { importBattleResult } from '../campaign/fleet/battleResultImporter';
import {
  PersistentBattleBinding,
  strategicEnemyFleetFor,
  validatePersistentBattleBindings
} from '../campaign/fleet/battleAdapter';
import { RULESET_V4, SIM_VERSION_V5 } from '../sim/battleConfig';
import { getShipDef, SHIP_CN, VARIANT_CN } from '../sim/shipVariants';
import { validateFleet } from '../sim/fleetValidator';
import { isPresentOnBattlefield, isStructurallyDestroyed, expectedDisableFlags } from '../sim/shipFlags';
import { computeCombatState } from '../sim/combatState';
import type { BattleState, FleetEntry, ShipClass, ShipVariant } from '../sim/battleTypes';
import {
  applyBattleCommanderConsequences,
  isCommanderAvailable,
  isCommanderIncapacitated,
  tickCommanderConditions,
  treatCommander
} from '../campaign/commander/commanderHealth';
import { ensureCommanderProfile, gainCommanderDomainExperience } from '../campaign/commander/commanderSystem';
import {
  MAX_RESERVE_COMMANDERS,
  commanderRecruitmentSupplyCost,
  generateCommanderRecruitmentCandidates
} from '../campaign/commander/commanderRecruitment';
import type {
  ConstructionOrder,
  CrisisPhase,
  ExtractionMode,
  FacilityType,
  PendingStrategicBattle,
  PermanentBlueprintId,
  ResearchProjectId,
  ShipProductionOrder,
  SpaceEntity,
  StrategicFleet,
  StrategicEnemyTaskForce,
  StrategicSiege,
  StrategicResources,
  StrategicTransportLink,
  UniverseAction,
  UniverseState
} from './universeTypes';
import {
  isStrategicCommandLocked,
  reconcileStrategicCommanderContinuity
} from './universeCommander';
import { strategicMobileEnemyBudget, strategicPressurePerTurn } from './universePacing';

export interface FacilityDefinition {
  label: string;
  description: string;
  cost: Partial<StrategicResources>;
  turns: number;
}

export interface ResearchDefinition {
  label: string;
  description: string;
  scienceCost: number;
  turns: number;
}

export const CRISIS_PHASE_LABEL: Record<CrisisPhase, string> = {
  foothold: '立足窗口',
  contest: '争夺阶段',
  collapse: '崩溃阶段',
  evacuation: '最终撤离'
};

export const BLUEPRINT_LABEL: Record<PermanentBlueprintId, string> = {
  fieldLogistics: '远征后勤核心',
  hardenedBulkheads: '强化舰体蓝图',
  compactFoundry: '紧凑工业核心'
};

export const FACILITY_DEFINITIONS: Record<FacilityType, FacilityDefinition> = {
  solarArray: {
    label: '临时太阳能阵列',
    description: '每回合提供 4 能源。撤离后遗弃。',
    cost: { minerals: 12 },
    turns: 2
  },
  miningArray: {
    label: '自动采矿阵列',
    description: '每回合提供 4 矿物。撤离后遗弃。',
    cost: { minerals: 16, energy: 8 },
    turns: 3
  },
  researchLab: {
    label: '星域研究实验室',
    description: '每回合提供 3 科学，用于本星域临时科研。',
    cost: { minerals: 18, energy: 10 },
    turns: 3
  },
  supplyWorks: {
    label: '补给生产线',
    description: '每回合提供 3 补给，为维修和撤离做准备。',
    cost: { minerals: 15, energy: 8 },
    turns: 3
  },
  repairDock: {
    label: '战地维修坞',
    description: '允许修复失能舰船。',
    cost: { minerals: 20, energy: 12 },
    turns: 3
  },
  defenseGrid: {
    label: '据点防御网',
    description: '降低敌方扩张对前进基地造成的损失。',
    cost: { minerals: 22, energy: 15 },
    turns: 3
  },
  shipyard: {
    label: '轻型轨道船坞',
    description: '允许主基地使用现有 core-v4 舰体与改型生产舰船。',
    cost: { minerals: 12, energy: 8 },
    turns: 3
  }
};

export const RESEARCH_DEFINITIONS: Record<ResearchProjectId, ResearchDefinition> = {
  routeAnalysis: {
    label: '本地航路解析',
    description: '当前星域航行燃料消耗降低 1。离开星域后失效。',
    scienceCost: 8,
    turns: 2
  },
  rapidFabrication: {
    label: '快速装配工艺',
    description: '当前星域新建项目工期降低 1 回合。',
    scienceCost: 12,
    turns: 3
  },
  crisisForecasting: {
    label: '危机演化预测',
    description: '当前星域每回合危机压力增长降低 2。',
    scienceCost: 14,
    turns: 3
  },
  gateTheory: {
    label: '星门快速校准',
    description: '每次星门校准额外增加 10% 进度。',
    scienceCost: 18,
    turns: 4
  }
};

export const COMMANDER_TREATMENT_SUPPLY_COST = 2;
export const SHIP_PRODUCTION_QUEUE_LIMIT = 2;
export const OUTPOST_ESTABLISH_COST: StrategicResources = {
  minerals: 8,
  energy: 4,
  science: 0,
  supplies: 3
};

function cloneState(state: UniverseState): UniverseState {
  return JSON.parse(JSON.stringify(state)) as UniverseState;
}

function appendLog(state: UniverseState, text: string): void {
  state.log.push({ turn: state.turn, text });
  if (state.log.length > 180) state.log = state.log.slice(-180);
}

/** 当前星系的全部敌对战略力量；驻军与移动舰队使用同一 core-v4 成本量纲。 */
export function strategicHostilePowerAt(state: UniverseState, systemId: string): number {
  const garrison = state.systems.find((system) => system.id === systemId)?.enemyPower ?? 0;
  const mobile = state.enemyTaskForces
    .filter((force) => force.systemId === systemId)
    .reduce((sum, force) => sum + force.power, 0);
  return garrison + mobile;
}

function baseEntity(state: UniverseState): SpaceEntity | undefined {
  return state.faction.baseEntityId
    ? state.entities.find((entity) => entity.id === state.faction.baseEntityId)
    : undefined;
}

/** 当前星域所有我方据点；baseEntityId 仅负责从中标出唯一主基地。 */
export function ownedStrategicStations(state: UniverseState): SpaceEntity[] {
  return state.entities
    .filter((entity) => entity.kind === 'station' && entity.ownerId === state.faction.id)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function stationForConstruction(state: UniverseState, entityId?: string): SpaceEntity | undefined {
  const id = entityId ?? state.faction.baseEntityId;
  return id
    ? ownedStrategicStations(state).find((entity) => entity.id === id)
    : undefined;
}

function stationInFleetSystem(state: UniverseState): SpaceEntity | undefined {
  return ownedStrategicStations(state).find((entity) => entity.systemId === state.fleet.systemId);
}

/** 仅使用已发现星系的稳定最短路；同层候选按 ID 排序，避免泄露隐藏航线且保证确定性。 */
export function strategicTransportPath(state: UniverseState, fromSystemId: string, toSystemId: string): string[] | null {
  const known = new Set(state.faction.knownSystemIds);
  if (!known.has(fromSystemId) || !known.has(toSystemId)) return null;
  const queue: string[][] = [[fromSystemId]];
  const visited = new Set([fromSystemId]);
  while (queue.length) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    if (current === toSystemId) return path;
    const system = state.systems.find((candidate) => candidate.id === current);
    const neighbors = [...(system?.neighbors ?? [])]
      .filter((id) => known.has(id) && !visited.has(id))
      .sort((left, right) => left.localeCompare(right));
    for (const neighbor of neighbors) {
      visited.add(neighbor);
      queue.push([...path, neighbor]);
    }
  }
  return null;
}

/** 敌方战略航路使用完整星系图；稳定 BFS 与 ID 排序保证相同状态得到完全相同的移动。 */
export function strategicEnemyPath(state: UniverseState, fromSystemId: string, toSystemId: string): string[] | null {
  if (!state.systems.some((system) => system.id === fromSystemId) || !state.systems.some((system) => system.id === toSystemId)) return null;
  const queue: string[][] = [[fromSystemId]];
  const visited = new Set([fromSystemId]);
  while (queue.length) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    if (current === toSystemId) return path;
    const system = state.systems.find((candidate) => candidate.id === current);
    for (const neighbor of [...(system?.neighbors ?? [])].sort((a, b) => a.localeCompare(b))) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push([...path, neighbor]);
    }
  }
  return null;
}

export type StrategicTransportStatus = 'active' | 'blocked';

export function strategicTransportStatus(state: UniverseState, link: StrategicTransportLink): StrategicTransportStatus {
  return link.pathSystemIds.some((id) => {
    const system = state.systems.find((candidate) => candidate.id === id);
    return !system || system.control === 'enemy' || strategicHostilePowerAt(state, id) > 0;
  }) ? 'blocked' : 'active';
}

function hasBlockingStrategicDecision(state: UniverseState): boolean {
  return !!state.pendingBattle || !!state.pendingRecruitment || isStrategicCommandLocked(state);
}

function facilityCount(base: SpaceEntity | undefined, type: FacilityType): number {
  return (base?.facilities ?? []).filter((facility) => facility.type === type).length;
}

function hasResources(resources: StrategicResources, cost: Partial<StrategicResources>): boolean {
  return (Object.keys(resources) as Array<keyof StrategicResources>)
    .every((key) => resources[key] >= (cost[key] ?? 0));
}

function spendResources(resources: StrategicResources, cost: Partial<StrategicResources>): void {
  for (const key of Object.keys(resources) as Array<keyof StrategicResources>) {
    resources[key] -= cost[key] ?? 0;
  }
}

/** 生产成本只从现有 core-v4 舰船成本换算，不修改舰船定义或战斗价值。 */
export function shipProductionCost(shipClass: ShipClass, variant: ShipVariant): StrategicResources {
  const entry = { shipClass, variant, count: 1 };
  if (!validateFleet([entry]).valid) throw new Error(`非法生产舰型：${shipClass}/${variant}。`);
  const value = campaignShipCost(shipClass, variant);
  return {
    minerals: Math.ceil(value / 5),
    energy: Math.ceil(value / 10),
    science: 0,
    supplies: Math.ceil(value / 25)
  };
}

export function shipProductionTurns(shipClass: ShipClass, variant: ShipVariant): number {
  const entry = { shipClass, variant, count: 1 };
  if (!validateFleet([entry]).valid) throw new Error(`非法生产舰型：${shipClass}/${variant}。`);
  return Math.max(2, Math.ceil(campaignShipCost(shipClass, variant) / 100) + 1);
}

function effectiveFacilityCost(state: UniverseState, facilityType: FacilityType): Partial<StrategicResources> {
  const definition = FACILITY_DEFINITIONS[facilityType];
  const discount = state.faction.legacy.blueprints.includes('compactFoundry') ? 4 : 0;
  return {
    ...definition.cost,
    minerals: Math.max(0, (definition.cost.minerals ?? 0) - discount)
  };
}

// ---------------- 真实逐舰舰队派生量（不再依赖抽象计数字段） ----------------

/** 战略舰队 → 战役 PersistentFleet（结构兼容，仅取 ships/formation/doctrine）。 */
export function toPersistentFleet(fleet: StrategicFleet): PersistentFleet {
  return {
    ships: fleet.ships.map((ship) => ({ ...ship, componentHp: ship.componentHp ? [...ship.componentHp] : undefined })),
    formation: fleet.formation,
    doctrine: fleet.doctrine
  };
}

export interface StrategicFleetCounts {
  total: number;
  operational: number;
  disabled: number;
  escaped: number;
  towed: number;
}

export function strategicFleetCounts(fleet: StrategicFleet): StrategicFleetCounts {
  let operational = 0;
  let disabled = 0;
  let escaped = 0;
  let towed = 0;
  for (const ship of fleet.ships) {
    if (ship.disabled) disabled++;
    else if (ship.escaped) escaped++;
    else if (isShipDeployable(ship)) operational++;
    if (ship.towed) towed++;
  }
  return { total: fleet.ships.length, operational, disabled, escaped, towed };
}

/** 动态计算的真实舰队战力。 */
export function strategicFleetPower(state: UniverseState): number {
  return campaignFleetPower(toPersistentFleet(state.fleet));
}

// ---------------- 战略战斗回写辅助 ----------------

/** 敌方剩余战力：复用与持久舰战力同一套成本单位的共享函数（destroyed/disabled 不贡献，escaped/operational 按成本×完整度）。 */
function enemyRemainingPower(battle: BattleState): number {
  return battleTeamRemainingPower(battle, 'B');
}

function teamACombatIds(battle: BattleState, bindings: ReadonlyArray<PersistentBattleBinding>, combatState: string): string[] {
  return bindings
    .filter((binding) => {
      const ship = battle.ships.find((candidate) => candidate.id === binding.battleShipId && candidate.team === 'A');
      return ship?.combatState === combatState;
    })
    .map((binding) => binding.campaignShipId)
    .sort((a, b) => a.localeCompare(b));
}

export function crisisPhaseForTurn(turn: number, finalTurn: number): CrisisPhase {
  const ratio = finalTurn > 0 ? turn / finalTurn : 1;
  if (ratio < 0.3) return 'foothold';
  if (ratio < 0.62) return 'contest';
  if (ratio < 0.84) return 'collapse';
  return 'evacuation';
}

export interface StrategicIncomeSource {
  entityId: string;
  status: 'local' | StrategicTransportStatus;
  produced: StrategicResources;
  delivered: StrategicResources;
}

export interface StrategicIncomeReport {
  total: StrategicResources;
  sources: StrategicIncomeSource[];
}

function stationIncome(station: SpaceEntity): StrategicResources {
  return {
    minerals: facilityCount(station, 'miningArray') * 4,
    energy: facilityCount(station, 'solarArray') * 4,
    science: facilityCount(station, 'researchLab') * 3,
    supplies: facilityCount(station, 'supplyWorks') * 3
  };
}

export function strategicIncomeReport(state: UniverseState): StrategicIncomeReport {
  const zero = (): StrategicResources => ({ minerals: 0, energy: 0, science: 0, supplies: 0 });
  const total = zero();
  const sources = ownedStrategicStations(state).map((station): StrategicIncomeSource => {
    const produced = stationIncome(station);
    const link = state.transportLinks.find((candidate) => candidate.outpostEntityId === station.id);
    const status = station.id === state.faction.baseEntityId ? 'local' : link ? strategicTransportStatus(state, link) : 'blocked';
    const delivered = status === 'blocked' ? zero() : { ...produced };
    for (const key of Object.keys(total) as Array<keyof StrategicResources>) total[key] += delivered[key];
    return { entityId: station.id, status, produced, delivered };
  });
  return { total, sources };
}

export function universeTurnIncome(state: UniverseState): StrategicResources {
  return strategicIncomeReport(state).total;
}

function processConstruction(state: UniverseState): void {
  for (const station of ownedStrategicStations(state)) {
    const queue = station.constructionQueue ?? [];
    if (!queue.length) continue;
    queue[0].turnsRemaining--;
    if (queue[0].turnsRemaining > 0) continue;
    const completed = queue.shift()!;
    station.facilities = station.facilities ?? [];
    station.facilities.push({
      id: `${station.id}-${completed.facilityType}-${state.sectorIndex}-${state.turn}`,
      type: completed.facilityType,
      level: 1
    });
    appendLog(state, `${station.name}的${FACILITY_DEFINITIONS[completed.facilityType].label}建造完成。`);
  }
}

function processShipProduction(state: UniverseState): void {
  const base = baseEntity(state);
  if (!base || state.fleet.systemId !== base.systemId) return;
  if (state.sieges.some((siege) => siege.stationEntityId === base.id)) return;
  const queue = base.shipProductionQueue ?? [];
  if (!queue.length) return;
  queue[0].turnsRemaining--;
  if (queue[0].turnsRemaining > 0) return;
  const completed = queue.shift()!;
  if (state.fleet.ships.some((ship) => ship.campaignShipId === completed.campaignShipId)) {
    throw new Error(`生产订单 ${completed.id} 的舰船 ID 与现有舰队重复。`);
  }
  const def = getShipDef(completed.shipClass, completed.variant).def;
  state.fleet.ships.push({
    campaignShipId: completed.campaignShipId,
    shipClass: completed.shipClass,
    variant: completed.variant,
    componentHp: def.components.map((component) => component.maxHp),
    disabled: false,
    escaped: false,
    towed: false,
    deployed: true
  });
  appendLog(state, `${SHIP_CN[completed.shipClass]}·${VARIANT_CN[completed.variant]}完工并编入${state.fleet.name}（${completed.campaignShipId}）。`);
}

function processResearch(state: UniverseState): void {
  if (!state.faction.researchQueue.length) return;
  state.faction.researchQueue[0].turnsRemaining--;
  if (state.faction.researchQueue[0].turnsRemaining > 0) return;
  const completed = state.faction.researchQueue.shift()!;
  if (!state.faction.localResearch.includes(completed.projectId)) state.faction.localResearch.push(completed.projectId);
  appendLog(state, `本地研究完成：${RESEARCH_DEFINITIONS[completed.projectId].label}。`);
}

function siegeDuration(station: SpaceEntity): number {
  return 2 + Math.min(2, facilityCount(station, 'defenseGrid'));
}

function startSiegeIfNeeded(state: UniverseState, force: StrategicEnemyTaskForce): void {
  if (force.role !== 'raider' || state.sieges.some((siege) => siege.taskForceId === force.id)) return;
  const station = ownedStrategicStations(state).find((candidate) => candidate.systemId === force.systemId);
  if (!station) return;
  const duration = siegeDuration(station);
  state.sieges.push({
    id: `siege-${force.id}-${station.id}`,
    taskForceId: force.id,
    stationEntityId: station.id,
    turnsRemaining: duration,
    totalTurns: duration
  });
  appendLog(state, `${station.name}遭到敌方特遣舰队围攻；若 ${duration} 回合内未击退，前哨将失守。`);
}

function loseSecondaryOutpost(state: UniverseState, station: SpaceEntity): void {
  station.ownerId = undefined;
  station.facilities = [];
  station.constructionQueue = [];
  station.shipProductionQueue = [];
  state.transportLinks = state.transportLinks.filter((link) => link.outpostEntityId !== station.id);
  const system = state.systems.find((candidate) => candidate.id === station.systemId);
  if (system && system.enemyPower === 0) system.control = 'neutral';
  appendLog(state, `${station.name}在围攻中失守；设施、队列和运输链全部损失。`);
}

/** 先结算既有围攻；新抵达的舰队从下一回合开始消耗倒计时。 */
export function processStrategicSieges(state: UniverseState): void {
  const remaining: StrategicSiege[] = [];
  for (const siege of state.sieges) {
    const force = state.enemyTaskForces.find((candidate) => candidate.id === siege.taskForceId);
    const station = ownedStrategicStations(state).find((candidate) => candidate.id === siege.stationEntityId);
    if (!force || !station || force.systemId !== station.systemId) continue;
    if (state.fleet.systemId === station.systemId) {
      remaining.push(siege);
      appendLog(state, `${state.fleet.name}已抵达${station.name}，围攻倒计时暂停；必须击退当地特遣舰队。`);
      continue;
    }
    siege.turnsRemaining--;
    if (siege.turnsRemaining > 0) {
      remaining.push(siege);
      appendLog(state, `${station.name}仍在围攻中，失守倒计时 ${siege.turnsRemaining} 回合。`);
      continue;
    }
    if (station.id === state.faction.baseEntityId) {
      state.status = 'collapsed';
      state.pendingSuccession = false;
      state.pendingRecruitment = undefined;
      appendLog(state, `${station.name}主基地失守，远征后勤与指挥链崩溃。`);
    } else {
      loseSecondaryOutpost(state, station);
    }
  }
  state.sieges = remaining;
}

function nearestOwnedStationPath(state: UniverseState, force: StrategicEnemyTaskForce): { station: SpaceEntity; path: string[] } | null {
  const candidates = ownedStrategicStations(state)
    .map((station) => ({ station, path: strategicEnemyPath(state, force.systemId, station.systemId) }))
    .filter((entry): entry is { station: SpaceEntity; path: string[] } => !!entry.path)
    .sort((left, right) => left.path.length - right.path.length || left.station.id.localeCompare(right.station.id));
  return candidates[0] ?? null;
}

/** 每个 raider 每个战略回合最多沿一条边移动；gateDefense 永远固守星门。 */
export function advanceStrategicEnemyTaskForces(state: UniverseState): void {
  for (const force of [...state.enemyTaskForces].sort((a, b) => a.id.localeCompare(b.id))) {
    if (force.role !== 'raider' || state.sieges.some((siege) => siege.taskForceId === force.id)) continue;
    const target = nearestOwnedStationPath(state, force);
    if (!target) continue;
    if (target.path.length > 1) force.systemId = target.path[1];
    startSiegeIfNeeded(state, force);
    const destination = state.systems.find((system) => system.id === force.systemId);
    if (destination?.discovered) appendLog(state, `侦测到敌方特遣舰队进入${destination.name}（战力 ${force.power}）。`);
  }
}

/** 敌袭据点的确定性补给损失；本地防御网与驻防舰队都必须真实降低损失。 */
export function strategicOutpostRaidSupplyLoss(state: UniverseState, stationId: string): number {
  const station = ownedStrategicStations(state).find((candidate) => candidate.id === stationId);
  if (!station) return 0;
  const defense = facilityCount(station, 'defenseGrid');
  const fleetPresent = state.fleet.systemId === station.systemId;
  return Math.max(0, 7 + state.sectorIndex * 2 - defense * 5 - (fleetPresent ? 4 : 0));
}

function applyStrategicOutpostRaidInPlace(state: UniverseState, attackedStation: SpaceEntity): void {
  const defense = facilityCount(attackedStation, 'defenseGrid');
  const fleetPresent = state.fleet.systemId === attackedStation.systemId;
  const supplyLoss = strategicOutpostRaidSupplyLoss(state, attackedStation.id);
  state.faction.resources.supplies = Math.max(0, state.faction.resources.supplies - supplyLoss);
  const counts = strategicFleetCounts(state.fleet);
  if (fleetPresent && supplyLoss >= 5 && counts.disabled < counts.operational) {
    const damaged = state.fleet.ships
      .filter(isShipDeployable)
      .sort((a, b) => a.campaignShipId.localeCompare(b.campaignShipId))
      .pop();
    if (damaged) disablePersistentShip(damaged);
  }
  appendLog(
    state,
    `敌方袭击${attackedStation.name}，损失补给 ${supplyLoss}` +
    `${defense ? '；据点防御网降低了损失' : ''}${fleetPresent ? '；驻防舰队参与拦截' : ''}。`
  );
}

/** 无头模拟与测试可直接调用的确定性据点敌袭结算；真实敌方扩张复用同一实现。 */
export function resolveStrategicOutpostRaid(state: UniverseState, stationId: string): UniverseState {
  if (state.status !== 'active') return state;
  const station = ownedStrategicStations(state).find((candidate) => candidate.id === stationId);
  if (!station) return state;
  const next = cloneState(state);
  applyStrategicOutpostRaidInPlace(next, ownedStrategicStations(next).find((candidate) => candidate.id === stationId)!);
  return next;
}

function enemyExpansion(state: UniverseState): void {
  const enemySystems = state.systems.filter((system) => system.control === 'enemy');
  const gateSystemId = state.entities.find((entity) => entity.id === state.extraction.gateEntityId)?.systemId;
  const candidates = state.systems.filter((system) =>
    system.control !== 'enemy' &&
    system.id !== gateSystemId &&
    !ownedStrategicStations(state).some((station) => station.systemId === system.id) &&
    enemySystems.some((enemy) => enemy.neighbors.includes(system.id))
  );
  if (!candidates.length) return;
  const ordered = [...candidates].sort((left, right) =>
    hash32(state.seed, state.sectorIndex, state.turn, left.id, 'enemy-spread') -
    hash32(state.seed, state.sectorIndex, state.turn, right.id, 'enemy-spread')
  );
  const target = ordered[0];
  target.control = 'enemy';
  target.enemyPower = Math.max(
    target.enemyPower,
    normalizeStrategicEnemyPower(systemEnemyBudget(state.sectorIndex, false) * 0.5)
  );
  appendLog(state, `敌方势力扩张至${target.name}，当地出现战力 ${target.enemyPower} 的守军。`);
}

function advanceCrisis(state: UniverseState): void {
  const previous = state.crisis.phase;
  const forecasting = state.faction.localResearch.includes('crisisForecasting');
  state.crisis.pressure = Math.min(
    100,
    state.crisis.pressure + strategicPressurePerTurn(state.sectorIndex, forecasting)
  );
  state.crisis.phase = crisisPhaseForTurn(state.turn, state.crisis.finalTurn);
  if (state.crisis.phase !== previous) appendLog(state, `星域危机进入“${CRISIS_PHASE_LABEL[state.crisis.phase]}”。`);
  const expansionInterval = state.crisis.phase === 'foothold' ? 4 : state.crisis.phase === 'contest' ? 3 : 2;
  if (state.turn > 0 && state.turn % expansionInterval === 0) enemyExpansion(state);
  if (state.turn > state.crisis.finalTurn) {
    state.status = 'collapsed';
    state.pendingSuccession = false;
    state.pendingRecruitment = undefined;
    appendLog(state, '星域彻底崩溃，远征舰队未能及时撤离。');
  }
}

/** 已被 reducer 验证通过的行动所使用的时间结算；即使行动结果触发继任，也必须完成本回合。 */
function resolveUniverseTurn(state: UniverseState, reason: string): UniverseState {
  const next = cloneState(state);
  next.turn++;
  next.commander = tickCommanderConditions(next.commander, next.seed);
  next.reserveCommanders = next.reserveCommanders.map((commander) =>
    tickCommanderConditions(commander, next.seed)
  );
  const income = universeTurnIncome(next);
  next.faction.resources.minerals += income.minerals;
  next.faction.resources.energy += income.energy;
  next.faction.resources.science += income.science;
  next.faction.resources.supplies += income.supplies;
  processConstruction(next);
  processResearch(next);
  processShipProduction(next);
  const localStation = stationInFleetSystem(next);
  if (localStation) {
    next.fleet.fuel = Math.min(next.fleet.maxFuel, next.fleet.fuel + 1);
  }
  appendLog(
    next,
    `${reason}；产出 矿物 +${income.minerals} / 能源 +${income.energy} / 科学 +${income.science} / 补给 +${income.supplies}。`
  );
  processStrategicSieges(next);
  if (next.status !== 'active') return next;
  advanceStrategicEnemyTaskForces(next);
  advanceCrisis(next);
  return next;
}

export function advanceUniverseTurn(state: UniverseState, reason = '战略时间推进'): UniverseState {
  if (
    state.status !== 'active' || state.pendingBattle || state.pendingRecruitment ||
    isStrategicCommandLocked(state)
  ) return state;
  return resolveUniverseTurn(state, reason);
}

export function travelFuelCost(state: UniverseState): number {
  const local = state.faction.localResearch.includes('routeAnalysis') ? 1 : 0;
  const legacy = state.faction.legacy.blueprints.includes('fieldLogistics') ? 1 : 0;
  return Math.max(1, 2 - local - legacy);
}

export function canEstablishBase(state: UniverseState, entityId: string): boolean {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  const system = entity ? state.systems.find((candidate) => candidate.id === entity.systemId) : undefined;
  return state.status === 'active' && !hasBlockingStrategicDecision(state) && !state.faction.baseEntityId && !!entity && entity.kind === 'station' &&
    entity.surveyed && entity.systemId === state.fleet.systemId && !entity.ownerId &&
    !!system && strategicHostilePowerAt(state, system.id) === 0 && state.faction.resources.minerals >= 10 &&
    state.faction.resources.energy >= 5 && state.faction.resources.supplies >= 4;
}

export function canEstablishOutpost(state: UniverseState, entityId: string): boolean {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  const system = entity ? state.systems.find((candidate) => candidate.id === entity.systemId) : undefined;
  return state.status === 'active' && !hasBlockingStrategicDecision(state) && !!state.faction.baseEntityId &&
    !!entity && entity.kind === 'station' && entity.id !== state.faction.baseEntityId &&
    entity.surveyed && entity.systemId === state.fleet.systemId && !entity.ownerId &&
    !!system && strategicHostilePowerAt(state, system.id) === 0 && !!strategicTransportPath(state, entity.systemId, baseEntity(state)!.systemId) &&
    hasResources(state.faction.resources, OUTPOST_ESTABLISH_COST);
}

export function canQueueFacility(state: UniverseState, facilityType: FacilityType, entityId?: string): boolean {
  if (state.status !== 'active' || hasBlockingStrategicDecision(state)) return false;
  const station = stationForConstruction(state, entityId);
  if (!station || state.fleet.systemId !== station.systemId) return false;
  if (state.sieges.some((siege) => siege.stationEntityId === station.id)) return false;
  const queue = station.constructionQueue ?? [];
  const occupied = (station.facilities?.length ?? 0) + queue.length;
  if (queue.length >= 2 || occupied >= (station.facilitySlots ?? 3)) return false;
  if (
    facilityType === 'shipyard' &&
    (station.id !== state.faction.baseEntityId ||
      (station.facilities ?? []).some((facility) => facility.type === 'shipyard') ||
      queue.some((order) => order.facilityType === 'shipyard'))
  ) return false;
  return hasResources(state.faction.resources, effectiveFacilityCost(state, facilityType));
}

export function canQueueShipProduction(state: UniverseState, shipClass: ShipClass, variant: ShipVariant): boolean {
  if (state.status !== 'active' || hasBlockingStrategicDecision(state)) return false;
  const base = baseEntity(state);
  if (!base || state.fleet.systemId !== base.systemId) return false;
  if (state.sieges.some((siege) => siege.stationEntityId === base.id)) return false;
  if (facilityCount(base, 'shipyard') !== 1) return false;
  if ((base.shipProductionQueue ?? []).length >= SHIP_PRODUCTION_QUEUE_LIMIT) return false;
  if (!validateFleet([{ shipClass, variant, count: 1 }]).valid) return false;
  return hasResources(state.faction.resources, shipProductionCost(shipClass, variant));
}

export function canQueueResearch(state: UniverseState, projectId: ResearchProjectId): boolean {
  if (state.status !== 'active' || !baseEntity(state) || hasBlockingStrategicDecision(state)) return false;
  if (state.faction.localResearch.includes(projectId)) return false;
  if (state.faction.researchQueue.some((order) => order.projectId === projectId)) return false;
  if (state.faction.researchQueue.length >= 2) return false;
  return state.faction.resources.science >= RESEARCH_DEFINITIONS[projectId].scienceCost;
}

export function canEngageEnemy(state: UniverseState): boolean {
  const current = state.systems.find((system) => system.id === state.fleet.systemId);
  return state.status === 'active' && !hasBlockingStrategicDecision(state) && !!current &&
    strategicHostilePowerAt(state, current.id) > 0 && strategicFleetCounts(state.fleet).operational > 0;
}

export function canRepairFleet(state: UniverseState): boolean {
  return state.fleet.ships.some((ship) => canRepairShip(state, ship.campaignShipId));
}

export function canRepairShip(state: UniverseState, campaignShipId: string): boolean {
  const station = stationInFleetSystem(state);
  const ship = state.fleet.ships.find((candidate) => candidate.campaignShipId === campaignShipId);
  return state.status === 'active' && !hasBlockingStrategicDecision(state) && !!station &&
    facilityCount(station, 'repairDock') > 0 && !!ship && ship.disabled &&
    state.faction.resources.supplies >= 5 && state.faction.resources.minerals >= 4;
}

export function canOpenCommanderRecruitment(state: UniverseState): boolean {
  const base = baseEntity(state);
  return state.status === 'active' && !state.pendingBattle && !state.pendingRecruitment &&
    !isStrategicCommandLocked(state) && !state.recruitmentUsedThisSector &&
    state.reserveCommanders.length < MAX_RESERVE_COMMANDERS && !!base && state.fleet.systemId === base.systemId;
}

export function canTreatStrategicCommander(state: UniverseState): boolean {
  const base = baseEntity(state);
  return state.status === 'active' && !state.pendingBattle && !state.pendingRecruitment &&
    !!base && state.fleet.systemId === base.systemId && state.commander.alive &&
    state.faction.resources.supplies >= COMMANDER_TREATMENT_SUPPLY_COST &&
    treatCommander(state.commander, state.seed) !== null;
}

export function canAppointStrategicCommander(state: UniverseState, commanderId: string): boolean {
  const candidate = state.reserveCommanders.find((commander) => commander.id === commanderId);
  return state.status === 'active' && !state.pendingBattle && !state.pendingRecruitment &&
    state.pendingSuccession && !!candidate && isCommanderAvailable(candidate, state.seed);
}

export function canCalibrateGate(state: UniverseState): boolean {
  if (hasBlockingStrategicDecision(state)) return false;
  const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId);
  const system = gate ? state.systems.find((candidate) => candidate.id === gate.systemId) : undefined;
  return state.status === 'active' && !!gate && gate.surveyed && gate.systemId === state.fleet.systemId &&
    !!system && strategicHostilePowerAt(state, system.id) === 0 && state.extraction.calibration < state.extraction.requiredCalibration &&
    state.faction.resources.energy >= 6 && state.faction.resources.science >= 2 && state.faction.resources.supplies >= 1;
}

export function canExtractSector(
  state: UniverseState,
  mode: ExtractionMode,
  rearguardShips = 0
): boolean {
  if (hasBlockingStrategicDecision(state)) return false;
  const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId);
  const system = gate ? state.systems.find((candidate) => candidate.id === gate.systemId) : undefined;
  const fleetCounts = strategicFleetCounts(state.fleet);
  if (
    state.status !== 'active' || !gate || !gate.surveyed || gate.systemId !== state.fleet.systemId ||
    !system || strategicHostilePowerAt(state, system.id) > 0 || state.extraction.gateDefense !== 'resolved' || fleetCounts.operational <= 0 ||
    rearguardShips < 0 || rearguardShips >= fleetCounts.operational
  ) return false;
  // 任何成功撤离必须至少保留一艘舰船（含失能舰），不得产生空舰队或零舰船 victory。
  const wouldLose = previewExtractLosses(state, mode, rearguardShips).length;
  if (state.fleet.ships.length - wouldLose < 1) return false;
  if (mode === 'stable') {
    return state.extraction.calibration >= state.extraction.requiredCalibration &&
      state.faction.resources.supplies >= 8 && state.fleet.fuel >= 2;
  }
  return state.extraction.calibration >= state.extraction.emergencyThreshold && state.faction.resources.supplies >= 4;
}

function queueConstruction(state: UniverseState, facilityType: FacilityType, entityId?: string): UniverseState {
  if (!canQueueFacility(state, facilityType, entityId)) return state;
  const next = cloneState(state);
  const definition = FACILITY_DEFINITIONS[facilityType];
  spendResources(next.faction.resources, effectiveFacilityCost(next, facilityType));
  const station = stationForConstruction(next, entityId)!;
  station.constructionQueue = station.constructionQueue ?? [];
  const reduction = next.faction.localResearch.includes('rapidFabrication') ? 1 : 0;
  const turns = Math.max(1, definition.turns - reduction);
  const order: ConstructionOrder = {
    id: `build-${facilityType}-${station.id}-s${next.sectorIndex}-t${next.turn}-${station.constructionQueue.length}`,
    facilityType,
    turnsRemaining: turns,
    totalTurns: turns
  };
  station.constructionQueue.push(order);
  appendLog(next, `${station.name}加入建造队列：${definition.label}（${turns} 回合）。`);
  return next;
}

function queueShipProduction(state: UniverseState, shipClass: ShipClass, variant: ShipVariant): UniverseState {
  if (!canQueueShipProduction(state, shipClass, variant)) return state;
  const next = cloneState(state);
  const base = baseEntity(next)!;
  base.shipProductionQueue = base.shipProductionQueue ?? [];
  const queueIndex = base.shipProductionQueue.length;
  const cost = shipProductionCost(shipClass, variant);
  spendResources(next.faction.resources, cost);
  const reduction = next.faction.localResearch.includes('rapidFabrication') ? 1 : 0;
  const turns = Math.max(1, shipProductionTurns(shipClass, variant) - reduction);
  const identity = `${next.seed}-s${next.sectorIndex}-t${next.turn}-q${queueIndex}`;
  const order: ShipProductionOrder = {
    id: `produce-${identity}`,
    campaignShipId: `cs-prod-${identity}`,
    shipClass,
    variant,
    turnsRemaining: turns,
    totalTurns: turns
  };
  base.shipProductionQueue.push(order);
  appendLog(next, `${SHIP_CN[shipClass]}·${VARIANT_CN[variant]}加入船坞生产队列（${turns} 回合，预分配 ${order.campaignShipId}）。`);
  return next;
}

function openCommanderRecruitment(state: UniverseState): UniverseState {
  if (!canOpenCommanderRecruitment(state)) return state;
  const next = cloneState(state);
  const base = baseEntity(next)!;
  const usedIds = [next.commander.id, ...next.reserveCommanders.map((commander) => commander.id)];
  next.pendingRecruitment = {
    nodeId: base.id,
    candidates: generateCommanderRecruitmentCandidates(
      next.seed,
      next.sectorIndex,
      base.id,
      usedIds
    ),
    supplyCost: commanderRecruitmentSupplyCost(next.reserveCommanders.length)
  };
  next.recruitmentUsedThisSector = true;
  appendLog(next, `前进基地发现两名可招募指挥人员；本星域招募机会已锁定。`);
  return next;
}

function resolveCommanderRecruitment(state: UniverseState, candidateId?: string): UniverseState {
  if (!state.pendingRecruitment) return state;
  if (!candidateId) {
    const next = cloneState(state);
    next.pendingRecruitment = undefined;
    appendLog(next, '放弃本星域的指挥官招募机会。');
    return next;
  }
  const offer = state.pendingRecruitment;
  const candidate = offer.candidates.find((commander) => commander.id === candidateId);
  if (!candidate || state.reserveCommanders.length >= MAX_RESERVE_COMMANDERS ||
    state.faction.resources.supplies < offer.supplyCost) return state;
  const next = cloneState(state);
  next.faction.resources.supplies -= offer.supplyCost;
  next.reserveCommanders.push(ensureCommanderProfile(candidate, next.seed));
  next.pendingRecruitment = undefined;
  appendLog(next, `招募 ${candidate.name} 加入候补名单，消耗补给 ${offer.supplyCost}。`);
  return next;
}

function treatStrategicCommander(state: UniverseState): UniverseState {
  if (!canTreatStrategicCommander(state)) return state;
  const treatment = treatCommander(state.commander, state.seed)!;
  const next = cloneState(state);
  next.faction.resources.supplies -= COMMANDER_TREATMENT_SUPPLY_COST;
  next.commander = treatment.commander;
  reconcileStrategicCommanderContinuity(next);
  appendLog(next, `${treatment.text} 消耗补给 ${COMMANDER_TREATMENT_SUPPLY_COST}。`);
  // 治疗本身已经通过入口校验，即使一次治疗后仍有另一处三级伤势、继任锁仍存在，
  // 也必须结算其明确承诺的一个战略回合。
  return resolveUniverseTurn(next, '指挥官治疗完成');
}

function appointStrategicCommander(state: UniverseState, commanderId: string): UniverseState {
  if (!canAppointStrategicCommander(state, commanderId)) return state;
  const next = cloneState(state);
  const index = next.reserveCommanders.findIndex((commander) => commander.id === commanderId);
  const candidate = ensureCommanderProfile(next.reserveCommanders[index], next.seed);
  const former = ensureCommanderProfile(next.commander, next.seed);
  next.reserveCommanders.splice(index, 1);
  if (former.alive && isCommanderIncapacitated(former, next.seed)) next.reserveCommanders.push(former);
  next.commander = candidate;
  reconcileStrategicCommanderContinuity(next);
  appendLog(next, `${candidate.name} 接任远征指挥官${former.alive ? `；${former.name} 转入伤病候补名单` : ''}。`);
  return next;
}

function queueResearch(state: UniverseState, projectId: ResearchProjectId): UniverseState {
  if (!canQueueResearch(state, projectId)) return state;
  const next = cloneState(state);
  const definition = RESEARCH_DEFINITIONS[projectId];
  next.faction.resources.science -= definition.scienceCost;
  next.faction.researchQueue.push({
    id: `research-${projectId}-s${next.sectorIndex}-t${next.turn}`,
    projectId,
    turnsRemaining: definition.turns,
    totalTurns: definition.turns
  });
  appendLog(next, `开始本地研究：${definition.label}（${definition.turns} 回合）。`);
  return next;
}

function establishBase(state: UniverseState, entityId: string): UniverseState {
  if (!canEstablishBase(state, entityId)) return state;
  let next = cloneState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  next.faction.resources.minerals -= 10;
  next.faction.resources.energy -= 5;
  next.faction.resources.supplies -= 4;
  station.ownerId = next.faction.id;
  station.facilities = station.facilities ?? [];
  station.constructionQueue = station.constructionQueue ?? [];
  station.shipProductionQueue = station.shipProductionQueue ?? [];
  next.faction.baseEntityId = station.id;
  const system = next.systems.find((candidate) => candidate.id === station.systemId)!;
  system.control = 'player';
  appendLog(next, `占领${station.name}并建立本星域前进基地。`);
  next = advanceUniverseTurn(next, '前进基地部署完成');
  return next;
}

function establishOutpost(state: UniverseState, entityId: string): UniverseState {
  if (!canEstablishOutpost(state, entityId)) return state;
  let next = cloneState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  const hub = baseEntity(next)!;
  const path = strategicTransportPath(next, station.systemId, hub.systemId)!;
  spendResources(next.faction.resources, OUTPOST_ESTABLISH_COST);
  station.ownerId = next.faction.id;
  station.facilities = station.facilities ?? [];
  station.constructionQueue = station.constructionQueue ?? [];
  station.shipProductionQueue = station.shipProductionQueue ?? [];
  const system = next.systems.find((candidate) => candidate.id === station.systemId)!;
  system.control = 'player';
  next.transportLinks.push({
    id: `transport-${station.id}-${hub.id}`,
    outpostEntityId: station.id,
    hubEntityId: hub.id,
    pathSystemIds: path
  });
  appendLog(next, `在${station.name}建立补给前哨，并开通至${hub.name}的 ${Math.max(0, path.length - 1)} 跳运输链。`);
  next = advanceUniverseTurn(next, '补给前哨部署完成');
  return next;
}

function preferredTaskForceAt(state: UniverseState, systemId: string): StrategicEnemyTaskForce | undefined {
  return [...state.enemyTaskForces]
    .filter((force) => force.systemId === systemId)
    .sort((left, right) => Number(right.role === 'gateDefense') - Number(left.role === 'gateDefense') || left.id.localeCompare(right.id))[0];
}

function lockStrategicBattleInPlace(state: UniverseState): void {
  if (state.pendingBattle) return;
  const system = state.systems.find((candidate) => candidate.id === state.fleet.systemId);
  if (!system) return;
  const gateDefense = preferredTaskForceAt(state, system.id)?.role === 'gateDefense'
    ? preferredTaskForceAt(state, system.id)
    : state.enemyTaskForces.find((force) => force.systemId === system.id && force.role === 'gateDefense');
  // 固定驻军必须先被清除；唯一例外是星门拦截舰队，它代表撤离流程的强制终战。
  const taskForce = gateDefense ?? (system.enemyPower > 0 ? undefined : preferredTaskForceAt(state, system.id));
  const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId);
  const isGate = taskForce?.role === 'gateDefense' || gate?.systemId === system.id;
  const source: PendingStrategicBattle['source'] = taskForce?.role === 'gateDefense'
    ? 'gateDefense'
    : taskForce ? 'taskForce' : 'garrison';
  const power = taskForce?.power ?? system.enemyPower;
  if (power <= 0) return;
  const seed = hash32(state.seed, state.sectorIndex, state.turn, system.id, taskForce?.id ?? 'garrison', 'strategic-battle') >>> 0;
  const enemyFleet = strategicEnemyFleetFor(seed, power, {
    sectorIndex: state.sectorIndex,
    gateGuard: isGate,
    cruiserAllowed: state.sectorIndex >= 2 || isGate
  });
  const actualPower = campaignFleetEntryCost(enemyFleet);
  if (taskForce) taskForce.power = actualPower;
  else system.enemyPower = actualPower;
  const pending: PendingStrategicBattle = {
    battleId: `sb-${state.seed}-${state.sectorIndex}-${system.id}-${state.turn}-${taskForce?.id ?? 'garrison'}`,
    systemId: system.id,
    battleSeed: seed,
    enemyPowerBefore: actualPower,
    enemyFleet,
    source,
    taskForceId: taskForce?.id
  };
  state.pendingBattle = pending;
  appendLog(
    state,
    `${source === 'gateDefense' ? '星门防御战开始' : `在${system.name}锁定敌军`}（战力 ${actualPower}），` +
    `已生成待处理真实战斗（battleId ${pending.battleId}）。点击“继续战斗”进入 core-v4 作战。`
  );
}

function engageEnemy(state: UniverseState): UniverseState {
  if (!canEngageEnemy(state)) return state;
  if (state.pendingBattle) return state;
  const next = cloneState(state);
  lockStrategicBattleInPlace(next);
  return next;
}

/** 逐舰维修：恢复一个损伤组件后，以共享组件规则重新计算 disabled。 */
function repairShipComponents(ship: PersistentShip): void {
  const { def } = getShipDef(ship.shipClass, ship.variant);
  if (!ship.componentHp) ship.componentHp = def.components.map((component) => component.maxHp);
  const keyTypes = new Set(['engine', 'weapon', 'sensor']);
  let target = -1;
  for (let i = 0; i < def.components.length; i++) {
    if (keyTypes.has(def.components[i].type) && (ship.componentHp[i] ?? 0) <= 0) {
      target = i;
      break;
    }
  }
  if (target < 0) {
    let maxGap = -1;
    for (let i = 0; i < def.components.length; i++) {
      const gap = def.components[i].maxHp - (ship.componentHp[i] ?? 0);
      if (gap > maxGap) {
        maxGap = gap;
        target = i;
      }
    }
  }
  if (target >= 0) {
    const maxHp = def.components[target].maxHp;
    const healed = Math.max(1, Math.ceil(maxHp * 0.5));
    ship.componentHp[target] = Math.min(maxHp, (ship.componentHp[target] ?? 0) + healed);
  }
  ship.disabled = isPersistentShipDisabled(ship);
}

function repairShip(state: UniverseState, campaignShipId: string): UniverseState {
  if (!canRepairShip(state, campaignShipId)) return state;
  let next = cloneState(state);
  next.faction.resources.supplies -= 5;
  next.faction.resources.minerals -= 4;
  const ship = next.fleet.ships.find((candidate) => candidate.campaignShipId === campaignShipId);
  if (ship) {
    repairShipComponents(ship);
    appendLog(next, `战地维修坞修复 ${ship.campaignShipId}（${SHIP_CN[ship.shipClass]} ${VARIANT_CN[ship.variant]}）。`);
  }
  next = advanceUniverseTurn(next, '舰队维修完成');
  return next;
}

function calibrateGate(state: UniverseState): UniverseState {
  if (!canCalibrateGate(state)) return state;
  let next = cloneState(state);
  next.faction.resources.energy -= 6;
  next.faction.resources.science -= 2;
  next.faction.resources.supplies -= 1;
  const bonus = next.faction.localResearch.includes('gateTheory') ? 10 : 0;
  next.extraction.calibration = Math.min(
    next.extraction.requiredCalibration,
    next.extraction.calibration + 25 + bonus
  );
  appendLog(next, `星门校准推进至 ${next.extraction.calibration}% 。`);
  next = advanceUniverseTurn(next, '星门校准作业完成');
  if (
    next.status === 'active' && next.extraction.calibration >= next.extraction.emergencyThreshold &&
    next.extraction.gateDefense === 'dormant'
  ) {
    const gate = next.entities.find((entity) => entity.id === next.extraction.gateEntityId)!;
    const seed = hash32(next.seed, next.sectorIndex, gate.systemId, 'gate-defense');
    // 启动时的机动拦截队继续使用受当前舰队战力限制的 gateDefense 预算；
    // D.1 的有限主基地生产不改变这条已验收的强制遭遇可玩性约束。
    const fleet = strategicEnemyFleetFor(
      seed,
      strategicMobileEnemyBudget(next.sectorIndex, strategicFleetPower(next), 'gateDefense'),
      {
      sectorIndex: next.sectorIndex,
      gateGuard: true,
      cruiserAllowed: true
      }
    );
    if (!fleet.length) {
      // 入口已保证至少一艘可作战舰；若未来成本表使预算无法装入合法舰船，必须明确失败而非生成空 pending。
      throw new Error('当前舰队战力不足以生成合法的星门防御舰队。');
    }
    next.enemyTaskForces.push({
      id: `gate-defense-${next.seed}-${next.sectorIndex}`,
      systemId: gate.systemId,
      power: campaignFleetEntryCost(fleet),
      role: 'gateDefense',
      spawnedTurn: next.turn
    });
    next.extraction.gateDefense = 'pending';
    appendLog(next, '星门达到可启动阈值时侦测到敌方拦截舰队；必须完成真实星门防御战后才能撤离。');
    lockStrategicBattleInPlace(next);
  }
  return next;
}

/**
 * 确定性选择撤离损失舰船：稳定撤离只损失断后舰（保留失能舰）；紧急撤离先舍弃失能舰，再按稳定 ID 顺序损失断后舰与高压额外舰。
 * 统一裁剪：任何成功撤离至少保留一艘舰船（maximumLosses = max(0, 总数 - 1)）。
 * 损失 ID 唯一、顺序稳定、不依赖当前数组偶然顺序；仅剩一艘舰时高压撤离不会删除最后一艘。
 */
function selectExtractLosses(fleet: StrategicFleet, mode: ExtractionMode, rearguard: number, extraLoss: number): string[] {
  const operational = fleet.ships
    .filter(isShipDeployable)
    .sort((a, b) => a.campaignShipId.localeCompare(b.campaignShipId));
  const disabledSorted = fleet.ships
    .filter((ship) => ship.disabled)
    .sort((a, b) => a.campaignShipId.localeCompare(b.campaignShipId));
  const lost: string[] = [];
  if (mode === 'emergency') lost.push(...disabledSorted.map((ship) => ship.campaignShipId));
  lost.push(...operational.slice(0, rearguard).map((ship) => ship.campaignShipId));
  if (mode === 'emergency') {
    lost.push(...operational.slice(rearguard, rearguard + extraLoss).map((ship) => ship.campaignShipId));
  }
  const unique = [...new Set(lost)];
  const maximumLosses = Math.max(0, fleet.ships.length - 1);
  return unique.slice(0, maximumLosses);
}

/** UI 预览：给定撤离模式与断后舰数，确定性返回将损失的舰船 ID 列表（与实际撤离逻辑完全一致）。 */
export function previewExtractLosses(state: UniverseState, mode: ExtractionMode, rearguardShips = 0): string[] {
  const counts = strategicFleetCounts(state.fleet);
  const hardened = state.faction.legacy.blueprints.includes('hardenedBulkheads');
  const rearguard = Math.min(counts.operational, rearguardShips);
  const pressureLoss = mode === 'emergency' && state.crisis.pressure >= 70 && rearguardShips === 0 && !hardened ? 1 : 0;
  const extraLoss = mode === 'emergency' ? pressureLoss : 0;
  return selectExtractLosses(state.fleet, mode, rearguard, extraLoss);
}

function extractSector(state: UniverseState, mode: ExtractionMode, rearguardShips = 0): UniverseState {
  if (!canExtractSector(state, mode, rearguardShips)) return state;
  const next = cloneState(state);
  const counts = strategicFleetCounts(next.fleet);
  const hardened = next.faction.legacy.blueprints.includes('hardenedBulkheads');
  const rearguard = Math.min(counts.operational, rearguardShips);
  const pressureLoss = mode === 'emergency' && next.crisis.pressure >= 70 && rearguardShips === 0 && !hardened ? 1 : 0;
  const extraLoss = mode === 'emergency' ? pressureLoss : 0;
  const lostIds = selectExtractLosses(next.fleet, mode, rearguard, extraLoss);
  const survivingShips = next.fleet.ships.filter((ship) => !lostIds.includes(ship.campaignShipId));
  const totalLost = lostIds.length;

  const carriedMaterials = mode === 'stable'
    ? Math.min(30, Math.floor(next.faction.resources.minerals * 0.5))
    : Math.min(12, Math.floor(next.faction.resources.minerals * 0.25));
  const carriedSupplies = mode === 'stable'
    ? Math.min(12, Math.max(0, next.faction.resources.supplies - 8))
    : Math.min(5, Math.max(0, next.faction.resources.supplies - 4));
  const blueprints = Array.from(new Set<PermanentBlueprintId>([
    ...next.faction.legacy.blueprints,
    ...next.faction.recoveredBlueprints
  ]));
  const legacy = {
    sectorsCleared: next.faction.legacy.sectorsCleared + 1,
    portableMaterials: carriedMaterials,
    reserveSupplies: carriedSupplies,
    blueprints,
    shipsLost: next.faction.legacy.shipsLost + totalLost
  };

  const inherited: PersistentFleet = {
    ships: survivingShips.map((ship) => ({ ...ship, componentHp: ship.componentHp ? [...ship.componentHp] : undefined })),
    formation: next.fleet.formation,
    doctrine: next.fleet.doctrine
  };

  if (next.sectorIndex >= next.targetSectorCount) {
    next.status = 'victory';
    next.fleet.ships = survivingShips.map((ship) => ({ ...ship, componentHp: ship.componentHp ? [...ship.componentHp] : undefined }));
    next.faction.legacy = legacy;
    appendLog(
      next,
      `${mode === 'stable' ? '稳定' : '紧急'}撤离完成；穿越全部 ${next.targetSectorCount} 个星域，舰船损失 ${totalLost}${lostIds.length ? `（${lostIds.join(', ')}）` : ''}。`
    );
    return next;
  }

  const nextSeed = hash32(next.seed, next.sectorIndex + 1, next.turn, mode, 'next-sector');
  const generated = generateUniverse(nextSeed, next.faction.name, {
    sectorIndex: next.sectorIndex + 1,
    targetSectorCount: next.targetSectorCount,
    legacy,
    fleet: inherited,
    commander: next.commander,
    reserveCommanders: next.reserveCommanders,
    pendingSuccession: next.pendingSuccession
  });
  generated.log.unshift({
    turn: 0,
    text: `${mode === 'stable' ? '稳定撤离' : '紧急突围'}上一星域：留下 ${rearguardShips} 艘断后舰，总损失 ${totalLost}${lostIds.length ? `（${lostIds.join(', ')}）` : ''}，携带矿物 ${carriedMaterials}、补给 ${carriedSupplies}。`
  });
  return generated;
}

export function applyUniverseAction(state: UniverseState, action: UniverseAction): UniverseState {
  // 存在待处理战斗时，除选择星系与（幂等）发起战斗外，其他战略行动一律阻止。
  if (state.pendingBattle && action.type !== 'engageEnemy' && action.type !== 'selectSystem') {
    return state;
  }
  // 招募候选人出现后必须先接受或放弃；期间只允许查看星系与处理该招募。
  if (state.pendingRecruitment && action.type !== 'resolveRecruitment' && action.type !== 'selectSystem') {
    return state;
  }
  // 指挥权中断时只允许查看、治疗现任或任命继任者。
  if (
    isStrategicCommandLocked(state) && action.type !== 'selectSystem' &&
    action.type !== 'treatCommander' && action.type !== 'appointCommander'
  ) return state;
  if (action.type === 'selectSystem') {
    if (!state.systems.some((system) => system.id === action.systemId && system.discovered)) return state;
    const next = cloneState(state);
    next.selectedSystemId = action.systemId;
    return next;
  }
  if (action.type === 'queueConstruction') return queueConstruction(state, action.facilityType, action.entityId);
  if (action.type === 'queueShipProduction') return queueShipProduction(state, action.shipClass, action.variant);
  if (action.type === 'queueResearch') return queueResearch(state, action.projectId);
  if (action.type === 'establishBase') return establishBase(state, action.entityId);
  if (action.type === 'establishOutpost') return establishOutpost(state, action.entityId);
  if (action.type === 'engageEnemy') return engageEnemy(state);
  if (action.type === 'openRecruitment') return openCommanderRecruitment(state);
  if (action.type === 'resolveRecruitment') return resolveCommanderRecruitment(state, action.candidateId);
  if (action.type === 'treatCommander') return treatStrategicCommander(state);
  if (action.type === 'appointCommander') return appointStrategicCommander(state, action.commanderId);
  if (action.type === 'repairShip') return repairShip(state, action.campaignShipId);
  if (action.type === 'calibrateGate') return calibrateGate(state);
  if (action.type === 'extractSector') return extractSector(state, action.mode, action.rearguardShips ?? 0);
  if (action.type === 'advanceTurn') return advanceUniverseTurn(state);
  if (state.status !== 'active') return state;

  if (action.type === 'travel') {
    const current = state.systems.find((system) => system.id === state.fleet.systemId);
    const target = state.systems.find((system) => system.id === action.systemId);
    const cost = travelFuelCost(state);
    if (!current || !target || !current.neighbors.includes(target.id) || state.fleet.fuel < cost) return state;
    let next = cloneState(state);
    next.fleet.systemId = target.id;
    next.fleet.fuel -= cost;
    next.selectedSystemId = target.id;
    const reached = next.systems.find((system) => system.id === target.id)!;
    reached.discovered = true;
    if (reached.control === 'unknown') reached.control = 'neutral';
    if (!next.faction.knownSystemIds.includes(reached.id)) next.faction.knownSystemIds.push(reached.id);
    for (const neighborId of reached.neighbors) {
      const neighbor = next.systems.find((system) => system.id === neighborId)!;
      neighbor.discovered = true;
      if (neighbor.control === 'unknown') neighbor.control = 'neutral';
      if (!next.faction.knownSystemIds.includes(neighbor.id)) next.faction.knownSystemIds.push(neighbor.id);
    }
    for (const entity of next.entities.filter((candidate) => candidate.systemId === reached.id)) entity.discovered = true;
    appendLog(next, `${next.fleet.name}抵达${reached.name}，消耗燃料 ${cost}。`);
    next = advanceUniverseTurn(next, '完成星际航行');
    return next;
  }

  if (action.type === 'surveyEntity') {
    const entity = state.entities.find((candidate) => candidate.id === action.entityId);
    const system = entity ? state.systems.find((candidate) => candidate.id === entity.systemId) : undefined;
    if (
      !entity || !entity.discovered || entity.surveyed || entity.systemId !== state.fleet.systemId ||
      !system || strategicHostilePowerAt(state, system.id) > 0
    ) return state;
    let next = cloneState(state);
    const target = next.entities.find((candidate) => candidate.id === entity.id)!;
    target.surveyed = true;
    const science = target.kind === 'relicSite' ? 5 : 3;
    next.faction.resources.science += science;
    if (target.kind === 'jumpGate') {
      next.extraction.discovered = true;
      appendLog(next, `确认${target.name}为本星域撤离目标。`);
    }
    if (target.kind === 'relicSite' && target.blueprint) {
      if (
        !next.faction.legacy.blueprints.includes(target.blueprint) &&
        !next.faction.recoveredBlueprints.includes(target.blueprint)
      ) {
        next.faction.recoveredBlueprints.push(target.blueprint);
        appendLog(next, `从${target.name}取得可撤离蓝图：${BLUEPRINT_LABEL[target.blueprint]}。`);
      }
    }
    appendLog(next, `完成${target.name}测绘，科学 +${science}。`);
    next = advanceUniverseTurn(next, '实体测绘完成');
    return next;
  }

  if (action.type === 'extractAsteroid') {
    const entity = state.entities.find((candidate) => candidate.id === action.entityId);
    const system = entity ? state.systems.find((candidate) => candidate.id === entity.systemId) : undefined;
    if (
      !entity || entity.kind !== 'asteroidField' || !entity.surveyed || entity.systemId !== state.fleet.systemId ||
      !system || strategicHostilePowerAt(state, system.id) > 0 || (entity.deposits?.minerals ?? 0) <= 0 || state.faction.resources.supplies < 1
    ) return state;
    let next = cloneState(state);
    const target = next.entities.find((candidate) => candidate.id === entity.id)!;
    const extracted = Math.min(9, target.deposits?.minerals ?? 0);
    const energy = Math.min(2, target.deposits?.energy ?? 0);
    target.deposits!.minerals -= extracted;
    target.deposits!.energy -= energy;
    next.faction.resources.minerals += extracted;
    next.faction.resources.energy += energy;
    next.faction.resources.supplies--;
    appendLog(next, `从${target.name}开采矿物 ${extracted}、能源 ${energy}，消耗补给 1。`);
    next = advanceUniverseTurn(next, '快速采集完成');
    return next;
  }

  return state;
}

/**
 * 将一次完成的真实 core-v4 战略战斗结果写回战略状态。
 * 幂等：若已无待处理战斗 / 状态非 active / 战斗未结束，直接返回原状态（结果只应用一次）。
 * 写回前执行严格校验，任何不匹配都拒绝应用并抛出明确错误（绝不静默写入任意 BattleState）：
 * - 战斗 binding 与当前战略舰队 / Team A 战斗舰结构一致（见 validatePersistentBattleBindings）；
 * - battle.seed / ruleset 与预期 core-v4 一致；
 * - Team B 的舰种/改型/数量与 pendingBattle.enemyFleet 一致；
 * - pendingBattle.systemId 等于舰队当前星系、对应星系仍为敌方且 enemyPower 与 pending 一致。
 * 写回规则：
 * - 玩家舰：destroyed 永久删除；disabled 保持 disabled；escaped 归一化为 escaped=false / deployed=true（脱离战斗而非离队）；未参战舰原状态完全不变。
 * - 敌方剩余战力：仅由真实 Team B 结果重算（destroyed/disabled 不贡献，escaped/operational 按成本×完整度）；无增援时不得高于战前。
 * - 仅推进一个战略回合；清零则星系恢复 neutral，否则保持 enemy。
 */
export function applyStrategicBattleResult(
  state: UniverseState,
  battle: BattleState,
  bindings: ReadonlyArray<PersistentBattleBinding>
): UniverseState {
  if (!state.pendingBattle || state.status !== 'active' || !battle.finished) return state;
  const pending = state.pendingBattle;
  const system = state.systems.find((candidate) => candidate.id === pending.systemId);
  if (!system) throw new Error('战略待处理战斗引用了不存在的星系。');

  // —— 关联与结构校验（拒绝任意不匹配的 BattleState）——
  if (battle.seed !== pending.battleSeed) {
    throw new Error(`战斗 seed（${battle.seed}）与待处理战斗（${pending.battleSeed}）不一致。`);
  }
  if (battle.ruleset !== RULESET_V4) {
    throw new Error(`战斗规则集（${battle.ruleset ?? '未知'}）不是预期的 core-v4（${RULESET_V4}）。`);
  }
  if (pending.systemId !== state.fleet.systemId) {
    throw new Error('待处理战斗的星系与舰队当前所在星系不一致。');
  }
  const pendingForce = pending.taskForceId
    ? state.enemyTaskForces.find((force) => force.id === pending.taskForceId)
    : undefined;
  if (pending.source === 'garrison') {
    if (pending.taskForceId || system.control !== 'enemy' || system.enemyPower !== pending.enemyPowerBefore) {
      throw new Error('驻军战斗对应星系的控制状态 / 战前预算与存档不一致。');
    }
  } else if (
    !pendingForce || pendingForce.systemId !== pending.systemId || pendingForce.power !== pending.enemyPowerBefore ||
    (pending.source === 'gateDefense') !== (pendingForce.role === 'gateDefense')
  ) {
    throw new Error('移动敌军战斗对应特遣舰队的来源 / 位置 / 战前预算与存档不一致。');
  }
  if (!teamBMatchesPending(battle, pending.enemyFleet)) {
    throw new Error('战斗敌方舰队（Team B）与待处理战斗的 enemyFleet 不一致。');
  }
  validatePersistentBattleBindings(bindings, toPersistentFleet(state.fleet), battle, pending.deployment);
  // 深层结构校验：版本 / ruleset / seed / 队伍计数 / 舰 id 唯一 / 有限数值 / 每舰组件与状态机一致性 / Team B 与 pending 一致。
  validateFinishedStrategicBattle(battle, { battleSeed: pending.battleSeed, enemyFleet: pending.enemyFleet });

  const next = cloneState(state);
  const target = next.systems.find((candidate) => candidate.id === pending.systemId)!;
  const persistentFleet = toPersistentFleet(next.fleet);
  const ownBefore = persistentFleet.ships.length;
  const updatedFleet = importBattleResult(persistentFleet, battle, bindings);

  // 归一化 escaped：从本次战斗脱离的玩家舰标准化为 escaped=false / deployed=true，
  // disabled 舰保持 disabled，destroyed 已删除，未参战舰保持原 deployed/escaped/disabled/towed/componentHp。
  const escapedIds = new Set(teamACombatIds(battle, bindings, 'escaped'));
  const standardizedShips = updatedFleet.ships.map((ship) => {
    if (!escapedIds.has(ship.campaignShipId)) return ship;
    return { ...ship, escaped: false, deployed: true };
  });
  next.fleet.ships = standardizedShips.map((ship) => ({ ...ship, componentHp: ship.componentHp ? [...ship.componentHp] : undefined }));
  const shipsLost = Math.max(0, ownBefore - next.fleet.ships.length);

  // 指挥官后果使用 V0.8 同源健康规则：真实舰损与胜负决定疲劳、动摇和创伤；
  // 战斗经验同样写入持久档案，且整个结果只随已验证的 BattleState 决定。
  next.commander = gainCommanderDomainExperience(
    next.commander,
    next.seed,
    'combat',
    battle.winner === 'A' ? 12 : 6
  );
  next.commander = applyBattleCommanderConsequences(
    next.commander,
    next.seed,
    next.turn,
    shipsLost,
    battle.winner === 'A'
  );

  // 战后敌方残余战力归一化：低于最低合法舰船成本（无法代表一艘合法舰船）一律归零并转为 neutral，
  // 既修复"严重受损但存活的敌舰产生低于最低成本的残余战力导致无法保存"，也防止"低残余被下一战膨胀成整舰"。
  const calculatedEnemyRemaining = normalizeStrategicEnemyPower(enemyRemainingPower(battle));
  // 星门防御是“守住启动窗口”目标：敌方被击毁、失能或撤出战场且玩家获胜，都表示拦截失败。
  // 普通驻军/特遣舰队仍按真实剩余价值写回，只有这一明确目标战采用战场控制语义。
  const enemyRemaining = pending.source === 'gateDefense' && battle.winner === 'A'
    ? 0
    : calculatedEnemyRemaining;
  // 无增援 / 敌方恢复 / 新单位生成时，战后战力不得高于战前（离散装箱误差已在共享函数层归整）。
  if (enemyRemaining > pending.enemyPowerBefore) {
    throw new Error(`敌方战后战力 ${enemyRemaining} 高于战前 ${pending.enemyPowerBefore}，拒绝写回。`);
  }
  if (pending.source === 'garrison') {
    target.enemyPower = enemyRemaining;
    target.control = enemyRemaining === 0 ? 'neutral' : 'enemy';
  } else {
    const force = next.enemyTaskForces.find((candidate) => candidate.id === pending.taskForceId)!;
    if (enemyRemaining === 0) {
      next.enemyTaskForces = next.enemyTaskForces.filter((candidate) => candidate.id !== force.id);
      next.sieges = next.sieges.filter((siege) => siege.taskForceId !== force.id);
      if (pending.source === 'gateDefense') next.extraction.gateDefense = 'resolved';
    } else {
      force.power = enemyRemaining;
    }
  }

  const destroyedIds = teamACombatIds(battle, bindings, 'destroyed');
  const disabledIds = teamACombatIds(battle, bindings, 'disabled');
  next.faction.legacy.shipsLost += shipsLost;
  appendLog(
    next,
    `战斗结束于${system.name}（battleId ${pending.battleId} / seed ${pending.battleSeed}）：` +
      `玩家损毁 [${destroyedIds.join(', ')}]，失能 [${disabledIds.join(', ')}]，脱离 [${escapedIds.size ? [...escapedIds].sort().join(', ') : '无'}]；` +
      `敌方战力 ${pending.enemyPowerBefore} → ${enemyRemaining}` +
      `${enemyRemaining === 0 ? pending.source === 'garrison' ? '；星系已清除' : '；特遣舰队已消灭' : ''}。`
  );

  next.pendingBattle = undefined;

  // 玩家无任何可作战舰船 → 失败（不清除敌方据点）。
  if (strategicFleetCounts(next.fleet).operational <= 0) {
    next.status = 'collapsed';
    next.pendingSuccession = false;
    appendLog(next, '远征舰队已无可用作战舰船。');
    return next;
  }

  const continuity = reconcileStrategicCommanderContinuity(next);
  if (continuity === 'succession') {
    appendLog(next, `${next.commander.name} 已无法履职；必须从候补名单任命继任者。`);
    return resolveUniverseTurn(next, '战斗行动结束');
  }
  if (continuity === 'collapsed') {
    appendLog(next, `${next.commander.name} 已无法履职且没有可用继任者，远征指挥体系崩溃。`);
    return next;
  }

  return advanceUniverseTurn(next, '战斗行动结束');
}

/** 校验战斗 Team B 的舰种/改型/数量是否与 pending 的 enemyFleet 完全一致。 */
function teamBMatchesPending(battle: BattleState, enemyFleet: ReadonlyArray<{ shipClass: string; variant: string; count: number }>): boolean {
  const counts = new Map<string, number>();
  for (const ship of battle.ships.filter((candidate) => candidate.team === 'B')) {
    const key = `${ship.type}:${ship.variant}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const want = new Map<string, number>();
  for (const entry of enemyFleet) {
    const key = `${entry.shipClass}:${entry.variant}`;
    want.set(key, (want.get(key) ?? 0) + Math.max(0, Math.floor(entry.count)));
  }
  if (counts.size !== want.size) return false;
  for (const [key, value] of want) {
    if (counts.get(key) !== value) return false;
  }
  return true;
}

/**
 * 校验单艘战斗舰与其 (舰体, 改型) 定义的深层一致性（拒绝被篡改的 BattleState）：
 * - ship.type / ship.variant 与权威 ShipDef（getShipDef）一致；
 * - 组件数量、类型（按序）、maxHp 与权威 ShipDef 完全一致；
 * - 每个组件 hp 为有限值、0 <= hp <= maxHp、destroyed === (hp <= 0)；
 * - **结构死亡双向一致**：combatState === 'destroyed' ⇔ 核心已毁或全组件摧毁；
 * - **失能标志与真实组件损伤一致**：mobilityDisabled / weaponsDisabled / sensorsDisabled 必须分别等于
 *   对应系统组件是否全部摧毁（与模拟器 recomputeDerivedV4 同一套规则）；combatState === 'disabled'
 *   必须由至少一个关键系统真实失能支撑；
 * - **alive 与 combatState 一致**：destroyed ⇒ alive=false；其余状态（含 escaped）⇒ alive=true（与模拟器一致）；
 * - **escaped / retreating**：escaped 必须有有限非负整数的 escapedTick；retreating 必须有有限非负整数的 retreatStartedTick；
 *   二者 tick 必须合法；destroyed 不得残留 escapedTick / retreatStartedTick；
 * - **数值字段**：id 为有限非负整数；shield / maxShield 有限且 0 <= shield <= maxShield；pos / heading 有限；
 *   escapedTick / retreatStartedTick 有值时为有限非负整数；combatState 属于合法枚举。
 */
export function validateBattleShipAgainstDefinition(ship: BattleState['ships'][number]): void {
  const canonical = getShipDef(ship.type, ship.variant).def;
  if (!ship.def || ship.def.type !== ship.type) {
    throw new Error(`战斗舰 ${ship.id} 的 def.type 与 type(${ship.type}) 不一致。`);
  }
  if (ship.components.length !== canonical.components.length) {
    throw new Error(`战斗舰 ${ship.id} 的组件数量与定义不一致。`);
  }
  const core = ship.components.find((component) => component.def.type === 'core');
  for (let i = 0; i < canonical.components.length; i++) {
    const component = ship.components[i];
    const def = canonical.components[i];
    if (component.def.type !== def.type) {
      throw new Error(`战斗舰 ${ship.id} 第 ${i} 个组件类型(${component.def.type})与定义(${def.type})不一致。`);
    }
    if (component.maxHp !== def.maxHp) {
      throw new Error(`战斗舰 ${ship.id} 第 ${i} 个组件 maxHp(${component.maxHp})与定义(${def.maxHp})不一致。`);
    }
    if (!Number.isFinite(component.hp) || component.hp < 0 || component.hp > component.maxHp) {
      throw new Error(`战斗舰 ${ship.id} 组件 hp(${component.hp})非法（应为有限值且 0<=hp<=maxHp）。`);
    }
    if (component.destroyed !== (component.hp <= 0)) {
      throw new Error(`战斗舰 ${ship.id} 组件 destroyed 标记与 hp 不一致。`);
    }
  }

  // —— 结构死亡双向一致性（与模拟器 dealDamage 规则一致）——
  const structurallyDead = isStructurallyDestroyed(ship);
  if (ship.combatState === 'destroyed' && !structurallyDead) {
    throw new Error(`战斗舰 ${ship.id} 标记 destroyed 但核心与全组件均存活（结构未死亡）。`);
  }
  if (structurallyDead && ship.combatState !== 'destroyed') {
    throw new Error(`战斗舰 ${ship.id} 核心或全组件已摧毁，但 combatState(${ship.combatState})不是 destroyed。`);
  }

  // —— 失能标志与真实组件损伤一致（与模拟器 recomputeDerivedV4 同一套规则）——
  const expected = expectedDisableFlags(ship);
  if (ship.mobilityDisabled !== expected.mobilityDisabled) {
    throw new Error(
      `战斗舰 ${ship.id} mobilityDisabled(${ship.mobilityDisabled})与引擎真实损毁(${expected.mobilityDisabled})不一致。`
    );
  }
  if (ship.weaponsDisabled !== expected.weaponsDisabled) {
    throw new Error(
      `战斗舰 ${ship.id} weaponsDisabled(${ship.weaponsDisabled})与武器真实损毁(${expected.weaponsDisabled})不一致。`
    );
  }
  if (ship.sensorsDisabled !== expected.sensorsDisabled) {
    throw new Error(
      `战斗舰 ${ship.id} sensorsDisabled(${ship.sensorsDisabled})与传感器真实损毁(${expected.sensorsDisabled})不一致。`
    );
  }
  if (ship.combatState === 'disabled' && !(ship.mobilityDisabled || ship.weaponsDisabled || ship.sensorsDisabled)) {
    throw new Error(`战斗舰 ${ship.id} 标记 disabled 但无任何关键系统真实失能。`);
  }

  // combatState 不能只是“未被破坏”的任意标签。引擎或武器失能在任何距离下都必须进入 disabled；
  // 无关键系统失能时，normal/damaged/critical/retreating 必须和模拟器的同源状态机一致。
  if (ship.combatState !== 'destroyed' && ship.combatState !== 'escaped') {
    if (expected.mobilityDisabled || expected.weaponsDisabled) {
      if (ship.combatState !== 'disabled') {
        throw new Error(`战斗舰 ${ship.id} 引擎或武器已真实失能，但 combatState(${ship.combatState})不是 disabled。`);
      }
    } else if (!expected.sensorsDisabled) {
      const derivedState = computeCombatState(ship, false);
      if (derivedState !== ship.combatState) {
        throw new Error(`战斗舰 ${ship.id} combatState(${ship.combatState})与组件真实状态(${derivedState})不一致。`);
      }
    }
  }

  // —— alive 与 combatState 一致（模拟器仅在结构死亡时置 alive=false）——
  if (ship.alive !== (ship.combatState !== 'destroyed')) {
    throw new Error(`战斗舰 ${ship.id} alive(${ship.alive})与 combatState(${ship.combatState})不一致。`);
  }

  // —— escaped / retreating 的 tick 合法性 ——
  if (ship.combatState === 'escaped') {
    if (ship.escapedTick === undefined) throw new Error(`战斗舰 ${ship.id} 标记 escaped 但缺少 escapedTick。`);
    if (!Number.isInteger(ship.escapedTick) || !Number.isFinite(ship.escapedTick) || (ship.escapedTick as number) < 0) {
      throw new Error(`战斗舰 ${ship.id} escapedTick(${ship.escapedTick})非法（须为有限非负整数）。`);
    }
  }
  if (ship.combatState === 'retreating') {
    if (ship.retreatStartedTick === undefined) throw new Error(`战斗舰 ${ship.id} 标记 retreating 但缺少 retreatStartedTick。`);
    if (!Number.isInteger(ship.retreatStartedTick) || !Number.isFinite(ship.retreatStartedTick) || (ship.retreatStartedTick as number) < 0) {
      throw new Error(`战斗舰 ${ship.id} retreatStartedTick(${ship.retreatStartedTick})非法（须为有限非负整数）。`);
    }
  }
  // destroyed 不得残留 escaped / retreating 状态字段（避免状态机冲突）。
  if (ship.combatState === 'destroyed' && (ship.escapedTick !== undefined || ship.retreatStartedTick !== undefined)) {
    throw new Error(`战斗舰 ${ship.id} 已 destroyed 却残留 escapedTick / retreatStartedTick。`);
  }

  if (core && core.hp <= 0 && ship.combatState !== 'destroyed') {
    throw new Error(`战斗舰 ${ship.id} 核心已损毁但 combatState(${ship.combatState})不是 destroyed。`);
  }
  if (
    (ship.combatState === 'normal' || ship.combatState === 'damaged' || ship.combatState === 'critical' || ship.combatState === 'retreating') &&
    core && core.hp <= 0
  ) {
    throw new Error(`战斗舰 ${ship.id} combatState(${ship.combatState})要求正 core hp，但核心已损毁。`);
  }
}

/**
 * 校验一份已结束的 core-v4 战略战斗 BattleState 的深层结构（拒绝任意不匹配的结果）：
 * - 必须 finished 且 ruleset === RULESET_V4、version === SIM_VERSION_V5；
 * - seed 为有限整数；与 pending.battleSeed 一致（若提供）；
 * - teamACount / teamBCount 与真实舰数一致；ship id 唯一；数值字段有限；
 * - 每艘舰通过 validateBattleShipAgainstDefinition；
 * - 若提供 pending，则 Team B 必须与 pending.enemyFleet 完全一致。
 */
export function validateFinishedStrategicBattle(
  battle: BattleState,
  pending?: { battleSeed: number; enemyFleet: ReadonlyArray<FleetEntry> }
): void {
  if (!battle || typeof battle !== 'object') throw new Error('BattleState 缺失或非法。');
  if (typeof battle.finished !== 'boolean' || !battle.finished) throw new Error('战斗尚未结束（finished 不为 true）。');
  if (battle.version !== SIM_VERSION_V5) throw new Error(`BattleState.version（${String(battle.version)}）不是预期的 ${SIM_VERSION_V5}。`);
  if (battle.ruleset !== RULESET_V4) throw new Error(`BattleState.ruleset（${String(battle.ruleset)}）不是预期的 ${RULESET_V4}。`);
  if (!Number.isInteger(battle.seed) || !Number.isFinite(battle.seed)) throw new Error('BattleState.seed 非法。');
  if (pending && battle.seed !== pending.battleSeed) {
    throw new Error(`战斗 seed（${battle.seed}）与待处理战斗（${pending.battleSeed}）不一致。`);
  }
  if (!Number.isFinite(battle.tick) || !Number.isFinite(battle.maxTicks)) throw new Error('BattleState 时间字段非法。');
  if (!Number.isInteger(battle.tick) || (battle.tick as number) < 0) throw new Error('BattleState.tick 须为非负整数。');
  if (!Number.isInteger(battle.maxTicks) || (battle.maxTicks as number) < 0) throw new Error('BattleState.maxTicks 须为非负整数。');
  // 胜利方与结束状态一致：finished 时必须明确为 'A' / 'B' / null（平局或超时无胜者）。
  if (battle.winner !== null && battle.winner !== 'A' && battle.winner !== 'B') {
    throw new Error(`BattleState.winner（${String(battle.winner)}）非法。`);
  }
  // teamACount / teamBCount 与模拟器保持一致：仅统计仍在场（未摧毁、未脱离）的舰，
  // 因为模拟器在每 tick 会据此重算（escaped 舰已离场不算入内）。
  const teamA = battle.ships.filter((ship) => ship.team === 'A' && isPresentOnBattlefield(ship));
  const teamB = battle.ships.filter((ship) => ship.team === 'B' && isPresentOnBattlefield(ship));
  if (teamA.length !== battle.teamACount) throw new Error(`BattleState.teamACount(${battle.teamACount}) 与真实 Team A 在场舰数(${teamA.length})不一致。`);
  if (teamB.length !== battle.teamBCount) throw new Error(`BattleState.teamBCount(${battle.teamBCount}) 与真实 Team B 在场舰数(${teamB.length})不一致。`);
  const ids = new Set<number>();
  const validTeams: ReadonlyArray<string> = ['A', 'B'];
  const validCombatStates: ReadonlyArray<string> = [
    'normal', 'damaged', 'critical', 'disabled', 'retreating', 'escaped', 'destroyed'
  ];
  for (const ship of battle.ships) {
    if (!Number.isFinite(ship.id) || !Number.isInteger(ship.id) || (ship.id as number) < 0) {
      throw new Error(`战斗舰 id(${ship.id})非法（须为非负整数）。`);
    }
    if (ids.has(ship.id)) throw new Error('战斗舰 id 重复。');
    ids.add(ship.id);
    if (!validTeams.includes(ship.team)) throw new Error(`战斗舰 ${ship.id} team(${ship.team})非法。`);
    if (!validCombatStates.includes(ship.combatState)) throw new Error(`战斗舰 ${ship.id} combatState(${ship.combatState})非法。`);
    if (!Number.isFinite(ship.shield) || !Number.isFinite(ship.maxShield)) throw new Error(`战斗舰 ${ship.id} 护盾数值非法。`);
    if (ship.shield < 0 || ship.shield > ship.maxShield) throw new Error(`战斗舰 ${ship.id} shield(${ship.shield})越界（须 0<=shield<=maxShield=${ship.maxShield}）。`);
    if (!Number.isFinite(ship.pos.x) || !Number.isFinite(ship.pos.y) || !Number.isFinite(ship.pos.z)) {
      throw new Error(`战斗舰 ${ship.id} pos 坐标非法。`);
    }
    if (!Number.isFinite(ship.heading)) throw new Error(`战斗舰 ${ship.id} heading 非法。`);
    validateBattleShipAgainstDefinition(ship);
  }
  if (pending && !teamBMatchesPending(battle, pending.enemyFleet)) {
    throw new Error('战斗敌方舰队（Team B）与待处理战斗的 enemyFleet 不一致。');
  }
}

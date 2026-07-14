import { generateUniverse, hash32 } from './universeGenerator';
import type {
  ConstructionOrder,
  CrisisPhase,
  ExtractionMode,
  FacilityType,
  PermanentBlueprintId,
  ResearchProjectId,
  SpaceEntity,
  StrategicResources,
  UniverseAction,
  UniverseState
} from './universeTypes';

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

function cloneState(state: UniverseState): UniverseState {
  return JSON.parse(JSON.stringify(state)) as UniverseState;
}

function appendLog(state: UniverseState, text: string): void {
  state.log.push({ turn: state.turn, text });
  if (state.log.length > 180) state.log = state.log.slice(-180);
}

function baseEntity(state: UniverseState): SpaceEntity | undefined {
  return state.faction.baseEntityId
    ? state.entities.find((entity) => entity.id === state.faction.baseEntityId)
    : undefined;
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

function effectiveFacilityCost(state: UniverseState, facilityType: FacilityType): Partial<StrategicResources> {
  const definition = FACILITY_DEFINITIONS[facilityType];
  const discount = state.faction.legacy.blueprints.includes('compactFoundry') ? 4 : 0;
  return {
    ...definition.cost,
    minerals: Math.max(0, (definition.cost.minerals ?? 0) - discount)
  };
}

export function crisisPhaseForTurn(turn: number, finalTurn: number): CrisisPhase {
  const ratio = finalTurn > 0 ? turn / finalTurn : 1;
  if (ratio < 0.3) return 'foothold';
  if (ratio < 0.62) return 'contest';
  if (ratio < 0.84) return 'collapse';
  return 'evacuation';
}

export function universeTurnIncome(state: UniverseState): StrategicResources {
  const base = baseEntity(state);
  return {
    minerals: facilityCount(base, 'miningArray') * 4,
    energy: facilityCount(base, 'solarArray') * 4,
    science: facilityCount(base, 'researchLab') * 3,
    supplies: facilityCount(base, 'supplyWorks') * 3
  };
}

function processConstruction(state: UniverseState): void {
  const base = baseEntity(state);
  const queue = base?.constructionQueue ?? [];
  if (!base || !queue.length) return;
  queue[0].turnsRemaining--;
  if (queue[0].turnsRemaining > 0) return;
  const completed = queue.shift()!;
  base.facilities = base.facilities ?? [];
  base.facilities.push({
    id: `${base.id}-${completed.facilityType}-${state.sectorIndex}-${state.turn}`,
    type: completed.facilityType,
    level: 1
  });
  appendLog(state, `${FACILITY_DEFINITIONS[completed.facilityType].label}建造完成。`);
}

function processResearch(state: UniverseState): void {
  if (!state.faction.researchQueue.length) return;
  state.faction.researchQueue[0].turnsRemaining--;
  if (state.faction.researchQueue[0].turnsRemaining > 0) return;
  const completed = state.faction.researchQueue.shift()!;
  if (!state.faction.localResearch.includes(completed.projectId)) state.faction.localResearch.push(completed.projectId);
  appendLog(state, `本地研究完成：${RESEARCH_DEFINITIONS[completed.projectId].label}。`);
}

function enemyExpansion(state: UniverseState): void {
  const enemySystems = state.systems.filter((system) => system.control === 'enemy');
  const candidates = state.systems.filter((system) =>
    system.control !== 'enemy' &&
    enemySystems.some((enemy) => enemy.neighbors.includes(system.id))
  );
  if (!candidates.length) return;
  const ordered = [...candidates].sort((left, right) =>
    hash32(state.seed, state.sectorIndex, state.turn, left.id, 'enemy-spread') -
    hash32(state.seed, state.sectorIndex, state.turn, right.id, 'enemy-spread')
  );
  const target = ordered.find((system) => !baseEntity(state) || system.id !== baseEntity(state)!.systemId) ?? ordered[0];
  const base = baseEntity(state);
  if (base && target.id === base.systemId) {
    const defense = facilityCount(base, 'defenseGrid');
    const supplyLoss = Math.max(0, 7 + state.sectorIndex * 2 - defense * 5);
    state.faction.resources.supplies = Math.max(0, state.faction.resources.supplies - supplyLoss);
    if (supplyLoss >= 5 && state.fleet.disabledShips < Math.max(0, state.fleet.shipCount - 1)) state.fleet.disabledShips++;
    appendLog(state, `敌方袭击前进基地，损失补给 ${supplyLoss}${defense ? '；防御网降低了损失' : ''}。`);
    return;
  }
  target.control = 'enemy';
  target.enemyPower = Math.max(target.enemyPower, 14 + state.sectorIndex * 5 + (state.crisis.phase === 'collapse' ? 8 : 0));
  appendLog(state, `敌方势力扩张至${target.name}，当地出现战力 ${target.enemyPower} 的守军。`);
}

function advanceCrisis(state: UniverseState): void {
  const previous = state.crisis.phase;
  const forecasting = state.faction.localResearch.includes('crisisForecasting') ? 2 : 0;
  state.crisis.pressure = Math.min(100, state.crisis.pressure + Math.max(3, 5 + state.sectorIndex - forecasting));
  state.crisis.phase = crisisPhaseForTurn(state.turn, state.crisis.finalTurn);
  if (state.crisis.phase !== previous) appendLog(state, `星域危机进入“${CRISIS_PHASE_LABEL[state.crisis.phase]}”。`);
  const expansionInterval = state.crisis.phase === 'foothold' ? 4 : state.crisis.phase === 'contest' ? 3 : 2;
  if (state.turn > 0 && state.turn % expansionInterval === 0) enemyExpansion(state);
  if (state.turn > state.crisis.finalTurn) {
    state.status = 'collapsed';
    appendLog(state, '星域彻底崩溃，远征舰队未能及时撤离。');
  }
}

export function advanceUniverseTurn(state: UniverseState, reason = '战略时间推进'): UniverseState {
  if (state.status !== 'active') return state;
  const next = cloneState(state);
  next.turn++;
  const income = universeTurnIncome(next);
  next.faction.resources.minerals += income.minerals;
  next.faction.resources.energy += income.energy;
  next.faction.resources.science += income.science;
  next.faction.resources.supplies += income.supplies;
  processConstruction(next);
  processResearch(next);
  const base = baseEntity(next);
  if (base && next.fleet.systemId === base.systemId) {
    next.fleet.fuel = Math.min(next.fleet.maxFuel, next.fleet.fuel + 1);
  }
  appendLog(
    next,
    `${reason}；产出 矿物 +${income.minerals} / 能源 +${income.energy} / 科学 +${income.science} / 补给 +${income.supplies}。`
  );
  advanceCrisis(next);
  return next;
}

export function travelFuelCost(state: UniverseState): number {
  const local = state.faction.localResearch.includes('routeAnalysis') ? 1 : 0;
  const legacy = state.faction.legacy.blueprints.includes('fieldLogistics') ? 1 : 0;
  return Math.max(1, 2 - local - legacy);
}

export function canEstablishBase(state: UniverseState, entityId: string): boolean {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  const system = entity ? state.systems.find((candidate) => candidate.id === entity.systemId) : undefined;
  return state.status === 'active' && !state.faction.baseEntityId && !!entity && entity.kind === 'station' &&
    entity.surveyed && entity.systemId === state.fleet.systemId && !entity.ownerId &&
    (system?.enemyPower ?? 0) === 0 && state.faction.resources.minerals >= 10 &&
    state.faction.resources.energy >= 5 && state.faction.resources.supplies >= 4;
}

export function canQueueFacility(state: UniverseState, facilityType: FacilityType): boolean {
  if (state.status !== 'active') return false;
  const base = baseEntity(state);
  if (!base || state.fleet.systemId !== base.systemId) return false;
  const queue = base.constructionQueue ?? [];
  const occupied = (base.facilities?.length ?? 0) + queue.length;
  if (queue.length >= 2 || occupied >= (base.facilitySlots ?? 3)) return false;
  return hasResources(state.faction.resources, effectiveFacilityCost(state, facilityType));
}

export function canQueueResearch(state: UniverseState, projectId: ResearchProjectId): boolean {
  if (state.status !== 'active' || !baseEntity(state)) return false;
  if (state.faction.localResearch.includes(projectId)) return false;
  if (state.faction.researchQueue.some((order) => order.projectId === projectId)) return false;
  if (state.faction.researchQueue.length >= 2) return false;
  return state.faction.resources.science >= RESEARCH_DEFINITIONS[projectId].scienceCost;
}

export function canEngageEnemy(state: UniverseState): boolean {
  const current = state.systems.find((system) => system.id === state.fleet.systemId);
  return state.status === 'active' && !!current && current.enemyPower > 0 && state.fleet.shipCount > 0;
}

export function canRepairFleet(state: UniverseState): boolean {
  const base = baseEntity(state);
  return state.status === 'active' && !!base && state.fleet.systemId === base.systemId &&
    facilityCount(base, 'repairDock') > 0 && state.fleet.disabledShips > 0 &&
    state.faction.resources.supplies >= 5 && state.faction.resources.minerals >= 4;
}

export function canCalibrateGate(state: UniverseState): boolean {
  const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId);
  const system = gate ? state.systems.find((candidate) => candidate.id === gate.systemId) : undefined;
  return state.status === 'active' && !!gate && gate.surveyed && gate.systemId === state.fleet.systemId &&
    (system?.enemyPower ?? 0) === 0 && state.extraction.calibration < state.extraction.requiredCalibration &&
    state.faction.resources.energy >= 6 && state.faction.resources.science >= 2 && state.faction.resources.supplies >= 1;
}

export function canExtractSector(
  state: UniverseState,
  mode: ExtractionMode,
  rearguardShips = 0
): boolean {
  const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId);
  const system = gate ? state.systems.find((candidate) => candidate.id === gate.systemId) : undefined;
  if (
    state.status !== 'active' || !gate || !gate.surveyed || gate.systemId !== state.fleet.systemId ||
    (system?.enemyPower ?? 0) > 0 || rearguardShips < 0 || rearguardShips >= state.fleet.shipCount
  ) return false;
  if (mode === 'stable') {
    return state.extraction.calibration >= state.extraction.requiredCalibration &&
      state.faction.resources.supplies >= 8 && state.fleet.fuel >= 2;
  }
  return state.extraction.calibration >= state.extraction.emergencyThreshold && state.faction.resources.supplies >= 4;
}

function queueConstruction(state: UniverseState, facilityType: FacilityType): UniverseState {
  if (!canQueueFacility(state, facilityType)) return state;
  const next = cloneState(state);
  const definition = FACILITY_DEFINITIONS[facilityType];
  spendResources(next.faction.resources, effectiveFacilityCost(next, facilityType));
  const base = baseEntity(next)!;
  base.constructionQueue = base.constructionQueue ?? [];
  const reduction = next.faction.localResearch.includes('rapidFabrication') ? 1 : 0;
  const turns = Math.max(1, definition.turns - reduction);
  const order: ConstructionOrder = {
    id: `build-${facilityType}-s${next.sectorIndex}-t${next.turn}-${base.constructionQueue.length}`,
    facilityType,
    turnsRemaining: turns,
    totalTurns: turns
  };
  base.constructionQueue.push(order);
  appendLog(next, `加入建造队列：${definition.label}（${turns} 回合）。`);
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
  next.faction.baseEntityId = station.id;
  const system = next.systems.find((candidate) => candidate.id === station.systemId)!;
  system.control = 'player';
  appendLog(next, `占领${station.name}并建立本星域前进基地。`);
  next = advanceUniverseTurn(next, '前进基地部署完成');
  return next;
}

function engageEnemy(state: UniverseState): UniverseState {
  if (!canEngageEnemy(state)) return state;
  let next = cloneState(state);
  const system = next.systems.find((candidate) => candidate.id === next.fleet.systemId)!;
  const enemyBefore = system.enemyPower;
  const inflicted = Math.max(10, Math.floor(next.fleet.combatPower * 0.42));
  const retaliation = Math.max(0, enemyBefore - Math.floor(next.fleet.combatPower * 0.38));
  system.enemyPower = Math.max(0, enemyBefore - inflicted);
  if (retaliation >= 34 && next.fleet.shipCount > 1) {
    next.fleet.shipCount--;
    next.fleet.combatPower = Math.max(20, next.fleet.combatPower - 25);
    next.faction.legacy.shipsLost++;
    if (next.fleet.disabledShips >= next.fleet.shipCount) next.fleet.disabledShips = Math.max(0, next.fleet.shipCount - 1);
    appendLog(next, `在${system.name}与敌军交战，一艘舰船被摧毁。`);
  } else if (retaliation >= 14 && next.fleet.disabledShips < Math.max(0, next.fleet.shipCount - 1)) {
    next.fleet.disabledShips++;
    next.fleet.combatPower = Math.max(20, next.fleet.combatPower - 10);
    appendLog(next, `在${system.name}与敌军交战，一艘舰船失能。`);
  } else {
    appendLog(next, `在${system.name}打击敌军，未出现严重舰损。`);
  }
  if (system.enemyPower === 0) {
    system.control = 'neutral';
    appendLog(next, `${system.name}的敌方战力已被清除。`);
  } else {
    appendLog(next, `${system.name}剩余敌方战力 ${system.enemyPower}。`);
  }
  if (next.fleet.shipCount <= 0) {
    next.status = 'collapsed';
    appendLog(next, '远征舰队全军覆没。');
    return next;
  }
  next = advanceUniverseTurn(next, '战斗行动结束');
  return next;
}

function repairFleet(state: UniverseState): UniverseState {
  if (!canRepairFleet(state)) return state;
  let next = cloneState(state);
  next.faction.resources.supplies -= 5;
  next.faction.resources.minerals -= 4;
  next.fleet.disabledShips--;
  const blueprintBonus = next.faction.legacy.blueprints.includes('hardenedBulkheads') ? next.fleet.shipCount * 4 : 0;
  next.fleet.combatPower = Math.min(next.fleet.shipCount * 32 + blueprintBonus, next.fleet.combatPower + 16);
  appendLog(next, '战地维修坞恢复一艘失能舰。');
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
  return next;
}

function extractSector(state: UniverseState, mode: ExtractionMode, rearguardShips = 0): UniverseState {
  if (!canExtractSector(state, mode, rearguardShips)) return state;
  const next = cloneState(state);
  const hardened = next.faction.legacy.blueprints.includes('hardenedBulkheads');
  const disabledLost = mode === 'emergency' ? next.fleet.disabledShips : 0;
  const pressureLoss = mode === 'emergency' && next.crisis.pressure >= 70 && rearguardShips === 0 && !hardened ? 1 : 0;
  const totalLost = Math.min(next.fleet.shipCount - 1, rearguardShips + disabledLost + pressureLoss);
  const survivingShips = next.fleet.shipCount - totalLost;
  const carriedMaterials = mode === 'stable'
    ? Math.min(30, Math.floor(next.faction.resources.minerals * 0.5))
    : Math.min(12, Math.floor(next.faction.resources.minerals * 0.25));
  const carriedSupplies = mode === 'stable'
    ? Math.min(12, Math.max(0, next.faction.resources.supplies - 8))
    : Math.min(5, Math.max(0, next.faction.resources.supplies - 4));
  const blueprints = Array.from(new Set([
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

  if (next.sectorIndex >= next.targetSectorCount) {
    next.status = 'victory';
    next.fleet.shipCount = survivingShips;
    next.fleet.disabledShips = mode === 'emergency' ? 0 : Math.min(next.fleet.disabledShips, survivingShips - 1);
    next.faction.legacy = legacy;
    appendLog(
      next,
      `${mode === 'stable' ? '稳定' : '紧急'}撤离完成；穿越全部 ${next.targetSectorCount} 个星域，舰船损失 ${totalLost}。`
    );
    return next;
  }

  const nextSeed = hash32(next.seed, next.sectorIndex + 1, next.turn, mode, 'next-sector');
  const generated = generateUniverse(nextSeed, next.faction.name, {
    sectorIndex: next.sectorIndex + 1,
    targetSectorCount: next.targetSectorCount,
    legacy,
    fleet: {
      shipCount: survivingShips,
      disabledShips: mode === 'emergency' ? 0 : Math.min(next.fleet.disabledShips, survivingShips - 1),
      combatPower: Math.max(survivingShips * 20, next.fleet.combatPower - totalLost * 25)
    }
  });
  generated.log.unshift({
    turn: 0,
    text: `${mode === 'stable' ? '稳定撤离' : '紧急突围'}上一星域：留下 ${rearguardShips} 艘断后舰，总损失 ${totalLost}，携带矿物 ${carriedMaterials}、补给 ${carriedSupplies}。`
  });
  return generated;
}

export function applyUniverseAction(state: UniverseState, action: UniverseAction): UniverseState {
  if (action.type === 'selectSystem') {
    if (!state.systems.some((system) => system.id === action.systemId && system.discovered)) return state;
    const next = cloneState(state);
    next.selectedSystemId = action.systemId;
    return next;
  }
  if (action.type === 'queueConstruction') return queueConstruction(state, action.facilityType);
  if (action.type === 'queueResearch') return queueResearch(state, action.projectId);
  if (action.type === 'establishBase') return establishBase(state, action.entityId);
  if (action.type === 'engageEnemy') return engageEnemy(state);
  if (action.type === 'repairFleet') return repairFleet(state);
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
      (system?.enemyPower ?? 0) > 0
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
      (system?.enemyPower ?? 0) > 0 || (entity.deposits?.minerals ?? 0) <= 0 || state.faction.resources.supplies < 1
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

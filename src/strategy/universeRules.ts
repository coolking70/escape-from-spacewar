import type {
  ConstructionOrder,
  FacilityType,
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
  requires?: ResearchProjectId;
}

export interface ResearchDefinition {
  label: string;
  description: string;
  scienceCost: number;
  turns: number;
}

export const FACILITY_DEFINITIONS: Record<FacilityType, FacilityDefinition> = {
  solarArray: {
    label: '轨道太阳能阵列',
    description: '每回合增加能源产出。',
    cost: { minerals: 15 },
    turns: 2
  },
  miningArray: {
    label: '自动采矿阵列',
    description: '每回合增加矿物产出。',
    cost: { minerals: 20, energy: 8 },
    turns: 3
  },
  researchLab: {
    label: '轨道研究实验室',
    description: '每回合产生科学，并提高长期研究能力。',
    cost: { minerals: 20, energy: 12 },
    turns: 3
  },
  shipyard: {
    label: '轻型轨道船坞',
    description: '为下一阶段的舰船制造和多舰队系统提供基础。',
    cost: { minerals: 35, energy: 20 },
    turns: 4,
    requires: 'orbitalEngineering'
  }
};

export const RESEARCH_DEFINITIONS: Record<ResearchProjectId, ResearchDefinition> = {
  stellarCartography: {
    label: '恒星测绘学',
    description: '战略舰队沿航线移动时燃料消耗降低 1。',
    scienceCost: 10,
    turns: 3
  },
  automatedIndustry: {
    label: '自动化工业',
    description: '每座产出设施额外提供 1 点对应资源。',
    scienceCost: 16,
    turns: 4
  },
  orbitalEngineering: {
    label: '轨道工程学',
    description: '解锁轻型轨道船坞。',
    scienceCost: 22,
    turns: 5
  }
};

function cloneState(state: UniverseState): UniverseState {
  return JSON.parse(JSON.stringify(state)) as UniverseState;
}

function baseEntity(state: UniverseState): SpaceEntity {
  const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId);
  if (!base) throw new Error('战略基地不存在。');
  return base;
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

function appendLog(state: UniverseState, text: string): void {
  state.log.push({ turn: state.turn, text });
  if (state.log.length > 160) state.log = state.log.slice(-160);
}

function facilityCount(base: SpaceEntity, type: FacilityType): number {
  return (base.facilities ?? []).filter((facility) => facility.type === type).length;
}

export function universeTurnIncome(state: UniverseState): StrategicResources {
  const base = baseEntity(state);
  const automation = state.faction.researched.includes('automatedIndustry') ? 1 : 0;
  return {
    minerals: 2 + facilityCount(base, 'miningArray') * (4 + automation),
    energy: 2 + facilityCount(base, 'solarArray') * (4 + automation),
    science: facilityCount(base, 'researchLab') * (2 + automation)
  };
}

function processConstruction(state: UniverseState): void {
  const base = baseEntity(state);
  const queue = base.constructionQueue ?? [];
  if (!queue.length) return;
  queue[0].turnsRemaining--;
  if (queue[0].turnsRemaining > 0) return;
  const completed = queue.shift()!;
  base.facilities = base.facilities ?? [];
  base.facilities.push({
    id: `${base.id}-${completed.facilityType}-${state.turn}`,
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
  if (!state.faction.researched.includes(completed.projectId)) state.faction.researched.push(completed.projectId);
  appendLog(state, `研究完成：${RESEARCH_DEFINITIONS[completed.projectId].label}。`);
}

export function advanceUniverseTurn(state: UniverseState, reason = '战略时间推进'): UniverseState {
  if (state.status !== 'active') return state;
  const next = cloneState(state);
  next.turn++;
  const income = universeTurnIncome(next);
  next.faction.resources.minerals += income.minerals;
  next.faction.resources.energy += income.energy;
  next.faction.resources.science += income.science;
  processConstruction(next);
  processResearch(next);
  if (next.fleet.systemId === baseEntity(next).systemId) next.fleet.fuel = Math.min(next.fleet.maxFuel, next.fleet.fuel + 1);
  appendLog(next, `${reason}；产出 矿物 +${income.minerals} / 能源 +${income.energy} / 科学 +${income.science}。`);
  return next;
}

export function travelFuelCost(state: UniverseState): number {
  return state.faction.researched.includes('stellarCartography') ? 1 : 2;
}

export function canQueueFacility(state: UniverseState, facilityType: FacilityType): boolean {
  if (state.status !== 'active') return false;
  const definition = FACILITY_DEFINITIONS[facilityType];
  const base = baseEntity(state);
  const queue = base.constructionQueue ?? [];
  if (queue.length >= 2) return false;
  if (definition.requires && !state.faction.researched.includes(definition.requires)) return false;
  return hasResources(state.faction.resources, definition.cost);
}

export function canQueueResearch(state: UniverseState, projectId: ResearchProjectId): boolean {
  if (state.status !== 'active') return false;
  if (state.faction.researched.includes(projectId)) return false;
  if (state.faction.researchQueue.some((order) => order.projectId === projectId)) return false;
  if (state.faction.researchQueue.length >= 2) return false;
  return state.faction.resources.science >= RESEARCH_DEFINITIONS[projectId].scienceCost;
}

function queueConstruction(state: UniverseState, facilityType: FacilityType): UniverseState {
  if (!canQueueFacility(state, facilityType)) return state;
  const next = cloneState(state);
  const definition = FACILITY_DEFINITIONS[facilityType];
  spendResources(next.faction.resources, definition.cost);
  const base = baseEntity(next);
  base.constructionQueue = base.constructionQueue ?? [];
  const order: ConstructionOrder = {
    id: `build-${facilityType}-${next.turn}-${base.constructionQueue.length}`,
    facilityType,
    turnsRemaining: definition.turns,
    totalTurns: definition.turns
  };
  base.constructionQueue.push(order);
  appendLog(next, `加入建造队列：${definition.label}（${definition.turns} 回合）。`);
  return next;
}

function queueResearch(state: UniverseState, projectId: ResearchProjectId): UniverseState {
  if (!canQueueResearch(state, projectId)) return state;
  const next = cloneState(state);
  const definition = RESEARCH_DEFINITIONS[projectId];
  next.faction.resources.science -= definition.scienceCost;
  next.faction.researchQueue.push({
    id: `research-${projectId}-${next.turn}`,
    projectId,
    turnsRemaining: definition.turns,
    totalTurns: definition.turns
  });
  appendLog(next, `开始研究：${definition.label}（${definition.turns} 回合）。`);
  return next;
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
    if (!next.faction.knownSystemIds.includes(reached.id)) next.faction.knownSystemIds.push(reached.id);
    for (const neighborId of reached.neighbors) {
      const neighbor = next.systems.find((system) => system.id === neighborId)!;
      neighbor.discovered = true;
      if (!next.faction.knownSystemIds.includes(neighbor.id)) next.faction.knownSystemIds.push(neighbor.id);
    }
    for (const entity of next.entities.filter((candidate) => candidate.systemId === reached.id)) entity.discovered = true;
    appendLog(next, `${next.fleet.name}抵达${reached.name}，消耗燃料 ${cost}。`);
    next = advanceUniverseTurn(next, '完成星际航行');
    return next;
  }

  if (action.type === 'surveyEntity') {
    const entity = state.entities.find((candidate) => candidate.id === action.entityId);
    if (!entity || !entity.discovered || entity.surveyed || entity.systemId !== state.fleet.systemId) return state;
    let next = cloneState(state);
    const target = next.entities.find((candidate) => candidate.id === entity.id)!;
    target.surveyed = true;
    next.faction.resources.science += 3;
    appendLog(next, `完成${target.name}测绘，科学 +3。`);
    next = advanceUniverseTurn(next, '实体测绘完成');
    return next;
  }

  if (action.type === 'extractAsteroid') {
    const entity = state.entities.find((candidate) => candidate.id === action.entityId);
    if (
      !entity || entity.kind !== 'asteroidField' || !entity.surveyed ||
      entity.systemId !== state.fleet.systemId || (entity.deposits?.minerals ?? 0) <= 0
    ) return state;
    let next = cloneState(state);
    const target = next.entities.find((candidate) => candidate.id === entity.id)!;
    const extracted = Math.min(8, target.deposits?.minerals ?? 0);
    target.deposits!.minerals -= extracted;
    next.faction.resources.minerals += extracted;
    appendLog(next, `从${target.name}开采矿物 ${extracted}，剩余储量 ${target.deposits!.minerals}。`);
    next = advanceUniverseTurn(next, '采矿作业完成');
    return next;
  }

  return state;
}

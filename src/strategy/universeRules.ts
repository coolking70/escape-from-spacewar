import { generateUniverse, hash32 } from './universeGenerator';
import { campaignFleetPower, campaignShipCost } from '../campaign/fleet/campaignPower';
import { PersistentFleet, PersistentShip } from '../campaign/fleet/persistentFleet';
import { importBattleResult } from '../campaign/fleet/battleResultImporter';
import { PersistentBattleBinding, strategicEnemyFleetFor } from '../campaign/fleet/battleAdapter';
import { getShipDef, SHIP_CN, VARIANT_CN } from '../sim/shipVariants';
import type { BattleState } from '../sim/battleTypes';
import type {
  ConstructionOrder,
  CrisisPhase,
  ExtractionMode,
  FacilityType,
  PendingStrategicBattle,
  PermanentBlueprintId,
  ResearchProjectId,
  SpaceEntity,
  StrategicFleet,
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
    else operational++;
    if (ship.towed) towed++;
  }
  return { total: fleet.ships.length, operational, disabled, escaped, towed };
}

/** 动态计算的真实舰队战力。 */
export function strategicFleetPower(state: UniverseState): number {
  return campaignFleetPower(toPersistentFleet(state.fleet));
}

// ---------------- 战略战斗回写辅助 ----------------

/** 敌方剩余战力：仅由真实 Team B 结果计算（destroyed/disabled 不贡献，escaped/operational 按成本×组件完整度）。 */
function enemyRemainingPower(battle: BattleState): number {
  let total = 0;
  for (const ship of battle.ships.filter((candidate) => candidate.team === 'B')) {
    if (ship.combatState === 'destroyed' || ship.combatState === 'disabled') continue;
    const cost = campaignShipCost(ship.type, ship.variant);
    const max = ship.components.reduce((sum, component) => sum + component.maxHp, 0);
    const current = ship.components.reduce((sum, component) => sum + Math.max(0, Math.min(component.maxHp, component.hp)), 0);
    const integrity = max > 0 ? current / max : 0;
    total += cost * integrity;
  }
  return Math.max(0, Math.round(total));
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
    const counts = strategicFleetCounts(state.fleet);
    if (supplyLoss >= 5 && counts.disabled < counts.operational) {
      const target = state.fleet.ships
        .filter((ship) => !ship.disabled)
        .sort((a, b) => a.campaignShipId.localeCompare(b.campaignShipId))
        .pop();
      if (target) target.disabled = true;
    }
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
  return state.status === 'active' && !!current && current.enemyPower > 0 && strategicFleetCounts(state.fleet).operational > 0;
}

export function canRepairFleet(state: UniverseState): boolean {
  return state.fleet.ships.some((ship) => canRepairShip(state, ship.campaignShipId));
}

export function canRepairShip(state: UniverseState, campaignShipId: string): boolean {
  const base = baseEntity(state);
  const ship = state.fleet.ships.find((candidate) => candidate.campaignShipId === campaignShipId);
  return state.status === 'active' && !!base && state.fleet.systemId === base.systemId &&
    facilityCount(base, 'repairDock') > 0 && !!ship && ship.disabled &&
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
    (system?.enemyPower ?? 0) > 0 || rearguardShips < 0 || rearguardShips >= strategicFleetCounts(state.fleet).operational
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
  // 幂等：已存在待处理战斗时保持原有 seed 与敌军，不重新抽取（刷新 / 重读 / 重复点击均不重抽）。
  if (state.pendingBattle) return state;
  let next = cloneState(state);
  const system = next.systems.find((candidate) => candidate.id === next.fleet.systemId)!;
  const gateSystem = next.entities.find((entity) => entity.id === next.extraction.gateEntityId);
  const isGate = gateSystem ? system.id === gateSystem.systemId : false;
  const seed = hash32(next.seed, next.sectorIndex, next.turn, system.id, 'strategic-battle') >>> 0;
  const cruiserAllowed = next.sectorIndex >= 2 || isGate;
  const enemyFleet = strategicEnemyFleetFor(seed, system.enemyPower, {
    sectorIndex: next.sectorIndex,
    gateGuard: isGate,
    cruiserAllowed
  });
  const pending: PendingStrategicBattle = {
    battleId: `sb-${next.seed}-${next.sectorIndex}-${system.id}-${next.turn}`,
    systemId: system.id,
    battleSeed: seed,
    enemyPowerBefore: system.enemyPower,
    enemyFleet
  };
  next.pendingBattle = pending;
  appendLog(
    next,
    `在${system.name}锁定敌军（战力 ${system.enemyPower}），已生成待处理战斗（battleId ${pending.battleId}）。点击“继续战斗”进入真实 core-v4 作战。`
  );
  return next;
}

/** 逐舰维修：优先恢复被摧毁的 core/engine/weapon 关键组件；否则维修缺口最大的组件；关键系统恢复后解除 disabled。 */
function repairShipComponents(ship: PersistentShip): void {
  const { def } = getShipDef(ship.shipClass, ship.variant);
  if (!ship.componentHp) ship.componentHp = def.components.map((component) => component.maxHp);
  const keyTypes = new Set(['core', 'engine', 'weapon']);
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
  const keyAlive = ['core', 'engine', 'weapon'].every((type) => {
    const index = def.components.findIndex((component) => component.type === type);
    return index >= 0 && (ship.componentHp?.[index] ?? 0) > 0;
  });
  if (keyAlive) ship.disabled = false;
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
  return next;
}

/** 确定性选择撤离损失舰船：稳定撤离只损失断后舰（保留失能舰）；紧急撤离先舍弃失能舰，再按稳定 ID 顺序损失断后舰与高压额外舰。 */
function selectExtractLosses(fleet: StrategicFleet, mode: ExtractionMode, rearguard: number, extraLoss: number): string[] {
  const operational = fleet.ships
    .filter((ship) => !ship.disabled)
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
  return lost;
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
    fleet: inherited
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

/**
 * 将一次完成的真实 core-v4 战略战斗结果写回战略状态。
 * 幂等：若已无待处理战斗 / 状态非 active / 战斗未结束，直接返回原状态（结果只应用一次）。
 * - 玩家舰：destroyed 永久删除；disabled/escaped/operational 保留组件 HP；未参战舰不变。
 * - 敌方剩余战力：仅由真实 Team B 结果重算（destroyed/disabled 不贡献，escaped/operational 按成本×完整度）。
 * - 仅推进一个战略回合；清零则星系恢复 neutral，否则保持 enemy。
 */
export function applyStrategicBattleResult(
  state: UniverseState,
  battle: BattleState,
  bindings: ReadonlyArray<PersistentBattleBinding>
): UniverseState {
  if (!state.pendingBattle || state.status !== 'active' || !battle.finished) return state;
  const next = cloneState(state);
  const pending = next.pendingBattle!;
  const system = next.systems.find((candidate) => candidate.id === pending.systemId);
  if (!system) return state;

  const persistentFleet = toPersistentFleet(next.fleet);
  const ownBefore = persistentFleet.ships.length;
  const updatedFleet = importBattleResult(persistentFleet, battle, bindings);
  next.fleet.ships = updatedFleet.ships.map((ship) => ({ ...ship, componentHp: ship.componentHp ? [...ship.componentHp] : undefined }));
  const shipsLost = Math.max(0, ownBefore - next.fleet.ships.length);

  const enemyRemaining = enemyRemainingPower(battle);
  system.enemyPower = enemyRemaining;
  system.control = enemyRemaining === 0 ? 'neutral' : 'enemy';

  const destroyedIds = teamACombatIds(battle, bindings, 'destroyed');
  const disabledIds = teamACombatIds(battle, bindings, 'disabled');
  const escapedIds = teamACombatIds(battle, bindings, 'escaped');
  next.faction.legacy.shipsLost += shipsLost;
  appendLog(
    next,
    `战斗结束于${system.name}（battleId ${pending.battleId} / seed ${pending.battleSeed}）：` +
      `玩家损毁 [${destroyedIds.join(', ')}]，失能 [${disabledIds.join(', ')}]，逃脱 [${escapedIds.join(', ')}]；` +
      `敌方战力 ${pending.enemyPowerBefore} → ${system.enemyPower}${system.enemyPower === 0 ? '；星系已清除' : ''}。`
  );

  next.pendingBattle = undefined;

  // 玩家无任何可作战舰船 → 失败（不清除敌方据点）。
  if (strategicFleetCounts(next.fleet).operational <= 0) {
    next.status = 'collapsed';
    appendLog(next, '远征舰队已无可用作战舰船。');
    return next;
  }

  return advanceUniverseTurn(next, '战斗行动结束');
}

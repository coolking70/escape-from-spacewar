import type { PersistentFleet } from '../campaign/fleet/persistentFleet';
import type { DeploymentSelection } from '../campaign/deployment/deploymentSystem';
import type { FleetEntry } from '../sim/battleTypes';
import type { CampaignCommander, PendingRecruitment } from '../campaign/campaignTypes';

/** 当前 Sector Expedition Code 版本。V1.0-D.4 升级为 1.0-alpha.13，加入逐舰战略模块装配。 */
export const SECTOR_EXPEDITION_VERSION = '1.0-alpha.13';
export type SectorExpeditionVersion = '1.0-alpha.13';

export type StarType = 'yellowDwarf' | 'redDwarf' | 'blueGiant' | 'whiteDwarf' | 'binary';
export type SpaceEntityKind = 'planet' | 'moon' | 'station' | 'asteroidField' | 'relicSite' | 'jumpGate';
export type FacilityType = 'solarArray' | 'miningArray' | 'researchLab' | 'supplyWorks' | 'repairDock' | 'defenseGrid' | 'shipyard';
export type ResearchProjectId = 'routeAnalysis' | 'rapidFabrication' | 'crisisForecasting' | 'gateTheory';
export type PermanentBlueprintId = 'fieldLogistics' | 'hardenedBulkheads' | 'compactFoundry';
export type StrategicModuleId = 'auxiliaryTank' | 'surveyArray' | 'fieldWorkshop';

export interface StrategicShipFitting {
  campaignShipId: string;
  moduleId: StrategicModuleId;
}
export type CrisisPhase = 'foothold' | 'contest' | 'collapse' | 'evacuation';
export type SystemControl = 'unknown' | 'neutral' | 'player' | 'enemy';
export type ExtractionMode = 'stable' | 'emergency';
export type ExtractionAssignmentRole = 'evacuate' | 'tow' | 'rearguard' | 'abandon';

export interface ExtractionAssignment {
  campaignShipId: string;
  role: ExtractionAssignmentRole;
}

/** 可保存的逐舰撤离清单；每艘当前舰船必须且只能出现一次。 */
export interface StrategicExtractionManifest {
  mode: ExtractionMode;
  assignments: ExtractionAssignment[];
}

export interface StrategicResources {
  minerals: number;
  energy: number;
  science: number;
  supplies: number;
}

export interface FacilityInstance {
  id: string;
  type: FacilityType;
  level: number;
}

export interface ConstructionOrder {
  id: string;
  facilityType: FacilityType;
  turnsRemaining: number;
  totalTurns: number;
}

/** 主基地船坞中的确定性生产订单；campaignShipId 在入队时分配，完成后永不变化。 */
export interface ShipProductionOrder {
  id: string;
  campaignShipId: string;
  shipClass: FleetEntry['shipClass'];
  variant: FleetEntry['variant'];
  turnsRemaining: number;
  totalTurns: number;
}

export interface ResearchOrder {
  id: string;
  projectId: ResearchProjectId;
  turnsRemaining: number;
  totalTurns: number;
}

/**
 * 一个次级据点到唯一主基地的固定抽象运输链。
 * 路径仅允许使用建立当时已经发现且逐段相邻的星系；畅通/中断由当前控制权动态计算，避免保存陈旧状态。
 */
export interface StrategicTransportLink {
  id: string;
  outpostEntityId: string;
  hubEntityId: string;
  pathSystemIds: string[];
}

export type StrategicEnemyTaskForceRole = 'raider' | 'gateDefense';

/** 按战略回合沿星系航线移动的敌方舰队；power 使用 core-v4 舰船成本量纲。 */
export interface StrategicEnemyTaskForce {
  id: string;
  systemId: string;
  power: number;
  role: StrategicEnemyTaskForceRole;
  spawnedTurn: number;
}

/** 敌方特遣舰队抵达我方据点后形成的持久围攻倒计时。 */
export interface StrategicSiege {
  id: string;
  taskForceId: string;
  stationEntityId: string;
  turnsRemaining: number;
  totalTurns: number;
}

export interface SpaceEntity {
  id: string;
  systemId: string;
  kind: SpaceEntityKind;
  name: string;
  orbit: number;
  discovered: boolean;
  surveyed: boolean;
  ownerId?: string;
  habitability?: number;
  deposits?: {
    minerals: number;
    energy: number;
  };
  facilitySlots?: number;
  facilities?: FacilityInstance[];
  constructionQueue?: ConstructionOrder[];
  shipProductionQueue?: ShipProductionOrder[];
  blueprint?: PermanentBlueprintId;
}

export interface StarSystem {
  id: string;
  name: string;
  x: number;
  y: number;
  starType: StarType;
  entityIds: string[];
  neighbors: string[];
  discovered: boolean;
  surveyed: boolean;
  control: SystemControl;
  enemyPower: number;
}

/**
 * 真实逐舰战略舰队。
 * 不再保存 shipCount / disabledShips / combatPower 等易与舰船数组失同步的抽象计数字段；
 * 舰船数量、失能数量与总战力全部由 `ships`（与战役 PersistentShip 同构）动态计算。
 * ships / formation / doctrine 与 PersistentFleet 结构兼容，可直接转换。
 */
export interface StrategicFleet {
  id: string;
  name: string;
  systemId: string;
  fuel: number;
  maxFuel: number;
  ships: PersistentFleet['ships'];
  formation: PersistentFleet['formation'];
  doctrine: PersistentFleet['doctrine'];
  fittings: StrategicShipFitting[];
}

/**
 * 一次待处理战略战斗。点击攻击时由 applyUniverseAction 生成并持久化；
 * 刷新页面 / 重新读取存档 / 重复点击"继续战斗"都不会重新抽取敌军。
 */
export interface PendingStrategicBattle {
  battleId: string;
  systemId: string;
  battleSeed: number;
  enemyPowerBefore: number;
  enemyFleet: FleetEntry[];
  source: 'garrison' | 'taskForce' | 'gateDefense';
  taskForceId?: string;
  deployment?: DeploymentSelection;
}

export interface SectorLegacy {
  sectorsCleared: number;
  portableMaterials: number;
  reserveSupplies: number;
  blueprints: PermanentBlueprintId[];
  shipsLost: number;
}

export interface StrategicFaction {
  id: string;
  name: string;
  resources: StrategicResources;
  localResearch: ResearchProjectId[];
  researchQueue: ResearchOrder[];
  knownSystemIds: string[];
  baseEntityId?: string;
  recoveredBlueprints: PermanentBlueprintId[];
  legacy: SectorLegacy;
}

export interface CrisisState {
  phase: CrisisPhase;
  pressure: number;
  finalTurn: number;
}

export interface ExtractionState {
  gateEntityId: string;
  discovered: boolean;
  calibration: number;
  requiredCalibration: number;
  emergencyThreshold: number;
  gateDefense: 'dormant' | 'pending' | 'resolved';
  manifest?: StrategicExtractionManifest;
}

export type UniverseStatus = 'active' | 'victory' | 'collapsed';

export interface UniverseLogEntry {
  turn: number;
  text: string;
}

/**
 * The historical name is kept at the API boundary so App wiring and saved-mode
 * separation remain stable. The state itself now represents one complete,
 * temporary strategic sector rather than a permanent galaxy.
 */
export interface UniverseState {
  version: SectorExpeditionVersion;
  seed: number;
  sectorIndex: number;
  targetSectorCount: number;
  turn: number;
  status: UniverseStatus;
  systems: StarSystem[];
  entities: SpaceEntity[];
  faction: StrategicFaction;
  commander: CampaignCommander;
  reserveCommanders: CampaignCommander[];
  pendingRecruitment?: PendingRecruitment;
  recruitmentUsedThisSector: boolean;
  pendingSuccession: boolean;
  transportLinks: StrategicTransportLink[];
  enemyTaskForces: StrategicEnemyTaskForce[];
  sieges: StrategicSiege[];
  fleet: StrategicFleet;
  crisis: CrisisState;
  extraction: ExtractionState;
  selectedSystemId: string;
  pendingBattle?: PendingStrategicBattle;
  log: UniverseLogEntry[];
}

export type UniverseAction =
  | { type: 'selectSystem'; systemId: string }
  | { type: 'travel'; systemId: string }
  | { type: 'surveyEntity'; entityId: string }
  | { type: 'extractAsteroid'; entityId: string }
  | { type: 'establishBase'; entityId: string }
  | { type: 'establishOutpost'; entityId: string }
  | { type: 'queueConstruction'; facilityType: FacilityType; entityId?: string }
  | { type: 'queueShipProduction'; shipClass: FleetEntry['shipClass']; variant: FleetEntry['variant'] }
  | { type: 'queueResearch'; projectId: ResearchProjectId }
  | { type: 'engageEnemy' }
  | { type: 'openRecruitment' }
  | { type: 'resolveRecruitment'; candidateId?: string }
  | { type: 'treatCommander' }
  | { type: 'appointCommander'; commanderId: string }
  | { type: 'repairShip'; campaignShipId: string }
  | { type: 'calibrateGate' }
  | { type: 'configureExtraction'; mode: ExtractionMode }
  | { type: 'assignExtractionShip'; campaignShipId: string; role: ExtractionAssignmentRole }
  | { type: 'fitStrategicModule'; campaignShipId: string; moduleId: StrategicModuleId }
  | { type: 'removeStrategicModule'; campaignShipId: string }
  | { type: 'extractSector'; mode: ExtractionMode; rearguardShips?: number }
  | { type: 'advanceTurn' };

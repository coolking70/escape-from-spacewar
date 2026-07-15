import type { PersistentFleet } from '../campaign/fleet/persistentFleet';
import type { DeploymentSelection } from '../campaign/deployment/deploymentSystem';
import type { FleetEntry } from '../sim/battleTypes';
import type { CampaignCommander } from '../campaign/campaignTypes';

/** 当前 Sector Expedition Code 版本。V1.0-C.1 升级为 1.0-alpha.6，加入复用 V0.8 模型的指挥官状态。 */
export const SECTOR_EXPEDITION_VERSION = '1.0-alpha.6';
export type SectorExpeditionVersion = '1.0-alpha.6';

export type StarType = 'yellowDwarf' | 'redDwarf' | 'blueGiant' | 'whiteDwarf' | 'binary';
export type SpaceEntityKind = 'planet' | 'moon' | 'station' | 'asteroidField' | 'relicSite' | 'jumpGate';
export type FacilityType = 'solarArray' | 'miningArray' | 'researchLab' | 'supplyWorks' | 'repairDock' | 'defenseGrid';
export type ResearchProjectId = 'routeAnalysis' | 'rapidFabrication' | 'crisisForecasting' | 'gateTheory';
export type PermanentBlueprintId = 'fieldLogistics' | 'hardenedBulkheads' | 'compactFoundry';
export type CrisisPhase = 'foothold' | 'contest' | 'collapse' | 'evacuation';
export type SystemControl = 'unknown' | 'neutral' | 'player' | 'enemy';
export type ExtractionMode = 'stable' | 'emergency';

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

export interface ResearchOrder {
  id: string;
  projectId: ResearchProjectId;
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
  pendingSuccession: boolean;
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
  | { type: 'queueConstruction'; facilityType: FacilityType }
  | { type: 'queueResearch'; projectId: ResearchProjectId }
  | { type: 'engageEnemy' }
  | { type: 'repairShip'; campaignShipId: string }
  | { type: 'calibrateGate' }
  | { type: 'extractSector'; mode: ExtractionMode; rearguardShips?: number }
  | { type: 'advanceTurn' };

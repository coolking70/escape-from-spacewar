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

export interface StrategicFleet {
  id: string;
  name: string;
  systemId: string;
  fuel: number;
  maxFuel: number;
  shipCount: number;
  disabledShips: number;
  combatPower: number;
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
  version: '1.0-alpha.2';
  seed: number;
  sectorIndex: number;
  targetSectorCount: number;
  turn: number;
  status: UniverseStatus;
  systems: StarSystem[];
  entities: SpaceEntity[];
  faction: StrategicFaction;
  fleet: StrategicFleet;
  crisis: CrisisState;
  extraction: ExtractionState;
  selectedSystemId: string;
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
  | { type: 'repairFleet' }
  | { type: 'calibrateGate' }
  | { type: 'extractSector'; mode: ExtractionMode; rearguardShips?: number }
  | { type: 'advanceTurn' };

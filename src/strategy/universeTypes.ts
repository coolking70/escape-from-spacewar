export type StarType = 'yellowDwarf' | 'redDwarf' | 'blueGiant' | 'whiteDwarf' | 'binary';
export type SpaceEntityKind = 'planet' | 'moon' | 'station' | 'asteroidField' | 'jumpGate';
export type FacilityType = 'solarArray' | 'miningArray' | 'researchLab' | 'shipyard';
export type ResearchProjectId = 'stellarCartography' | 'automatedIndustry' | 'orbitalEngineering';

export interface StrategicResources {
  minerals: number;
  energy: number;
  science: number;
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
  facilities?: FacilityInstance[];
  constructionQueue?: ConstructionOrder[];
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
}

export interface StrategicFleet {
  id: string;
  name: string;
  systemId: string;
  fuel: number;
  maxFuel: number;
}

export interface StrategicFaction {
  id: string;
  name: string;
  resources: StrategicResources;
  researched: ResearchProjectId[];
  researchQueue: ResearchOrder[];
  knownSystemIds: string[];
  baseEntityId: string;
}

export type UniverseStatus = 'active' | 'collapsed';

export interface UniverseLogEntry {
  turn: number;
  text: string;
}

export interface UniverseState {
  version: '1.0-alpha.1';
  seed: number;
  turn: number;
  status: UniverseStatus;
  systems: StarSystem[];
  entities: SpaceEntity[];
  faction: StrategicFaction;
  fleet: StrategicFleet;
  selectedSystemId: string;
  log: UniverseLogEntry[];
}

export type UniverseAction =
  | { type: 'selectSystem'; systemId: string }
  | { type: 'travel'; systemId: string }
  | { type: 'surveyEntity'; entityId: string }
  | { type: 'extractAsteroid'; entityId: string }
  | { type: 'queueConstruction'; facilityType: FacilityType }
  | { type: 'queueResearch'; projectId: ResearchProjectId }
  | { type: 'advanceTurn' };

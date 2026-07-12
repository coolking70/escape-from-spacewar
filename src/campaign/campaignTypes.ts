import type { CampaignCargo, CargoItemType } from './cargo/cargoTypes';
import type { DeploymentSelection } from './deployment/deploymentSystem';
import type { ExtractionMode, ExtractionRisk } from './extraction/extractionSystem';
import type { PersistentFleet } from './fleet/persistentFleet';
import type { PendingSalvage, SalvageOptionId } from './salvage/salvageTypes';
import type { SectorState } from './sector/sectorTypes';

export interface CampaignCommander {
  id: string;
  name: string;
  level: number;
  experience: number;
  alive: boolean;
}

export interface CampaignResources {
  supplies: number;
  fuel: number;
  materials: number;
}

export interface CampaignHistoryEntry {
  turn: number;
  text: string;
  nodeId?: string;
}

export type CampaignStatus = 'active' | 'victory' | 'defeat';

export interface PendingBattle {
  nodeId: string;
  battleIndex: number;
  reason: string;
  deployment?: DeploymentSelection;
}

export interface SectorSummary {
  sectorIndex: number;
  turns: number;
  visitedNodes: number;
  totalNodes: number;
  shipsRemaining: number;
  disabledShips: number;
  cargoUsed: number;
  cargoCapacity: number;
  threatLevel: number;
  extractionMode: ExtractionMode;
  extractionRisk: ExtractionRisk;
  jettisonedUnits: number;
  damagedInJump: string[];
}

export interface CampaignState {
  version: '0.2';
  campaignSeed: number;
  sectorIndex: number;
  turn: number;
  status: CampaignStatus;
  commander: CampaignCommander;
  fleet: PersistentFleet;
  resources: CampaignResources;
  cargo: CampaignCargo;
  sector: SectorState;
  history: CampaignHistoryEntry[];
  pendingBattle?: PendingBattle;
  pendingSalvage?: PendingSalvage;
  extractionPrepared?: boolean;
  lastSectorSummary?: SectorSummary;
}

export type CampaignAction =
  | { type: 'move'; targetNodeId: string }
  | { type: 'scan' }
  | { type: 'gather' }
  | { type: 'resolveSignal'; optionId: string }
  | { type: 'resolveSalvage'; optionId: SalvageOptionId }
  | { type: 'useCargo'; itemType: CargoItemType }
  | { type: 'jettisonCargo'; itemType: CargoItemType; quantity?: number }
  | { type: 'fieldRepair'; campaignShipId: string }
  | { type: 'towShip'; campaignShipId: string }
  | { type: 'dismantleShip'; campaignShipId: string }
  | { type: 'abandonShip'; campaignShipId: string }
  | { type: 'toggleDeployment'; campaignShipId: string }
  | { type: 'prepareExtraction' }
  | { type: 'enterGate'; mode?: ExtractionMode }
  | { type: 'wait' };

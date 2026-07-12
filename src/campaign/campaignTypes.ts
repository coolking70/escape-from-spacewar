import { CampaignCargo, CargoItemType } from './cargo/cargoTypes';
import { PersistentFleet } from './fleet/persistentFleet';
import { PendingSalvage, SalvageOptionId } from './salvage/salvageTypes';
import { SectorState } from './sector/sectorTypes';

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
}

export type CampaignAction =
  | { type: 'move'; targetNodeId: string }
  | { type: 'scan' }
  | { type: 'gather' }
  | { type: 'resolveSignal'; optionId: string }
  | { type: 'resolveSalvage'; optionId: SalvageOptionId }
  | { type: 'useCargo'; itemType: CargoItemType }
  | { type: 'fieldRepair'; campaignShipId: string }
  | { type: 'towShip'; campaignShipId: string }
  | { type: 'dismantleShip'; campaignShipId: string }
  | { type: 'abandonShip'; campaignShipId: string }
  | { type: 'enterGate' }
  | { type: 'wait' };

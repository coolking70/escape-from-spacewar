import { PersistentFleet } from './fleet/persistentFleet';
import { SectorState } from './sector/sectorTypes';

export interface CampaignCommander { id: string; name: string; level: number; experience: number; alive: boolean; }
export interface CampaignResources { supplies: number; fuel: number; materials: number; }
export interface CampaignHistoryEntry { turn: number; text: string; nodeId?: string; }
export type CampaignStatus = 'active' | 'victory' | 'defeat';
export interface PendingBattle { nodeId: string; battleIndex: number; reason: string; }
export interface CampaignState {
  version: '0.1'; campaignSeed: number; sectorIndex: number; turn: number; status: CampaignStatus;
  commander: CampaignCommander; fleet: PersistentFleet; resources: CampaignResources;
  sector: SectorState; history: CampaignHistoryEntry[]; pendingBattle?: PendingBattle;
}
export type CampaignAction =
  | { type: 'move'; targetNodeId: string } | { type: 'scan' } | { type: 'gather' }
  | { type: 'resolveSignal'; optionId: string } | { type: 'enterGate' } | { type: 'wait' };

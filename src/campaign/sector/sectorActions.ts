import { CampaignState } from '../campaignTypes';
import { hash32 } from './sectorGenerator';
export function resourceReward(state: CampaignState, nodeId: string) { const r = hash32(state.campaignSeed, state.sectorIndex, nodeId, 'resource'); return { supplies: 1 + r % 4, fuel: 1 + ((r >>> 4) % 3), materials: 1 + ((r >>> 8) % 3) }; }
export function signalOutcome(state: CampaignState, nodeId: string, optionId: string) { const r = hash32(state.campaignSeed, state.sectorIndex, nodeId, optionId); return { supplies: (r % 5) - 1, fuel: ((r >>> 3) % 4) - 1, materials: (r >>> 7) % 3, threat: 1 + ((r >>> 11) % 3), battle: optionId === 'investigate' && r % 3 === 0, gateClue: r % 2 === 0 }; }

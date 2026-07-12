import { hash32 } from '../sector/sectorGenerator';
import type { CampaignCommander, CampaignState, PendingRecruitment } from '../campaignTypes';
import type { CommanderFocus } from './commanderTypes';
import { createCommanderWithId } from './commanderSystem';

const NAMES = ['林澈', '阿斯特拉', '周衡', '维拉', '伊森', '诺瓦', '沈岚', '卡西娅', '韩舟', '莱娅'];
const FOCUSES: CommanderFocus[] = ['balanced', 'tactician', 'quartermaster', 'scout', 'survivor'];

export const MAX_RESERVE_COMMANDERS = 3;

function candidateSeed(state: CampaignState, nodeId: string, index: number): number {
  return hash32(state.campaignSeed, state.sectorIndex, nodeId, index, 'commander-recruit');
}

export function generateRecruitmentOffer(state: CampaignState, nodeId: string): PendingRecruitment {
  const used = new Set([state.commander.id, ...(state.reserveCommanders ?? []).map((commander) => commander.id)]);
  const candidates: CampaignCommander[] = [];
  for (let index = 0; candidates.length < 2 && index < 8; index++) {
    const seed = candidateSeed(state, nodeId, index);
    const id = `cmd-recruit-s${state.sectorIndex}-${nodeId}-${index}`;
    if (used.has(id)) continue;
    const name = NAMES[seed % NAMES.length];
    const focus = FOCUSES[(seed >>> 8) % FOCUSES.length];
    candidates.push(createCommanderWithId(seed, id, { name, focus }));
    used.add(id);
  }
  return { nodeId, candidates, supplyCost: 2 };
}

export function shouldOfferRecruitment(state: CampaignState, nodeId: string): boolean {
  const reserveCount = state.reserveCommanders?.length ?? 0;
  if (reserveCount >= MAX_RESERVE_COMMANDERS || state.pendingRecruitment) return false;
  if (reserveCount === 0) return true;
  return hash32(state.campaignSeed, state.sectorIndex, nodeId, 'recruit-offer') % 3 === 0;
}

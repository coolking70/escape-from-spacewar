import { hash32 } from '../sector/sectorGenerator';
import type { CampaignCommander, CampaignState, PendingRecruitment } from '../campaignTypes';
import type { CommanderFocus } from './commanderTypes';
import { createCommanderWithId } from './commanderSystem';

const NAMES = ['林澈', '阿斯特拉', '周衡', '维拉', '伊森', '诺瓦', '沈岚', '卡西娅', '韩舟', '莱娅'];
const FOCUSES: CommanderFocus[] = ['balanced', 'tactician', 'quartermaster', 'scout', 'survivor'];
const RECRUITMENT_HISTORY_MARKER = '发现可招募的指挥人员';

export const MAX_RESERVE_COMMANDERS = 3;

function candidateSeed(state: CampaignState, nodeId: string, index: number): number {
  return hash32(state.campaignSeed, state.sectorIndex, nodeId, index, 'commander-recruit');
}

function offeredInCurrentSector(state: CampaignState): boolean {
  const sectorMarker = `进入第 ${state.sectorIndex} 星域`;
  let start = 0;
  for (let index = state.history.length - 1; index >= 0; index--) {
    if (state.history[index].text.includes(sectorMarker)) {
      start = index;
      break;
    }
  }
  return state.history.slice(start).some((entry) => entry.text.includes(RECRUITMENT_HISTORY_MARKER));
}

export function recruitmentSupplyCost(state: CampaignState): number {
  return 2 + Math.min(2, state.reserveCommanders?.length ?? 0);
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
  return { nodeId, candidates, supplyCost: recruitmentSupplyCost(state) };
}

export function shouldOfferRecruitment(state: CampaignState, nodeId: string): boolean {
  const reserveCount = state.reserveCommanders?.length ?? 0;
  if (reserveCount >= MAX_RESERVE_COMMANDERS || state.pendingRecruitment || offeredInCurrentSector(state)) return false;
  if (reserveCount === 0) return true;
  const divisor = reserveCount === 1 ? 4 : 8;
  return hash32(state.campaignSeed, state.sectorIndex, nodeId, 'recruit-offer') % divisor === 0;
}

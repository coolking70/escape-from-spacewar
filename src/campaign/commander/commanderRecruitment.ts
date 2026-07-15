import { hash32 } from '../sector/sectorGenerator';
import type { CampaignCommander, CampaignState, PendingRecruitment } from '../campaignTypes';
import type { CommanderFocus } from './commanderTypes';
import { createCommanderWithId } from './commanderSystem';

const NAMES = ['林澈', '阿斯特拉', '周衡', '维拉', '伊森', '诺瓦', '沈岚', '卡西娅', '韩舟', '莱娅'];
const FOCUSES: CommanderFocus[] = ['balanced', 'tactician', 'quartermaster', 'scout', 'survivor'];
const RECRUITMENT_HISTORY_MARKER = '发现可招募的指挥人员';

export const MAX_RESERVE_COMMANDERS = 3;

function candidateSeed(seed: number, sectorIndex: number, sourceId: string, index: number): number {
  return hash32(seed, sectorIndex, sourceId, index, 'commander-recruit');
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
  return commanderRecruitmentSupplyCost(state.reserveCommanders?.length ?? 0);
}

/** V0.8 与战略层共享的招募补给成本权威函数。 */
export function commanderRecruitmentSupplyCost(reserveCount: number): number {
  return 2 + Math.min(2, Math.max(0, Math.floor(reserveCount)));
}

/**
 * V0.8 与战略层共享的确定性候选人生成器。相同 seed / 星域 / 来源 / 已用 ID
 * 必须生成完全一致的两名候选人；这里只生成档案，不修改任何状态。
 */
export function generateCommanderRecruitmentCandidates(
  seed: number,
  sectorIndex: number,
  sourceId: string,
  usedCommanderIds: Iterable<string>
): CampaignCommander[] {
  const used = new Set(usedCommanderIds);
  const candidates: CampaignCommander[] = [];
  for (let index = 0; candidates.length < 2 && index < 8; index++) {
    const generatedSeed = candidateSeed(seed, sectorIndex, sourceId, index);
    const id = `cmd-recruit-s${sectorIndex}-${sourceId}-${index}`;
    if (used.has(id)) continue;
    const name = NAMES[generatedSeed % NAMES.length];
    const focus = FOCUSES[(generatedSeed >>> 8) % FOCUSES.length];
    candidates.push(createCommanderWithId(generatedSeed, id, { name, focus }));
    used.add(id);
  }
  return candidates;
}

export function generateRecruitmentOffer(state: CampaignState, nodeId: string): PendingRecruitment {
  const used = [state.commander.id, ...(state.reserveCommanders ?? []).map((commander) => commander.id)];
  const candidates = generateCommanderRecruitmentCandidates(
    state.campaignSeed,
    state.sectorIndex,
    nodeId,
    used
  );
  return { nodeId, candidates, supplyCost: recruitmentSupplyCost(state) };
}

export function shouldOfferRecruitment(state: CampaignState, nodeId: string): boolean {
  const reserveCount = state.reserveCommanders?.length ?? 0;
  if (reserveCount >= MAX_RESERVE_COMMANDERS || state.pendingRecruitment || offeredInCurrentSector(state)) return false;
  if (reserveCount === 0) return true;
  const divisor = reserveCount === 1 ? 4 : 8;
  return hash32(state.campaignSeed, state.sectorIndex, nodeId, 'recruit-offer') % divisor === 0;
}

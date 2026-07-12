import type { CampaignState } from '../campaignTypes';
import { isCommanderAvailable, isCommanderIncapacitated, treatCommander } from './commanderHealth';
import { ensureCommanderProfile } from './commanderSystem';
import { MAX_RESERVE_COMMANDERS } from './commanderRecruitment';

export function normalizeCommanderRoster(state: CampaignState): CampaignState {
  state.commander = ensureCommanderProfile(state.commander, state.campaignSeed);
  state.reserveCommanders = (state.reserveCommanders ?? [])
    .map((commander) => ensureCommanderProfile(commander, state.campaignSeed))
    .filter((commander, index, list) => commander.id !== state.commander.id && list.findIndex((item) => item.id === commander.id) === index)
    .slice(0, MAX_RESERVE_COMMANDERS);
  if (state.pendingRecruitment) {
    state.pendingRecruitment = {
      ...state.pendingRecruitment,
      candidates: state.pendingRecruitment.candidates
        .map((commander) => ensureCommanderProfile(commander, state.campaignSeed))
        .filter((commander, index, list) => list.findIndex((item) => item.id === commander.id) === index)
    };
  }
  state.pendingSuccession = !!state.pendingSuccession;
  return state;
}

export function updateCommanderContinuity(state: CampaignState): CampaignState {
  normalizeCommanderRoster(state);
  if (isCommanderAvailable(state.commander, state.campaignSeed)) {
    state.pendingSuccession = false;
    return state;
  }
  const replacements = (state.reserveCommanders ?? []).filter((commander) =>
    isCommanderAvailable(commander, state.campaignSeed)
  );
  if (replacements.length > 0) {
    state.pendingSuccession = true;
    return state;
  }
  state.pendingSuccession = false;
  if (!state.commander.alive) state.status = 'defeat';
  return state;
}

export function recruitCommander(state: CampaignState, candidateId?: string): string {
  const offer = state.pendingRecruitment;
  if (!offer) return '当前没有待处理的招募。';
  if (!candidateId) {
    state.pendingRecruitment = undefined;
    return '放弃本次指挥官招募机会。';
  }
  if ((state.reserveCommanders?.length ?? 0) >= MAX_RESERVE_COMMANDERS) return '候补指挥官名单已满。';
  const candidate = offer.candidates.find((commander) => commander.id === candidateId);
  if (!candidate) return '未知的招募候选人。';
  if (state.resources.supplies < offer.supplyCost) return `补给不足，招募需要 ${offer.supplyCost}。`;
  state.resources.supplies -= offer.supplyCost;
  state.reserveCommanders = [...(state.reserveCommanders ?? []), ensureCommanderProfile(candidate, state.campaignSeed)];
  state.pendingRecruitment = undefined;
  return `招募 ${candidate.name} 加入候补名单，消耗补给 ${offer.supplyCost}。`;
}

export function appointCommander(state: CampaignState, commanderId: string): string {
  if (!state.pendingSuccession) return '当前不需要任命继任指挥官。';
  const index = (state.reserveCommanders ?? []).findIndex((commander) => commander.id === commanderId);
  if (index < 0) return '未找到该候补指挥官。';
  const candidate = ensureCommanderProfile(state.reserveCommanders![index], state.campaignSeed);
  if (!isCommanderAvailable(candidate, state.campaignSeed)) return '该候补指挥官当前无法履职。';
  const former = ensureCommanderProfile(state.commander, state.campaignSeed);
  state.reserveCommanders = state.reserveCommanders!.filter((_, current) => current !== index);
  if (former.alive && isCommanderIncapacitated(former, state.campaignSeed)) {
    state.reserveCommanders.push(former);
  }
  state.commander = candidate;
  state.pendingSuccession = false;
  return `${candidate.name} 接任舰队指挥官。`;
}

export function treatActiveCommander(state: CampaignState): string {
  if (state.resources.supplies < 2) return '治疗指挥官需要 2 点补给。';
  const treatment = treatCommander(state.commander, state.campaignSeed);
  if (!treatment) return '指挥官当前没有可治疗的伤病或负面状态。';
  state.resources.supplies -= 2;
  state.commander = treatment.commander;
  updateCommanderContinuity(state);
  return treatment.text;
}

import { isCommanderAvailable } from '../campaign/commander/commanderHealth';
import type { CampaignCommander } from '../campaign/campaignTypes';
import type { UniverseState } from './universeTypes';

type StrategicCommanderState = Pick<
  UniverseState,
  'seed' | 'status' | 'commander' | 'reserveCommanders' | 'pendingSuccession'
>;

/** 当前现任指挥官是否能够主持战略行动。 */
export function isStrategicCommanderAvailable(
  state: Pick<UniverseState, 'seed' | 'commander'>
): boolean {
  return isCommanderAvailable(state.commander, state.seed);
}

/** 是否存在一名能够立即接任的后备指挥官。 */
export function hasAvailableStrategicSuccessor(
  reserveCommanders: CampaignCommander[],
  seed: number
): boolean {
  return reserveCommanders.some((commander) => isCommanderAvailable(commander, seed));
}

/**
 * 活跃远征的继任状态必须与现任指挥官的真实可用性完全一致：
 * 现任可履职时不得等待继任；现任不可履职时必须等待一名可用候补接任。
 * 已结束远征不允许残留尚未处理的继任流程。
 */
export function isStrategicSuccessionStateConsistent(state: StrategicCommanderState): boolean {
  if (state.status !== 'active') return !state.pendingSuccession;
  const commanderAvailable = isStrategicCommanderAvailable(state);
  if (commanderAvailable) return !state.pendingSuccession;
  return state.pendingSuccession && hasAvailableStrategicSuccessor(state.reserveCommanders, state.seed);
}

/** 防御性行动锁：即使畸形状态绕过载入，也不能在无可履职指挥官时推进战略状态。 */
export function isStrategicCommandLocked(
  state: Pick<UniverseState, 'seed' | 'commander' | 'pendingSuccession'>
): boolean {
  return state.pendingSuccession || !isStrategicCommanderAvailable(state);
}

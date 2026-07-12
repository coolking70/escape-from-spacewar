import { CAMPAIGN_STORAGE_KEY } from './campaignConfig';
import { migrateCampaignState, validateCampaignState } from './campaignCode';
import { ensureCommanderProfile } from './commander/commanderSystem';
import { CampaignState } from './campaignTypes';

function normalizeCommander(state: CampaignState): boolean {
  const before = JSON.stringify(state.commander);
  state.commander = ensureCommanderProfile(state.commander, state.campaignSeed);
  return before !== JSON.stringify(state.commander);
}

export function saveCampaign(state: CampaignState): void {
  normalizeCommander(state);
  if (!validateCampaignState(state)) throw new Error('无法保存无效的战役状态。');
  localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(state));
}

export function loadCampaign(): CampaignState | null {
  const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const state = migrateCampaignState(parsed);
    if (!state) throw new Error('结构无效');
    const commanderMigrated = normalizeCommander(state);
    if (!validateCampaignState(state)) throw new Error('结构无效');
    if (parsed.version !== state.version || commanderMigrated) {
      localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(state));
    }
    return state;
  } catch {
    throw new Error('本地战役存档损坏或不兼容。');
  }
}

export function clearCampaign(): void {
  localStorage.removeItem(CAMPAIGN_STORAGE_KEY);
}

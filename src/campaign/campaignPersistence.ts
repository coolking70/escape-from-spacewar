import { CAMPAIGN_STORAGE_KEY } from './campaignConfig';
import { migrateCampaignState, validateCampaignState } from './campaignCode';
import { CampaignState } from './campaignTypes';

export function saveCampaign(state: CampaignState): void {
  if (!validateCampaignState(state)) throw new Error('无法保存无效的战役状态。');
  localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(state));
}

export function loadCampaign(): CampaignState | null {
  const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const state = migrateCampaignState(parsed);
    if (!state || !validateCampaignState(state)) throw new Error('结构无效');
    if (parsed.version !== state.version) localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(state));
    return state;
  } catch {
    throw new Error('本地战役存档损坏或不兼容。');
  }
}

export function clearCampaign(): void {
  localStorage.removeItem(CAMPAIGN_STORAGE_KEY);
}

import { CAMPAIGN_STORAGE_KEY } from './campaignConfig';
import { CampaignState } from './campaignTypes';
import { validateCampaignState } from './campaignCode';
export function saveCampaign(state: CampaignState): void { localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(state)); }
export function loadCampaign(): CampaignState | null { const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY); if (!raw) return null; try { const state = JSON.parse(raw); if (!validateCampaignState(state)) throw new Error('结构无效'); return state; } catch { throw new Error('本地战役存档损坏或不兼容。'); } }
export function clearCampaign(): void { localStorage.removeItem(CAMPAIGN_STORAGE_KEY); }

import { CampaignState } from '../campaign/campaignTypes';
export function campaignResultPanel(state: CampaignState): string { return state.status === 'active' ? '' : `<div class="campaign-result ${state.status}"><h2>${state.status === 'victory' ? '战役胜利' : '战役失败'}</h2><p>${state.status === 'victory' ? '你成功穿越了第三个星域。' : '舰队已无法继续远征。'}</p></div>`; }

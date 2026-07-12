import { CampaignState } from './campaignTypes';

export interface CampaignLogExport {
  type: 'spacewar-campaign-log';
  formatVersion: '1.1';
  campaign: {
    version: CampaignState['version'];
    campaignSeed: number;
    sectorIndex: number;
    turn: number;
    status: CampaignState['status'];
    commander: CampaignState['commander'];
    reserveCommanders: CampaignState['reserveCommanders'];
    organization: CampaignState['organization'];
    pendingOrganizationEvent: CampaignState['pendingOrganizationEvent'];
    resources: CampaignState['resources'];
    cargo: CampaignState['cargo'];
    fleet: CampaignState['fleet'];
    currentNodeId: string;
    threat: CampaignState['sector']['threat'];
    lastSectorSummary: CampaignState['lastSectorSummary'];
  };
  history: CampaignState['history'];
}

export function buildCampaignLogExport(state: CampaignState): CampaignLogExport {
  return {
    type: 'spacewar-campaign-log',
    formatVersion: '1.1',
    campaign: {
      version: state.version,
      campaignSeed: state.campaignSeed,
      sectorIndex: state.sectorIndex,
      turn: state.turn,
      status: state.status,
      commander: state.commander,
      reserveCommanders: state.reserveCommanders,
      organization: state.organization,
      pendingOrganizationEvent: state.pendingOrganizationEvent,
      resources: state.resources,
      cargo: state.cargo,
      fleet: state.fleet,
      currentNodeId: state.sector.currentNodeId,
      threat: state.sector.threat,
      lastSectorSummary: state.lastSectorSummary
    },
    history: state.history
  };
}

export function encodeCampaignLog(state: CampaignState): string {
  return JSON.stringify(buildCampaignLogExport(state), null, 2);
}

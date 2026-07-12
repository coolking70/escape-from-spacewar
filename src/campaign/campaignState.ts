import { CampaignState } from './campaignTypes';
export function campaignSummary(state: CampaignState) { return { sector: state.sectorIndex, turn: state.turn, status: state.status, node: state.sector.currentNodeId, threat: state.sector.threat, resources: state.resources, ships: state.fleet.ships.length }; }

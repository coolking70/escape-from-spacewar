import {
  CAMPAIGN_VERSION,
  STARTING_CARGO_CAPACITY,
  STARTING_RESOURCES
} from './campaignConfig';
import { createEmptyCargo } from './cargo/cargoSystem';
import { CampaignState } from './campaignTypes';
import { createStarterFleet } from './fleet/persistentFleet';
import { generateSector } from './sector/sectorGenerator';

export function createCampaign(seed: number, name = '星域指挥官'): CampaignState {
  return {
    version: CAMPAIGN_VERSION,
    campaignSeed: seed >>> 0,
    sectorIndex: 1,
    turn: 0,
    status: 'active
import {
  CAMPAIGN_VERSION,
  STARTING_CARGO_CAPACITY,
  STARTING_RESOURCES
} from './campaignConfig';
import { createEmptyCargo } from './cargo/cargoSystem';
import { createCommander } from './commander/commanderSystem';
import { CampaignState } from './campaignTypes';
import { createStarterFleet } from './fleet/persistentFleet';
import { generateSector } from './sector/sectorGenerator';

export function createCampaign(seed: number, name = '星域指挥官'): CampaignState {
  return {
    version: CAMPAIGN_VERSION,
    campaignSeed: seed >>> 0,
    sectorIndex: 1,
    turn: 0,
    status: 'active',
    commander: createCommander(seed, name),
    fleet: createStarterFleet(),
    resources: { ...STARTING_RESOURCES },
    cargo: createEmptyCargo(STARTING_CARGO_CAPACITY),
    sector: generateSector(seed, 1),
    extractionPrepared: false,
    history: [{ turn: 0, text: `战役开始：${name.trim() || '星域指挥官'}率领舰队进入第一星域。` }]
  };
}

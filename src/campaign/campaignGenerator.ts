import {
  CAMPAIGN_VERSION,
  STARTING_CARGO_CAPACITY,
  STARTING_RESOURCES
} from './campaignConfig';
import { createEmptyCargo } from './cargo/cargoSystem';
import { createCommander } from './commander/commanderSystem';
import type { CommanderCreationOptions, CommanderFocus } from './commander/commanderTypes';
import { CampaignState } from './campaignTypes';
import { createStarterFleet } from './fleet/persistentFleet';
import { generateSector } from './sector/sectorGenerator';

let queuedCreation: CommanderCreationOptions | null = null;

export function queueCommanderCreation(options: CommanderCreationOptions): void {
  queuedCreation = {
    name: options.name.trim() || '星域指挥官',
    focus: options.focus
  };
}

export function createCampaign(
  seed: number,
  name = '星域指挥官',
  focus: CommanderFocus = 'balanced'
): CampaignState {
  const options = queuedCreation ?? { name, focus };
  queuedCreation = null;
  const commander = createCommander(seed, options.name, options.focus);
  return {
    version: CAMPAIGN_VERSION,
    campaignSeed: seed >>> 0,
    sectorIndex: 1,
    turn: 0,
    status: 'active',
    commander,
    reserveCommanders: [],
    pendingSuccession: false,
    fleet: createStarterFleet(),
    resources: { ...STARTING_RESOURCES },
    cargo: createEmptyCargo(STARTING_CARGO_CAPACITY),
    sector: generateSector(seed, 1),
    extractionPrepared: false,
    history: [{ turn: 0, text: `战役开始：${commander.name}以${options.focus}专长率领舰队进入第一星域。` }]
  };
}

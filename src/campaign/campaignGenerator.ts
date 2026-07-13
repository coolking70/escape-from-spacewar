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
import { createOrganization, organizationCargoBonus } from './organization/organizationSystem';
import type { OrganizationCreationOptions } from './organization/organizationTypes';
import { generateSector } from './sector/sectorGenerator';

let queuedCommanderCreation: CommanderCreationOptions | null = null;
let queuedOrganizationCreation: OrganizationCreationOptions | null = null;

export function queueCommanderCreation(options: CommanderCreationOptions): void {
  queuedCommanderCreation = {
    name: options.name.trim() || '星域指挥官',
    focus: options.focus
  };
}

export function queueOrganizationCreation(options: OrganizationCreationOptions): void {
  queuedOrganizationCreation = {
    name: options.name.trim(),
    archetype: options.archetype,
    government: options.government,
    values: [...options.values]
  };
}

export function createCampaign(
  seed: number,
  name = '星域指挥官',
  focus: CommanderFocus = 'balanced',
  organizationOptions?: Partial<OrganizationCreationOptions>
): CampaignState {
  const commanderOptions = queuedCommanderCreation ?? { name, focus };
  const organization = createOrganization(seed, queuedOrganizationCreation ?? organizationOptions);
  queuedCommanderCreation = null;
  queuedOrganizationCreation = null;
  const commander = createCommander(seed, commanderOptions.name, commanderOptions.focus);
  return {
    version: CAMPAIGN_VERSION,
    campaignSeed: seed >>> 0,
    sectorIndex: 1,
    turn: 0,
    status: 'active',
    commander,
    reserveCommanders: [],
    pendingSuccession: false,
    organization,
    fleet: createStarterFleet(),
    resources: { ...STARTING_RESOURCES },
    cargo: createEmptyCargo(STARTING_CARGO_CAPACITY + organizationCargoBonus(organization)),
    sector: generateSector(seed, 1),
    extractionPrepared: false,
    history: [{
      turn: 0,
      text: `战役开始：${commander.name}以${commanderOptions.focus}专长率领“${organization.name}”进入第一星域。`
    }]
  };
}

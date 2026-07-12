import { hash32 } from '../sector/sectorGenerator';
import type {
  CampaignOrganization,
  GovernmentType,
  OrganizationArchetype,
  OrganizationCreationOptions,
  OrganizationValue,
  ResearchResources
} from './organizationTypes';
import { createResearchState, hasInstalledTechnology } from './technologySystem';

export const ORGANIZATION_ARCHETYPES: OrganizationArchetype[] = ['expedition', 'military', 'commerce', 'exile'];
export const GOVERNMENT_TYPES: GovernmentType[] = [
  'militaryCouncil', 'captainsAssembly', 'corporateBoard', 'technocracy', 'emergencyDirectorate'
];
export const ORGANIZATION_VALUES: OrganizationValue[] = [
  'order', 'freedom', 'survival', 'expansion', 'knowledge', 'profit', 'unity'
];

export const ORGANIZATION_ARCHETYPE_LABEL: Record<OrganizationArchetype, string> = {
  expedition: '远征舰队',
  military: '军事共同体',
  commerce: '商贸联合体',
  exile: '流亡殖民团'
};

export const GOVERNMENT_LABEL: Record<GovernmentType, string> = {
  militaryCouncil: '军事委员会',
  captainsAssembly: '舰长议会',
  corporateBoard: '商业董事会',
  technocracy: '技术官僚制',
  emergencyDirectorate: '紧急统制局'
};

export const ORGANIZATION_VALUE_LABEL: Record<OrganizationValue, string> = {
  order: '秩序', freedom: '自由', survival: '生存', expansion: '扩张', knowledge: '知识', profit: '利润', unity: '团结'
};

const ARCHETYPE_DEFAULT_VALUES: Record<OrganizationArchetype, [OrganizationValue, OrganizationValue]> = {
  expedition: ['knowledge', 'unity'],
  military: ['order', 'expansion'],
  commerce: ['profit', 'freedom'],
  exile: ['survival', 'unity']
};

function initialReputation(archetype: OrganizationArchetype): CampaignOrganization['reputation'] {
  const base = { civilian: 0, military: 0, frontier: 0 };
  if (archetype === 'expedition') base.frontier = 2;
  if (archetype === 'military') base.military = 2;
  if (archetype === 'commerce') base.civilian = 2;
  if (archetype === 'exile') base.frontier = 1;
  return base;
}

function normalizedValues(values: unknown, archetype: OrganizationArchetype): OrganizationValue[] {
  const valid = Array.isArray(values)
    ? values.filter((value): value is OrganizationValue => ORGANIZATION_VALUES.includes(value as OrganizationValue))
    : [];
  const unique = [...new Set(valid)].slice(0, 2);
  for (const fallback of ARCHETYPE_DEFAULT_VALUES[archetype]) {
    if (unique.length >= 2) break;
    if (!unique.includes(fallback)) unique.push(fallback);
  }
  return unique;
}

export function createOrganization(seed: number, options?: Partial<OrganizationCreationOptions>): CampaignOrganization {
  const archetype = ORGANIZATION_ARCHETYPES.includes(options?.archetype as OrganizationArchetype)
    ? options!.archetype as OrganizationArchetype
    : 'expedition';
  const government = GOVERNMENT_TYPES.includes(options?.government as GovernmentType)
    ? options!.government as GovernmentType
    : 'captainsAssembly';
  const values = normalizedValues(options?.values, archetype);
  const suffix = hash32(seed, archetype, government, values.join('-'), 'organization').toString(36).slice(0, 5);
  return {
    id: `org-${seed >>> 0}-${suffix}`,
    name: options?.name?.trim() || `${ORGANIZATION_ARCHETYPE_LABEL[archetype]}-${suffix.toUpperCase()}`,
    archetype,
    government,
    values,
    stability: 70,
    reputation: initialReputation(archetype),
    research: createResearchState(archetype)
  };
}

export function ensureOrganization(value: unknown, seed: number): CampaignOrganization {
  const raw = value as Partial<CampaignOrganization> | undefined;
  const generated = createOrganization(seed, {
    name: typeof raw?.name === 'string' ? raw.name : undefined,
    archetype: raw?.archetype,
    government: raw?.government,
    values: raw?.values
  });
  const organization: CampaignOrganization = {
    ...generated,
    ...raw,
    id: typeof raw?.id === 'string' && raw.id ? raw.id : generated.id,
    name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : generated.name,
    archetype: ORGANIZATION_ARCHETYPES.includes(raw?.archetype as OrganizationArchetype) ? raw!.archetype! : generated.archetype,
    government: GOVERNMENT_TYPES.includes(raw?.government as GovernmentType) ? raw!.government! : generated.government,
    values: normalizedValues(raw?.values, generated.archetype),
    stability: Number.isFinite(raw?.stability) ? Math.max(0, Math.min(100, Math.floor(raw!.stability!))) : generated.stability,
    reputation: {
      civilian: Number.isFinite(raw?.reputation?.civilian) ? Math.floor(raw!.reputation!.civilian) : generated.reputation.civilian,
      military: Number.isFinite(raw?.reputation?.military) ? Math.floor(raw!.reputation!.military) : generated.reputation.military,
      frontier: Number.isFinite(raw?.reputation?.frontier) ? Math.floor(raw!.reputation!.frontier) : generated.reputation.frontier
    },
    research: {
      resources: {
        navigation: Math.max(0, Math.floor(raw?.research?.resources?.navigation ?? generated.research.resources.navigation)),
        engineering: Math.max(0, Math.floor(raw?.research?.resources?.engineering ?? generated.research.resources.engineering)),
        tactical: Math.max(0, Math.floor(raw?.research?.resources?.tactical ?? generated.research.resources.tactical)),
        social: Math.max(0, Math.floor(raw?.research?.resources?.social ?? generated.research.resources.social))
      },
      unlocked: Array.isArray(raw?.research?.unlocked) ? [...new Set(raw!.research!.unlocked)] : generated.research.unlocked,
      installed: Array.isArray(raw?.research?.installed) ? [...new Set(raw!.research!.installed)] : generated.research.installed,
      slots: Number.isInteger(raw?.research?.slots) ? Math.max(1, Math.min(4, raw!.research!.slots)) : generated.research.slots
    }
  };
  organization.research.installed = organization.research.installed
    .filter((id) => organization.research.unlocked.includes(id))
    .slice(0, organization.research.slots);
  return organization;
}

export function organizationHasValue(organization: CampaignOrganization, value: OrganizationValue): boolean {
  return organization.values.includes(value);
}

export function organizationTreatmentCost(organization: CampaignOrganization): number {
  let cost = 2;
  if (organization.archetype === 'exile') cost--;
  if (organizationHasValue(organization, 'survival')) cost--;
  if (hasInstalledTechnology(organization, 'traumaCare')) cost--;
  return Math.max(1, cost);
}

export function organizationEmergencyRefuelCost(organization: CampaignOrganization): number {
  let cost = 2;
  if (organization.archetype === 'exile') cost--;
  if (organizationHasValue(organization, 'survival')) cost--;
  return Math.max(1, cost);
}

export function organizationScanThreat(organization: CampaignOrganization): number {
  let threat = 2;
  if (organization.archetype === 'expedition') threat--;
  if (hasInstalledTechnology(organization, 'deepSensorArray')) threat--;
  return Math.max(0, threat);
}

export function organizationRepairThreat(organization: CampaignOrganization): number {
  return hasInstalledTechnology(organization, 'fieldRepairProtocol') ? 1 : 2;
}

export function organizationEvadeBonus(organization: CampaignOrganization): number {
  let bonus = organization.archetype === 'expedition' ? 3 : 0;
  if (hasInstalledTechnology(organization, 'deepSensorArray')) bonus += 8;
  if (hasInstalledTechnology(organization, 'retreatCoordination')) bonus += 7;
  return bonus;
}

export function organizationExtractionFuelDiscount(organization: CampaignOrganization): number {
  return hasInstalledTechnology(organization, 'jumpCalibration') ? 1 : 0;
}

export function organizationCargoBonus(organization: CampaignOrganization): number {
  return hasInstalledTechnology(organization, 'modularCargo') ? 4 : 0;
}

export function organizationGatherBonus(organization: CampaignOrganization): { supplies: number; fuel: number; materials: number } {
  let supplies = 0;
  let fuel = 0;
  let materials = 0;
  if (organization.archetype === 'commerce') materials++;
  if (organization.government === 'corporateBoard') materials++;
  if (organizationHasValue(organization, 'profit')) materials++;
  if (organization.archetype === 'exile') supplies++;
  if (organization.archetype === 'expedition') fuel++;
  return { supplies, fuel, materials };
}

export type OrganizationResearchAction = 'scan' | 'gather' | 'signal' | 'battle' | 'salvage' | 'repair' | 'treat' | 'extract';

export function organizationResearchGain(
  organization: CampaignOrganization,
  action: OrganizationResearchAction
): Partial<ResearchResources> {
  const gain: Partial<ResearchResources> = {};
  if (action === 'scan') gain.navigation = 2;
  if (action === 'gather') gain.engineering = 2;
  if (action === 'signal') gain.social = 2;
  if (action === 'battle') gain.tactical = 3;
  if (action === 'salvage') gain.engineering = 3;
  if (action === 'repair') gain.engineering = 2;
  if (action === 'treat') gain.social = 2;
  if (action === 'extract') gain.navigation = 4;

  if (organization.archetype === 'military' && action === 'battle') gain.tactical = (gain.tactical ?? 0) + 1;
  if (organization.government === 'technocracy') {
    const first = Object.keys(gain)[0] as keyof ResearchResources | undefined;
    if (first) gain[first] = (gain[first] ?? 0) + 1;
  }
  if (organizationHasValue(organization, 'knowledge') && (action === 'scan' || action === 'signal')) {
    const key = action === 'scan' ? 'navigation' : 'social';
    gain[key] = (gain[key] ?? 0) + 1;
  }
  if (organizationHasValue(organization, 'expansion') && action === 'battle') gain.tactical = (gain.tactical ?? 0) + 1;
  return gain;
}

export function changeOrganizationStability(organization: CampaignOrganization, delta: number): void {
  organization.stability = Math.max(0, Math.min(100, organization.stability + Math.floor(delta)));
}

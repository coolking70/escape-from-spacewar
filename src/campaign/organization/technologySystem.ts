import type {
  CampaignOrganization,
  OrganizationArchetype,
  ResearchResourceKey,
  ResearchResources,
  ResearchState,
  TechnologyId
} from './organizationTypes';

export interface TechnologyDefinition {
  id: TechnologyId;
  label: string;
  field: string;
  description: string;
  cost: Partial<ResearchResources>;
}

export const TECHNOLOGY_DEFINITIONS: Record<TechnologyId, TechnologyDefinition> = {
  jumpCalibration: {
    id: 'jumpCalibration',
    label: '高效跃迁校准',
    field: '航行',
    description: '普通与紧急跃迁燃料消耗降低 1。',
    cost: { navigation: 8 }
  },
  modularCargo: {
    id: 'modularCargo',
    label: '模块化货舱',
    field: '后勤',
    description: '组织科技槽启用时，货舱容量增加 4。',
    cost: { engineering: 8 }
  },
  fieldRepairProtocol: {
    id: 'fieldRepairProtocol',
    label: '战地维修协议',
    field: '舰船工程',
    description: '战地维修产生的威胁降低 1，并获得额外工程数据。',
    cost: { engineering: 6, tactical: 2 }
  },
  deepSensorArray: {
    id: 'deepSensorArray',
    label: '深空传感阵列',
    field: '传感器',
    description: '扫描产生的威胁降低 1，战前规避率提高。',
    cost: { navigation: 6, social: 2 }
  },
  retreatCoordination: {
    id: 'retreatCoordination',
    label: '撤退协同协议',
    field: '战术理论',
    description: '战前规避率提高，并减少撤退后的组织稳定度损失。',
    cost: { tactical: 8 }
  },
  traumaCare: {
    id: 'traumaCare',
    label: '创伤救治程序',
    field: '医疗与人员',
    description: '治疗额外补给成本降低 1，治疗会产生社会研究数据。',
    cost: { social: 6, engineering: 2 }
  }
};

export const TECHNOLOGY_IDS = Object.keys(TECHNOLOGY_DEFINITIONS) as TechnologyId[];
export const RESEARCH_RESOURCE_KEYS: ResearchResourceKey[] = ['navigation', 'engineering', 'tactical', 'social'];

const ARCHETYPE_STARTING_TECH: Record<OrganizationArchetype, TechnologyId> = {
  expedition: 'deepSensorArray',
  military: 'retreatCoordination',
  commerce: 'modularCargo',
  exile: 'traumaCare'
};

function emptyResources(): ResearchResources {
  return { navigation: 0, engineering: 0, tactical: 0, social: 0 };
}

export function createResearchState(archetype: OrganizationArchetype): ResearchState {
  const starting = ARCHETYPE_STARTING_TECH[archetype];
  return {
    resources: emptyResources(),
    unlocked: [starting],
    installed: [starting],
    slots: 2
  };
}

export function hasInstalledTechnology(organization: CampaignOrganization, id: TechnologyId): boolean {
  return organization.research.installed.includes(id);
}

export function canUnlockTechnology(organization: CampaignOrganization, id: TechnologyId): boolean {
  if (organization.research.unlocked.includes(id)) return false;
  const cost = TECHNOLOGY_DEFINITIONS[id].cost;
  return RESEARCH_RESOURCE_KEYS.every((key) => organization.research.resources[key] >= (cost[key] ?? 0));
}

export function unlockTechnology(organization: CampaignOrganization, id: TechnologyId): boolean {
  if (!canUnlockTechnology(organization, id)) return false;
  const cost = TECHNOLOGY_DEFINITIONS[id].cost;
  for (const key of RESEARCH_RESOURCE_KEYS) {
    organization.research.resources[key] -= cost[key] ?? 0;
  }
  organization.research.unlocked.push(id);
  return true;
}

export function installTechnology(organization: CampaignOrganization, id: TechnologyId): boolean {
  if (!organization.research.unlocked.includes(id) || organization.research.installed.includes(id)) return false;
  if (organization.research.installed.length >= organization.research.slots) return false;
  organization.research.installed.push(id);
  return true;
}

export function uninstallTechnology(organization: CampaignOrganization, id: TechnologyId): boolean {
  const index = organization.research.installed.indexOf(id);
  if (index < 0) return false;
  organization.research.installed.splice(index, 1);
  return true;
}

export function addResearchResources(
  organization: CampaignOrganization,
  gains: Partial<ResearchResources>
): void {
  for (const key of RESEARCH_RESOURCE_KEYS) {
    organization.research.resources[key] = Math.max(0, organization.research.resources[key] + Math.floor(gains[key] ?? 0));
  }
}

export function technologyCostText(id: TechnologyId): string {
  const labels: Record<ResearchResourceKey, string> = {
    navigation: '航行', engineering: '工程', tactical: '战术', social: '社会'
  };
  return RESEARCH_RESOURCE_KEYS
    .filter((key) => (TECHNOLOGY_DEFINITIONS[id].cost[key] ?? 0) > 0)
    .map((key) => `${labels[key]} ${TECHNOLOGY_DEFINITIONS[id].cost[key]}`)
    .join(' / ');
}

import type { CampaignState } from '../campaignTypes';
import { addThreat } from '../sector/threatSystem';
import { hash32 } from '../sector/sectorGenerator';
import type {
  OrganizationEventEffect,
  OrganizationEventOption,
  PendingOrganizationEvent
} from './organizationTypes';
import { addResearchResources } from './technologySystem';
import { changeOrganizationStability, organizationHasValue } from './organizationSystem';

function eventOptions(state: CampaignState, variant: number): OrganizationEventOption[] {
  if (variant === 0) {
    return [
      {
        id: 'rescue',
        label: '优先救援平民船员',
        description: '消耗补给，提升民间声望和组织稳定度。',
        requiredValue: 'unity',
        effect: { supplies: -2, stability: 6, reputation: { civilian: 3 }, research: { social: 2 } }
      },
      {
        id: 'secure',
        label: '先回收关键数据',
        description: '获得工程与航行数据，但组织稳定度略降。',
        requiredValue: 'knowledge',
        effect: { stability: -2, research: { engineering: 3, navigation: 2 } }
      },
      {
        id: 'ration',
        label: '按现有配额处理',
        description: '保持中立，不产生额外风险。',
        effect: { research: { social: 1 } }
      }
    ];
  }
  if (variant === 1) {
    return [
      {
        id: 'pursue',
        label: '授权追击敌舰',
        description: '提高军事声望和战术数据，同时增加威胁。',
        requiredValue: 'expansion',
        effect: { stability: 2, reputation: { military: 3 }, research: { tactical: 4 }, threat: 2 }
      },
      {
        id: 'fortify',
        label: '巩固当前航线',
        description: '消耗材料换取稳定度和工程数据。',
        requiredValue: 'order',
        effect: { materials: -1, stability: 5, research: { engineering: 3 } }
      },
      {
        id: 'observe',
        label: '保持观察',
        description: '少量获得战术数据，不改变局势。',
        effect: { research: { tactical: 1 } }
      }
    ];
  }
  return [
    {
      id: 'trade',
      label: '公开交易遗物',
      description: '获得补给和民间声望，但组织内部产生争议。',
      requiredValue: 'profit',
      effect: { supplies: 3, stability: -3, reputation: { civilian: 2 }, research: { social: 2 } }
    },
    {
      id: 'study',
      label: '交由技术部门研究',
      description: '获得多类研究数据。',
      requiredValue: 'knowledge',
      effect: { research: { navigation: 2, engineering: 2, social: 1 } }
    },
    {
      id: 'store',
      label: '封存并延后决策',
      description: '提升稳定度，但暂时没有直接收益。',
      effect: { stability: 2 }
    }
  ];
}

export function generateOrganizationEvent(state: CampaignState): PendingOrganizationEvent {
  const variant = hash32(
    state.campaignSeed,
    state.sectorIndex,
    state.organization.id,
    state.organization.government,
    'organization-event'
  ) % 3;
  const titles = ['救援配额争议', '航线安全会议', '遗物处置听证'];
  const descriptions = [
    '组织内部对有限资源应优先用于救援还是数据回收产生分歧。',
    '新星域的敌对活动迫使组织决定追击、巩固航线或保持观察。',
    '一批高价值遗物引发商业、技术和安全部门之间的争论。'
  ];
  return {
    id: `org-event-s${state.sectorIndex}-${variant}`,
    title: titles[variant],
    description: descriptions[variant],
    options: eventOptions(state, variant)
  };
}

function canPay(state: CampaignState, effect: OrganizationEventEffect): boolean {
  return state.resources.supplies + (effect.supplies ?? 0) >= 0 &&
    state.resources.fuel + (effect.fuel ?? 0) >= 0 &&
    state.resources.materials + (effect.materials ?? 0) >= 0;
}

export function canResolveOrganizationEvent(state: CampaignState, option: OrganizationEventOption): boolean {
  if (option.requiredValue && !organizationHasValue(state.organization, option.requiredValue)) return false;
  return canPay(state, option.effect);
}

export function resolveOrganizationEvent(state: CampaignState, optionId: string): string | null {
  const pending = state.pendingOrganizationEvent;
  const option = pending?.options.find((candidate) => candidate.id === optionId);
  if (!pending || !option || !canResolveOrganizationEvent(state, option)) return null;
  const effect = option.effect;
  state.resources.supplies = Math.max(0, state.resources.supplies + (effect.supplies ?? 0));
  state.resources.fuel = Math.max(0, state.resources.fuel + (effect.fuel ?? 0));
  state.resources.materials = Math.max(0, state.resources.materials + (effect.materials ?? 0));
  changeOrganizationStability(state.organization, effect.stability ?? 0);
  for (const key of ['civilian', 'military', 'frontier'] as const) {
    state.organization.reputation[key] += Math.floor(effect.reputation?.[key] ?? 0);
  }
  addResearchResources(state.organization, effect.research ?? {});
  state.sector.threat = addThreat(state.sector.threat, Math.max(0, effect.threat ?? 0));
  state.pendingOrganizationEvent = undefined;
  return `${pending.title}：选择“${option.label}”。`;
}

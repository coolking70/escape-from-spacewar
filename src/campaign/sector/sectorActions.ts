import { CampaignState } from '../campaignTypes';
import { hash32 } from './sectorGenerator';
import { SIGNAL_TEMPLATES } from '../campaignConfig';

export function resourceReward(state: CampaignState, nodeId: string) {
  const roll = hash32(state.campaignSeed, state.sectorIndex, nodeId, 'resource');
  return {
    supplies: 1 + roll % 4,
    fuel: 1 + ((roll >>> 4) % 3),
    materials: 1 + ((roll >>> 8) % 3)
  };
}

export function signalTemplate(state: CampaignState, nodeId: string) {
  return SIGNAL_TEMPLATES[
    hash32(state.campaignSeed, state.sectorIndex, nodeId, 'signal') % SIGNAL_TEMPLATES.length
  ];
}

export function signalOptions(state: CampaignState, nodeId: string): [string, string] {
  const options: Record<string, [string, string]> = {
    '废弃补给舱': ['谨慎扫描', '直接靠近'],
    '受损商船': ['救援幸存者', '拆解船体'],
    '可疑求救信号': ['回应求救', '保持距离'],
    '古代探测器': ['校准探测器', '拆解设备'],
    '漂流舰船残骸': ['搜寻日志', '回收材料']
  };
  return options[signalTemplate(state, nodeId)] ?? ['谨慎扫描', '直接靠近'];
}

export function signalOutcome(state: CampaignState, nodeId: string, optionId: string) {
  const roll = hash32(state.campaignSeed, state.sectorIndex, nodeId, optionId);
  return {
    supplies: (roll % 5) - 1,
    fuel: ((roll >>> 3) % 4) - 1,
    materials: (roll >>> 7) % 3,
    threat: 1 + ((roll >>> 11) % 3),
    battle: optionId !== 'cautious' && roll % 3 === 0,
    gateClue: roll % 2 === 0
  };
}

export function hazardOutcome(state: CampaignState, nodeId: string) {
  const roll = hash32(state.campaignSeed, state.sectorIndex, nodeId, 'hazard');
  const names = ['辐射风暴', '引力异常', '残骸雷区'] as const;
  return {
    name: names[roll % names.length],
    supplies: -(roll % 2),
    fuel: -((roll >>> 2) % 2),
    threat: 1 + ((roll >>> 4) % 2),
    damageIndex: (roll >>> 6) % Math.max(1, state.fleet.ships.length),
    componentIndex: roll >>> 10,
    damage: 1 + ((roll >>> 15) % 4)
  };
}

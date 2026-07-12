import type { CampaignState } from '../campaignTypes';
import type { CommanderDomainExperience } from './commanderTypes';
import { updateCommanderContinuity } from './commanderRoster';
import {
  ensureCommanderProfile,
  killCommander
} from './commanderSystem';

function emptyExperience(): CommanderDomainExperience {
  return { combat: 0, exploration: 0, logistics: 0, survival: 0 };
}

export function commanderExperienceFromHistory(state: CampaignState): CommanderDomainExperience {
  const xp = emptyExperience();
  for (const entry of state.history) {
    const text = entry.text;
    if (text.includes('移动至未知节点')) xp.exploration += 2;
    if (text.includes('扫描附近节点')) xp.exploration += 4;
    if (text.includes('采集星域资源')) {
      xp.exploration += 3;
      xp.logistics += 4;
    }
    if (text.includes('处理特殊信号')) xp.exploration += 4;
    if (text.includes('战斗胜利')) xp.combat += 20;
    if (text.includes('舰队脱离战斗')) xp.survival += 10;
    if (text.includes('成功规避') || text.includes('交战前退回上一节点')) xp.survival += 6;
    if (text.includes('战地维修')) xp.logistics += 8;
    if (text.includes('治疗')) xp.logistics += 6;
    if (text.includes('招募')) xp.commander = 0 as never;
    if (text.includes('拆解') && text.includes('回收')) xp.logistics += 4;
    if (text.includes('使用了一份')) xp.logistics += 3;
    if (text.includes('星门跃迁')) {
      xp.exploration += 5;
      xp.survival += 10;
    }
    if (text.includes('资源受损，威胁上升')) xp.survival += 4;
  }
  return xp;
}

export function synchronizeCommanderCareer(state: CampaignState): CampaignState {
  let commander = ensureCommanderProfile(state.commander, state.campaignSeed);
  const derived = commanderExperienceFromHistory(state);
  commander.domainExperience = {
    combat: Math.max(commander.domainExperience.combat, derived.combat),
    exploration: Math.max(commander.domainExperience.exploration, derived.exploration),
    logistics: Math.max(commander.domainExperience.logistics, derived.logistics),
    survival: Math.max(commander.domainExperience.survival, derived.survival)
  };
  const domainTotal = Object.values(commander.domainExperience).reduce((sum, value) => sum + value, 0);
  commander.experience = Math.max(commander.experience, domainTotal);
  commander.level = Math.max(commander.level, 1 + Math.floor(commander.experience / 100));

  if (state.status === 'defeat' && state.fleet.ships.length === 0 && commander.alive) {
    commander = killCommander(commander, state.campaignSeed, state.turn, '舰队全歼');
  }
  state.commander = commander;
  updateCommanderContinuity(state);
  return state;
}

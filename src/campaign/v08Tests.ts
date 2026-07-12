import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { CAMPAIGN_STORAGE_KEY } from './campaignConfig';
import { createCampaign } from './campaignGenerator';
import { loadCampaign } from './campaignPersistence';
import { evaluateCampaignStatus } from './campaignReducer';
import { synchronizeCommanderCareer } from './commander/commanderProgression';
import {
  commanderProfileSignature,
  ensureCommanderProfile,
  gainCommanderDomainExperience,
  killCommander
} from './commander/commanderSystem';

export function runV08Tests(): SuiteResult {
  return runSuite('campaign-v0.8', (add) => {
    {
      const test = new Case('指挥官档案按 seed 确定生成');
      const first = createCampaign(808, '阿尔法').commander;
      const same = createCampaign(808, '阿尔法').commander;
      const different = createCampaign(809, '阿尔法').commander;
      test.eq(commanderProfileSignature(first, 808), commanderProfileSignature(same, 808), '相同 seed 生成相同属性和特质');
      test.true_(commanderProfileSignature(first, 808) !== commanderProfileSignature(different, 809), '不同 seed 通常生成不同档案');
      const profile = ensureCommanderProfile(first, 808);
      test.eq(profile.traits.length, 2, '初始拥有两个特质');
      test.eq(new Set(profile.traits).size, 2, '初始特质不重复');
      test.true_(Object.values(profile.attributes).every((value) => Number.isInteger(value) && value >= 1 && value <= 10), '属性处于合法范围');
      add(test);
    }

    {
      const test = new Case('旧战役存档自动补齐 V0.8 指挥官字段');
      const store = new Map<string, string>();
      (globalThis as any).localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key)
      };
      const legacy = createCampaign(810, '旧档指挥官');
      delete legacy.commander.attributes;
      delete legacy.commander.traits;
      delete legacy.commander.domainExperience;
      delete legacy.commander.conditions;
      delete legacy.commander.injuries;
      store.set(CAMPAIGN_STORAGE_KEY, JSON.stringify(legacy));
      const loaded = loadCampaign()!;
      const profile = ensureCommanderProfile(loaded.commander, loaded.campaignSeed);
      test.eq(profile.name, '旧档指挥官', '迁移保留姓名');
      test.eq(profile.traits.length, 2, '迁移补齐特质');
      test.true_(!!loaded.commander.attributes && !!loaded.commander.domainExperience, '迁移结果写回完整档案');
      test.true_(store.get(CAMPAIGN_STORAGE_KEY)!.includes('domainExperience'), '本地存档已原位升级');
      add(test);
    }

    {
      const test = new Case('领域经验与等级成长规则稳定');
      const state = createCampaign(811);
      const gained = gainCommanderDomainExperience(state.commander, state.campaignSeed, 'combat', 125);
      test.eq(gained.domainExperience.combat, 125, '战斗领域经验独立累计');
      test.eq(gained.experience, 125, '总经验同步累计');
      test.eq(gained.level, 2, '每 100 总经验提升一级');
      const repeat = gainCommanderDomainExperience(state.commander, state.campaignSeed, 'combat', 125);
      test.eq(JSON.stringify(gained), JSON.stringify(repeat), '相同输入得到相同成长结果');
      add(test);
    }

    {
      const test = new Case('战役日志确定性驱动领域经验');
      const state = createCampaign(812);
      state.history.push(
        { turn: 1, text: '扫描附近节点，获得情报。' },
        { turn: 2, text: '采集星域资源。' },
        { turn: 3, text: '战斗胜利，剩余舰船 2；等待打捞决策。' },
        { turn: 4, text: '执行稳定星门跃迁。' }
      );
      synchronizeCommanderCareer(state);
      const profile = ensureCommanderProfile(state.commander, state.campaignSeed);
      test.eq(profile.domainExperience.combat, 20, '战斗胜利提供战斗经验');
      test.eq(profile.domainExperience.exploration, 12, '扫描、采集和跃迁提供探索经验');
      test.eq(profile.domainExperience.logistics, 4, '采集提供后勤经验');
      test.eq(profile.domainExperience.survival, 10, '跃迁提供生存经验');
      const first = JSON.stringify(profile.domainExperience);
      synchronizeCommanderCareer(state);
      test.eq(JSON.stringify(ensureCommanderProfile(state.commander, state.campaignSeed).domainExperience), first, '重复同步不会重复加经验');
      add(test);
    }

    {
      const test = new Case('指挥官死亡会终止战役');
      const state = createCampaign(813);
      state.commander = killCommander(state.commander, state.campaignSeed, state.turn, '测试致命事故');
      const ended = evaluateCampaignStatus(state);
      const profile = ensureCommanderProfile(ended.commander, ended.campaignSeed);
      test.eq(ended.status, 'defeat', '主指挥官死亡后战役失败');
      test.true_(!profile.alive, '死亡状态持久化');
      test.true_(profile.injuries.some((injury) => injury.id === 'fatal' && injury.cause === '测试致命事故'), '记录致命伤与原因');
      add(test);
    }

    {
      const test = new Case('舰队全歼会记录主指挥官死亡');
      const state = createCampaign(814);
      state.status = 'defeat';
      state.fleet.ships = [];
      synchronizeCommanderCareer(state);
      const profile = ensureCommanderProfile(state.commander, state.campaignSeed);
      test.true_(!profile.alive, '全歼后指挥官死亡');
      test.true_(profile.injuries.some((injury) => injury.id === 'fatal' && injury.cause === '舰队全歼'), '全歼死亡原因明确');
      add(test);
    }
  });
}

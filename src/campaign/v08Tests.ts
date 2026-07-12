import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { CAMPAIGN_STORAGE_KEY } from './campaignConfig';
import { decodeCampaign, encodeCampaign, validateCampaignState } from './campaignCode';
import { createCampaign } from './campaignGenerator';
import { loadCampaign } from './campaignPersistence';
import { applyCampaignAction, evaluateCampaignStatus, getAvailableCampaignActions } from './campaignReducer';
import {
  addCommanderCondition,
  addCommanderInjury,
  commanderEvadeModifier,
  commanderSupplyUpkeepModifier
} from './commander/commanderHealth';
import { synchronizeCommanderCareer } from './commander/commanderProgression';
import { generateRecruitmentOffer } from './commander/commanderRecruitment';
import {
  commanderProfileSignature,
  createCommanderWithId,
  ensureCommanderProfile,
  gainCommanderDomainExperience,
  killCommander
} from './commander/commanderSystem';
import { buildEncounterPreview } from './fleet/encounterControl';
import { movementFuelCost } from './fleet/persistentFleet';

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
      const test = new Case('创建专长提供受控属性与保证特质');
      const scout = createCampaign(809, '侦察官', 'scout');
      const quartermaster = createCampaign(809, '后勤官', 'quartermaster');
      const scoutProfile = ensureCommanderProfile(scout.commander, scout.campaignSeed);
      const logisticsProfile = ensureCommanderProfile(quartermaster.commander, quartermaster.campaignSeed);
      test.true_(scoutProfile.traits.includes('scout'), '侦察专长保证侦察特质');
      test.true_(logisticsProfile.traits.includes('quartermaster'), '后勤专长保证军需官特质');
      test.true_(logisticsProfile.attributes.logistics >= scoutProfile.attributes.logistics, '后勤专长提高后勤属性');
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
      delete legacy.reserveCommanders;
      delete legacy.pendingSuccession;
      store.set(CAMPAIGN_STORAGE_KEY, JSON.stringify(legacy));
      const loaded = loadCampaign()!;
      const profile = ensureCommanderProfile(loaded.commander, loaded.campaignSeed);
      test.eq(profile.name, '旧档指挥官', '迁移保留姓名');
      test.eq(profile.traits.length, 2, '迁移补齐特质');
      test.true_(!!loaded.commander.attributes && !!loaded.commander.domainExperience, '迁移结果写回完整档案');
      test.true_(Array.isArray(loaded.reserveCommanders) && loaded.pendingSuccession === false, '迁移补齐候补名单与继任状态');
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
      const test = new Case('负面状态影响补给与规避');
      const state = createCampaign(813, '测试官', 'scout');
      state.pendingBattle = {
        nodeId: state.sector.currentNodeId,
        originNodeId: state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!.neighbors[0],
        battleIndex: 1,
        reason: '测试遭遇'
      };
      const base = buildEncounterPreview(state)!;
      state.commander = addCommanderCondition(state.commander, state.campaignSeed, 'shaken', 3, 5);
      state.commander = addCommanderCondition(state.commander, state.campaignSeed, 'fatigued', 2, 5);
      const affected = buildEncounterPreview(state)!;
      test.true_(affected.evadeChance < base.evadeChance, '动摇与疲劳降低规避率');
      test.true_(commanderEvadeModifier(state.commander, state.campaignSeed) < commanderEvadeModifier(createCampaign(813, '测试官', 'scout').commander, 813), '健康修正方向正确');
      test.true_(commanderSupplyUpkeepModifier(state.commander, state.campaignSeed) >= 0, '疲劳不会降低补给消耗');
      add(test);
    }

    {
      const test = new Case('确定性招募与候补名单');
      let state = createCampaign(814);
      const nodeId = state.sector.currentNodeId;
      const offerA = generateRecruitmentOffer(state, nodeId);
      const offerB = generateRecruitmentOffer(state, nodeId);
      test.eq(JSON.stringify(offerA), JSON.stringify(offerB), '相同状态生成相同候选人');
      state.pendingRecruitment = offerA;
      const supplies = state.resources.supplies;
      state = applyCampaignAction(state, { type: 'resolveRecruitment', candidateId: offerA.candidates[0].id });
      test.eq(state.reserveCommanders?.length, 1, '候选人加入候补名单');
      test.eq(state.resources.supplies, supplies - offerA.supplyCost, '招募消耗明确补给');
      test.true_(!state.pendingRecruitment, '招募后清理待处理状态');
      add(test);
    }

    {
      const test = new Case('治疗消耗补给并缓解伤病');
      let state = createCampaign(815);
      state.commander = addCommanderCondition(state.commander, state.campaignSeed, 'shaken', 2, 6);
      const supplies = state.resources.supplies;
      state = applyCampaignAction(state, { type: 'treatCommander' });
      const profile = ensureCommanderProfile(state.commander, state.campaignSeed);
      test.eq(state.turn, 1, '治疗消耗一个回合');
      test.eq(state.resources.supplies, supplies - 3, '治疗支付两点补给并承担一回合基础补给');
      test.true_(!profile.conditions.some((condition) => condition.id === 'shaken' && condition.severity >= 2), '治疗降低负面状态严重度');
      add(test);
    }

    {
      const test = new Case('三级创伤触发候补继任');
      let state = createCampaign(816);
      const reserve = createCommanderWithId(991, 'cmd-reserve-test', { name: '候补官', focus: 'survivor' });
      state.reserveCommanders = [reserve];
      state.commander = addCommanderInjury(state.commander, state.campaignSeed, 'trauma', 3, 1, '测试重伤');
      state = evaluateCampaignStatus(state);
      test.true_(state.pendingSuccession === true, '现任重伤时要求继任');
      const formerId = state.commander.id;
      state = applyCampaignAction(state, { type: 'appointCommander', commanderId: reserve.id });
      test.eq(state.commander.id, reserve.id, '候补成为现任指挥官');
      test.true_(!state.pendingSuccession, '继任完成后恢复行动');
      test.true_(!!state.reserveCommanders?.some((commander) => commander.id === formerId), '仍存活的重伤前任进入候补名单');
      add(test);
    }

    {
      const test = new Case('人员状态可存档往返且拒绝重复 ID');
      const state = createCampaign(817);
      const reserve = createCommanderWithId(992, 'cmd-roundtrip', { name: '往返候补', focus: 'tactician' });
      state.reserveCommanders = [reserve];
      state.pendingRecruitment = generateRecruitmentOffer(state, state.sector.currentNodeId);
      const decoded = decodeCampaign(encodeCampaign(state));
      test.eq(decoded.reserveCommanders?.[0].id, reserve.id, '候补名单通过 Campaign Code 往返');
      test.true_(!!decoded.pendingRecruitment?.candidates.length, '招募池通过 Campaign Code 往返');
      const duplicate = JSON.parse(JSON.stringify(state));
      duplicate.reserveCommanders[0].id = duplicate.commander.id;
      test.true_(!validateCampaignState(duplicate), '重复指挥官 ID 被深层校验拒绝');
      add(test);
    }

    {
      const test = new Case('燃料耗尽后可通过应急调配解除节点软锁');
      let state = createCampaign(1446551889);
      state.turn = 12;
      state.sector.currentNodeId = 's1-n12';
      const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
      current.visibility = 'visited';
      for (const neighborId of current.neighbors) {
        const neighbor = state.sector.nodes.find((node) => node.id === neighborId)!;
        if (neighbor.visibility === 'hidden') neighbor.visibility = 'detected';
      }
      state.resources.fuel = 0;
      state.resources.supplies = 8;
      state = applyCampaignAction(state, { type: 'scan' });
      const blocked = getAvailableCampaignActions(state);
      test.true_(!blocked.move, '燃料不足时相邻节点不可移动');
      test.true_(blocked.emergencyRefuel, '软锁状态提供应急燃料调配');
      const cost = movementFuelCost(state.fleet);
      const supplies = state.resources.supplies;
      state = applyCampaignAction(state, { type: 'emergencyRefuel' });
      test.true_(state.resources.fuel >= cost, '应急调配恢复至少一次移动所需燃料');
      test.true_(state.resources.supplies < supplies, '应急调配消耗补给');
      test.true_(getAvailableCampaignActions(state).move, '调配后相邻节点重新可点击');
      add(test);
    }

    {
      const test = new Case('指挥官死亡会终止战役');
      const state = createCampaign(818);
      state.commander = killCommander(state.commander, state.campaignSeed, state.turn, '测试致命事故');
      const ended = evaluateCampaignStatus(state);
      const profile = ensureCommanderProfile(ended.commander, ended.campaignSeed);
      test.eq(ended.status, 'defeat', '无候补时主指挥官死亡后战役失败');
      test.true_(!profile.alive, '死亡状态持久化');
      test.true_(profile.injuries.some((injury) => injury.id === 'fatal' && injury.cause === '测试致命事故'), '记录致命伤与原因');
      add(test);
    }

    {
      const test = new Case('舰队全歼会记录主指挥官死亡');
      const state = createCampaign(819);
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

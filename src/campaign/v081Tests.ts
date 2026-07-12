import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { decodeCampaign, encodeCampaign, validateCampaignState } from './campaignCode';
import { createCampaign } from './campaignGenerator';
import { applyCampaignAction } from './campaignReducer';
import {
  addCommanderCondition,
  applyBattleCommanderConsequences,
  isCommanderIncapacitated
} from './commander/commanderHealth';
import {
  generateRecruitmentOffer,
  MAX_RESERVE_COMMANDERS,
  shouldOfferRecruitment
} from './commander/commanderRecruitment';
import { createCommanderWithId, ensureCommanderProfile } from './commander/commanderSystem';

export function runV081Tests(): SuiteResult {
  return runSuite('campaign-v0.8.1', (add) => {
    {
      const test = new Case('每星域最多一次招募且候补越多越稀有');
      const state = createCampaign(821);
      const nodeId = 's1-recruit-test';
      test.true_(shouldOfferRecruitment(state, nodeId), '没有候补时首个合格信号保证提供招募');
      test.eq(generateRecruitmentOffer(state, nodeId).supplyCost, 2, '首名候补招募成本为 2');

      state.history.push({ turn: state.turn, text: '信号来源中发现可招募的指挥人员。' });
      test.true_(!shouldOfferRecruitment(state, 's1-second-signal'), '同一星域不会重复提供招募');

      state.sectorIndex = 2;
      state.history.push({ turn: 0, text: '进入第 2 星域；舰损、货舱和拖曳状态已保留。' });
      state.reserveCommanders = [createCommanderWithId(9001, 'cmd-v081-r1', { name: '候补一', focus: 'balanced' })];
      const oneReserveOffers = Array.from({ length: 64 }, (_, index) => `s2-candidate-${index}`)
        .filter((candidate) => shouldOfferRecruitment(state, candidate)).length;
      test.eq(generateRecruitmentOffer(state, nodeId).supplyCost, 3, '第二名候补招募成本提高到 3');

      state.reserveCommanders.push(createCommanderWithId(9002, 'cmd-v081-r2', { name: '候补二', focus: 'scout' }));
      const twoReserveOffers = Array.from({ length: 64 }, (_, index) => `s2-candidate-${index}`)
        .filter((candidate) => shouldOfferRecruitment(state, candidate)).length;
      test.eq(generateRecruitmentOffer(state, nodeId).supplyCost, 4, '第三名候补招募成本提高到 4');
      test.true_(oneReserveOffers > twoReserveOffers, '已有两名候补时招募机会进一步降低');

      state.reserveCommanders.push(createCommanderWithId(9003, 'cmd-v081-r3', { name: '候补三', focus: 'survivor' }));
      test.eq(state.reserveCommanders.length, MAX_RESERVE_COMMANDERS, '候补名单达到上限');
      test.true_(!shouldOfferRecruitment(state, 's2-over-cap'), '候补满员后不再生成招募');
      add(test);
    }

    {
      const test = new Case('临时负面状态有持续上限且一次治疗即可清除');
      let state = createCampaign(822);
      state.resources.supplies = 20;
      state.commander = addCommanderCondition(state.commander, state.campaignSeed, 'shaken', 3, 99);
      let profile = ensureCommanderProfile(state.commander, state.campaignSeed);
      const shaken = profile.conditions.find((condition) => condition.id === 'shaken');
      test.eq(shaken?.remainingTurns, 3, '动摇持续时间被限制为最多 3 回合');

      const supplies = state.resources.supplies;
      state = applyCampaignAction(state, { type: 'treatCommander' });
      profile = ensureCommanderProfile(state.commander, state.campaignSeed);
      test.eq(state.turn, 1, '治疗仍消耗一个回合');
      test.eq(state.resources.supplies, supplies - 3, '治疗支付 2 点医疗补给和 1 点常规回合补给');
      test.true_(!profile.conditions.some((condition) => condition.id === 'shaken'), '一次治疗清除临时动摇状态');
      add(test);
    }

    {
      const test = new Case('普通惨重损失不会立即强制继任');
      const state = createCampaign(823);
      const moderate = applyBattleCommanderConsequences(state.commander, state.campaignSeed, 4, 2, false);
      const moderateProfile = ensureCommanderProfile(moderate, state.campaignSeed);
      test.eq(moderateProfile.injuries.find((injury) => injury.id === 'trauma')?.severity, 2, '损失两舰产生二级创伤');
      test.true_(!isCommanderIncapacitated(moderate, state.campaignSeed), '二级创伤不会立即剥夺指挥权');

      const catastrophic = applyBattleCommanderConsequences(state.commander, state.campaignSeed, 4, 3, false);
      test.eq(ensureCommanderProfile(catastrophic, state.campaignSeed).injuries.find((injury) => injury.id === 'trauma')?.severity, 3, '损失三舰仍会产生三级创伤');
      test.true_(isCommanderIncapacitated(catastrophic, state.campaignSeed), '灾难性损失仍触发无法履职');
      add(test);
    }

    {
      const test = new Case('临时状态会在三个正常回合内自然消退');
      let state = createCampaign(824);
      state.resources.supplies = 30;
      state.commander = addCommanderCondition(state.commander, state.campaignSeed, 'fatigued', 2, 20);
      for (let turn = 0; turn < 3; turn++) state = applyCampaignAction(state, { type: 'wait' });
      const profile = ensureCommanderProfile(state.commander, state.campaignSeed);
      test.true_(!profile.conditions.some((condition) => condition.id === 'fatigued'), '疲劳在三个回合后自然移除');
      add(test);
    }

    {
      const test = new Case('指挥官系统可完成三星域战役烟雾流程');
      let state = createCampaign(825, '收口测试官', 'quartermaster');
      state.resources.supplies = 100;
      state.resources.fuel = 100;
      state.pendingRecruitment = generateRecruitmentOffer(state, state.sector.currentNodeId);
      state = applyCampaignAction(state, {
        type: 'resolveRecruitment',
        candidateId: state.pendingRecruitment.candidates[0].id
      });
      state.commander = addCommanderCondition(state.commander, state.campaignSeed, 'shaken', 2, 9);
      state = applyCampaignAction(state, { type: 'treatCommander' });

      for (let sector = 1; sector <= 3; sector++) {
        const gate = state.sector.nodes.find((node) => node.type === 'gate')!;
        state.sector.currentNodeId = gate.id;
        gate.visibility = 'visited';
        gate.processed = true;
        state.sector.gateKnown = true;
        state.sector.threat = { value: 0, level: 0 };
        state.resources.supplies = 100;
        state.resources.fuel = 100;
        state = applyCampaignAction(state, { type: 'enterGate', mode: 'normal' });
        if (sector < 3) {
          test.eq(state.sectorIndex, sector + 1, `第 ${sector} 次跃迁进入下一星域`);
          test.eq(state.status, 'active', '中途战役保持进行中');
        }
      }

      test.eq(state.status, 'victory', '第三次跃迁后战役胜利');
      test.eq(state.reserveCommanders?.length, 1, '候补名单跨三星域保持');
      test.true_(!ensureCommanderProfile(state.commander, state.campaignSeed).conditions.some((condition) => condition.id === 'shaken'), '治疗结果跨星域保持');
      const decoded = decodeCampaign(encodeCampaign(state));
      test.true_(validateCampaignState(decoded), '最终状态可通过 Campaign Code 往返和深层校验');
      add(test);
    }
  });
}

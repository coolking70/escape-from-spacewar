import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { addCargo, cargoUsed } from './cargo/cargoSystem';
import { decodeCampaign, encodeCampaign, migrateCampaignState, validateCampaignState } from './campaignCode';
import { createCampaign } from './campaignGenerator';
import {
  applyCampaignAction,
  evaluateCampaignStatus,
  getAvailableCampaignActions
} from './campaignReducer';
import { buildExtractionPlan } from './extraction/extractionSystem';
import {
  canResolveOrganizationEvent,
  generateOrganizationEvent
} from './organization/organizationEvents';
import {
  createOrganization,
  organizationGatherBonus,
  organizationTreatmentCost
} from './organization/organizationSystem';
import { TECHNOLOGY_DEFINITIONS } from './organization/technologySystem';
import { escapeHtml } from '../ui/html';
import { campaignResultPanel } from '../ui/campaignResultPanel';

function resolveNeutralOrganizationEvent(state: ReturnType<typeof createCampaign>) {
  if (!state.pendingOrganizationEvent) return state;
  const option = state.pendingOrganizationEvent.options.find((candidate) => !candidate.requiredValue)!;
  return applyCampaignAction(state, { type: 'resolveOrganizationEvent', optionId: option.id });
}

function moveDirectlyToGate(state: ReturnType<typeof createCampaign>) {
  const gate = state.sector.nodes.find((node) => node.type === 'gate')!;
  state.sector.currentNodeId = gate.id;
  gate.visibility = 'visited';
  gate.processed = true;
  state.sector.gateKnown = true;
  state.resources.fuel = Math.max(state.resources.fuel, 20);
  state.resources.supplies = Math.max(state.resources.supplies, 40);
  return state;
}

export function runV09Tests(): SuiteResult {
  return runSuite('campaign-v0.9', (add) => {
    {
      const test = new Case('组织创建确定且原型提供不同初始科技');
      const expeditionA = createCampaign(901, '远征官', 'balanced', {
        name: '阿尔法远征团',
        archetype: 'expedition',
        government: 'technocracy',
        values: ['knowledge', 'unity']
      });
      const expeditionB = createCampaign(901, '远征官', 'balanced', {
        name: '阿尔法远征团',
        archetype: 'expedition',
        government: 'technocracy',
        values: ['knowledge', 'unity']
      });
      const commerce = createCampaign(901, '商贸官', 'balanced', {
        name: '航路联合体',
        archetype: 'commerce',
        government: 'corporateBoard',
        values: ['profit', 'freedom']
      });
      test.eq(JSON.stringify(expeditionA.organization), JSON.stringify(expeditionB.organization), '相同输入生成相同组织');
      test.true_(expeditionA.organization.research.installed.includes('deepSensorArray'), '远征舰队初始装配深空传感阵列');
      test.true_(commerce.organization.research.installed.includes('modularCargo'), '商贸联合体初始装配模块化货舱');
      test.eq(commerce.cargo.capacity, expeditionA.cargo.capacity + 4, '模块化货舱提高起始容量');
      add(test);
    }

    {
      const test = new Case('旧 0.2 存档迁移到 0.3 组织格式');
      const raw: any = JSON.parse(JSON.stringify(createCampaign(902)));
      raw.version = '0.2';
      delete raw.organization;
      delete raw.pendingOrganizationEvent;
      const migrated = migrateCampaignState(raw)!;
      test.eq(migrated.version, '0.3', '迁移升级版本');
      test.eq(migrated.organization.archetype, 'expedition', '旧存档获得稳定默认组织');
      test.eq(migrated.organization.values.length, 2, '迁移补齐两项价值观');
      test.true_(migrated.history.some((entry) => entry.text.includes('V0.9')), '迁移历史可追踪');
      test.true_(validateCampaignState(migrated), '迁移结果通过深层校验');
      add(test);
    }

    {
      const test = new Case('Campaign Code 0.3 往返并拒绝非法组织');
      const state = createCampaign(903, '组织官', 'tactician', {
        name: '边疆议会',
        archetype: 'exile',
        government: 'captainsAssembly',
        values: ['survival', 'unity']
      });
      const decoded = decodeCampaign(encodeCampaign(state));
      test.eq(decoded.version, '0.3', 'Campaign Code 使用 0.3');
      test.eq(decoded.organization.name, '边疆议会', '组织身份完整往返');
      const duplicateValues = JSON.parse(JSON.stringify(state));
      duplicateValues.organization.values = ['survival', 'survival'];
      test.true_(!validateCampaignState(duplicateValues), '重复价值观被拒绝');
      const lockedInstalled = JSON.parse(JSON.stringify(state));
      lockedInstalled.organization.research.installed.push('jumpCalibration');
      test.true_(!validateCampaignState(lockedInstalled), '未解锁科技不能装配');
      const currentFormatCorrupt = JSON.parse(JSON.stringify(state));
      currentFormatCorrupt.organization.values = ['survival', 'survival'];
      test.eq(migrateCampaignState(currentFormatCorrupt), null, '当前版本损坏存档不会被静默规范化');
      add(test);
    }

    {
      const test = new Case('组织原型与研究资源接入战役行动');
      let state = createCampaign(904, '研究官', 'scout', {
        name: '技术远征队',
        archetype: 'expedition',
        government: 'technocracy',
        values: ['knowledge', 'unity']
      });
      const beforeThreat = state.sector.threat.value;
      state = applyCampaignAction(state, { type: 'scan' });
      test.eq(state.sector.threat.value, beforeThreat, '远征原型与深空传感阵列抵消扫描威胁');
      test.eq(state.organization.research.resources.navigation, 4, '扫描按原型、政体和价值观获得航行数据');

      const commerce = createOrganization(905, {
        name: '贸易董事会',
        archetype: 'commerce',
        government: 'corporateBoard',
        values: ['profit', 'freedom']
      });
      test.eq(organizationGatherBonus(commerce).materials, 3, '商业原型、董事会和利润价值观叠加采集奖励');
      add(test);
    }

    {
      const test = new Case('科技可解锁装配且货舱超载时不能卸下');
      let state = createCampaign(906, '工程官', 'quartermaster', {
        name: '工程试验团',
        archetype: 'expedition',
        government: 'technocracy',
        values: ['knowledge', 'order']
      });
      state.organization.research.resources.engineering = TECHNOLOGY_DEFINITIONS.modularCargo.cost.engineering!;
      const baseCapacity = state.cargo.capacity;
      state = applyCampaignAction(state, { type: 'unlockTechnology', technologyId: 'modularCargo' });
      test.true_(state.organization.research.unlocked.includes('modularCargo'), '研究资源足够时解锁科技');
      state = applyCampaignAction(state, { type: 'installTechnology', technologyId: 'modularCargo' });
      test.eq(state.cargo.capacity, baseCapacity + 4, '装配后货舱容量立即提高');
      state.cargo = addCargo(state.cargo, [{ type: 'supplyCrate', quantity: baseCapacity + 2 }]).cargo;
      state = applyCampaignAction(state, { type: 'uninstallTechnology', technologyId: 'modularCargo' });
      test.true_(state.organization.research.installed.includes('modularCargo'), '超出基础容量时拒绝卸下货舱科技');
      test.true_(cargoUsed(state.cargo) > baseCapacity, '拒绝卸载时货物保持不变');
      add(test);
    }

    {
      const test = new Case('组织事件确定、价值观受限且阻塞其他行动');
      let state = createCampaign(907, '议事官', 'balanced', {
        name: '自由求生团',
        archetype: 'exile',
        government: 'captainsAssembly',
        values: ['freedom', 'survival']
      });
      const first = generateOrganizationEvent(state);
      const second = generateOrganizationEvent(state);
      test.eq(JSON.stringify(first), JSON.stringify(second), '相同状态生成相同组织事件');
      state.pendingOrganizationEvent = first;
      const required = first.options.find((option) => option.requiredValue)!;
      const neutral = first.options.find((option) => !option.requiredValue)!;
      test.true_(!canResolveOrganizationEvent(state, required), '缺少价值观时专属选项不可用');
      test.true_(canResolveOrganizationEvent(state, neutral), '中立选项始终可处理');
      const available = getAvailableCampaignActions(state);
      test.true_(!available.move && !available.scan && !available.wait, '待处理组织事件阻塞常规行动');
      state = applyCampaignAction(state, { type: 'resolveOrganizationEvent', optionId: neutral.id });
      test.true_(!state.pendingOrganizationEvent, '选择后清理组织事件');
      add(test);
    }

    {
      const test = new Case('跨星域产生组织事件且跃迁科技降低燃料');
      let state = createCampaign(908, '航行官', 'scout', {
        name: '深空校准局',
        archetype: 'expedition',
        government: 'technocracy',
        values: ['knowledge', 'order']
      });
      state.organization.research.resources.navigation = TECHNOLOGY_DEFINITIONS.jumpCalibration.cost.navigation!;
      state = applyCampaignAction(state, { type: 'unlockTechnology', technologyId: 'jumpCalibration' });
      state = applyCampaignAction(state, { type: 'installTechnology', technologyId: 'jumpCalibration' });
      moveDirectlyToGate(state);
      test.eq(buildExtractionPlan(state).fuelCost, 0, '跃迁校准降低基础跃迁燃料至零');
      state = applyCampaignAction(state, { type: 'enterGate', mode: 'normal' });
      test.eq(state.sectorIndex, 2, '进入第二星域');
      test.true_(!!state.pendingOrganizationEvent, '跨星域生成组织决策');
      test.true_(state.organization.research.resources.navigation >= 4, '跃迁获得航行研究数据');
      add(test);
    }

    {
      const test = new Case('流亡组织治疗成本降低且稳定度归零失败');
      let state = createCampaign(909, '医疗官', 'survivor', {
        name: '流亡救护团',
        archetype: 'exile',
        government: 'emergencyDirectorate',
        values: ['survival', 'unity']
      });
      test.eq(organizationTreatmentCost(state.organization), 1, '流亡、生存和创伤救治组合将医疗成本降至下限');
      state.organization.stability = 0;
      state = evaluateCampaignStatus(state);
      test.eq(state.status, 'defeat', '组织稳定度归零导致战役失败');
      add(test);
    }

    {
      const test = new Case('终局、待决事件与 HTML 渲染边界一致');
      const terminal = createCampaign(911, '终局官', 'balanced');
      terminal.status = 'victory';
      terminal.organization.research.resources.engineering = TECHNOLOGY_DEFINITIONS.modularCargo.cost.engineering!;
      const afterTechnology = applyCampaignAction(terminal, {
        type: 'unlockTechnology',
        technologyId: 'modularCargo'
      });
      test.true_(!afterTechnology.organization.research.unlocked.includes('modularCargo'), '终局后不能解锁科技');

      const terminalEvent = createCampaign(912, '终局事件官', 'balanced');
      terminalEvent.pendingOrganizationEvent = generateOrganizationEvent(terminalEvent);
      terminalEvent.status = 'defeat';
      test.true_(!validateCampaignState(terminalEvent), '终局状态不能保留待处理组织事件');

      const escaped = escapeHtml('<img src=x onerror=alert(1)>');
      test.true_(!escaped.includes('<img'), '导入文本会被转义而非成为标签');
      const logged = createCampaign(913, '日志官', 'balanced');
      logged.status = 'defeat';
      logged.history.push({ turn: 0, text: '<script>bad()</script>' });
      test.true_(!campaignResultPanel(logged, true).includes('<script>'), '结算完整日志会转义导入文本');
      add(test);
    }

    {
      const test = new Case('V0.9 组织事件可贯穿完整三星域流程');
      let state = createCampaign(910, '总指挥', 'balanced', {
        name: '联合远征议会',
        archetype: 'expedition',
        government: 'captainsAssembly',
        values: ['knowledge', 'unity']
      });
      for (let sector = 1; sector <= 3; sector++) {
        moveDirectlyToGate(state);
        state = applyCampaignAction(state, { type: 'enterGate', mode: 'normal' });
        state = resolveNeutralOrganizationEvent(state);
      }
      test.eq(state.status, 'victory', '第三星域结束后胜利');
      test.true_(state.organization.research.resources.navigation >= 12, '三次跃迁累计航行数据');
      const decoded = decodeCampaign(encodeCampaign(state));
      test.true_(validateCampaignState(decoded), 'V0.9 最终状态可存档往返');
      add(test);
    }
  });
}

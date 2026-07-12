import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { addCargo, cargoUsed } from './cargo/cargoSystem';
import { migrateCampaignState, validateCampaignState } from './campaignCode';
import { createCampaign } from './campaignGenerator';
import { applyCampaignAction } from './campaignReducer';
import { defaultDeployment } from './deployment/deploymentSystem';
import { enemyFleetFor, prepareCampaignBattle } from './fleet/battleAdapter';
import { assessEncounter, campaignFleetEntryCost, campaignFleetPower, campaignShipCost } from './fleet/campaignPower';
import { buildEncounterPreview } from './fleet/encounterControl';
import { orderTeamRetreat, shouldOrderCampaignRetreat } from './fleet/campaignRuntimeControls';
import { ensurePersistentComponentHp } from './repair/repairSystem';
import { generatePendingSalvage } from './salvage/salvageGenerator';
import { generateSector, isReachable } from './sector/sectorGenerator';

export function runV071Tests(): SuiteResult {
  return runSuite('campaign-v0.7.1', (add) => {
    {
      const test = new Case('标准舰体成本按舰级区分');
      test.eq(campaignShipCost('Fighter', 'standard'), 50, '标准战斗机成本');
      test.eq(campaignShipCost('Frigate', 'standard'), 150, '标准护卫舰成本');
      test.eq(campaignShipCost('Cruiser', 'standard'), 360, '标准巡洋舰成本');
      add(test);
    }

    {
      const test = new Case('普通遭遇受当前舰队战力上限约束');
      const state = createCampaign(701);
      const power = campaignFleetPower(state.fleet);
      const enemy = enemyFleetFor(701, 1, 0, false, power);
      const enemyPower = campaignFleetEntryCost(enemy);
      test.true_(enemyPower <= power * 1.15, '第一星域普通敌军不超过我方 1.15 倍');
      test.true_(assessEncounter(power, enemyPower).ratio <= 1.15, '风险评估与预算一致');
      add(test);
    }

    {
      const test = new Case('遭遇评估和规避结果确定');
      const state = createCampaign(702);
      state.pendingBattle = {
        nodeId: state.sector.nodes[1].id,
        originNodeId: state.sector.currentNodeId,
        battleIndex: 3,
        reason: '测试遭遇',
        deployment: defaultDeployment(state.fleet),
        retreatPolicy: 'loss50'
      };
      const first = buildEncounterPreview(state)!;
      const second = buildEncounterPreview(state)!;
      test.eq(JSON.stringify(first), JSON.stringify(second), '相同状态得到相同评估和规避掷值');
      test.true_(first.evadeChance >= 10 && first.evadeChance <= 85, '规避概率在公开范围内');
      add(test);
    }

    {
      const test = new Case('战前退回消耗燃料并解除遭遇');
      let state = createCampaign(703);
      const origin = state.sector.currentNodeId;
      const target = state.sector.nodes.find((node) => node.depth === 1)!;
      state.sector.currentNodeId = target.id;
      state.pendingBattle = {
        nodeId: target.id,
        originNodeId: origin,
        battleIndex: 1,
        reason: '测试遭遇',
        deployment: defaultDeployment(state.fleet),
        retreatPolicy: 'loss50'
      };
      const fuel = state.resources.fuel;
      state = applyCampaignAction(state, { type: 'withdrawBeforeBattle' });
      test.eq(state.sector.currentNodeId, origin, '返回上一节点');
      test.eq(state.resources.fuel, fuel - 1, '消耗一点燃料');
      test.true_(!state.pendingBattle, '解除待处理战斗');
      add(test);
    }

    {
      const test = new Case('手动与自动全舰撤退命令');
      const state = createCampaign(704);
      const power = campaignFleetPower(state.fleet);
      const context = prepareCampaignBattle(state.fleet, enemyFleetFor(704, 1, 0, false, power), 704);
      test.true_(!shouldOrderCampaignRetreat(context.state, 'loss50', context.bindings.length), '无损失时不自动撤退');
      const ordered = orderTeamRetreat(context.state);
      test.eq(ordered, context.bindings.length, '全部可机动我方舰收到撤退命令');
      test.true_(context.state.ships.filter((ship) => ship.team === 'A').every((ship) => ship.retreatStartedTick === 0), '撤退起始 tick 写入状态');
      add(test);
    }

    {
      const test = new Case('分层星图具有多路线和前期保护');
      const sector = generateSector(705, 1);
      const start = sector.nodes.find((node) => node.type === 'start')!;
      const gate = sector.nodes.find((node) => node.type === 'gate')!;
      test.true_(sector.nodes.length >= 20 && sector.nodes.length <= 30, '节点总量保持 20 至 30');
      test.true_(new Set(sector.nodes.map((node) => node.depth)).size >= 7, '至少七个视觉层级');
      test.true_(start.neighbors.length >= 2, '起点至少分出两条路线');
      test.true_(gate.neighbors.length >= 2, '星门至少有两条接近路线');
      test.true_(isReachable(sector, start.id, gate.id), '起点可到达星门');
      test.true_(sector.nodes.some((node) => node.depth === 1 && node.type === 'resource'), '早期保证资源节点');
      test.true_(sector.nodes.some((node) => node.feature === 'rescue'), '第一星域保证救援机会');
      test.true_(!sector.nodes.some((node) => node.depth <= 2 && node.type === 'battle'), '前两层不生成强制战斗节点');
      add(test);
    }

    {
      const test = new Case('失能敌舰可回收并维修复役');
      let state = createCampaign(706);
      const disabledEnemy = {
        id: 99,
        team: 'B',
        type: 'Fighter',
        variant: 'interceptor',
        combatState: 'disabled'
      } as any;
      state.pendingSalvage = generatePendingSalvage(
        state.campaignSeed,
        state.sectorIndex,
        state.sector.currentNodeId,
        4,
        { ships: [disabledEnemy] } as any,
        3,
        3
      );
      test.true_(state.pendingSalvage.options.some((option) => option.id === 'recover'), '出现回收失能敌舰选项');
      state = applyCampaignAction(state, { type: 'resolveSalvage', optionId: 'recover' });
      const recovered = state.fleet.ships.find((ship) => ship.campaignShipId.includes('recovered'))!;
      test.true_(recovered.disabled && recovered.towed, '回收舰以失能拖曳状态加入');
      state.cargo = addCargo(state.cargo, [{ type: 'repairParts', quantity: 1 }]).cargo;
      state = applyCampaignAction(state, { type: 'fieldRepair', campaignShipId: recovered.campaignShipId });
      const repaired = state.fleet.ships.find((ship) => ship.campaignShipId === recovered.campaignShipId)!;
      test.true_(!repaired.disabled && !repaired.towed, '维修后恢复作战能力');
      add(test);
    }

    {
      const test = new Case('旧星图存档迁移区域和深度字段');
      const legacy: any = JSON.parse(JSON.stringify(createCampaign(707)));
      for (const node of legacy.sector.nodes) {
        delete node.region;
        delete node.depth;
      }
      const migrated = migrateCampaignState(legacy)!;
      test.true_(migrated.sector.nodes.every((node) => !!node.region && Number.isInteger(node.depth)), '迁移后补齐星图结构字段');
      test.true_(validateCampaignState(migrated), '迁移状态通过深层校验');
      add(test);
    }

    {
      const test = new Case('星域总结使用货物重量而非件数');
      let state = createCampaign(708);
      state.cargo = addCargo(state.cargo, [{ type: 'relic', quantity: 2 }]).cargo;
      const gate = state.sector.nodes.find((node) => node.type === 'gate')!;
      state.sector.currentNodeId = gate.id;
      gate.visibility = 'visited';
      gate.processed = true;
      state = applyCampaignAction(state, { type: 'enterGate', mode: 'normal' });
      test.eq(state.lastSectorSummary?.cargoUsed, cargoUsed(state.cargo), '总结载荷与货舱重量口径一致');
      add(test);
    }
  });
}

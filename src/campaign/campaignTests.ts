import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { createCampaign } from './campaignGenerator';
import {
  applyCampaignAction,
  evaluateCampaignStatus,
  getAvailableCampaignActions
} from './campaignReducer';
import { decodeCampaign, encodeCampaign, validateCampaignState } from './campaignCode';
import { generateSector, isReachable } from './sector/sectorGenerator';
import {
  enemyBudgetFor,
  enemyFleetFor,
  deriveBattleSeed,
  prepareCampaignBattle,
  runCampaignBattle
} from './fleet/battleAdapter';
import { validateFleet } from '../sim/fleetValidator';
import { clearCampaign, loadCampaign, saveCampaign } from './campaignPersistence';
import {
  hazardOutcome,
  resourceReward,
  signalOptions,
  signalTemplate
} from './sector/sectorActions';
import { addThreat } from './sector/threatSystem';
import { createStarterFleet } from './fleet/persistentFleet';
import { importBattleResult } from './fleet/battleResultImporter';
import { visibleSectorGraph } from './sector/sectorVisibility';

function firstNeighbor(state: ReturnType<typeof createCampaign>): string {
  return state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!.neighbors[0];
}

export function runCampaignTests(): SuiteResult {
  return runSuite('campaign', (add) => {
    const sectorA = generateSector(42, 1);
    const sectorB = generateSector(42, 1);
    const sectorC = generateSector(43, 1);

    {
      const test = new Case('确定性星域生成与图约束');
      const signature = (sector: typeof sectorA) =>
        JSON.stringify(sector.nodes.map((node) => [node.id, node.type, node.neighbors]));
      test.eq(signature(sectorA), signature(sectorB), '相同 seed 生成相同星域');
      test.true_(signature(sectorA) !== signature(sectorC), '不同 seed 通常生成不同星域');
      test.true_(sectorA.nodes.length >= 20 && sectorA.nodes.length <= 30, '节点数在 20~30');
      test.eq(sectorA.nodes.filter((node) => node.type === 'start').length, 1, '起点唯一');
      test.eq(sectorA.nodes.filter((node) => node.type === 'gate').length, 1, '星门唯一');
      test.true_(
        isReachable(
          sectorA,
          sectorA.currentNodeId,
          sectorA.nodes.find((node) => node.type === 'gate')!.id
        ),
        '星门可达'
      );
      test.true_(
        sectorA.nodes.every((node) => isReachable(sectorA, sectorA.currentNodeId, node.id)),
        '无孤立节点'
      );
      add(test);
    }

    {
      const test = new Case('移动、燃料与扫描');
      let state = createCampaign(7);
      const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
      const nonNeighbor = state.sector.nodes.find(
        (node) => ![state.sector.currentNodeId, ...current.neighbors].includes(node.id)
      )!;
      test.eq(
        applyCampaignAction(state, { type: 'move', targetNodeId: nonNeighbor.id }).sector.currentNodeId,
        state.sector.currentNodeId,
        '只能移动相邻节点'
      );
      state.resources.fuel = 0;
      test.eq(
        applyCampaignAction(state, { type: 'move', targetNodeId: firstNeighbor(state) }).sector.currentNodeId,
        state.sector.currentNodeId,
        '燃料不足不能移动'
      );
      state = createCampaign(7);
      const scanned = applyCampaignAction(state, { type: 'scan' });
      test.true_(scanned.sector.nodes.some((node) => node.visibility === 'scanned'), '扫描提升可见度');
      add(test);
    }

    {
      const test = new Case('资源、威胁与敌军确定性');
      let state = createCampaign(9);
      const resource = state.sector.nodes.find((node) => node.type === 'resource')!;
      const start = state.sector.nodes.find((node) => node.type === 'start')!;
      start.neighbors.push(resource.id);
      resource.neighbors.push(start.id);
      state = applyCampaignAction(state, { type: 'move', targetNodeId: resource.id });
      const gathered = applyCampaignAction(state, { type: 'gather' });
      const again = applyCampaignAction(gathered, { type: 'gather' });
      test.true_(gathered.sector.threat.value > state.sector.threat.value, '采集提高威胁');
      test.eq(
        JSON.stringify(resourceReward(state, resource.id)),
        JSON.stringify(resourceReward(state, resource.id)),
        '节点资源收益确定'
      );
      test.eq(again.resources.materials, gathered.resources.materials, '资源不能无限采集');
      test.eq(addThreat({ value: 9, level: 1 }, 1).level, 2, '威胁等级效果确定');
      const enemyA = enemyFleetFor(100, 1, 2);
      const enemyB = enemyFleetFor(100, 1, 2);
      test.eq(JSON.stringify(enemyA), JSON.stringify(enemyB), '敌军生成确定');
      test.true_(validateFleet(enemyA).valid, '敌军 FleetEntry 合法');
      test.eq(deriveBattleSeed(1, 2, 'n', 3), deriveBattleSeed(1, 2, 'n', 3), '战斗 seed 稳定');
      add(test);
    }

    {
      const test = new Case('星门、胜利与 Campaign Code');
      let state = createCampaign(3);
      for (let sector = 1; sector <= 3; sector++) {
        const gate = state.sector.nodes.find((node) => node.type === 'gate')!;
        const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
        current.neighbors.push(gate.id);
        gate.neighbors.push(current.id);
        state = applyCampaignAction(state, { type: 'move', targetNodeId: gate.id });
        state = applyCampaignAction(state, { type: 'enterGate' });
      }
      test.eq(state.status, 'victory', '第三星域撤离后胜利');
      const roundTrip = decodeCampaign(encodeCampaign(createCampaign(99)));
      test.eq(roundTrip.campaignSeed, 99, 'Campaign Code 往返');
      let wrongType = false;
      try {
        decodeCampaign('eyJ0eXBlIjoic3BhY2V3YXItZmxlZXQifQ');
      } catch (error) {
        wrongType = String(error).includes('舰队方案码');
      }
      test.true_(wrongType, '错误 Code 类型明确拒绝');
      add(test);
    }

    {
      const test = new Case('相同行动序列保持确定性');
      const run = () => {
        let state = createCampaign(555);
        state = applyCampaignAction(state, { type: 'scan' });
        state = applyCampaignAction(state, { type: 'wait' });
        state = applyCampaignAction(state, { type: 'move', targetNodeId: firstNeighbor(state) });
        return JSON.stringify(state);
      };
      test.eq(run(), run(), '相同 seed 和行动序列结果一致');
      add(test);
    }

    {
      const test = new Case('本地存档损坏安全报错');
      const store = new Map<string, string>();
      (globalThis as any).localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key)
      };
      saveCampaign(createCampaign(15));
      test.eq(loadCampaign()?.campaignSeed, 15, '本地存档可读取');
      store.set('spacewar.campaign.current.v1', '{坏数据');
      let threw = false;
      try {
        loadCampaign();
      } catch {
        threw = true;
      }
      test.true_(threw, '损坏存档安全报错');
      clearCampaign();
      add(test);
    }

    {
      const test = new Case('战斗结果写回保持战役舰船语义');
      const fleet = createStarterFleet();
      const battle = {
        ships: [
          { id: 0, team: 'A', combatState: 'destroyed', components: [] },
          { id: 1, team: 'A', combatState: 'escaped', components: [{ hp: 3 }] },
          { id: 2, team: 'A', combatState: 'disabled', components: [{ hp: 2 }] }
        ]
      } as any;
      const next = importBattleResult(fleet, battle, [
        { campaignShipId: 'cs-0', battleShipId: 0 },
        { campaignShipId: 'cs-1', battleShipId: 1 },
        { campaignShipId: 'cs-2', battleShipId: 2 }
      ]);
      test.eq(next.ships.length, 2, 'destroyed 舰船移除');
      test.true_(next.ships.some((ship) => ship.campaignShipId === 'cs-1' && ship.escaped), 'escaped 舰船保留');
      test.true_(next.ships.some((ship) => ship.campaignShipId === 'cs-2' && ship.disabled), 'disabled 舰船保留并标记');
      test.true_(next.ships.every((ship) => ship.campaignShipId.startsWith('cs-')), 'campaignShipId 战斗前后稳定');
      add(test);
    }

    {
      const test = new Case('多舰同改型绑定与组件继承');
      const fleet = createStarterFleet();
      fleet.ships[1] = {
        ...fleet.ships[1],
        campaignShipId: 'cs-dup',
        variant: 'standard',
        componentHp: [1, 2, 3, 4]
      };
      const enemy = enemyFleetFor(88, 1, 0);
      const context = prepareCampaignBattle(fleet, enemy, 88);
      test.eq(context.bindings.length, 3, '所有可参战舰船均有 binding');
      test.eq(new Set(context.bindings.map((binding) => binding.campaignShipId)).size, 3, '同改型绑定保持唯一');
      const binding = context.bindings.find((item) => item.campaignShipId === 'cs-dup')!;
      const ship = context.state.ships.find((item) => item.id === binding.battleShipId)!;
      test.eq(ship.components[0].hp, 1, '下一战继承上一战组件损伤');
      const result = runCampaignBattle(fleet, enemy, 88);
      test.true_(result.state.finished, '无头战斗仅用于测试可正常结束');
      add(test);
    }

    {
      const test = new Case('迷雾、终局与敌军预算');
      const state = createCampaign(33);
      const graph = visibleSectorGraph(state.sector);
      test.true_(
        graph.edges.every(
          ([left, right]) =>
            state.sector.nodes.find((node) => node.id === left)!.visibility !== 'hidden' &&
            state.sector.nodes.find((node) => node.id === right)!.visibility !== 'hidden'
        ),
        '隐藏节点和边不会出现在可见图'
      );
      const ended = { ...state, status: 'victory' as const };
      test.eq(applyCampaignAction(ended, { type: 'wait' }).turn, ended.turn, '胜利后行动被拒绝');
      test.true_(enemyBudgetFor(3, 0) > enemyBudgetFor(2, 0), '高星域预算递增');
      test.true_(enemyBudgetFor(2, 4) >= enemyBudgetFor(2, 0), '威胁不降低预算');
      test.true_(enemyBudgetFor(2, 1, true) > enemyBudgetFor(2, 1), '星门守卫强于普通战斗');
      add(test);
    }

    {
      const test = new Case('信号与危险模板完整且确定');
      const signals = new Set<string>();
      const hazards = new Set<string>();
      for (let seed = 0; seed < 300 && (signals.size < 5 || hazards.size < 3); seed++) {
        const state = createCampaign(seed);
        const nodeId = state.sector.nodes.find((node) => node.type === 'signal')!.id;
        const signal = signalTemplate(state, nodeId);
        signals.add(signal);
        test.eq(signalOptions(state, nodeId).length, 2, `${signal} 有两个选项`);
        test.eq(
          JSON.stringify(signalOptions(state, nodeId)),
          JSON.stringify(signalOptions(state, nodeId)),
          '信号选项确定'
        );
        const hazard = hazardOutcome(state, nodeId);
        hazards.add(hazard.name);
        test.eq(
          JSON.stringify(hazard),
          JSON.stringify(hazardOutcome(state, nodeId)),
          `${hazard.name} 结算确定`
        );
      }
      test.eq(signals.size, 5, '五个信号模板均可生成');
      test.eq(hazards.size, 3, '三类 hazard 均可生成');
      add(test);
    }

    {
      const test = new Case('资源耗尽失败与可用行动统一');
      const stranded = createCampaign(76);
      stranded.resources.supplies = 0;
      stranded.resources.fuel = 0;
      const current = stranded.sector.nodes.find((node) => node.id === stranded.sector.currentNodeId)!;
      current.type = 'empty';
      current.processed = true;
      current.neighbors = [];
      test.true_(!getAvailableCampaignActions(stranded).wait, '补给耗尽时等待不可用');
      test.eq(evaluateCampaignStatus(stranded).status, 'defeat', '资源耗尽且无有效行动时失败');

      const recoverable = createCampaign(77);
      recoverable.resources.supplies = 0;
      recoverable.resources.fuel = 0;
      const recoverableNode = recoverable.sector.nodes.find(
        (node) => node.id === recoverable.sector.currentNodeId
      )!;
      recoverableNode.type = 'resource';
      recoverableNode.gathered = false;
      test.true_(getAvailableCampaignActions(recoverable).gather, '当前资源节点仍可采集');
      test.eq(evaluateCampaignStatus(recoverable).status, 'active', '存在有效行动时不提前失败');
      add(test);
    }

    {
      const test = new Case('高威胁存档与深层损坏校验');
      for (const value of [30, 50, 100]) {
        const state = createCampaign(value);
        state.sector.threat = { value, level: 5 };
        test.true_(validateCampaignState(state), `威胁 ${value} 的合法状态可校验`);
        test.eq(decodeCampaign(encodeCampaign(state)).sector.threat.value, value, `威胁 ${value} 可往返`);
      }

      const valid = createCampaign(66);
      const duplicate = JSON.parse(JSON.stringify(valid));
      duplicate.fleet.ships.push({ ...duplicate.fleet.ships[0] });
      const badEdge = JSON.parse(JSON.stringify(valid));
      badEdge.sector.nodes[0].neighbors.push('missing-node');
      let duplicateRejected = false;
      let edgeRejected = false;
      try {
        encodeCampaign(duplicate);
      } catch {
        duplicateRejected = true;
      }
      try {
        encodeCampaign(badEdge);
      } catch {
        edgeRejected = true;
      }
      test.true_(duplicateRejected, '重复 campaignShipId 被拒绝');
      test.true_(edgeRejected, '非法节点连线被拒绝');
      add(test);
    }

    {
      const test = new Case('hazard 可损伤初始舰队');
      let state = createCampaign(91);
      const hazard = state.sector.nodes.find((node) => node.type === 'hazard')!;
      const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
      if (!current.neighbors.includes(hazard.id)) current.neighbors.push(hazard.id);
      if (!hazard.neighbors.includes(current.id)) hazard.neighbors.push(current.id);
      test.true_(state.fleet.ships.every((ship) => ship.componentHp === undefined), '初始舰队尚未初始化组件 HP');
      state = applyCampaignAction(state, { type: 'move', targetNodeId: hazard.id });
      test.true_(state.fleet.ships.some((ship) => Array.isArray(ship.componentHp)), 'hazard 初始化并损伤组件 HP');
      test.true_(state.sector.nodes.find((node) => node.id === hazard.id)!.hazardResolved === true, 'hazard 只结算一次');
      add(test);
    }
  });
}

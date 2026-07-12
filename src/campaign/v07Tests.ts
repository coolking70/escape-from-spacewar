import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { addCargo, cargoQuantity, cargoUsed } from './cargo/cargoSystem';
import { migrateCampaignState, validateCampaignState } from './campaignCode';
import { createCampaign } from './campaignGenerator';
import { applyCampaignAction } from './campaignReducer';
import { defaultDeployment } from './deployment/deploymentSystem';
import { buildExtractionPlan } from './extraction/extractionSystem';
import { enemyFleetFor, prepareCampaignBattle } from './fleet/battleAdapter';
import { activeShips, movementFuelCost } from './fleet/persistentFleet';
import { ensurePersistentComponentHp } from './repair/repairSystem';
import { generatePendingSalvage } from './salvage/salvageGenerator';

function moveToGate(state: ReturnType<typeof createCampaign>) {
  const gate = state.sector.nodes.find((node) => node.type === 'gate')!;
  state.sector.currentNodeId = gate.id;
  gate.visibility = 'visited';
  gate.processed = true;
  return state;
}

export function runV07Tests(): SuiteResult {
  return runSuite('campaign-v0.7', (add) => {
    {
      const test = new Case('货舱容量与溢出');
      const transfer = addCargo(
        { capacity: 5, items: [] },
        [
          { type: 'repairParts', quantity: 4 },
          { type: 'relic', quantity: 1 }
        ]
      );
      test.eq(cargoUsed(transfer.cargo), 4, '只接受容量内物资');
      test.eq(cargoQuantity(transfer.cargo, 'repairParts'), 4, '普通物资进入货舱');
      test.eq(transfer.rejected[0]?.type, 'relic', '超重遗物被拒绝');
      add(test);
    }

    {
      const test = new Case('V0.6 存档迁移到 0.2');
      const current = createCampaign(101);
      const legacy: any = JSON.parse(JSON.stringify(current));
      legacy.version = '0.1';
      delete legacy.cargo;
      delete legacy.pendingSalvage;
      delete legacy.extractionPrepared;
      delete legacy.lastSectorSummary;
      for (const ship of legacy.fleet.ships) {
        delete ship.towed;
        delete ship.deployed;
      }
      const migrated = migrateCampaignState(legacy)!;
      test.eq(migrated.version, '0.2', '迁移后版本正确');
      test.eq(migrated.cargo.capacity, 18, '迁移后获得默认货舱');
      test.true_(migrated.fleet.ships.every((ship) => ship.towed === false), '旧舰船补充拖曳状态');
      test.true_(migrated.fleet.ships.every((ship) => ship.deployed !== false), '旧舰船默认允许部署');
      test.true_(validateCampaignState(migrated), '迁移结果通过深层校验');
      add(test);
    }

    {
      const test = new Case('战后打捞生成确定');
      const battle = {
        ships: [
          { team: 'B', combatState: 'destroyed' },
          { team: 'B', combatState: 'disabled' },
          { team: 'A', combatState: 'active' }
        ]
      } as any;
      const first = generatePendingSalvage(5, 2, 'node', 7, battle, 3, 2);
      const second = generatePendingSalvage(5, 2, 'node', 7, battle, 3, 2);
      test.eq(JSON.stringify(first), JSON.stringify(second), '相同输入得到相同打捞方案');
      test.eq(first.options.length, 3, '提供快速、完整和离开三种选择');
      test.true_(
        first.options.find((option) => option.id === 'thorough')!.threat >
          first.options.find((option) => option.id === 'quick')!.threat,
        '完整打捞风险更高'
      );
      add(test);
    }

    {
      const test = new Case('打捞决策进入货舱');
      let state = createCampaign(202);
      state.pendingSalvage = generatePendingSalvage(
        202,
        1,
        state.sector.currentNodeId,
        1,
        { ships: [] } as any,
        3,
        3
      );
      const before = state.turn;
      state = applyCampaignAction(state, { type: 'resolveSalvage', optionId: 'quick' });
      test.true_(!state.pendingSalvage, '决策后清除待处理打捞');
      test.true_(cargoUsed(state.cargo) > 0, '战利品进入货舱');
      test.true_(state.turn > before, '打捞消耗回合');
      add(test);
    }

    {
      const test = new Case('战地维修消耗零件并恢复 HP');
      let state = createCampaign(303);
      const ship = state.fleet.ships[0];
      ship.componentHp = ensurePersistentComponentHp(ship);
      ship.componentHp[0] = Math.max(1, ship.componentHp[0] - 5);
      state.cargo = addCargo(state.cargo, [{ type: 'repairParts', quantity: 1 }]).cargo;
      const beforeHp = ship.componentHp[0];
      state = applyCampaignAction(state, {
        type: 'fieldRepair',
        campaignShipId: ship.campaignShipId
      });
      const repaired = state.fleet.ships.find(
        (item) => item.campaignShipId === ship.campaignShipId
      )!;
      test.true_(repaired.componentHp![0] > beforeHp, '组件 HP 得到恢复');
      test.eq(cargoQuantity(state.cargo, 'repairParts'), 0, '消耗一份维修零件');
      add(test);
    }

    {
      const test = new Case('拖曳增加移动成本');
      let state = createCampaign(404);
      state.fleet.ships[2].disabled = true;
      const normal = movementFuelCost(state.fleet);
      state = applyCampaignAction(state, {
        type: 'towShip',
        campaignShipId: state.fleet.ships[2].campaignShipId
      });
      test.eq(movementFuelCost(state.fleet), normal + 1, '每艘拖曳舰增加一点燃料成本');
      add(test);
    }

    {
      const test = new Case('未处理失能舰阻止撤离');
      let state = moveToGate(createCampaign(505));
      state.fleet.ships[2].disabled = true;
      const blocked = applyCampaignAction(state, { type: 'enterGate' });
      test.eq(blocked.sectorIndex, 1, '未拖曳失能舰时不能穿越星门');
      state = applyCampaignAction(state, {
        type: 'towShip',
        campaignShipId: state.fleet.ships[2].campaignShipId
      });
      const extracted = applyCampaignAction(state, { type: 'enterGate' });
      test.eq(extracted.sectorIndex, 2, '拖曳后可带入下一星域');
      test.true_(
        extracted.fleet.ships.some((ship) => ship.disabled && ship.towed),
        '失能舰及拖曳状态跨星域保留'
      );
      add(test);
    }

    {
      const test = new Case('战前部署改变实际参战舰队');
      let state = createCampaign(606);
      state.pendingBattle = {
        nodeId: state.sector.currentNodeId,
        battleIndex: 1,
        reason: '部署测试',
        deployment: defaultDeployment(state.fleet)
      };
      const excludedId = state.fleet.ships[0].campaignShipId;
      state = applyCampaignAction(state, {
        type: 'toggleDeployment',
        campaignShipId: excludedId
      });
      test.eq(activeShips(state.fleet).length, 2, '取消一艘后只有两艘进入 activeShips');
      const context = prepareCampaignBattle(state.fleet, enemyFleetFor(606, 1, 0), 606);
      test.eq(context.bindings.length, 2, '实际 core-v4 binding 数量匹配部署选择');
      test.true_(!context.bindings.some((binding) => binding.campaignShipId === excludedId), '留守舰未进入战斗');
      add(test);
    }

    {
      const test = new Case('至少保留一艘参战舰');
      let state = createCampaign(607);
      state.pendingBattle = {
        nodeId: state.sector.currentNodeId,
        battleIndex: 1,
        reason: '最小部署测试',
        deployment: defaultDeployment(state.fleet)
      };
      for (const ship of state.fleet.ships) {
        state = applyCampaignAction(state, {
          type: 'toggleDeployment',
          campaignShipId: ship.campaignShipId
        });
      }
      test.eq(activeShips(state.fleet).length, 1, '不能取消最后一艘参战舰');
      add(test);
    }

    {
      const test = new Case('跃迁准备降低可见风险');
      let state = moveToGate(createCampaign(707));
      state.sector.threat = { value: 20, level: 4 };
      const before = buildExtractionPlan(state);
      state = applyCampaignAction(state, { type: 'prepareExtraction' });
      const after = buildExtractionPlan(state);
      test.true_(state.extractionPrepared === true, '记录已完成跃迁准备');
      test.true_(after.riskScore < before.riskScore, '准备后风险分数降低');
      add(test);
    }

    {
      const test = new Case('普通跃迁拒绝超出安全载荷');
      let state = moveToGate(createCampaign(808));
      state.fleet.ships[0].componentHp = ensurePersistentComponentHp(state.fleet.ships[0]);
      state.fleet.ships[0].componentHp![0] -= 1;
      state.cargo = addCargo(state.cargo, [{ type: 'repairParts', quantity: 18 }]).cargo;
      const plan = buildExtractionPlan(state);
      test.true_(plan.overload > 0, '受损舰降低安全载荷并形成超载');
      const blocked = applyCampaignAction(state, { type: 'enterGate', mode: 'normal' });
      test.eq(blocked.sectorIndex, 1, '普通跃迁不会接受超载');
      add(test);
    }

    {
      const test = new Case('紧急跃迁确定性抛货并造成舰损');
      const run = () => {
        let state = moveToGate(createCampaign(909));
        state.sector.threat = { value: 20, level: 4 };
        const gate = state.sector.nodes.find((node) => node.type === 'gate')!;
        gate.processed = true;
        state.fleet.ships[0].componentHp = ensurePersistentComponentHp(state.fleet.ships[0]);
        state.fleet.ships[0].componentHp![0] -= 1;
        state.cargo = addCargo(state.cargo, [{ type: 'repairParts', quantity: 18 }]).cargo;
        return applyCampaignAction(state, { type: 'enterGate', mode: 'emergency' });
      };
      const first = run();
      const second = run();
      test.eq(JSON.stringify(first), JSON.stringify(second), '相同状态紧急跃迁结果确定');
      test.eq(first.sectorIndex, 2, '紧急跃迁可进入下一星域');
      test.true_((first.lastSectorSummary?.jettisonedUnits ?? 0) > 0, '自动抛弃超出安全载荷的货物');
      test.true_((first.lastSectorSummary?.damagedInJump.length ?? 0) > 0, '高风险紧急跃迁造成确定性舰损');
      add(test);
    }

    {
      const test = new Case('主动抛货解除超载');
      let state = moveToGate(createCampaign(1001));
      state.fleet.ships[0].componentHp = ensurePersistentComponentHp(state.fleet.ships[0]);
      state.fleet.ships[0].componentHp![0] -= 1;
      state.cargo = addCargo(state.cargo, [{ type: 'repairParts', quantity: 18 }]).cargo;
      const before = buildExtractionPlan(state).overload;
      state = applyCampaignAction(state, {
        type: 'jettisonCargo',
        itemType: 'repairParts',
        quantity: before
      });
      test.eq(buildExtractionPlan(state).overload, 0, '抛货后恢复到安全载荷');
      const extracted = applyCampaignAction(state, { type: 'enterGate', mode: 'normal' });
      test.eq(extracted.sectorIndex, 2, '解除超载后可普通跃迁');
      add(test);
    }

    {
      const test = new Case('星域结算保留关键统计');
      let state = moveToGate(createCampaign(1102));
      state.turn = 9;
      const extracted = applyCampaignAction(state, { type: 'enterGate', mode: 'normal' });
      test.eq(extracted.lastSectorSummary?.sectorIndex, 1, '记录离开的星域');
      test.true_((extracted.lastSectorSummary?.totalNodes ?? 0) >= 20, '记录星域节点总数');
      test.eq(extracted.lastSectorSummary?.extractionMode, 'normal', '记录撤离模式');
      test.true_(validateCampaignState(extracted), '带星域总结的状态通过存档校验');
      add(test);
    }
  });
}

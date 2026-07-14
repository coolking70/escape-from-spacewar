import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { generateUniverse } from './universeGenerator';
import { decodeUniverse, encodeUniverse, validateUniverseState } from './universePersistence';
import {
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  applyUniverseAction,
  crisisPhaseForTurn,
  travelFuelCost,
  universeTurnIncome
} from './universeRules';

function graphReachable(state: ReturnType<typeof generateUniverse>): boolean {
  const seen = new Set<string>([state.systems[0].id]);
  const queue = [state.systems[0].id];
  while (queue.length) {
    const id = queue.shift()!;
    const system = state.systems.find((candidate) => candidate.id === id)!;
    for (const neighbor of system.neighbors) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return seen.size === state.systems.length;
}

function establishStartingBase(state: ReturnType<typeof generateUniverse>) {
  const station = state.entities.find((entity) =>
    entity.systemId === state.fleet.systemId && entity.kind === 'station'
  )!;
  return applyUniverseAction(state, { type: 'establishBase', entityId: station.id });
}

function prepareGate(state: ReturnType<typeof generateUniverse>, calibration: number) {
  const next = JSON.parse(JSON.stringify(state)) as ReturnType<typeof generateUniverse>;
  const gate = next.entities.find((entity) => entity.id === next.extraction.gateEntityId)!;
  const system = next.systems.find((candidate) => candidate.id === gate.systemId)!;
  gate.discovered = true;
  gate.surveyed = true;
  next.extraction.discovered = true;
  next.extraction.calibration = calibration;
  next.fleet.systemId = system.id;
  next.selectedSystemId = system.id;
  system.discovered = true;
  system.control = 'neutral';
  system.enemyPower = 0;
  if (!next.faction.knownSystemIds.includes(system.id)) next.faction.knownSystemIds.push(system.id);
  next.faction.resources.supplies = 50;
  next.fleet.fuel = next.fleet.maxFuel;
  return next;
}

export function runStrategicTests(): SuiteResult {
  return runSuite('strategic-sector-v1.0', (add) => {
    {
      const test = new Case('每个星域按 seed 生成完整战略结构');
      const first = generateUniverse(1001, '开拓局');
      const same = generateUniverse(1001, '开拓局');
      const different = generateUniverse(1002, '开拓局');
      const signature = (state: typeof first) => JSON.stringify({ systems: state.systems, entities: state.entities });
      test.eq(signature(first), signature(same), '相同 seed 生成相同星系、航线、实体和敌情');
      test.true_(signature(first) !== signature(different), '不同 seed 生成不同星域');
      test.eq(first.systems.length, 9, '单个星域包含九个战略星系');
      test.true_(graphReachable(first), '星域航线图整体连通');
      test.true_(first.entities.some((entity) => entity.kind === 'jumpGate'), '存在唯一撤离星门');
      test.true_(first.entities.some((entity) => entity.kind === 'relicSite'), '存在可带走蓝图的科研遗迹');
      test.true_(first.systems.filter((system) => system.control === 'enemy').length >= 2, '星域开局存在真实敌方控制区');
      test.eq(first.faction.baseEntityId, undefined, '开局没有免费永久基地');
      test.eq(first.crisis.phase, 'foothold', '开局处于立足窗口');
      add(test);
    }

    {
      const test = new Case('占领据点后可进行临时建设与回合生产');
      let state = establishStartingBase(generateUniverse(1003));
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.true_(!!base && base.ownerId === state.faction.id, '已占领废弃空间站建立前进基地');
      const before = state.faction.resources.minerals;
      state = applyUniverseAction(state, { type: 'queueConstruction', facilityType: 'miningArray' });
      test.eq(state.faction.resources.minerals, before - FACILITY_DEFINITIONS.miningArray.cost.minerals!, '建设成本立即扣除');
      for (let turn = 0; turn < FACILITY_DEFINITIONS.miningArray.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      const completedBase = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.true_(completedBase.facilities?.some((facility) => facility.type === 'miningArray') ?? false, '临时采矿阵列按回合完成');
      test.eq(universeTurnIncome(state).minerals, 4, '设施开始提供本星域回合产出');
      add(test);
    }

    {
      const test = new Case('本地科研提供快速收益但穿越星门后重置');
      let state = establishStartingBase(generateUniverse(1004));
      state.faction.resources.science = 30;
      state = applyUniverseAction(state, { type: 'queueResearch', projectId: 'routeAnalysis' });
      for (let turn = 0; turn < RESEARCH_DEFINITIONS.routeAnalysis.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      test.true_(state.faction.localResearch.includes('routeAnalysis'), '本地航路解析研究完成');
      test.eq(travelFuelCost(state), 1, '本星域航行燃料降低');
      const prepared = prepareGate(state, 100);
      const nextSector = applyUniverseAction(prepared, { type: 'extractSector', mode: 'stable' });
      test.eq(nextSector.sectorIndex, 2, '稳定撤离后生成下一完整战略星域');
      test.eq(nextSector.faction.localResearch.length, 0, '本地科研在跨星域后重置');
      test.eq(nextSector.faction.baseEntityId, undefined, '临时基地不会跨星域继承');
      test.eq(nextSector.faction.legacy.sectorsCleared, 1, '跨星域进度进入长期继承状态');
      add(test);
    }

    {
      const test = new Case('危机阶段随时间升级并最终摧毁未撤离舰队');
      let state = generateUniverse(1005);
      test.eq(crisisPhaseForTurn(Math.ceil(state.crisis.finalTurn * 0.4), state.crisis.finalTurn), 'contest', '中段进入争夺阶段');
      test.eq(crisisPhaseForTurn(Math.ceil(state.crisis.finalTurn * 0.7), state.crisis.finalTurn), 'collapse', '后段进入崩溃阶段');
      for (let turn = 0; turn <= state.crisis.finalTurn; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      test.eq(state.status, 'collapsed', '超过最终撤离窗口后战役失败');
      test.eq(state.crisis.phase, 'evacuation', '终局处于最终撤离阶段');
      add(test);
    }

    {
      const test = new Case('敌军是地图实体压力并可被舰队清除');
      let state = generateUniverse(1006);
      const hostile = state.systems.find((system) => system.control === 'enemy')!;
      state.fleet.systemId = hostile.id;
      state.selectedSystemId = hostile.id;
      hostile.discovered = true;
      hostile.enemyPower = 18;
      const before = hostile.enemyPower;
      state = applyUniverseAction(state, { type: 'engageEnemy' });
      const updated = state.systems.find((system) => system.id === hostile.id)!;
      test.true_(updated.enemyPower < before, '战斗会永久降低当地敌方战力');
      test.eq(updated.enemyPower, 0, '优势舰队可清除小型敌方据点');
      test.eq(updated.control, 'neutral', '清除后星系恢复为可利用区域');
      add(test);
    }

    {
      const test = new Case('维修坞能恢复失能舰并消耗本地资源');
      let state = establishStartingBase(generateUniverse(1007));
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      base.facilities!.push({ id: 'test-repair-dock', type: 'repairDock', level: 1 });
      state.fleet.disabledShips = 1;
      state.faction.resources.supplies = 20;
      state.faction.resources.minerals = 20;
      const supplies = state.faction.resources.supplies;
      state = applyUniverseAction(state, { type: 'repairFleet' });
      test.eq(state.fleet.disabledShips, 0, '失能舰恢复战斗能力');
      test.true_(state.faction.resources.supplies < supplies, '维修消耗星域补给');
      add(test);
    }

    {
      const test = new Case('紧急撤离会舍弃资源和舰船但仍可进入下一星域');
      let state = prepareGate(generateUniverse(1008), 40);
      state.crisis.pressure = 85;
      state.fleet.shipCount = 3;
      state.fleet.disabledShips = 0;
      state.faction.resources.minerals = 80;
      const next = applyUniverseAction(state, { type: 'extractSector', mode: 'emergency' });
      test.eq(next.sectorIndex, 2, '部分校准允许紧急穿越星门');
      test.true_(next.fleet.shipCount < 3, '高压无断后撤离造成舰船损失');
      test.true_(next.faction.resources.minerals < 80, '只能携带少量压缩资源进入下一星域');
      test.true_(next.faction.legacy.shipsLost > 0, '永久记录跨域舰船损失');
      add(test);
    }

    {
      const test = new Case('连续三次撤离形成完整搜打撤 SLG 战役');
      let state = generateUniverse(1009);
      for (let sector = 1; sector <= 3; sector++) {
        state = prepareGate(state, 100);
        state = applyUniverseAction(state, { type: 'extractSector', mode: 'stable' });
        if (sector < 3) {
          test.eq(state.sectorIndex, sector + 1, `第 ${sector} 次撤离进入下一星域`);
          test.eq(state.status, 'active', '中途继续远征');
        }
      }
      test.eq(state.status, 'victory', '穿越第三星域后完成远征');
      test.eq(state.faction.legacy.sectorsCleared, 3, '长期状态记录三个已清理星域');
      add(test);
    }

    {
      const test = new Case('星域远征码完整往返并拒绝损坏状态');
      const state = generateUniverse(1010);
      const decoded = decodeUniverse(encodeUniverse(state));
      test.eq(JSON.stringify(decoded), JSON.stringify(state), 'alpha.2 星域远征状态完整往返');
      test.true_(validateUniverseState(decoded), '往返状态通过深层校验');
      const invalidGate = JSON.parse(JSON.stringify(state));
      invalidGate.extraction.gateEntityId = 'missing-gate';
      test.true_(!validateUniverseState(invalidGate), '不存在的星门引用被拒绝');
      const duplicateBlueprint = JSON.parse(JSON.stringify(state));
      duplicateBlueprint.faction.legacy.blueprints = ['fieldLogistics', 'fieldLogistics'];
      test.true_(!validateUniverseState(duplicateBlueprint), '重复永久蓝图被拒绝');
      add(test);
    }
  });
}

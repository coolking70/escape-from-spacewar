import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { generateUniverse } from './universeGenerator';
import { decodeUniverse, encodeUniverse, validateUniverseState } from './universePersistence';
import {
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  applyUniverseAction,
  travelFuelCost
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

export function runStrategicTests(): SuiteResult {
  return runSuite('strategic-universe-v1.0', (add) => {
    {
      const test = new Case('随机宇宙按 seed 确定生成');
      const first = generateUniverse(1001, '开拓局');
      const same = generateUniverse(1001, '开拓局');
      const different = generateUniverse(1002, '开拓局');
      const signature = (state: typeof first) => JSON.stringify({ systems: state.systems, entities: state.entities });
      test.eq(signature(first), signature(same), '相同 seed 生成相同星系、航线和实体');
      test.true_(signature(first) !== signature(different), '不同 seed 生成不同宇宙');
      test.eq(first.systems.length, 7, '垂直切片生成七个星系');
      test.true_(graphReachable(first), '星系航线图整体连通');
      test.true_(first.entities.some((entity) => entity.kind === 'planet'), '存在行星实体');
      test.true_(first.entities.some((entity) => entity.kind === 'station'), '存在空间站实体');
      test.true_(first.entities.some((entity) => entity.kind === 'asteroidField'), '存在小行星带实体');
      add(test);
    }

    {
      const test = new Case('轨道基地拥有持久设施与建造队列');
      let state = generateUniverse(1003);
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      const beforeMinerals = state.faction.resources.minerals;
      state = applyUniverseAction(state, { type: 'queueConstruction', facilityType: 'miningArray' });
      test.eq(base.constructionQueue?.length ?? 0, 0, '规则采用不可变更新，不修改旧状态');
      const queuedBase = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.eq(queuedBase.constructionQueue?.length, 1, '设施进入建造队列');
      test.eq(state.faction.resources.minerals, beforeMinerals - (FACILITY_DEFINITIONS.miningArray.cost.minerals ?? 0), '建造成本立即扣除');
      for (let turn = 0; turn < FACILITY_DEFINITIONS.miningArray.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      const completedBase = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.true_(completedBase.facilities?.some((facility) => facility.type === 'miningArray') ?? false, '建造完成后设施永久存在');
      test.eq(completedBase.constructionQueue?.length, 0, '完成项目离开队列');
      add(test);
    }

    {
      const test = new Case('科研项目需要资源和时间并产生战略效果');
      let state = generateUniverse(1004);
      state = applyUniverseAction(state, { type: 'queueResearch', projectId: 'stellarCartography' });
      test.eq(state.faction.researchQueue.length, 1, '研究进入队列');
      test.eq(state.faction.resources.science, 12 - RESEARCH_DEFINITIONS.stellarCartography.scienceCost, '科学成本立即扣除');
      for (let turn = 0; turn < RESEARCH_DEFINITIONS.stellarCartography.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      test.true_(state.faction.researched.includes('stellarCartography'), '研究在规定回合后完成');
      test.eq(travelFuelCost(state), 1, '恒星测绘降低战略航行燃料');
      add(test);
    }

    {
      const test = new Case('舰队移动会揭示星系与长期实体');
      let state = generateUniverse(1005);
      const home = state.systems.find((system) => system.id === state.fleet.systemId)!;
      const target = state.systems.find((system) => system.id === home.neighbors[0])!;
      const fuel = state.fleet.fuel;
      state = applyUniverseAction(state, { type: 'travel', systemId: target.id });
      test.eq(state.fleet.systemId, target.id, '舰队抵达相邻星系');
      test.eq(state.fleet.fuel, fuel - 2, '航行消耗燃料');
      test.true_(state.entities.filter((entity) => entity.systemId === target.id).every((entity) => entity.discovered), '抵达后识别星系内实体');
      test.true_(state.systems.filter((system) => target.neighbors.includes(system.id)).every((system) => system.discovered), '抵达后揭示相邻星系坐标');
      add(test);
    }

    {
      const test = new Case('小行星资源会被开采并永久减少');
      let state = generateUniverse(1006);
      const asteroid = state.entities.find((entity) => entity.systemId === state.fleet.systemId && entity.kind === 'asteroidField')!;
      asteroid.surveyed = true;
      const reserve = asteroid.deposits!.minerals;
      const minerals = state.faction.resources.minerals;
      state = applyUniverseAction(state, { type: 'extractAsteroid', entityId: asteroid.id });
      const updated = state.entities.find((entity) => entity.id === asteroid.id)!;
      test.eq(updated.deposits!.minerals, reserve - Math.min(8, reserve), '矿物储量永久减少');
      test.true_(state.faction.resources.minerals > minerals, '开采收益进入势力资源');
      add(test);
    }

    {
      const test = new Case('战略宇宙码完整往返并拒绝损坏航线');
      const state = generateUniverse(1007);
      const decoded = decodeUniverse(encodeUniverse(state));
      test.eq(JSON.stringify(decoded), JSON.stringify(state), '战略宇宙状态完整往返');
      test.true_(validateUniverseState(decoded), '往返状态通过深层校验');
      const corrupted = JSON.parse(JSON.stringify(state));
      corrupted.systems[0].neighbors.push('missing-system');
      test.true_(!validateUniverseState(corrupted), '不存在的航线目标被拒绝');
      add(test);
    }
  });
}

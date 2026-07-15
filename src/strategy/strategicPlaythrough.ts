import { prepareStrategicBattle } from '../campaign/fleet/battleAdapter';
import { createSimulator } from '../sim/rulesets';
import { decodeUniverse, encodeUniverse, validateUniverseState } from './universePersistence';
import { generateUniverse } from './universeGenerator';
import {
  applyStrategicBattleResult,
  applyUniverseAction,
  canAppointStrategicCommander,
  canExtractSector,
  strategicFleetPower,
  toPersistentFleet,
  travelFuelCost
} from './universeRules';
import type { UniverseAction, UniverseState } from './universeTypes';

export interface StrategicPlaythroughBattle {
  sectorIndex: number;
  turn: number;
  source: NonNullable<UniverseState['pendingBattle']>['source'];
  enemyPower: number;
  winner: 'A' | 'B' | null;
  ticks: number;
}

export interface StrategicPlaythroughSector {
  sectorIndex: number;
  turn: number;
  pressure: number;
  shipIds: string[];
  fleetPower: number;
}

export interface StrategicPlaythroughResult {
  finalState: UniverseState;
  finalCode: string;
  actions: UniverseAction[];
  battles: StrategicPlaythroughBattle[];
  sectors: StrategicPlaythroughSector[];
}

function shortestPath(state: UniverseState, fromId: string, toId: string): string[] | null {
  const queue: string[][] = [[fromId]];
  const visited = new Set([fromId]);
  while (queue.length) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    if (current === toId) return path;
    const system = state.systems.find((candidate) => candidate.id === current);
    for (const neighbor of [...(system?.neighbors ?? [])].sort((a, b) => a.localeCompare(b))) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push([...path, neighbor]);
    }
  }
  return null;
}

/** 每一步都强制经过正式远征码往返，确保端到端策略没有依赖不可持久化的瞬时状态。 */
function checkpoint(state: UniverseState): UniverseState {
  const location = `第 ${state.sectorIndex} 星域第 ${state.turn} 回合`;
  if (!validateUniverseState(state)) throw new Error(`三星域流程在${location}生成了无效状态。`);
  return decodeUniverse(encodeUniverse(state));
}

/**
 * C.5 发布验证玩家策略：只调用正式 reducer、远征码和真实 core-v4 战斗入口。
 * 它建立每域基地、排队航路研究、首域招募一名候补、击退围攻主基地的 raider、
 * 沿稳定最短路寻找星门、完成真实星门防御并紧急撤离，直到三星域胜利。
 */
export function runStrategicThreeSectorPlaythrough(seed: number): StrategicPlaythroughResult {
  let state = checkpoint(generateUniverse(seed, 'C.5 验证远征团'));
  const actions: UniverseAction[] = [];
  const battles: StrategicPlaythroughBattle[] = [];
  const sectors: StrategicPlaythroughSector[] = [];
  let departedBase = false;
  let guard = 0;

  const act = (action: UniverseAction): void => {
    const before = state;
    state = applyUniverseAction(state, action);
    if (state === before) throw new Error(`三星域流程行动未生效：${action.type}（星域 ${state.sectorIndex} / 回合 ${state.turn}）。`);
    actions.push(action);
    state = checkpoint(state);
  };

  while (state.status === 'active' && guard++ < 160) {
    if (state.pendingRecruitment) {
      const candidateId = state.reserveCommanders.length === 0
        ? state.pendingRecruitment.candidates[0]?.id
        : undefined;
      act({ type: 'resolveRecruitment', candidateId });
      continue;
    }

    if (state.pendingSuccession) {
      const candidate = state.reserveCommanders.find((commander) =>
        canAppointStrategicCommander(state, commander.id)
      );
      if (!candidate) throw new Error('三星域流程进入继任状态，但没有可任命的候补指挥官。');
      act({ type: 'appointCommander', commanderId: candidate.id });
      continue;
    }

    if (state.pendingBattle) {
      const pending = state.pendingBattle;
      const context = prepareStrategicBattle(
        toPersistentFleet(state.fleet),
        pending.enemyFleet,
        pending.battleSeed,
        pending.deployment
      );
      const simulator = createSimulator(context.state, context.rng);
      let ticks = 0;
      while (!context.state.finished && ticks++ < 200000) simulator.step();
      if (!context.state.finished) throw new Error(`真实战略战斗在 200000 tick 内未结束：${pending.battleId}。`);
      battles.push({
        sectorIndex: state.sectorIndex,
        turn: state.turn,
        source: pending.source,
        enemyPower: pending.enemyPowerBefore,
        winner: context.state.winner,
        ticks
      });
      state = checkpoint(applyStrategicBattleResult(state, context.state, context.bindings));
      continue;
    }

    if (!state.faction.baseEntityId) {
      const station = state.entities.find((entity) =>
        entity.systemId === state.fleet.systemId && entity.kind === 'station' && entity.surveyed
      );
      if (!station) throw new Error('新星域入口缺少可建立前进基地的已测绘空间站。');
      act({ type: 'establishBase', entityId: station.id });
      act({ type: 'queueResearch', projectId: 'routeAnalysis' });
      act({ type: 'openRecruitment' });
      continue;
    }

    const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
    const raider = state.enemyTaskForces.find((force) => force.role === 'raider');
    if (!departedBase && raider) {
      if (raider.systemId === base.systemId) {
        act({ type: 'engageEnemy' });
      } else {
        act({ type: 'advanceTurn' });
      }
      continue;
    }

    const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId)!;
    const route = shortestPath(state, state.fleet.systemId, gate.systemId);
    if (!route) throw new Error('入口星系与星门之间不存在航路。');

    if (!departedBase) {
      const hops = route.length - 1;
      if (state.fleet.fuel < hops * travelFuelCost(state)) {
        if (state.faction.localResearch.includes('routeAnalysis')) {
          throw new Error(`航路研究完成后仍无足够燃料抵达星门（${hops} 跳）。`);
        }
        act({ type: 'advanceTurn' });
        continue;
      }
      departedBase = true;
    }

    if (state.fleet.systemId === gate.systemId) {
      if (!gate.surveyed) {
        act({ type: 'surveyEntity', entityId: gate.id });
        continue;
      }
      if (state.extraction.calibration < state.extraction.emergencyThreshold) {
        act({ type: 'calibrateGate' });
        continue;
      }
      if (!canExtractSector(state, 'emergency')) {
        throw new Error(`第 ${state.sectorIndex} 星域已完成防御但紧急撤离仍不可用。`);
      }
      sectors.push({
        sectorIndex: state.sectorIndex,
        turn: state.turn,
        pressure: state.crisis.pressure,
        shipIds: state.fleet.ships.map((ship) => ship.campaignShipId).sort(),
        fleetPower: strategicFleetPower(state)
      });
      act({ type: 'extractSector', mode: 'emergency' });
      departedBase = false;
      continue;
    }

    const nextId = route[1];
    const nextSystem = state.systems.find((system) => system.id === nextId);
    if (!nextSystem?.discovered) {
      throw new Error(`玩家下一跳 ${nextId} 尚未被当前星系探索揭示。`);
    }
    act({ type: 'travel', systemId: nextId });
  }

  if (guard >= 160) throw new Error('三星域流程超过 160 个决策步骤。');
  if (state.status !== 'victory') {
    throw new Error(`三星域流程未取得胜利：${state.status}（星域 ${state.sectorIndex} / 回合 ${state.turn}）。`);
  }
  return { finalState: state, finalCode: encodeUniverse(state), actions, battles, sectors };
}

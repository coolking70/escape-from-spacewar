// 战斗时间线：将 sim 产生的视觉事件流聚合为关键事件标记（TimelineMarker）。
// 该模块属于 sim 层，不依赖 Three.js / DOM，可无渲染地运行。
// 设计约束（来自 V0.5 规范）：
//  - 时间线由「确定性重模拟」生成，绝不反向影响战斗结果；
//  - 聚合规则：跳过普通 weaponFired / 单次 supportEffect / auraApplied / pointDefenseFired；
//  - 首个命中 / 首个护盾击穿 / 首个组件摧毁 / 首舰被击毁仅保留一次；
//  - 巡洋舰被击毁 / 无人机打击 / 大额伤害按「同类 10 tick 内合并」去重；
//  - 重新载入 replay 后，可再次调用 simulateFull + buildTimeline 重新生成。

import { ReplayConfig, BattleEvent, Team } from './battleTypes';
import { createPRNG } from './prng';
import { createInitialState, createSimulator } from './rulesets';

export type TimelineMarkerType =
  | 'firstHit'
  | 'firstShieldDown'
  | 'firstComponentDestroyed'
  | 'firstShipDestroyed'
  | 'cruiserDestroyed'
  | 'droneStrike'
  | 'largeDamage'
  | 'battleEnd';

export type MarkerImportance = 'high' | 'medium' | 'low';

export interface TimelineMarker {
  tick: number;
  type: TimelineMarkerType;
  label: string;
  /** 相关舰船（用于定位/提示） */
  shipId?: number;
  team?: Team;
  importance: MarkerImportance;
}

/** 单次伤害达到该值即记为「大额伤害」事件 */
const LARGE_DAMAGE_THRESHOLD = 40;
/** 同类标记在此 tick 窗口内合并（仅保留最早一个） */
const MERGE_WINDOW = 10;

/** 无渲染地完整模拟一场战斗，返回全部视觉事件（用于生成时间线）。 */
export function simulateFull(replay: ReplayConfig): BattleEvent[] {
  const rng = createPRNG(replay.seed);
  const state = createInitialState(replay, rng);
  const sim = createSimulator(state, rng);
  const all: BattleEvent[] = [];
  const maxTicks = state.maxTicks;
  let guard = 0;
  while (!state.finished && guard <= maxTicks + 1) {
    const res = sim.step();
    for (const e of res.events) all.push(e);
    guard++;
  }
  return all;
}

/** 将完整事件流聚合成时间线标记（确定性、纯函数）。 */
export function buildTimeline(events: BattleEvent[]): TimelineMarker[] {
  const markers: TimelineMarker[] = [];
  let firstHit = false;
  let firstShield = false;
  let firstComp = false;
  let firstShip = false;
  const lastByType: Partial<Record<TimelineMarkerType, number>> = {};

  const canMerge = (type: TimelineMarkerType, tick: number): boolean => {
    const last = lastByType[type];
    if (last === undefined) return true;
    return tick - last >= MERGE_WINDOW;
  };
  const mark = (type: TimelineMarkerType, tick: number): void => {
    lastByType[type] = tick;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'hit': {
        if (!firstHit) {
          firstHit = true;
          markers.push({
            tick: ev.tick,
            type: 'firstHit',
            label: '首次命中',
            shipId: ev.targetId,
            team: ev.attackerTeam === 'A' ? 'B' : 'A',
            importance: 'low'
          });
        }
        if (ev.damage >= LARGE_DAMAGE_THRESHOLD && canMerge('largeDamage', ev.tick)) {
          mark('largeDamage', ev.tick);
          markers.push({
            tick: ev.tick,
            type: 'largeDamage',
            label: `大额伤害 ${Math.round(ev.damage)}`,
            shipId: ev.targetId,
            team: ev.attackerTeam === 'A' ? 'B' : 'A',
            importance: 'medium'
          });
        }
        break;
      }
      case 'shieldDown': {
        if (!firstShield) {
          firstShield = true;
          markers.push({
            tick: ev.tick,
            type: 'firstShieldDown',
            label: '首个护盾击穿',
            shipId: ev.shipId,
            team: ev.team,
            importance: 'medium'
          });
        }
        break;
      }
      case 'componentDamaged': {
        if (ev.destroyed && !firstComp) {
          firstComp = true;
          markers.push({
            tick: ev.tick,
            type: 'firstComponentDestroyed',
            label: '首个组件摧毁',
            shipId: ev.shipId,
            importance: 'medium'
          });
        }
        break;
      }
      case 'shipDestroyed': {
        if (!firstShip) {
          firstShip = true;
          markers.push({
            tick: ev.tick,
            type: 'firstShipDestroyed',
            label: '首舰被击毁',
            shipId: ev.shipId,
            team: ev.team,
            importance: 'high'
          });
        }
        if (ev.shipType === 'Cruiser' && canMerge('cruiserDestroyed', ev.tick)) {
          mark('cruiserDestroyed', ev.tick);
          markers.push({
            tick: ev.tick,
            type: 'cruiserDestroyed',
            label: '巡洋舰被击毁',
            shipId: ev.shipId,
            team: ev.team,
            importance: 'high'
          });
        }
        break;
      }
      case 'droneStrike': {
        if (canMerge('droneStrike', ev.tick)) {
          mark('droneStrike', ev.tick);
          markers.push({
            tick: ev.tick,
            type: 'droneStrike',
            label: `无人机打击 (×${ev.targetIds.length})`,
            shipId: ev.sourceShipId,
            importance: 'medium'
          });
        }
        break;
      }
      case 'battleEnded': {
        markers.push({
          tick: ev.tick,
          type: 'battleEnd',
          label: '战斗结束',
          importance: 'high'
        });
        break;
      }
      default:
        // weaponFired / auraApplied / pointDefenseFired / supportEffect 均跳过
        break;
    }
  }

  markers.sort((a, b) => a.tick - b.tick || typeRank(a.type) - typeRank(b.type));
  return markers;
}

/** 用于同 tick 内稳定排序：首舰事件优先于后续同类事件 */
function typeRank(t: TimelineMarkerType): number {
  const order: TimelineMarkerType[] = [
    'firstHit',
    'firstShieldDown',
    'firstComponentDestroyed',
    'firstShipDestroyed',
    'cruiserDestroyed',
    'droneStrike',
    'largeDamage',
    'battleEnd'
  ];
  return order.indexOf(t);
}

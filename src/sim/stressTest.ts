// 100 艘无渲染压力测试（纯 sim，无 Three.js）。
// 50v50 core-v4，固定 seed，最大 6000 tick。
// 输出：是否完成 / 实际 tick / 运行耗时 / winner / reason / 结果摘要 hash /
//      连续两次 hash 一致性 / 以及一组"确定性不变量"诊断（NaN、越界、负 HP、
//      shield 超限、未知 combatState、无效 targetId）。
// 性能耗时仅作诊断，不参与通过判定。
// 浏览器中可用 window.runSimulationStressTest() 运行。

import { createPRNG } from './prng';
import { createInitialState, createSimulator } from './rulesets';
import { ReplayConfig, Ship, CombatState } from './battleTypes';
import { SIM_VERSION_V5, RULESET_V4, TICKS_PER_SECOND } from './battleConfig';

const VALID_COMBAT_STATES = new Set<CombatState>([
  'normal',
  'damaged',
  'critical',
  'disabled',
  'retreating',
  'escaped',
  'destroyed'
]);

export interface StressResult {
  completed: boolean;
  tick: number;
  durationMs: number;
  winner: string | null;
  victoryReason: string;
  summaryHash: string;
  hashStable: boolean;
  /** 不变量诊断 */
  diagnostics: {
    nan: number;
    outOfBounds: number;
    negativeHp: number;
    shieldOverflow: number;
    unknownCombatState: number;
    invalidTargetId: number;
  };
  passed: boolean;
  notes: string[];
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function summaryOf(ships: Ship[]): string {
  return ships
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(
      (s) =>
        `${s.id}:${s.team}:${s.combatState}:${s.alive ? 1 : 0}:${Math.round(
          s.components.reduce((x, c) => x + c.hp, 0)
        )}:${s.pos.x.toFixed(1)},${s.pos.z.toFixed(1)}`
    )
    .join('|');
}

function makeConfig(seed: number): ReplayConfig {
  return {
    v: SIM_VERSION_V5,
    ruleset: RULESET_V4,
    seed: seed >>> 0,
    budget: { mode: 'unlimited', limit: 999999 },
    teamA: {
      fleet: [
        { shipClass: 'Fighter', variant: 'standard', count: 30 },
        { shipClass: 'Frigate', variant: 'support', count: 12 },
        { shipClass: 'Cruiser', variant: 'fortress', count: 8 }
      ],
      formation: 'wall',
      doctrine: 'defensive'
    },
    teamB: {
      fleet: [
        { shipClass: 'Fighter', variant: 'interceptor', count: 30 },
        { shipClass: 'Frigate', variant: 'artillery', count: 12 },
        { shipClass: 'Cruiser', variant: 'carrier', count: 8 }
      ],
      formation: 'wedge',
      doctrine: 'aggressive'
    }
  };
}

function runOnce(seed: number, maxTicks: number): { tick: number; hash: string; diagnostics: StressResult['diagnostics']; winner: string | null; reason: string } {
  const rng = createPRNG(seed);
  const state = createInitialState(makeConfig(seed), rng);
  state.maxTicks = maxTicks;
  const sim = createSimulator(state, rng);

  const diag: StressResult['diagnostics'] = {
    nan: 0,
    outOfBounds: 0,
    negativeHp: 0,
    shieldOverflow: 0,
    unknownCombatState: 0,
    invalidTargetId: 0
  };

  let g = 0;
  while (!state.finished && g <= state.maxTicks) {
    sim.step();
    g++;
    // 每 200 tick 抽样一次诊断（避免每次都 O(n) 拖慢，但足够发现系统性错误）
    if (g % 200 === 0 || state.finished) {
      const ids = new Set(state.ships.map((s) => s.id));
      for (const s of state.ships) {
        if (!Number.isFinite(s.pos.x) || !Number.isFinite(s.pos.z) || !Number.isFinite(s.pos.y)) diag.nan++;
        if (Math.abs(s.pos.x) > 200 || Math.abs(s.pos.z) > 200) diag.outOfBounds++;
        for (const c of s.components) {
          if (c.hp < -0.001) diag.negativeHp++;
          if (!Number.isFinite(c.hp)) diag.nan++;
        }
        if (s.shield > s.maxShield + 0.001) diag.shieldOverflow++;
        if (!Number.isFinite(s.shield)) diag.nan++;
        if (!VALID_COMBAT_STATES.has(s.combatState)) diag.unknownCombatState++;
        if (s.targetId !== null && !ids.has(s.targetId)) diag.invalidTargetId++;
      }
    }
  }

  const winner = state.winner;
  const reason = state.victoryReason ?? 'none';
  return { tick: state.tick, hash: djb2(summaryOf(state.ships)), diagnostics: diag, winner, reason };
}

export function runSimulationStressTest(seed = 5005, maxTicks = 6000): StressResult {
  const t0 = Date.now();
  const a = runOnce(seed, maxTicks);
  const b = runOnce(seed, maxTicks);
  const durationMs = Date.now() - t0;

  const diag = {
    nan: a.diagnostics.nan + b.diagnostics.nan,
    outOfBounds: a.diagnostics.outOfBounds + b.diagnostics.outOfBounds,
    negativeHp: a.diagnostics.negativeHp + b.diagnostics.negativeHp,
    shieldOverflow: a.diagnostics.shieldOverflow + b.diagnostics.shieldOverflow,
    unknownCombatState: a.diagnostics.unknownCombatState + b.diagnostics.unknownCombatState,
    invalidTargetId: a.diagnostics.invalidTargetId + b.diagnostics.invalidTargetId
  };

  const hashStable = a.hash === b.hash;
  const invariantsOk =
    diag.nan === 0 &&
    diag.outOfBounds === 0 &&
    diag.negativeHp === 0 &&
    diag.shieldOverflow === 0 &&
    diag.unknownCombatState === 0 &&
    diag.invalidTargetId === 0;

  const notes: string[] = [];
  notes.push(`50v50 无渲染压测（seed=${seed}, maxTicks=${maxTicks}）`);
  notes.push(`完成 tick=${a.tick}；winner=${a.winner ?? 'null'}；reason=${a.reason}`);
  notes.push(`摘要 hash=${a.hash}；连续两次一致=${hashStable}`);
  notes.push(`运行耗时(两次合计)=${durationMs}ms（仅诊断，不参与判定）`);
  notes.push(
    `不变量诊断：NaN=${diag.nan} 越界=${diag.outOfBounds} 负HP=${diag.negativeHp} ` +
      `shield超限=${diag.shieldOverflow} 未知状态=${diag.unknownCombatState} 无效target=${diag.invalidTargetId}`
  );

  return {
    completed: a.tick <= maxTicks,
    tick: a.tick,
    durationMs,
    winner: a.winner,
    victoryReason: a.reason,
    summaryHash: a.hash,
    hashStable,
    diagnostics: diag,
    passed: hashStable && invariantsOk,
    notes
  };
}

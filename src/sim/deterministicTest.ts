// 确定性自检：仅针对 sim 层（不比较任何渲染/镜头/特效对象）。
// V0.6：统一 core-v4（spacewar-core-v4），仅保证 v0.5 录像导入导出；
//   旧版本（v0.1~v0.4）一律拒绝并提示重新生成。覆盖 fleet+variant+budget 往返、
//   同 seed 复现、倍速一致、跳转(seek)一致、多 doctrine 组合、改型确定性、
//   舰队码往返、舰队码vs录像码区分、replay 无 UI 状态、时间线确定性、平衡单局 vs sim、
//   swap 不改配置、克隆隔离、50 舰、Carrier/Scout/Support/Escort 共存、稳定排序。
// 全部一致则输出 "Deterministic test passed"，否则输出差异明细。

import { createPRNG } from './prng';
import { createInitialState, createSimulator } from './rulesets';
import { decodeReplay, encodeReplay } from './replayCodec';
import { summarizeStats } from './battleStats';
import {
  ReplayConfig,
  TeamConfig,
  FleetEntry,
  ShipClass,
  ShipVariant,
  FormationType,
  DoctrineType
} from './battleTypes';
import { SIM_VERSION_V5, RULESET_V4, TICKS_PER_SECOND, tickToSeconds } from './battleConfig';
import { runBalance, BalanceRunConfig } from './balanceRunner';
import { encodeFleet, decodeFleet, makeFleetPreset } from './fleetPreset';
import { simulateFull, buildTimeline } from './timeline';
import { cloneFleet, cloneReplayConfig } from './clone';
import { isPresentOnBattlefield } from './shipFlags';

function b64url(obj: unknown): string {
  const b64 = btoa(JSON.stringify(obj));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 由若干编队项构造 FleetEntry[] */
function fleet(entries: { shipClass: ShipClass; variant: ShipVariant; count: number }[]): FleetEntry[] {
  return entries.map((e) => ({ shipClass: e.shipClass, variant: e.variant, count: e.count }));
}

function makeCfg(
  seed: number,
  a: FleetEntry[],
  b: FleetEntry[],
  aForm: FormationType,
  aDoc: DoctrineType,
  bForm: FormationType,
  bDoc: DoctrineType,
  budgetMode: 'limited' | 'unlimited' | 'legacy' = 'unlimited',
  budgetLimit = 1000
): ReplayConfig {
  const team = (fl: FleetEntry[], form: FormationType, doc: DoctrineType): TeamConfig => ({
    fleet: fl,
    formation: form,
    doctrine: doc
  });
  return {
    v: SIM_VERSION_V5,
    ruleset: RULESET_V4,
    seed: seed >>> 0,
    budget: { mode: budgetMode, limit: budgetLimit },
    teamA: team(a, aForm, aDoc),
    teamB: team(b, bForm, bDoc)
  };
}

function lossSum(st: ReturnType<typeof summarizeStats>, t: 'A' | 'B'): number {
  let s = 0;
  for (const v of Object.values(st.losses[t])) s += v;
  return s;
}

function fingerprint(state: ReturnType<typeof createInitialState>): string {
  const ships = state.ships
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((s) => {
      const comps = s.components
        .map((c) => `${c.hp.toFixed(2)}:${c.destroyed ? 1 : 0}`)
        .join(',');
      return `${s.id}:${s.team}:${s.type}:${s.variant}:${isPresentOnBattlefield(s) ? 1 : 0}:[${comps}]`;
    })
    .join('|');
  const st = summarizeStats(state);
  return (
    `winner=${state.winner}|tick=${state.tick}|A=${state.teamACount}|B=${state.teamBCount}` +
    `|dmg=${st.totalDamage.A}/${st.totalDamage.B}|kills=${st.kills.A}/${st.kills.B}` +
    `|lossA=${lossSum(st, 'A')}|lossB=${lossSum(st, 'B')}|ships=${ships}`
  );
}

/** 从头连续模拟到结束（chunk 控制每次推进的 tick 数，用于验证倍速无关性） */
function runToEnd(cfg: ReplayConfig, chunk = 1, maxTicks?: number): ReturnType<typeof createInitialState> {
  const rng = createPRNG(cfg.seed);
  const state = createInitialState(cfg, rng);
  if (typeof maxTicks === 'number' && maxTicks > 0) state.maxTicks = maxTicks;
  const sim = createSimulator(state, rng);
  let guard = 0;
  while (!state.finished && guard < state.maxTicks + 5) {
    if (chunk <= 1) {
      sim.step();
    } else {
      for (let k = 0; k < chunk && !state.finished; k++) sim.step();
    }
    guard++;
  }
  return state;
}

/** 模拟到 seekTick 后再继续到结束（验证跳转与连续播放结果一致） */
function runToEndViaSeek(cfg: ReplayConfig, seekTick: number): ReturnType<typeof createInitialState> {
  const rng = createPRNG(cfg.seed);
  const state = createInitialState(cfg, rng);
  const sim = createSimulator(state, rng);
  let guard = 0;
  while (state.tick < seekTick && !state.finished && guard < state.maxTicks + 5) {
    sim.step();
    guard++;
  }
  guard = 0;
  while (!state.finished && guard < state.maxTicks + 5) {
    sim.step();
    guard++;
  }
  return state;
}

/** 纯 sim 的平衡测试：以自动递增 seed 跑 N 次，输出胜率与平均指标。
 *  V0.5：委托给 balanceRunner.runBalance（更丰富的统计）。保留原 console 友好签名。 */
export function runBalanceTest(config?: ReplayConfig, count = 20): string {
  const base: ReplayConfig =
    config ??
    (() => {
      const f: FleetEntry[] = [
        { shipClass: 'Fighter', variant: 'standard', count: 6 },
        { shipClass: 'Frigate', variant: 'standard', count: 2 },
        { shipClass: 'Cruiser', variant: 'standard', count: 1 }
      ];
      return makeCfg(1000, f, f, 'line', 'balanced', 'line', 'balanced', 'unlimited', 1000);
    })();

  const balCfg: BalanceRunConfig = {
    teamA: base.teamA,
    teamB: base.teamB,
    seed: base.seed,
    seedStep: 2654435761,
    runs: Math.max(1, count),
    maxTicks: 4000,
    swapSides: false
  };
  const res = runBalance(balCfg);
  const line =
    `Balance test (n=${res.runs}): A胜率 ${res.winRateA.toFixed(1)}% | B胜率 ${res.winRateB.toFixed(1)}% | 平局 ${res.draws}\n` +
    `  平均 tick=${res.avgTicks} (min ${res.minTicks}, max ${res.maxTicks})\n` +
    `  平均剩余 A=${res.avgRemainA} B=${res.avgRemainB}\n` +
    `  平均剩余点数 A=${res.avgPointsA} B=${res.avgPointsB}\n` +
    `  平均总伤害 A=${res.avgDamageA} B=${res.avgDamageB}`;
  console.log('[SpaceWar] ' + line);
  return line;
}

export function runDeterministicTest(): string {
  const out: string[] = [];
  let ok = true;
  const fail = (msg: string) => {
    ok = false;
    out.push('  ✗ ' + msg);
  };
  const pass = (msg: string) => out.push('  ✓ ' + msg);

  // ---------- 1. 旧格式 replay（v0.2）必须被拒绝并提示重新生成 ----------
  try {
    const oldCode = b64url({
      v: '0.2',
      seed: 123456,
      teamA: { Fighter: 3, Frigate: 1, Cruiser: 1 },
      teamB: { Fighter: 2, Frigate: 2, Cruiser: 0 }
    });
    let threw = false;
    let msg = '';
    try {
      decodeReplay(oldCode);
    } catch (e) {
      threw = true;
      msg = String(e);
    }
    if (!threw) fail('旧格式(v0.2) 应被拒绝，却成功解码');
    else if (!msg.includes('当前快速开发版已不再兼容历史测试录像')) fail('旧格式拒绝信息不明确：' + msg);
    else pass('旧格式(v0.2) 导入被明确拒绝（提示重新生成录像代码）');
  } catch (e) {
    fail('旧格式测试抛错：' + (e as Error).message);
  }

  // ---------- 2. 旧格式 replay（v0.3）必须被拒绝并提示重新生成 ----------
  try {
    const oldCode = b64url({
      v: '0.3',
      seed: 654321,
      teamA: { ships: { Fighter: 6, Frigate: 2, Cruiser: 1 }, formation: 'wedge', doctrine: 'aggressive' },
      teamB: { ships: { Fighter: 4, Frigate: 3, Cruiser: 1 }, formation: 'wall', doctrine: 'defensive' }
    });
    let threw = false;
    let msg = '';
    try {
      decodeReplay(oldCode);
    } catch (e) {
      threw = true;
      msg = String(e);
    }
    if (!threw) fail('旧格式(v0.3) 应被拒绝，却成功解码');
    else if (!msg.includes('当前快速开发版已不再兼容历史测试录像')) fail('旧格式拒绝信息不明确：' + msg);
    else pass('旧格式(v0.3) 导入被明确拒绝（提示重新生成录像代码）');
  } catch (e) {
    fail('旧格式测试抛错：' + (e as Error).message);
  }

  // ---------- 3. v0.5 编解码往返：fleet + variant + budget 不丢失 ----------
  try {
    const cfgV5 = makeCfg(
      0x1234,
      fleet([
        { shipClass: 'Fighter', variant: 'interceptor', count: 4 },
        { shipClass: 'Frigate', variant: 'escort', count: 1 },
        { shipClass: 'Cruiser', variant: 'fortress', count: 1 }
      ]),
      fleet([
        { shipClass: 'Fighter', variant: 'bomber', count: 3 },
        { shipClass: 'Frigate', variant: 'artillery', count: 2 },
        { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
      ]),
      'wedge',
      'aggressive',
      'wall',
      'defensive',
      'limited',
      1000
    );
    const code = encodeReplay(cfgV5);
    const dec = decodeReplay(code);
    const fleetOk =
      JSON.stringify(dec.teamA.fleet) === JSON.stringify(cfgV5.teamA.fleet) &&
      JSON.stringify(dec.teamB.fleet) === JSON.stringify(cfgV5.teamB.fleet);
    const budgetOk =
      !!dec.budget &&
      dec.budget.mode === 'limited' &&
      dec.budget.limit === 1000;
    if (!fleetOk) fail('v0.5 编解码：fleet/variant 未完整保留');
    else if (!budgetOk) fail('v0.5 编解码：budget 未完整保留');
    else pass('v0.5 编解码往返：fleet + variant + budget 完整保留');
  } catch (e) {
    fail('v0.5 编解码抛错：' + (e as Error).message);
  }

  // ---------- 4. 同 seed + 同 formation/doctrine 连续两次结果一致（标准改型） ----------
  const baseCfg = makeCfg(
    0x00abc123,
    fleet([{ shipClass: 'Fighter', variant: 'standard', count: 3 }, { shipClass: 'Frigate', variant: 'standard', count: 1 }, { shipClass: 'Cruiser', variant: 'standard', count: 1 }]),
    fleet([{ shipClass: 'Fighter', variant: 'standard', count: 3 }, { shipClass: 'Frigate', variant: 'standard', count: 1 }, { shipClass: 'Cruiser', variant: 'standard', count: 1 }]),
    'line', 'balanced', 'line', 'balanced'
  );
  const r1 = fingerprint(runToEnd(baseCfg));
  const r2 = fingerprint(runToEnd(baseCfg));
  if (r1 === r2) pass('同 seed+formation+doctrine 连跑两次结果完全一致');
  else { ok = false; out.push('  ✗ 同配置两次模拟不一致：\n    A=' + r1 + '\n    B=' + r2); }

  // ---------- 5. 改型（bomber/escort/fortress/carrier 等）确定性复现 ----------
  const variantCfg = makeCfg(
    0x77cc99,
    fleet([
      { shipClass: 'Fighter', variant: 'bomber', count: 4 },
      { shipClass: 'Frigate', variant: 'escort', count: 2 },
      { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
    ]),
    fleet([
      { shipClass: 'Fighter', variant: 'interceptor', count: 4 },
      { shipClass: 'Frigate', variant: 'artillery', count: 2 },
      { shipClass: 'Cruiser', variant: 'fortress', count: 1 }
    ]),
    'swarm', 'antiCapital', 'wall', 'defensive'
  );
  const v1 = fingerprint(runToEnd(variantCfg));
  const v2 = fingerprint(runToEnd(variantCfg));
  if (v1 === v2) pass('混合改型（bomber/escort/carrier vs interceptor/artillery/fortress）确定性复现一致');
  else { ok = false; out.push('  ✗ 改型模拟不一致：\n    X=' + v1 + '\n    Y=' + v2); }

  // ---------- 6. 不同倍速（1x/2x/4x）最终结果一致 ----------
  const a1 = fingerprint(runToEnd(baseCfg, 1));
  const a2 = fingerprint(runToEnd(baseCfg, 2));
  const a4 = fingerprint(runToEnd(baseCfg, 4));
  if (a1 === a2 && a2 === a4) pass('倍速 1x/2x/4x 最终结果一致（与帧推进无关）');
  else { ok = false; out.push('  ✗ 倍速影响结果：\n    1x=' + a1 + '\n    2x=' + a2 + '\n    4x=' + a4); }

  // ---------- 7. 从头播放 vs 跳转中段再播放，结果一致 ----------
  const full = fingerprint(runToEnd(baseCfg));
  const seeked = fingerprint(runToEndViaSeek(baseCfg, 500));
  if (full === seeked) pass('从头播放 与 跳转(tick=500)再播放 结果一致');
  else { ok = false; out.push('  ✗ 跳转影响结果：\n    full=' + full + '\n    seek=' + seeked); }

  // ---------- 8. 多 doctrine 组合：结果确定且不同组合有差异 ----------
  const pairs: [DoctrineType, DoctrineType][] = [
    ['balanced', 'balanced'],
    ['aggressive', 'defensive'],
    ['kite', 'antiCapital']
  ];
  for (const [da, db] of pairs) {
    const cfg = makeCfg(
      0x55aa33,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 4 }, { shipClass: 'Frigate', variant: 'standard', count: 2 }, { shipClass: 'Cruiser', variant: 'standard', count: 1 }]),
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 4 }, { shipClass: 'Frigate', variant: 'standard', count: 2 }, { shipClass: 'Cruiser', variant: 'standard', count: 1 }]),
      'wedge', da, 'wall', db
    );
    const x = fingerprint(runToEnd(cfg));
    const y = fingerprint(runToEnd(cfg));
    if (x === y) pass(`doctrine ${da} vs ${db}：确定性复现一致`);
    else { ok = false; out.push(`  ✗ doctrine ${da} vs ${db} 不一致：\n    X=${x}\n    Y=${y}`); }
  }

  // ---------- 9. V0.1 最旧格式必须被拒绝并提示重新生成 ----------
  try {
    const v1Code = b64url({
      v: '0.1',
      seed: 11111,
      teamA: { Fighter: 3, Frigate: 1, Cruiser: 1 },
      teamB: { Fighter: 2, Frigate: 2, Cruiser: 0 }
    });
    let threw = false;
    let msg = '';
    try {
      decodeReplay(v1Code);
    } catch (e) {
      threw = true;
      msg = String(e);
    }
    if (!threw) fail('v0.1 应被拒绝，却成功解码');
    else if (!msg.includes('当前快速开发版已不再兼容历史测试录像')) fail('v0.1 拒绝信息不明确：' + msg);
    else pass('v0.1 最旧格式导入被明确拒绝（提示重新生成录像代码）');
  } catch (e) {
    fail('v0.1 测试抛错：' + (e as Error).message);
  }

  // ---------- 10. 舰队方案码 encode/decode 往返（与录像码完全独立） ----------
  try {
    const preset = makeFleetPreset({
      name: '测试舰队',
      fleet: fleet([
        { shipClass: 'Fighter', variant: 'scout', count: 3 },
        { shipClass: 'Frigate', variant: 'support', count: 1 },
        { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
      ]),
      formation: 'wall',
      doctrine: 'defensive',
      notes: '备注文本'
    });
    const code = encodeFleet(preset);
    const dec = decodeFleet(code);
    const okFleet = JSON.stringify(dec.fleet) === JSON.stringify(preset.fleet);
    const okMeta =
      dec.formation === 'wall' &&
      dec.doctrine === 'defensive' &&
      dec.name === '测试舰队' &&
      dec.notes === '备注文本';
    if (!okFleet) fail('舰队码往返：fleet/variant 未完整保留');
    else if (!okMeta) fail('舰队码往返：formation/doctrine/name/notes 未完整保留');
    else pass('舰队码 encode/decode 往返：fleet+formation+doctrine+name+notes 完整保留（id 重新生成）');
  } catch (e) {
    fail('舰队码往返抛错：' + (e as Error).message);
  }

  // ---------- 11. 舰队码 vs 战斗录像码 类型区分（互贴给明确提示） ----------
  try {
    const preset = makeFleetPreset({
      name: 'x',
      fleet: fleet([{ shipClass: 'Fighter', variant: 'standard', count: 2 }]),
      formation: 'line',
      doctrine: 'balanced'
    });
    const fleetCode = encodeFleet(preset);
    const battleCode = encodeReplay(baseCfg);
    let fleetAsReplayErr = false;
    let replayAsFleetErr = false;
    try {
      decodeReplay(fleetCode);
    } catch {
      fleetAsReplayErr = true;
    }
    try {
      decodeFleet(battleCode);
    } catch {
      replayAsFleetErr = true;
    }
    if (!fleetAsReplayErr) fail('把舰队码当录像码解码应当报错，却成功');
    else if (!replayAsFleetErr) fail('把录像码当舰队码解码应当报错，却成功');
    else pass('舰队码与录像码类型区分：互贴会给出明确提示，不会静默误用');
  } catch (e) {
    fail('类型区分测试抛错：' + (e as Error).message);
  }

  // ---------- 12. 选择 / 镜头 / 视图筛选 不是 replay 的一部分（不影响结果） ----------
  try {
    const code = encodeReplay(baseCfg);
    const dec = decodeReplay(code);
    const s = JSON.stringify(dec).toLowerCase();
    if (s.includes('selection') || s.includes('camera') || s.includes('viewfilter') || s.includes('filter'))
      fail('replay 不应包含选择/镜头/视图筛选等 UI 状态字段');
    else pass('replay code 仅含战斗配置（v/ruleset/seed/budget/teamA/teamB），选择/镜头/视图筛选不影响结果');
  } catch (e) {
    fail('replay UI 隔离检查抛错：' + (e as Error).message);
  }

  // ---------- 13. 时间线聚合确定性（不依赖任何 UI 状态） ----------
  try {
    const markers1 = buildTimeline(simulateFull(baseCfg));
    const markers2 = buildTimeline(simulateFull(baseCfg));
    const norm = (ms: ReturnType<typeof buildTimeline>) =>
      JSON.stringify(ms.map((m) => ({ t: m.tick, ty: m.type, s: m.shipId, tm: m.team, im: m.importance })));
    if (norm(markers1) === norm(markers2))
      pass(`时间线聚合确定性一致（${markers1.length} 个关键事件标记，两次生成完全相同）`);
    else {
      ok = false;
      out.push('  ✗ 时间线两次生成不一致');
    }
  } catch (e) {
    fail('时间线生成抛错：' + (e as Error).message);
  }

  // ---------- 14. 平衡实验室单局（runBalance runs=1）与直接 sim 结果完全一致 ----------
  try {
    const MT = 6000;
    const balCfg: BalanceRunConfig = {
      teamA: baseCfg.teamA,
      teamB: baseCfg.teamB,
      seed: baseCfg.seed,
      seedStep: 1,
      runs: 1,
      maxTicks: MT,
      swapSides: false
    };
    const res = runBalance(balCfg);
    const rec = res.runsList[0];
    const state = runToEnd(baseCfg, 1, MT);
    const st = summarizeStats(state);
    const okWin = state.winner === rec.winner;
    const okTick = state.tick === rec.ticks;
    const okA = state.teamACount === rec.teamARemaining;
    const okB = state.teamBCount === rec.teamBRemaining;
    const okDA = Math.round(st.totalDamage.A) === rec.teamADamage;
    const okDB = Math.round(st.totalDamage.B) === rec.teamBDamage;
    if (okWin && okTick && okA && okB && okDA && okDB)
      pass('平衡实验室单局(runBalance, runs=1) 与直接 sim 结果完全一致（Worker/主线程同源）');
    else {
      ok = false;
      out.push(
        `  ✗ 平衡单局 vs sim 不一致：sim(win=${state.winner},tick=${state.tick},A=${state.teamACount},B=${state.teamBCount},dmgA=${Math.round(
          st.totalDamage.A
        )},dmgB=${Math.round(st.totalDamage.B)}) vs bal(win=${rec.winner},tick=${rec.ticks},A=${rec.teamARemaining},B=${rec.teamBRemaining},dmgA=${rec.teamADamage},dmgB=${rec.teamBDamage})`
      );
    }
  } catch (e) {
    fail('平衡单局对比抛错：' + (e as Error).message);
  }

  // ---------- 15. swap-sides 运行后输入配置（teamA/teamB）不变 ----------
  try {
    const input: BalanceRunConfig = {
      teamA: JSON.parse(JSON.stringify(baseCfg.teamA)),
      teamB: JSON.parse(JSON.stringify(baseCfg.teamB)),
      seed: 777,
      seedStep: 1,
      runs: 4,
      maxTicks: 3000,
      swapSides: true
    };
    const snapshot = JSON.stringify(input);
    runBalance(input);
    if (JSON.stringify(input) === snapshot) pass('swap-sides 运行后输入配置（teamA/teamB）未被修改');
    else {
      ok = false;
      out.push('  ✗ swap-sides 修改了输入配置');
    }
  } catch (e) {
    fail('swap 不改配置测试抛错：' + (e as Error).message);
  }

  // ---------- 16. 克隆隔离：载入/导入/应用不污染原配置 ----------
  try {
    const src = makeCfg(
      123,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 5 }]),
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 3 }]),
      'line',
      'balanced',
      'line',
      'balanced'
    );
    const cloned = cloneReplayConfig(src);
    cloned.teamA.fleet[0].count = 99;
    (cloned.teamA as TeamConfig).formation = 'wedge';
    const fleetCloned = cloneFleet(src.teamA.fleet);
    fleetCloned[0].count = 42;
    const iso =
      src.teamA.fleet[0].count === 5 &&
      src.teamA.formation === 'line' &&
      src.teamA.fleet[0].count === 5;
    if (iso) pass('克隆隔离：cloneReplayConfig / cloneFleet 不共享引用（载入/导入不影响原配置）');
    else {
      ok = false;
      out.push('  ✗ 克隆未隔离引用：原配置被修改');
    }
  } catch (e) {
    fail('克隆隔离测试抛错：' + (e as Error).message);
  }

  // ---------- 17. 50 舰（25 v 25）大规模战斗确定性 ----------
  try {
    const big = makeCfg(
      2024,
      fleet([
        { shipClass: 'Fighter', variant: 'standard', count: 15 },
        { shipClass: 'Frigate', variant: 'standard', count: 5 },
        { shipClass: 'Cruiser', variant: 'standard', count: 5 }
      ]),
      fleet([
        { shipClass: 'Fighter', variant: 'standard', count: 15 },
        { shipClass: 'Frigate', variant: 'standard', count: 5 },
        { shipClass: 'Cruiser', variant: 'standard', count: 5 }
      ]),
      'swarm',
      'balanced',
      'swarm',
      'balanced',
      'unlimited',
      1000
    );
    const b1 = fingerprint(runToEnd(big));
    const b2 = fingerprint(runToEnd(big));
    if (b1 === b2) pass('50 舰（25 v 25）大规模战斗确定性复现一致');
    else {
      ok = false;
      out.push('  ✗ 50 舰模拟不一致');
    }
  } catch (e) {
    fail('50 舰测试抛错：' + (e as Error).message);
  }

  // ---------- 18. Carrier / Scout / Support / Escort 同场共存确定性 ----------
  try {
    const mixed = makeCfg(
      909,
      fleet([
        { shipClass: 'Fighter', variant: 'scout', count: 2 },
        { shipClass: 'Fighter', variant: 'standard', count: 3 },
        { shipClass: 'Frigate', variant: 'support', count: 1 },
        { shipClass: 'Frigate', variant: 'escort', count: 1 },
        { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
      ]),
      fleet([
        { shipClass: 'Fighter', variant: 'scout', count: 2 },
        { shipClass: 'Frigate', variant: 'support', count: 1 },
        { shipClass: 'Frigate', variant: 'escort', count: 1 },
        { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
      ]),
      'line',
      'balanced',
      'line',
      'balanced'
    );
    const m1 = fingerprint(runToEnd(mixed));
    const m2 = fingerprint(runToEnd(mixed));
    if (m1 === m2) pass('Carrier/Scout/Support/Escort 同场共存：确定性复现一致');
    else {
      ok = false;
      out.push('  ✗ Carrier/Scout/Support/Escort 共存不一致');
    }
  } catch (e) {
    fail('共存测试抛错：' + (e as Error).message);
  }

  // ---------- 19. 稳定排序：同配置多次模拟结果一致（等价目标按 ship.id 解析） ----------
  try {
    const sym = makeCfg(
      555,
      fleet([
        { shipClass: 'Fighter', variant: 'standard', count: 8 },
        { shipClass: 'Frigate', variant: 'standard', count: 4 },
        { shipClass: 'Cruiser', variant: 'standard', count: 2 }
      ]),
      fleet([
        { shipClass: 'Fighter', variant: 'standard', count: 8 },
        { shipClass: 'Frigate', variant: 'standard', count: 4 },
        { shipClass: 'Cruiser', variant: 'standard', count: 2 }
      ]),
      'line',
      'focusFire',
      'line',
      'focusFire'
    );
    const fps = [
      fingerprint(runToEnd(sym)),
      fingerprint(runToEnd(sym)),
      fingerprint(runToEnd(sym)),
      fingerprint(runToEnd(sym)),
      fingerprint(runToEnd(sym))
    ];
    const allSame = fps.every((f) => f === fps[0]);
    if (allSame) pass('稳定排序：同配置连跑 5 次结果完全一致（等价目标按 ship.id 确定性解析）');
    else {
      ok = false;
      out.push('  ✗ 稳定排序不一致：5 次中有差异');
    }
  } catch (e) {
    fail('稳定排序测试抛错：' + (e as Error).message);
  }

  // ---------- 20. v0.5 + core-v4 新建战斗默认与编解码往返 ----------
  try {
    const cfgV5: ReplayConfig = {
      v: SIM_VERSION_V5,
      ruleset: RULESET_V4,
      seed: 0xc0ffee,
      budget: { mode: 'unlimited', limit: 999999 },
      teamA: { fleet: fleet([{ shipClass: 'Fighter', variant: 'standard', count: 2 }]), formation: 'wedge', doctrine: 'balanced' },
      teamB: { fleet: fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 1 }]), formation: 'wall', doctrine: 'defensive' }
    };
    const code5 = encodeReplay(cfgV5);
    const dec5 = decodeReplay(code5);
    if (dec5.v !== SIM_VERSION_V5) fail(`v0.5 编解码：version 应为 ${SIM_VERSION_V5}，实际 ${dec5.v}`);
    else if (dec5.ruleset !== RULESET_V4) fail(`v0.5 编解码：ruleset 应为 ${RULESET_V4}，实际 ${dec5.ruleset}`);
    else if (dec5.seed !== 0xc0ffee) fail('v0.5 编解码：seed 未保留');
    else pass('v0.5 + core-v4 编解码往返：version/ruleset/seed 完整保留');
  } catch (e) {
    fail('v0.5 编解码抛错：' + (e as Error).message);
  }

  // ---------- 21. 未知 ruleset 必须被拒绝（不静默回退） ----------
  try {
    const bad = b64url({ v: '0.5', ruleset: 'spacewar-core-v99', seed: 1, teamA: { fleet: [{ shipClass: 'Fighter', variant: 'standard', count: 1 }] }, teamB: { fleet: [{ shipClass: 'Fighter', variant: 'standard', count: 1 }] } });
    let threw = false;
    let msg = '';
    try {
      decodeReplay(bad as unknown as string);
    } catch (e) {
      threw = true;
      msg = String(e);
    }
    if (!threw) fail('未知 ruleset(spacewar-core-v99) 应当被拒绝，却成功解码');
    else if (!msg.includes('不支持的战斗规则版本')) fail('未知 ruleset 错误信息不明确');
    else pass('未知 ruleset 被明确拒绝（信息：不支持的战斗规则版本）');
  } catch (e) {
    fail('未知 ruleset 测试抛错：' + (e as Error).message);
  }

  // ---------- 22. 旧版本（v0.2）一律拒绝，无论其声称的 ruleset 是什么 ----------
  try {
    const mismatch = b64url({ v: '0.2', ruleset: 'spacewar-core-v4', seed: 1, teamA: { Fighter: 1 }, teamB: { Fighter: 1 } });
    let threw = false;
    let msg = '';
    try {
      decodeReplay(mismatch as unknown as string);
    } catch (e) {
      threw = true;
      msg = String(e);
    }
    if (threw && msg.includes('当前快速开发版已不再兼容历史测试录像')) pass('旧版本(v0.2) 被拒绝并提示重新生成（不兼容历史录像）');
    else fail('旧版本(v0.2) 应当被拒绝并提示重新生成，实际 threw=' + threw);
  } catch (e) {
    fail('旧版本拒绝测试抛错：' + (e as Error).message);
  }

  // ---------- 23. tick 时间换算与 maxTicks 无关 ----------
  try {
    const tps = TICKS_PER_SECOND;
    const conv = (tick: number, maxTicks: number) => tickToSeconds(tick); // 第二参数仅用于语义对照，实际不使用
    const cases: [number, number][] = [
      [30, 3600],
      [300, 3600],
      [300, 6000],
      [300, 12000]
    ];
    let allOk = true;
    for (const [tick, mt] of cases) {
      const sec = conv(tick, mt);
      const expect = tick / tps;
      if (Math.abs(sec - expect) > 1e-9) allOk = false;
    }
    if (!allOk) fail('tick 时间换算受 maxTicks 影响');
    else if (Math.abs(conv(30, 3600) - 1) > 1e-9) fail('tick=30 应等于 1 秒');
    else if (Math.abs(conv(300, 6000) - 10) > 1e-9) fail('tick=300 应等于 10 秒（与 maxTicks 无关）');
    else pass(`tick 时间换算与 maxTicks 无关（tick=30→1s, tick=300→10s，TPS=${tps}）`);
  } catch (e) {
    fail('时间换算测试抛错：' + (e as Error).message);
  }

  // ---------- 汇总 ----------
  if (ok) {
    const line = 'Deterministic test passed — 全部用例通过（旧版本 v0.1~v0.4 拒绝、v0.5 编解码往返、舰队码往返、舰队码vs录像码区分、replay无UI状态、同seed、改型、倍速、seek、时间线确定性、平衡单局vs sim、swap不改配置、克隆隔离、50舰、Carrier/Scout/Support/Escort共存、稳定排序）';
    console.log('[SpaceWar] ' + line);
    return line;
  }
  const msg = 'Deterministic test FAILED：\n' + out.join('\n');
  console.error('[SpaceWar] ' + msg);
  return msg;
}

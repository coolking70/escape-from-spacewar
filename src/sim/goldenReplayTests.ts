// 黄金录像回归测试（core-v4 唯一正式规则）。
//
// 每个黄金用例是固定 (config, ruleset, seed, maxTicks) 的战斗，跑到结束后对其最终状态做
// 确定性指纹；指纹与内嵌的 EXPECTED 基线比对。若不一致说明模拟层发生非预期变更
// （破坏录像可复现性）。纯 sim，无渲染 / DOM。
//
// 注意：
//  - 指纹只描述"战斗结果"（winner/reason/tick/舰船与组件终态），**不含 ruleset 标签本身**。
//  - runGoldenReplayTests() 严格要求所有用例都有内嵌基线；缺失即判失败（绝不自动写入）。
//  - 只有 generateGoldenReplayValues() 会输出候选值，且明确提示"需人工核对后再更新"。
// 浏览器中可用 window.runGoldenReplayTests() / window.generateGoldenReplayValues() 运行。

import { createPRNG } from './prng';
import { createInitialState, createSimulator } from './rulesets';
import {
  ReplayConfig,
  TeamConfig,
  FleetEntry,
  ShipClass,
  ShipVariant,
  FormationType,
  DoctrineType,
  Ship,
  CombatState
} from './battleTypes';
import { SIM_VERSION_V5, RULESET_V4, MAX_TICKS } from './battleConfig';
import { getVariantDef } from './shipVariants';
import { isPresentOnBattlefield } from './shipFlags';

function fleet(entries: { shipClass: ShipClass; variant: ShipVariant; count: number }[]): FleetEntry[] {
  return entries.map((e) => ({ shipClass: e.shipClass, variant: e.variant, count: e.count }));
}
function team(fl: FleetEntry[], form: FormationType, doc: DoctrineType): TeamConfig {
  return { fleet: fl, formation: form, doctrine: doc };
}
function makeReplay(
  v: string,
  ruleset: string,
  seed: number,
  a: FleetEntry[],
  b: FleetEntry[],
  aForm: FormationType,
  aDoc: DoctrineType,
  bForm: FormationType,
  bDoc: DoctrineType
): ReplayConfig {
  return {
    v,
    ruleset,
    seed: seed >>> 0,
    budget: { mode: 'unlimited', limit: 999999 },
    teamA: team(a, aForm, aDoc),
    teamB: team(b, bForm, bDoc)
  };
}

// ---------------- 单舰价值（纯 CombatState 派生，v4 唯一口径） ----------------
// 规则（冻结）：normal/damaged/critical/retreating = 100% cost；
//       escaped = 100% cost（保存下来的舰队价值）；disabled = 50% cost；destroyed = 0%。
function shipValue(ship: Ship): number {
  const cost = getVariantDef(ship.variant).cost;
  const cs: CombatState = ship.combatState;
  if (cs === 'destroyed') return 0;
  if (cs === 'disabled') return cost * 0.5;
  return cost; // normal / damaged / critical / retreating / escaped
}

function isDestroyed(ship: Ship): boolean {
  return ship.combatState === 'destroyed'; // 脱战(escaped)不算摧毁
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** 跑完一场战斗并对最终状态生成确定性指纹（同输入必得同输出） */
export function fingerprintOf(cfg: ReplayConfig, maxTicks?: number): string {
  const rng = createPRNG(cfg.seed);
  const state = createInitialState(cfg, rng);
  if (maxTicks && maxTicks > 0) state.maxTicks = maxTicks;
  const sim = createSimulator(state, rng);
  let g = 0;
  while (!state.finished && g <= state.maxTicks + 1) {
    sim.step();
    g++;
  }

  let dA = 0,
    dB = 0,
    disA = 0,
    disB = 0,
    escA = 0,
    escB = 0,
    rvA = 0,
    rvB = 0;
  const tdA = Math.round(state.stats.team.A.totalDamage);
  const tdB = Math.round(state.stats.team.B.totalDamage);

  for (const sh of state.ships) {
    const cs = sh.combatState;
    if (cs === 'disabled') {
      if (sh.team === 'A') disA++;
      else disB++;
    } else if (cs === 'escaped') {
      if (sh.team === 'A') escA++;
      else escB++;
    }
    if (isDestroyed(sh)) {
      if (sh.team === 'A') dA++;
      else dB++;
    }
    const v = shipValue(sh);
    if (sh.team === 'A') rvA += v;
    else rvB += v;
  }

  const ships = state.ships
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(
      (s) =>
        `${s.id}:${s.team}:${s.variant}:${isPresentOnBattlefield(s) ? 1 : 0}:${s.combatState ?? 'normal'}` +
        `:${Math.round(s.components.reduce((x, c) => x + c.hp, 0))}:${s.escapedTick ?? -1}` +
        `:${s.pos.x.toFixed(2)},${s.pos.z.toFixed(2)}`
    )
    .join('|');

  const comps = state.ships
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((s) =>
      s.components
        .map((c, i) => `${i}:${c.def.type}:${Math.round(c.hp)}:${c.destroyed ? 1 : 0}`)
        .join(',')
    )
    .join('|');

  const shipHash = djb2(ships);
  const compHash = djb2(comps);

  return [
    `winner=${state.winner}`,
    `reason=${state.victoryReason ?? 'none'}`,
    `tick=${state.tick}`,
    `maxTicks=${state.maxTicks}`,
    `A=${state.teamACount}`,
    `B=${state.teamBCount}`,
    `destroyed=${dA}:${dB}`,
    `disabled=${disA}:${disB}`,
    `escaped=${escA}:${escB}`,
    `remainingFleetValue=${Math.round(rvA)}:${Math.round(rvB)}`,
    `totalDamage=${tdA}:${tdB}`,
    `shipHash=${shipHash}`,
    `compHash=${compHash}`,
    `ships=${ships}`,
    `comps=${comps}`
  ].join('|');
}

interface GoldenCase {
  name: string;
  cfg: ReplayConfig;
  maxTicks?: number;
}

// 黄金用例：覆盖 core-v4（方向命中 / 失能 / 撤退 / 战术深化），不同阵型与战术、
// 小/中/大/超大舰队、含支援/航母/侦察等改型，以及失能、脱战、撤离等结局。
// 共 8 组（仅保留唯一正式规则 core-v4）。
export const GOLDEN_CASES: GoldenCase[] = [
  // ---- core-v4（方向命中 / 失能 / 撤退 / 战术深化） ----
  {
    name: 'v4-small-balanced',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 1001,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 3 }, { shipClass: 'Frigate', variant: 'standard', count: 2 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 3 }, { shipClass: 'Frigate', variant: 'standard', count: 2 }]),
      'wedge', 'balanced', 'wedge', 'balanced')
  },
  {
    name: 'v4-large-mixed',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 2002,
      fleet([{ shipClass: 'Cruiser', variant: 'standard', count: 2 }, { shipClass: 'Frigate', variant: 'support', count: 3 }, { shipClass: 'Fighter', variant: 'scout', count: 5 }]),
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Cruiser', variant: 'carrier', count: 2 }, { shipClass: 'Fighter', variant: 'interceptor', count: 5 }]),
      'wall', 'defensive', 'line', 'aggressive')
  },
  {
    name: 'v4-kite-vs-screen',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 3003,
      fleet([{ shipClass: 'Frigate', variant: 'support', count: 4 }, { shipClass: 'Fighter', variant: 'scout', count: 6 }]),
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Cruiser', variant: 'carrier', count: 2 }, { shipClass: 'Fighter', variant: 'interceptor', count: 6 }]),
      'swarm', 'kite', 'wedge', 'screen')
  },
  {
    name: 'v4-25v25',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 4004,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 15 }, { shipClass: 'Frigate', variant: 'support', count: 6 }, { shipClass: 'Cruiser', variant: 'fortress', count: 4 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 15 }, { shipClass: 'Cruiser', variant: 'carrier', count: 6 }, { shipClass: 'Cruiser', variant: 'standard', count: 4 }]),
      'wall', 'defensive', 'wedge', 'aggressive')
  },
  {
    name: 'v4-50v50',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 5005,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 30 }, { shipClass: 'Frigate', variant: 'support', count: 12 }, { shipClass: 'Cruiser', variant: 'fortress', count: 8 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 30 }, { shipClass: 'Cruiser', variant: 'carrier', count: 12 }, { shipClass: 'Cruiser', variant: 'standard', count: 8 }]),
      'wall', 'defensive', 'wedge', 'aggressive'),
    maxTicks: 6000
  },
  {
    name: 'v4-defensive-retreat',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 6006,
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Frigate', variant: 'support', count: 3 }, { shipClass: 'Fighter', variant: 'scout', count: 5 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 18 }]),
      'wall', 'defensive', 'wedge', 'aggressive')
  },
  {
    name: 'v4-focusFire-vs-screen',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 7007,
      fleet([{ shipClass: 'Cruiser', variant: 'standard', count: 2 }, { shipClass: 'Fighter', variant: 'standard', count: 8 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 10 }, { shipClass: 'Frigate', variant: 'standard', count: 4 }]),
      'wall', 'focusFire', 'line', 'screen')
  },
  {
    name: 'v4-antiCapital-vs-swarm',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 8008,
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 3 }, { shipClass: 'Fighter', variant: 'standard', count: 6 }]),
      fleet([{ shipClass: 'Cruiser', variant: 'carrier', count: 3 }, { shipClass: 'Fighter', variant: 'scout', count: 12 }]),
      'wedge', 'antiCapital', 'swarm', 'kite')
  }
];

// 黄金基线指纹（由 generateGoldenReplayValues() 生成后人工核对再内嵌；任何模拟层变更
// 都必须保持这些指纹稳定）。缺失的键会导致 runGoldenReplayTests() 直接判失败。
export const GOLDEN_EXPECTED: Record<string, string> = {
  'v4-small-balanced': "winner=B|reason=timeout|tick=3600|maxTicks=3600|A=1|B=1|destroyed=2:2|disabled=0:0|escaped=2:2|remainingFleetValue=150:155|totalDamage=1028:827|shipHash=98b22a08|compHash=99eb74f7|ships=0:A:standard:0:escaped:92:956:-47.09,54.38|1:A:standard:0:destroyed:54:-1:-21.01,-33.46|2:A:standard:0:destroyed:82:-1:-39.92,56.90|3:A:standard:1:normal:467:-1:-29.27,-53.90|4:A:standard:0:escaped:245:703:-47.07,98.93|5:B:interceptor:0:destroyed:32:-1:-38.26,-93.94|6:B:interceptor:0:escaped:90:589:47.40,-42.74|7:B:interceptor:0:destroyed:0:-1:-17.61,-111.88|8:B:standard:0:escaped:182:2024:47.01,-114.12|9:B:standard:1:normal:438:-1:-68.49,-105.21|comps=0:core:10:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:155:0,1:engine:55:0,2:engine:55:0,3:weapon:60:0,4:weapon:45:0,5:weapon:12:0,6:sensor:30:0,7:shield:55:0|0:core:23:0,1:engine:37:0,2:engine:46:0,3:weapon:49:0,4:weapon:0:1,5:weapon:45:0,6:sensor:45:0,7:shield:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:4:0|0:core:8:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:28:0,1:engine:27:0,2:engine:4:0,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:7:0,7:shield:0:1|0:core:153:0,1:engine:55:0,2:engine:55:0,3:weapon:59:0,4:weapon:45:0,5:weapon:12:0,6:sensor:34:0,7:shield:26:0",
  'v4-large-mixed': "winner=B|reason=retreat|tick=1106|maxTicks=3600|A=1|B=6|destroyed=7:3|disabled=1:2|escaped=2:0|remainingFleetValue=375:1935|totalDamage=529:3118|shipHash=3e0125e0|compHash=87fa4f08|ships=0:A:standard:1:disabled:1216:-1:-96.26,-44.99|1:A:standard:0:destroyed:865:-1:-83.76,-32.48|2:A:support:0:escaped:471:107:-47.18,-17.05|3:A:support:0:escaped:405:290:-47.96,-24.04|4:A:support:0:destroyed:169:-1:-54.59,-15.32|5:A:scout:0:destroyed:79:-1:-23.41,-5.80|6:A:scout:0:destroyed:77:-1:-25.03,-1.92|7:A:scout:0:destroyed:85:-1:-28.21,3.75|8:A:scout:0:destroyed:85:-1:-28.90,15.88|9:A:scout:0:destroyed:65:-1:-30.46,15.16|10:B:fortress:1:normal:1845:-1:-19.38,-60.13|11:B:fortress:1:normal:1845:-1:-21.33,-18.49|12:B:carrier:1:normal:1600:-1:-17.83,-43.97|13:B:carrier:1:normal:1600:-1:-29.57,-3.80|14:B:interceptor:1:disabled:113:-1:32.00,-1.29|15:B:interceptor:1:disabled:82:-1:25.11,1.67|16:B:interceptor:0:destroyed:28:-1:11.15,2.08|17:B:interceptor:0:destroyed:28:-1:3.19,4.83|18:B:interceptor:0:destroyed:28:-1:-2.53,8.47|comps=0:core:351:0,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:119:0,1:engine:55:0,2:engine:55:0,3:weapon:68:0,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:72:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:54:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:19:0|0:core:0:1,1:engine:12:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:44:0,1:engine:28:0,2:weapon:10:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1",
  'v4-kite-vs-screen': "winner=B|reason=retreat|tick=1644|maxTicks=3600|A=0|B=4|destroyed=4:3|disabled=0:0|escaped=6:3|remainingFleetValue=530:2045|totalDamage=657:2434|shipHash=b4a6f68a|compHash=d709351a|ships=0:A:support:0:destroyed:279:-1:-62.43,-50.21|1:A:support:0:escaped:464:1644:-60.12,-44.25|2:A:support:0:destroyed:204:-1:-69.93,-3.97|3:A:support:0:escaped:345:107:-47.18,-16.46|4:A:scout:0:escaped:94:244:-47.10,-0.97|5:A:scout:0:escaped:109:124:-47.09,3.29|6:A:scout:0:destroyed:53:-1:-41.91,23.14|7:A:scout:0:destroyed:65:-1:-36.32,13.91|8:A:scout:0:escaped:118:283:-47.31,40.99|9:A:scout:0:escaped:87:510:-47.14,25.17|10:B:fortress:1:normal:1845:-1:9.19,-3.54|11:B:fortress:1:normal:1845:-1:-3.65,7.34|12:B:carrier:1:normal:1600:-1:-11.30,22.20|13:B:carrier:1:normal:1600:-1:-27.01,26.25|14:B:interceptor:0:destroyed:16:-1:-4.24,5.11|15:B:interceptor:0:escaped:57:1479:47.06,-4.84|16:B:interceptor:0:escaped:72:895:47.19,2.97|17:B:interceptor:0:destroyed:39:-1:-39.80,10.66|18:B:interceptor:0:escaped:108:984:47.03,1.87|19:B:interceptor:0:destroyed:7:-1:-47.71,-9.03|comps=0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:65:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:10:0,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:25:0,7:shield:65:0|0:core:58:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:3:0,7:shield:84:0|0:core:17:0,1:engine:12:0,2:weapon:32:0,3:sensor:33:0|0:core:31:0,1:engine:28:0,2:weapon:32:0,3:sensor:18:0|0:core:0:1,1:engine:0:1,2:weapon:26:0,3:sensor:27:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:25:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:8:0,1:engine:14:0,2:weapon:32:0,3:sensor:33:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:0:1,2:weapon:13:0,3:sensor:3:0|0:core:37:0,1:engine:21:0,2:weapon:0:1,3:sensor:0:1|0:core:44:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:17:0,3:sensor:22:0|0:core:57:0,1:engine:28:0,2:weapon:23:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:7:0",
  'v4-25v25': "winner=B|reason=retreat|tick=1548|maxTicks=3600|A=0|B=17|destroyed=22:8|disabled=0:8|escaped=3:0|remainingFleetValue=525:3248|totalDamage=2561:10448|shipHash=84638916|compHash=8b38c673|ships=0:A:standard:0:destroyed:54:-1:-41.42,-61.92|1:A:standard:0:destroyed:54:-1:-34.36,-57.76|2:A:standard:0:destroyed:54:-1:-40.27,-44.54|3:A:standard:0:destroyed:44:-1:-25.80,-53.55|4:A:standard:0:destroyed:35:-1:-26.29,-40.63|5:A:standard:0:destroyed:54:-1:-31.92,-35.51|6:A:standard:0:destroyed:54:-1:-40.07,-25.36|7:A:standard:0:destroyed:66:-1:-28.85,-22.91|8:A:standard:0:destroyed:54:-1:-47.32,-2.56|9:A:standard:0:destroyed:34:-1:-30.71,-14.71|10:A:standard:0:destroyed:27:-1:-33.96,-5.70|11:A:standard:0:destroyed:54:-1:-36.00,2.16|12:A:standard:0:destroyed:28:-1:-30.58,1.07|13:A:standard:0:destroyed:68:-1:-31.26,5.86|14:A:standard:0:destroyed:14:-1:-29.88,13.80|15:A:support:0:destroyed:169:-1:-100.67,66.11|16:A:support:0:escaped:281:1263:-93.91,74.22|17:A:support:0:escaped:362:1088:-87.91,72.32|18:A:support:0:destroyed:284:-1:-33.61,40.28|19:A:support:0:escaped:262:1548:-106.17,71.07|20:A:support:0:destroyed:231:-1:-61.51,70.19|21:A:fortress:0:destroyed:977:-1:-46.49,46.11|22:A:fortress:0:destroyed:375:-1:-38.17,64.74|23:A:fortress:0:destroyed:1015:-1:-100.51,81.62|24:A:fortress:0:destroyed:482:-1:-77.51,106.35|25:B:interceptor:0:destroyed:29:-1:-43.75,60.73|26:B:interceptor:0:destroyed:19:-1:-64.47,35.63|27:B:interceptor:0:destroyed:30:-1:-44.65,53.22|28:B:interceptor:0:destroyed:28:-1:-61.14,22.74|29:B:interceptor:0:destroyed:28:-1:-46.55,46.05|30:B:interceptor:0:destroyed:0:-1:-42.57,44.94|31:B:interceptor:1:disabled:91:-1:-43.02,21.58|32:B:interceptor:0:destroyed:28:-1:-42.41,31.91|33:B:interceptor:1:disabled:54:-1:-22.29,30.45|34:B:interceptor:1:disabled:64:-1:-41.65,5.63|35:B:interceptor:1:disabled:75:-1:-27.18,12.24|36:B:interceptor:0:destroyed:28:-1:-26.38,7.50|37:B:interceptor:1:disabled:29:-1:-18.66,0.83|38:B:interceptor:1:disabled:36:-1:4.14,5.80|39:B:interceptor:1:disabled:91:-1:9.58,15.20|40:B:carrier:1:normal:1600:-1:-32.43,44.47|41:B:carrier:1:normal:1600:-1:-28.31,61.41|42:B:carrier:1:normal:1600:-1:-45.67,36.76|43:B:carrier:1:normal:1600:-1:-25.74,77.71|44:B:carrier:1:normal:1600:-1:-43.49,55.67|45:B:carrier:1:normal:1600:-1:-32.31,109.58|46:B:standard:1:disabled:1128:-1:-1.45,62.36|47:B:standard:1:normal:1600:-1:-40.06,124.47|48:B:standard:1:normal:1521:-1:-30.92,92.63|49:B:standard:1:normal:1600:-1:-69.38,136.72|comps=0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:16:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:13:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:20:0,2:weapon:0:1,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:5:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:14:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:14:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:54:0,7:shield:0:1|0:core:82:0,1:engine:55:0,2:engine:55:0,3:weapon:32:0,4:weapon:0:1,5:weapon:45:0,6:sensor:12:0,7:shield:0:1|0:core:159:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:23:0,6:sensor:0:1,7:shield:25:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:65:0,1:engine:0:1,2:engine:27:0,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:54:0,7:shield:62:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:137:0,11:shield:154:0,12:armor:163:0,13:armor:157:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:50:0,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:12:0,9:sensor:58:0,10:shield:23:0,11:shield:0:1,12:armor:163:0,13:armor:8:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:14:0,11:shield:0:1,12:armor:163:0,13:armor:0:1|0:core:0:1,1:engine:28:0,2:weapon:1:0,3:sensor:0:1|0:core:0:1,1:engine:19:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:2:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:17:0,1:engine:28:0,2:weapon:0:1,3:sensor:9:0|0:core:36:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:34:0,1:engine:28:0,2:weapon:0:1,3:sensor:13:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:1:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:8:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:223:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:47:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:60:0,9:sensor:60:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0",
  'v4-50v50': "winner=B|reason=retreat|tick=1165|maxTicks=6000|A=1|B=45|destroyed=41:5|disabled=1:14|escaped=8:0|remainingFleetValue=1005:7158|totalDamage=4260:18043|shipHash=ab385175|compHash=f75447e3|ships=0:A:standard:0:destroyed:54:-1:-35.68,-148.97|1:A:standard:0:destroyed:38:-1:-44.80,-148.02|2:A:standard:0:destroyed:54:-1:-57.74,-120.83|3:A:standard:0:destroyed:0:-1:-40.16,-142.03|4:A:standard:0:destroyed:67:-1:-35.74,-123.58|5:A:standard:0:destroyed:54:-1:-30.04,-118.83|6:A:standard:0:destroyed:67:-1:-61.30,-93.54|7:A:standard:0:escaped:51:329:-55.31,-90.12|8:A:standard:0:escaped:71:315:-48.86,-75.90|9:A:standard:0:destroyed:8:-1:-33.79,-100.57|10:A:standard:0:destroyed:35:-1:-37.55,-76.11|11:A:standard:0:destroyed:38:-1:-31.12,-73.19|12:A:standard:0:destroyed:58:-1:-31.89,-69.58|13:A:standard:0:destroyed:50:-1:-30.64,-65.38|14:A:standard:0:destroyed:54:-1:-54.18,-47.94|15:A:standard:0:escaped:106:112:-47.29,-59.90|16:A:standard:0:destroyed:54:-1:-34.36,-45.56|17:A:standard:0:destroyed:54:-1:-51.01,-41.63|18:A:standard:0:escaped:83:269:-53.42,-22.04|19:A:standard:0:escaped:65:239:-51.20,-17.67|20:A:standard:0:destroyed:74:-1:-29.97,-22.01|21:A:standard:0:destroyed:74:-1:-31.69,-18.52|22:A:standard:0:destroyed:54:-1:-36.26,-9.16|23:A:standard:0:destroyed:54:-1:-43.62,-2.48|24:A:standard:0:destroyed:29:-1:-31.20,-1.20|25:A:standard:0:destroyed:54:-1:-41.62,3.86|26:A:standard:0:destroyed:28:-1:-29.84,10.12|27:A:standard:0:destroyed:54:-1:-33.99,9.61|28:A:standard:0:destroyed:54:-1:-33.22,16.82|29:A:standard:0:destroyed:28:-1:-30.34,27.35|30:A:support:0:destroyed:131:-1:-70.68,75.11|31:A:support:0:escaped:275:387:-56.51,52.79|32:A:support:0:destroyed:187:-1:-32.81,47.82|33:A:support:0:destroyed:298:-1:-46.15,53.90|34:A:support:0:destroyed:129:-1:-37.07,62.40|35:A:support:0:destroyed:291:-1:-54.11,59.90|36:A:support:0:destroyed:284:-1:-42.69,75.20|37:A:support:0:escaped:305:470:-55.56,80.49|38:A:support:0:destroyed:105:-1:-36.07,93.21|39:A:support:0:escaped:246:434:-53.07,89.35|40:A:support:0:destroyed:263:-1:-34.44,109.33|41:A:support:0:destroyed:298:-1:-64.02,106.93|42:A:fortress:0:destroyed:488:-1:-54.77,118.72|43:A:fortress:0:destroyed:566:-1:-91.43,125.39|44:A:fortress:0:destroyed:857:-1:-34.80,134.83|45:A:fortress:0:destroyed:1015:-1:-78.02,131.13|46:A:fortress:0:destroyed:1055:-1:-29.88,151.56|47:A:fortress:1:disabled:1399:-1:-106.67,157.20|48:A:fortress:0:destroyed:984:-1:-42.20,163.27|49:A:fortress:0:destroyed:488:-1:-93.20,165.21|50:B:interceptor:1:normal:145:-1:-101.20,98.56|51:B:interceptor:1:normal:145:-1:-59.82,119.51|52:B:interceptor:1:normal:145:-1:-102.71,119.49|53:B:interceptor:1:normal:145:-1:-63.76,128.06|54:B:interceptor:1:normal:136:-1:-109.32,118.76|55:B:interceptor:1:normal:127:-1:-65.08,133.07|56:B:interceptor:1:disabled:113:-1:7.11,-122.36|57:B:interceptor:1:normal:136:-1:-70.49,129.07|58:B:interceptor:1:normal:119:-1:-106.55,128.27|59:B:interceptor:1:normal:136:-1:-75.33,143.09|60:B:interceptor:1:normal:136:-1:-94.82,129.58|61:B:interceptor:1:normal:92:-1:-79.47,147.75|62:B:interceptor:1:disabled:76:-1:-98.57,123.75|63:B:interceptor:1:normal:145:-1:-77.96,154.28|64:B:interceptor:0:destroyed:13:-1:-98.65,116.71|65:B:interceptor:1:disabled:89:-1:-62.49,110.52|66:B:interceptor:1:disabled:60:-1:-91.12,106.98|67:B:interceptor:1:disabled:114:-1:-31.94,-58.52|68:B:interceptor:0:destroyed:8:-1:-90.38,83.00|69:B:interceptor:1:disabled:76:-1:-64.28,68.57|70:B:interceptor:1:disabled:95:-1:-89.12,91.04|71:B:interceptor:1:disabled:92:-1:-46.80,78.18|72:B:interceptor:1:disabled:53:-1:-78.63,76.49|73:B:interceptor:1:disabled:91:-1:-50.43,62.87|74:B:interceptor:0:destroyed:28:-1:-84.51,98.17|75:B:interceptor:1:disabled:89:-1:-44.87,40.77|76:B:interceptor:1:disabled:67:-1:-75.13,92.35|77:B:interceptor:1:disabled:95:-1:-38.23,13.02|78:B:interceptor:1:normal:99:-1:-72.09,67.94|79:B:interceptor:0:destroyed:28:-1:7.04,30.97|80:B:carrier:1:normal:1600:-1:-36.40,58.16|81:B:carrier:1:normal:1600:-1:-28.15,92.29|82:B:carrier:1:normal:1600:-1:-38.05,74.62|83:B:carrier:1:normal:1600:-1:-21.77,105.74|84:B:carrier:1:normal:1600:-1:-44.90,88.97|85:B:carrier:1:normal:1600:-1:-23.28,118.73|86:B:carrier:1:normal:1600:-1:-40.72,98.25|87:B:carrier:1:normal:1600:-1:-18.07,131.70|88:B:carrier:1:normal:1600:-1:-38.22,106.61|89:B:carrier:1:normal:1600:-1:-18.89,145.71|90:B:carrier:1:normal:1329:-1:-37.96,117.09|91:B:carrier:1:normal:1600:-1:-22.15,158.43|92:B:standard:0:destroyed:905:-1:-1.74,119.74|93:B:standard:1:normal:1600:-1:-19.76,174.44|94:B:standard:1:disabled:1043:-1:-3.57,122.69|95:B:standard:1:normal:1600:-1:-28.97,165.55|96:B:standard:1:normal:1600:-1:-32.04,130.90|97:B:standard:1:normal:1600:-1:-28.57,184.52|98:B:standard:1:normal:1142:-1:-29.23,145.67|99:B:standard:1:normal:1600:-1:-38.08,194.56|comps=0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:24:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:13:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:13:0,2:weapon:32:0,3:sensor:22:0|0:core:8:0,1:engine:5:0,2:weapon:16:0,3:sensor:22:0|0:core:5:0,1:engine:12:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:8:0,3:sensor:0:1|0:core:0:1,1:engine:5:0,2:weapon:16:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:24:0,3:sensor:14:0|0:core:0:1,1:engine:4:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:12:0,2:weapon:32:0,3:sensor:6:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:46:0,1:engine:28:0,2:weapon:32:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:13:0,1:engine:23:0,2:weapon:32:0,3:sensor:15:0|0:core:23:0,1:engine:20:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:20:0,2:weapon:9:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:32:0,4:weapon:0:1,5:weapon:45:0,6:sensor:54:0,7:shield:0:1|0:core:72:0,1:engine:55:0,2:engine:55:0,3:weapon:12:0,4:weapon:0:1,5:weapon:45:0,6:sensor:35:0,7:shield:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:18:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:23:0,2:engine:0:1,3:weapon:22:0,4:weapon:45:0,5:weapon:0:1,6:sensor:40:0,7:shield:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:38:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:31:0,6:sensor:54:0,7:shield:84:0|0:core:71:0,1:engine:53:0,2:engine:55:0,3:weapon:46:0,4:weapon:0:1,5:weapon:45:0,6:sensor:35:0,7:shield:0:1|0:core:0:1,1:engine:21:0,2:engine:39:0,3:weapon:0:1,4:weapon:45:0,5:weapon:0:1,6:sensor:0:1,7:shield:0:1|0:core:79:0,1:engine:15:0,2:engine:0:1,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:37:0,7:shield:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:63:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:0:1,11:shield:20:0,12:armor:0:1,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:60:0,11:shield:38:0,12:armor:0:1,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:37:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:134:0,11:shield:101:0,12:armor:163:0,13:armor:117:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:389:0,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:54:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:145:0,12:armor:149:0,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:20:0,11:shield:0:1,12:armor:0:1,13:armor:163:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:54:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:54:0,1:engine:28:0,2:weapon:23:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:13:0|0:core:37:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:23:0,3:sensor:22:0|0:core:54:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:32:0,1:engine:28:0,2:weapon:32:0,3:sensor:0:1|0:core:48:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:13:0,2:weapon:0:1,3:sensor:0:1|0:core:39:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:25:0,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:54:0,1:engine:28:0,2:weapon:32:0,3:sensor:0:1|0:core:0:1,1:engine:8:0,2:weapon:0:1,3:sensor:0:1|0:core:48:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:4:0|0:core:50:0,1:engine:28:0,2:weapon:14:0,3:sensor:0:1|0:core:8:0,1:engine:28:0,2:weapon:17:0,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:55:0,1:engine:28:0,2:weapon:0:1,3:sensor:6:0|0:core:39:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:44:0,1:engine:28:0,2:weapon:23:0,3:sensor:0:1|0:core:44:0,1:engine:10:0,2:weapon:23:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:359:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:21:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:40:0,9:sensor:4:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:260:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:29:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:100:0,11:shield:92:0,12:armor:87:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:307:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:80:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:8:0,10:shield:84:0,11:shield:60:0,12:armor:55:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0",
  'v4-defensive-retreat': "winner=A|reason=combatDisabled|tick=305|maxTicks=3600|A=5|B=11|destroyed=5:7|disabled=0:11|escaped=0:0|remainingFleetValue=1445:303|totalDamage=1655:497|shipHash=34f9c0b7|compHash=153b7ba1|ships=0:A:fortress:1:normal:1845:-1:-55.53,-39.12|1:A:fortress:1:normal:1845:-1:-45.71,-34.07|2:A:support:1:normal:578:-1:-68.08,-35.57|3:A:support:1:normal:578:-1:-59.98,-29.64|4:A:support:1:normal:578:-1:-70.68,-24.92|5:A:scout:0:destroyed:65:-1:-32.88,-8.33|6:A:scout:0:destroyed:65:-1:-33.34,1.75|7:A:scout:0:destroyed:65:-1:-32.30,9.15|8:A:scout:0:destroyed:65:-1:-34.77,21.52|9:A:scout:0:destroyed:85:-1:-34.66,27.62|10:B:interceptor:0:destroyed:28:-1:-7.00,-39.55|11:B:interceptor:1:disabled:98:-1:-6.09,-14.06|12:B:interceptor:0:destroyed:28:-1:0.62,-24.06|13:B:interceptor:0:destroyed:35:-1:-16.54,-11.00|14:B:interceptor:0:destroyed:67:-1:7.86,-13.87|15:B:interceptor:0:destroyed:67:-1:14.00,-12.43|16:B:interceptor:1:disabled:123:-1:24.63,-17.71|17:B:interceptor:1:disabled:93:-1:24.42,-10.37|18:B:interceptor:1:disabled:43:-1:22.93,-3.54|19:B:interceptor:1:disabled:53:-1:12.22,4.01|20:B:interceptor:1:disabled:113:-1:8.43,10.06|21:B:interceptor:1:disabled:62:-1:-0.93,12.47|22:B:interceptor:0:destroyed:36:-1:-21.05,-18.66|23:B:interceptor:1:disabled:78:-1:-27.37,-7.00|24:B:interceptor:1:disabled:95:-1:-22.57,4.64|25:B:interceptor:1:disabled:60:-1:-42.28,-3.31|26:B:interceptor:1:disabled:56:-1:-33.63,-2.10|27:B:interceptor:0:destroyed:19:-1:-42.06,2.36|comps=0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:7:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:7:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:0:1|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:13:0,1:engine:28:0,2:weapon:0:1,3:sensor:3:0|0:core:24:0,1:engine:28:0,2:weapon:1:0,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:34:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:8:0,3:sensor:0:1|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:4:0|0:core:32:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:28:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:19:0,2:weapon:0:1,3:sensor:0:1",
  'v4-focusFire-vs-screen': "winner=A|reason=retreat|tick=1253|maxTicks=3600|A=2|B=1|destroyed=3:11|disabled=0:1|escaped=5:2|remainingFleetValue=350:130|totalDamage=3021:627|shipHash=234d86a9|compHash=60fb79d8|ships=0:A:standard:1:normal:1600:-1:-41.66,-33.92|1:A:standard:1:normal:1596:-1:-7.53,-58.14|2:A:standard:0:escaped:96:179:-47.32,-22.14|3:A:standard:0:destroyed:38:-1:-14.87,-21.41|4:A:standard:0:escaped:96:164:-47.25,-11.70|5:A:standard:0:escaped:96:137:-47.18,-5.49|6:A:standard:0:destroyed:82:-1:-26.12,0.77|7:A:standard:0:escaped:96:167:-47.04,-1.36|8:A:standard:0:escaped:120:87:-47.22,20.03|9:A:standard:0:destroyed:58:-1:-22.22,4.53|10:B:interceptor:0:escaped:69:30:47.17,-45.50|11:B:interceptor:0:destroyed:22:-1:40.17,-30.27|12:B:interceptor:0:destroyed:60:-1:16.24,-20.29|13:B:interceptor:0:destroyed:82:-1:15.82,-14.14|14:B:interceptor:0:destroyed:37:-1:15.43,-7.56|15:B:interceptor:0:destroyed:38:-1:14.83,-1.37|16:B:interceptor:0:destroyed:0:-1:22.07,-10.39|17:B:interceptor:0:destroyed:32:-1:0.82,-3.91|18:B:interceptor:0:destroyed:54:-1:-8.03,-15.77|19:B:interceptor:0:destroyed:54:-1:-17.52,-5.01|20:B:standard:0:destroyed:111:-1:33.89,-8.26|21:B:standard:0:destroyed:133:-1:16.78,-1.52|22:B:standard:0:escaped:233:1216:47.03,-0.00|23:B:standard:1:disabled:404:-1:5.28,-1.17|comps=0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:116:0,12:armor:130:0,13:armor:130:0|0:core:62:0,1:engine:28:0,2:weapon:0:1,3:sensor:6:0|0:core:0:1,1:engine:0:1,2:weapon:16:0,3:sensor:22:0|0:core:62:0,1:engine:28:0,2:weapon:0:1,3:sensor:6:0|0:core:14:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:14:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:70:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:24:0,3:sensor:6:0|0:core:41:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:6:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:15:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:10:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:0:1,4:weapon:12:0,5:weapon:45:0,6:sensor:0:1,7:shield:55:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:25:0,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:18:0|0:core:121:0,1:engine:31:0,2:engine:31:0,3:weapon:0:1,4:weapon:0:1,5:weapon:45:0,6:sensor:0:1,7:shield:5:0|0:core:129:0,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:45:0,7:shield:70:0",
  'v4-antiCapital-vs-swarm': "winner=B|reason=timeout|tick=3600|maxTicks=3600|A=1|B=15|destroyed=3:0|disabled=0:0|escaped=5:0|remainingFleetValue=1120:1980|totalDamage=0:5442|shipHash=8f42e6ef|compHash=88ba40e7|ships=0:A:fortress:1:normal:1208:-1:-2.26,41.90|1:A:fortress:0:escaped:639:2969:-69.30,4.05|2:A:fortress:0:destroyed:461:-1:38.21,65.81|3:A:standard:0:escaped:88:38:-47.28,-28.13|4:A:standard:0:escaped:101:47:-47.16,-21.00|5:A:standard:0:escaped:61:119:-47.06,-20.99|6:A:standard:0:destroyed:32:-1:-31.00,-17.80|7:A:standard:0:escaped:69:199:-47.08,-15.01|8:A:standard:0:destroyed:7:-1:-8.91,-6.33|9:B:carrier:1:normal:1600:-1:78.40,11.58|10:B:carrier:1:normal:1600:-1:-57.86,-51.88|11:B:carrier:1:normal:1600:-1:92.11,20.34|12:B:scout:1:normal:163:-1:-23.14,23.24|13:B:scout:1:normal:163:-1:14.91,63.97|14:B:scout:1:normal:163:-1:-29.85,37.76|15:B:scout:1:normal:163:-1:14.55,19.67|16:B:scout:1:normal:163:-1:-29.51,47.79|17:B:scout:1:normal:163:-1:7.02,15.77|18:B:scout:1:normal:163:-1:-21.18,62.30|19:B:scout:1:normal:163:-1:-29.22,10.82|20:B:scout:1:normal:163:-1:-22.36,15.28|21:B:scout:1:normal:163:-1:-26.88,16.98|22:B:scout:1:normal:163:-1:-27.92,54.67|23:B:scout:1:normal:163:-1:-28.13,21.76|comps=0:core:357:0,1:engine:28:0,2:engine:38:0,3:engine:50:0,4:weapon:95:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:70:0,9:sensor:75:0,10:shield:107:0,11:shield:82:0,12:armor:83:0,13:armor:163:0|0:core:77:0,1:engine:60:0,2:engine:71:0,3:engine:72:0,4:weapon:95:0,5:weapon:10:0,6:weapon:0:1,7:weapon:0:1,8:sensor:66:0,9:sensor:69:0,10:shield:0:1,11:shield:0:1,12:armor:120:0,13:armor:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:0:1,6:weapon:53:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:0:1,11:shield:0:1,12:armor:0:1,13:armor:163:0|0:core:38:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:70:0,1:engine:28:0,2:weapon:0:1,3:sensor:3:0|0:core:33:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:0:1|0:core:51:0,1:engine:17:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:7:0,3:sensor:0:1|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0",
};

export function runGoldenReplayTests(): string {
  let ok = 0;
  let fail = 0;
  let missing = 0;
  const lines: string[] = [];
  for (const c of GOLDEN_CASES) {
    const got = fingerprintOf(c.cfg, c.maxTicks);
    const exp = GOLDEN_EXPECTED[c.name];
    if (exp === undefined || exp === '') {
      missing++;
      lines.push(`[UNFROZEN] ${c.name}（缺少黄金基线，禁止自动写入；请用 generateGoldenReplayValues() 生成并人工核对）`);
    } else if (got === exp) {
      ok++;
    } else {
      fail++;
      lines.push(`FAIL ${c.name}\n  expect: ${exp.slice(0, 300)}\n  got:    ${got.slice(0, 300)}`);
    }
  }
  if (fail === 0 && missing === 0) {
    return `Golden replay tests passed (${ok}/${GOLDEN_CASES.length})${lines.length ? '\n' + lines.join('\n') : ''}`;
  }
  const parts: string[] = [];
  if (fail) parts.push(`${fail} 例不一致`);
  if (missing) parts.push(`${missing} 例未冻结`);
  return `Golden replay tests FAILED (${parts.join('，')}; passed=${ok}/${GOLDEN_CASES.length}):\n` + lines.join('\n');
}

/** 仅输出候选黄金值，绝不修改源码。开发者需人工核对规则后再将输出粘贴进 GOLDEN_EXPECTED。 */
export function generateGoldenReplayValues(): string {
  const lines: string[] = [
    '===== 候选黄金值（仅供人工核对，不会写入源码） =====',
    '请确认以下结果符合预期规则后，将其粘贴进 GOLDEN_EXPECTED（键名 = 用例名）。',
    `生成时间基准：TICKS_PER_SECOND=${30}，MAX_TICKS 默认=${MAX_TICKS}。`,
    ''
  ];
  for (const c of GOLDEN_CASES) {
    lines.push(`  '${c.name}': '${fingerprintOf(c.cfg, c.maxTicks)}',`);
  }
  lines.push('');
  lines.push('===== 结束（请人工核对后再更新 GOLDEN_EXPECTED） =====');
  return lines.join('\n');
}

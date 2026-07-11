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
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Frigate', variant: 'carrier', count: 2 }, { shipClass: 'Fighter', variant: 'interceptor', count: 5 }]),
      'wall', 'defensive', 'line', 'aggressive')
  },
  {
    name: 'v4-kite-vs-screen',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 3003,
      fleet([{ shipClass: 'Frigate', variant: 'support', count: 4 }, { shipClass: 'Fighter', variant: 'scout', count: 6 }]),
      fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Frigate', variant: 'carrier', count: 2 }, { shipClass: 'Fighter', variant: 'interceptor', count: 6 }]),
      'swarm', 'kite', 'wedge', 'screen')
  },
  {
    name: 'v4-25v25',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 4004,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 15 }, { shipClass: 'Frigate', variant: 'support', count: 6 }, { shipClass: 'Cruiser', variant: 'fortress', count: 4 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 15 }, { shipClass: 'Frigate', variant: 'carrier', count: 6 }, { shipClass: 'Cruiser', variant: 'standard', count: 4 }]),
      'wall', 'defensive', 'wedge', 'aggressive')
  },
  {
    name: 'v4-50v50',
    cfg: makeReplay(SIM_VERSION_V5, RULESET_V4, 5005,
      fleet([{ shipClass: 'Fighter', variant: 'standard', count: 30 }, { shipClass: 'Frigate', variant: 'support', count: 12 }, { shipClass: 'Cruiser', variant: 'fortress', count: 8 }]),
      fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 30 }, { shipClass: 'Frigate', variant: 'carrier', count: 12 }, { shipClass: 'Cruiser', variant: 'standard', count: 8 }]),
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
      fleet([{ shipClass: 'Frigate', variant: 'carrier', count: 3 }, { shipClass: 'Fighter', variant: 'scout', count: 12 }]),
      'wedge', 'antiCapital', 'swarm', 'kite')
  }
];

// 黄金基线指纹（由 generateGoldenReplayValues() 生成后人工核对再内嵌；任何模拟层变更
// 都必须保持这些指纹稳定）。缺失的键会导致 runGoldenReplayTests() 直接判失败。
export const GOLDEN_EXPECTED: Record<string, string> = {
  // v4-small-balanced
  'v4-small-balanced': "winner=B|reason=timeout|tick=3600|maxTicks=3600|A=1|B=1|destroyed=2:2|disabled=0:0|escaped=2:2|remainingFleetValue=150:155|totalDamage=1028:827|shipHash=98b22a08|compHash=99eb74f7|ships=0:A:standard:0:escaped:92:956:-47.09,54.38|1:A:standard:0:destroyed:54:-1:-21.01,-33.46|2:A:standard:0:destroyed:82:-1:-39.92,56.90|3:A:standard:1:normal:467:-1:-29.27,-53.90|4:A:standard:0:escaped:245:703:-47.07,98.93|5:B:interceptor:0:destroyed:32:-1:-38.26,-93.94|6:B:interceptor:0:escaped:90:589:47.40,-42.74|7:B:interceptor:0:destroyed:0:-1:-17.61,-111.88|8:B:standard:0:escaped:182:2024:47.01,-114.12|9:B:standard:1:normal:438:-1:-68.49,-105.21|comps=0:core:10:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:155:0,1:engine:55:0,2:engine:55:0,3:weapon:60:0,4:weapon:45:0,5:weapon:12:0,6:sensor:30:0,7:shield:55:0|0:core:23:0,1:engine:37:0,2:engine:46:0,3:weapon:49:0,4:weapon:0:1,5:weapon:45:0,6:sensor:45:0,7:shield:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:4:0|0:core:8:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:28:0,1:engine:27:0,2:engine:4:0,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:7:0,7:shield:0:1|0:core:153:0,1:engine:55:0,2:engine:55:0,3:weapon:59:0,4:weapon:45:0,5:weapon:12:0,6:sensor:34:0,7:shield:26:0",
  // v4-large-mixed
  'v4-large-mixed': "winner=B|reason=timeout|tick=3600|maxTicks=3600|A=5|B=5|destroyed=5:4|disabled=0:3|escaped=0:0|remainingFleetValue=625:1003|totalDamage=1364:508|shipHash=86c913ba|compHash=da53bd52|ships=0:A:standard:1:normal:1600:-1:-101.47,-52.93|1:A:standard:1:normal:1600:-1:-94.79,-37.54|2:A:support:1:normal:569:-1:-85.31,-51.48|3:A:support:1:normal:578:-1:-79.24,-43.79|4:A:support:1:normal:578:-1:-75.72,-30.06|5:A:scout:0:destroyed:40:-1:-39.91,-2.08|6:A:scout:0:destroyed:85:-1:-29.23,0.04|7:A:scout:0:destroyed:85:-1:-30.42,3.68|8:A:scout:0:destroyed:87:-1:-25.01,12.87|9:A:scout:0:destroyed:93:-1:-29.49,14.21|10:B:fortress:1:normal:1845:-1:-21.59,-96.36|11:B:fortress:1:normal:1845:-1:-0.09,-11.43|12:B:carrier:0:destroyed:270:-1:-5.41,-23.12|13:B:carrier:0:destroyed:270:-1:-27.48,-8.37|14:B:interceptor:1:disabled:33:-1:24.26,-2.13|15:B:interceptor:0:destroyed:29:-1:-3.65,-0.67|16:B:interceptor:0:destroyed:28:-1:10.96,3.53|17:B:interceptor:1:disabled:57:-1:-5.38,4.71|18:B:interceptor:1:disabled:52:-1:0.58,12.73|comps=0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:162:0,1:engine:53:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:28:0,2:weapon:12:0,3:sensor:0:1|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:26:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:5:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:1:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:29:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:19:0,1:engine:28:0,2:weapon:0:1,3:sensor:5:0",
  // v4-kite-vs-screen
  'v4-kite-vs-screen': "winner=B|reason=timeout|tick=3600|maxTicks=3600|A=3|B=3|destroyed=3:3|disabled=0:1|escaped=4:4|remainingFleetValue=835:1380|totalDamage=1327:1005|shipHash=b91be313|compHash=d5c40f6d|ships=0:A:support:1:normal:578:-1:-9.00,102.49|1:A:support:1:normal:578:-1:76.67,19.32|2:A:support:0:escaped:433:3089:-47.19,92.64|3:A:support:1:normal:533:-1:69.47,27.26|4:A:scout:0:destroyed:57:-1:-32.37,0.15|5:A:scout:0:escaped:72:94:-47.04,3.94|6:A:scout:0:destroyed:49:-1:-40.52,20.59|7:A:scout:0:escaped:94:399:-47.09,25.20|8:A:scout:0:destroyed:78:-1:-28.61,35.12|9:A:scout:0:escaped:87:359:-47.10,31.64|10:B:fortress:1:normal:1845:-1:54.37,85.69|11:B:fortress:1:normal:1845:-1:51.84,104.03|12:B:carrier:0:destroyed:250:-1:6.46,17.55|13:B:carrier:1:disabled:377:-1:42.45,90.11|14:B:interceptor:0:escaped:95:244:47.11,-12.24|15:B:interceptor:0:escaped:87:536:47.14,30.03|16:B:interceptor:0:escaped:95:191:47.33,-5.81|17:B:interceptor:0:destroyed:82:-1:7.74,10.32|18:B:interceptor:0:escaped:104:172:47.19,5.45|19:B:interceptor:0:destroyed:31:-1:1.89,19.43|comps=0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:145:0,1:engine:55:0,2:engine:55:0,3:weapon:5:0,4:weapon:43:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:165:0,1:engine:55:0,2:engine:55:0,3:weapon:58:0,4:weapon:45:0,5:weapon:45:0,6:sensor:26:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:weapon:24:0,3:sensor:33:0|0:core:40:0,1:engine:28:0,2:weapon:4:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:26:0,3:sensor:24:0|0:core:16:0,1:engine:13:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:17:0,3:sensor:33:0|0:core:2:0,1:engine:20:0,2:weapon:32:0,3:sensor:33:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:38:0,6:sensor:45:0,7:shield:52:0|0:core:122:0,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:38:0,6:sensor:37:0,7:shield:65:0|0:core:54:0,1:engine:28:0,2:weapon:0:1,3:sensor:13:0|0:core:5:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:4:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:13:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:15:0,3:sensor:16:0",
  // v4-25v25
  'v4-25v25': "winner=A|reason=timeout|tick=3600|maxTicks=3600|A=10|B=7|destroyed=15:18|disabled=0:4|escaped=0:0|remainingFleetValue=2890:260|totalDamage=5194:1960|shipHash=de4b431a|compHash=2f374f66|ships=0:A:standard:0:destroyed:54:-1:-43.47,-60.59|1:A:standard:0:destroyed:54:-1:-30.29,-60.94|2:A:standard:0:destroyed:58:-1:-43.44,-43.56|3:A:standard:0:destroyed:24:-1:-31.81,-54.47|4:A:standard:0:destroyed:54:-1:-30.72,-38.66|5:A:standard:0:destroyed:46:-1:-37.36,-34.91|6:A:standard:0:destroyed:54:-1:-45.97,-21.79|7:A:standard:0:destroyed:54:-1:-59.23,-11.70|8:A:standard:0:destroyed:60:-1:-49.58,5.58|9:A:standard:0:destroyed:28:-1:-28.50,-13.76|10:A:standard:0:destroyed:54:-1:-33.19,-5.43|11:A:standard:0:destroyed:54:-1:-36.09,0.70|12:A:standard:0:destroyed:60:-1:-29.58,3.49|13:A:standard:0:destroyed:54:-1:-39.76,8.53|14:A:standard:0:destroyed:28:-1:-32.01,13.83|15:A:support:1:normal:578:-1:-106.22,68.08|16:A:support:1:normal:578:-1:-118.90,100.11|17:A:support:1:normal:578:-1:-112.19,60.30|18:A:support:1:normal:578:-1:-126.87,107.55|19:A:support:1:normal:578:-1:-109.80,93.80|20:A:support:1:normal:578:-1:-117.60,110.74|21:A:fortress:1:normal:1845:-1:-118.74,79.58|22:A:fortress:1:normal:1723:-1:-137.85,120.32|23:A:fortress:1:normal:1845:-1:-128.24,66.38|24:A:fortress:1:normal:1845:-1:-144.86,135.60|25:B:interceptor:0:destroyed:13:-1:-33.90,34.03|26:B:interceptor:0:destroyed:13:-1:-51.40,30.05|27:B:interceptor:0:destroyed:28:-1:-29.58,34.57|28:B:interceptor:0:destroyed:28:-1:-76.24,17.49|29:B:interceptor:0:destroyed:28:-1:-34.89,29.56|30:B:interceptor:0:destroyed:28:-1:-65.38,8.22|31:B:interceptor:0:destroyed:28:-1:-32.43,28.44|32:B:interceptor:0:destroyed:19:-1:-44.37,9.25|33:B:interceptor:0:destroyed:28:-1:-34.98,3.09|34:B:interceptor:1:disabled:82:-1:-46.48,-1.59|35:B:interceptor:1:disabled:51:-1:-20.37,-7.44|36:B:interceptor:1:disabled:114:-1:-26.46,-8.90|37:B:interceptor:0:destroyed:28:-1:-5.95,3.34|38:B:interceptor:0:destroyed:60:-1:1.91,6.34|39:B:interceptor:1:disabled:91:-1:9.59,15.40|40:B:carrier:0:destroyed:225:-1:-45.55,29.47|41:B:carrier:0:destroyed:270:-1:-43.37,42.36|42:B:carrier:0:destroyed:270:-1:-42.12,53.52|43:B:carrier:0:destroyed:266:-1:-10.38,41.02|44:B:carrier:0:destroyed:253:-1:-30.14,59.26|45:B:carrier:0:destroyed:175:-1:-11.22,75.76|46:B:standard:0:destroyed:905:-1:-5.10,60.35|47:B:standard:1:normal:1600:-1:-51.44,152.71|48:B:standard:1:normal:1502:-1:-47.86,16.37|49:B:standard:1:normal:1600:-1:-69.84,160.71|comps=0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:4:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:24:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:24:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:6:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:21:0,2:weapon:25:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:468:0,1:engine:95:0,2:engine:95:0,3:engine:85:0,4:weapon:95:0,5:weapon:49:0,6:weapon:60:0,7:weapon:52:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:143:0,12:armor:106:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:13:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:13:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:19:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:54:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:1:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:23:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:19:0,3:sensor:13:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:60:0,4:weapon:0:1,5:weapon:45:0,6:sensor:10:0,7:shield:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:66:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:28:0,6:sensor:0:1,7:shield:70:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:11:0,4:weapon:45:0,5:weapon:0:1,6:sensor:10:0,7:shield:0:1|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:80:0,5:weapon:60:0,6:weapon:60:0,7:weapon:44:0,8:sensor:53:0,9:sensor:40:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0",
  // v4-50v50
  'v4-50v50': "winner=B|reason=retreat|tick=4321|maxTicks=6000|A=0|B=27|destroyed=41:23|disabled=0:22|escaped=9:0|remainingFleetValue=2305:1918|totalDamage=10717:20640|shipHash=40a8df15|compHash=f9d7d5b5|ships=0:A:standard:0:destroyed:54:-1:-30.08,-151.00|1:A:standard:0:destroyed:54:-1:-27.49,-145.76|2:A:standard:0:destroyed:47:-1:-51.18,-121.24|3:A:standard:0:destroyed:32:-1:-31.71,-142.13|4:A:standard:0:destroyed:54:-1:-44.78,-112.87|5:A:standard:0:destroyed:54:-1:-38.12,-110.52|6:A:standard:0:destroyed:54:-1:-56.75,-97.08|7:A:standard:0:destroyed:67:-1:-33.99,-104.15|8:A:standard:0:destroyed:54:-1:-46.73,-81.62|9:A:standard:0:destroyed:12:-1:-28.42,-99.82|10:A:standard:0:destroyed:54:-1:-60.38,-70.59|11:A:standard:0:destroyed:42:-1:-35.03,-80.75|12:A:standard:0:destroyed:54:-1:-33.42,-70.07|13:A:standard:0:destroyed:46:-1:-28.01,-66.37|14:A:standard:0:destroyed:54:-1:-54.85,-40.23|15:A:standard:0:destroyed:34:-1:-24.91,-58.03|16:A:standard:0:destroyed:54:-1:-45.50,-30.88|17:A:standard:0:destroyed:82:-1:-28.92,-40.43|18:A:standard:0:destroyed:54:-1:-36.19,-30.03|19:A:standard:0:destroyed:54:-1:-32.98,-25.95|20:A:standard:0:destroyed:54:-1:-45.34,-16.35|21:A:standard:0:destroyed:54:-1:-52.02,-13.10|22:A:standard:0:destroyed:54:-1:-60.59,0.76|23:A:standard:0:destroyed:54:-1:-61.45,9.96|24:A:standard:0:destroyed:37:-1:-35.28,-2.30|25:A:standard:0:escaped:84:246:-54.59,9.30|26:A:standard:0:destroyed:47:-1:-33.35,7.28|27:A:standard:0:destroyed:54:-1:-42.77,13.41|28:A:standard:0:destroyed:54:-1:-39.75,18.47|29:A:standard:0:destroyed:22:-1:-42.19,27.19|30:A:support:0:destroyed:205:-1:-91.37,143.00|31:A:support:0:destroyed:182:-1:-163.33,147.74|32:A:support:0:destroyed:295:-1:-42.36,56.24|33:A:support:0:destroyed:213:-1:-55.98,60.89|34:A:support:0:escaped:298:786:-61.96,101.39|35:A:support:0:destroyed:240:-1:-150.02,149.87|36:A:support:0:escaped:263:886:-73.52,114.29|37:A:support:0:escaped:282:2109:-144.29,157.29|38:A:support:0:escaped:370:974:-72.71,141.60|39:A:support:0:destroyed:298:-1:-132.46,158.56|40:A:support:0:escaped:304:1218:-91.92,154.53|41:A:support:0:destroyed:298:-1:-120.28,162.07|42:A:fortress:0:destroyed:914:-1:-97.33,175.81|43:A:fortress:0:escaped:919:3026:-190.53,152.83|44:A:fortress:0:destroyed:633:-1:-37.99,129.27|45:A:fortress:0:escaped:907:2734:-175.98,153.54|46:A:fortress:0:destroyed:1015:-1:-59.33,151.55|47:A:fortress:0:destroyed:468:-1:-200.00,156.90|48:A:fortress:0:destroyed:400:-1:-35.77,169.09|49:A:fortress:0:escaped:922:4321:-200.00,139.70|50:B:interceptor:0:destroyed:13:-1:-115.66,85.22|51:B:interceptor:0:destroyed:28:-1:-65.10,107.42|52:B:interceptor:1:disabled:98:-1:-77.28,84.18|53:B:interceptor:1:disabled:73:-1:-58.12,106.82|54:B:interceptor:1:disabled:44:-1:-105.58,80.89|55:B:interceptor:0:destroyed:28:-1:-62.21,120.40|56:B:interceptor:0:destroyed:28:-1:-97.70,80.88|57:B:interceptor:0:destroyed:28:-1:-58.77,99.67|58:B:interceptor:0:destroyed:28:-1:-75.45,86.33|59:B:interceptor:0:destroyed:13:-1:-52.71,117.68|60:B:interceptor:1:disabled:58:-1:-81.48,76.18|61:B:interceptor:0:destroyed:13:-1:-55.12,95.52|62:B:interceptor:0:destroyed:28:-1:-75.51,74.40|63:B:interceptor:1:disabled:63:-1:-46.65,96.75|64:B:interceptor:0:destroyed:28:-1:-69.79,73.49|65:B:interceptor:1:disabled:30:-1:-44.99,86.48|66:B:interceptor:1:disabled:97:-1:-65.72,55.54|67:B:interceptor:0:destroyed:28:-1:-53.88,73.19|68:B:interceptor:1:disabled:38:-1:-60.96,65.41|69:B:interceptor:1:disabled:73:-1:-46.52,69.50|70:B:interceptor:1:disabled:97:-1:-64.10,36.03|71:B:interceptor:1:disabled:88:-1:-53.92,32.55|72:B:interceptor:1:disabled:91:-1:-40.06,63.27|73:B:interceptor:1:disabled:74:-1:-47.05,29.17|74:B:interceptor:0:destroyed:39:-1:-58.17,48.40|75:B:interceptor:1:disabled:47:-1:-32.52,22.08|76:B:interceptor:1:disabled:66:-1:-39.45,22.29|77:B:interceptor:0:destroyed:28:-1:-29.99,15.42|78:B:interceptor:1:disabled:36:-1:-3.65,21.25|79:B:interceptor:1:disabled:72:-1:8.69,32.22|80:B:carrier:0:destroyed:253:-1:-94.29,112.91|81:B:carrier:0:destroyed:214:-1:-71.46,143.87|82:B:carrier:1:disabled:366:-1:-78.60,103.34|83:B:carrier:0:destroyed:264:-1:-6.43,57.95|84:B:carrier:0:destroyed:189:-1:-117.78,118.74|85:B:carrier:0:destroyed:149:-1:-59.35,136.62|86:B:carrier:1:disabled:352:-1:-69.95,119.91|87:B:carrier:1:disabled:495:-1:-41.40,128.45|88:B:carrier:1:disabled:324:-1:0.47,93.91|89:B:carrier:0:destroyed:187:-1:-24.75,135.10|90:B:carrier:1:disabled:275:-1:-17.11,95.13|91:B:carrier:0:destroyed:239:-1:-28.57,144.10|92:B:standard:0:destroyed:885:-1:2.75,119.40|93:B:standard:1:normal:1600:-1:-122.70,126.38|94:B:standard:0:destroyed:475:-1:-8.72,119.70|95:B:standard:1:normal:1600:-1:-131.94,178.68|96:B:standard:0:destroyed:890:-1:-2.21,149.33|97:B:standard:1:normal:1600:-1:-141.47,191.85|98:B:standard:1:normal:1600:-1:-121.62,143.18|99:B:standard:1:normal:1600:-1:-156.23,199.97|comps=0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:15:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:13:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:12:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:20:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:24:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:1:0,3:sensor:6:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:9:0,3:sensor:0:1|0:core:9:0,1:engine:21:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:25:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:54:0,7:shield:36:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:13:0,5:weapon:45:0,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:81:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:2:0,5:weapon:45:0,6:sensor:54:0,7:shield:42:0|0:core:126:0,1:engine:31:0,2:engine:49:0,3:weapon:0:1,4:weapon:0:1,5:weapon:45:0,6:sensor:0:1,7:shield:47:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:26:0|0:core:57:0,1:engine:0:1,2:engine:2:0,3:weapon:70:0,4:weapon:35:0,5:weapon:45:0,6:sensor:54:0,7:shield:0:1|0:core:40:0,1:engine:25:0,2:engine:48:0,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:54:0,7:shield:0:1|0:core:104:0,1:engine:34:0,2:engine:55:0,3:weapon:69:0,4:weapon:6:0,5:weapon:45:0,6:sensor:0:1,7:shield:58:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:53:0,1:engine:0:1,2:engine:3:0,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:49:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:148:0,11:shield:96:0,12:armor:142:0,13:armor:163:0|0:core:358:0,1:engine:0:1,2:engine:20:0,3:engine:10:0,4:weapon:95:0,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:64:0,11:shield:0:1,12:armor:163:0,13:armor:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:49:0,5:weapon:16:0,6:weapon:28:0,7:weapon:0:1,8:sensor:15:0,9:sensor:58:0,10:shield:101:0,11:shield:95:0,12:armor:122:0,13:armor:149:0|0:core:358:0,1:engine:0:1,2:engine:52:0,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:0:1,11:shield:29:0,12:armor:163:0,13:armor:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:0:1,11:shield:0:1,12:armor:163:0,13:armor:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:0:1,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:0:1,9:sensor:13:0,10:shield:41:0,11:shield:0:1,12:armor:163:0,13:armor:123:0|0:core:381:0,1:engine:0:1,2:engine:0:1,3:engine:5:0,4:weapon:95:0,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:43:0,11:shield:26:0,12:armor:163:0,13:armor:0:1|0:core:0:1,1:engine:13:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:48:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:2:0|0:core:16:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:13:0,2:weapon:0:1,3:sensor:0:1|0:core:30:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:13:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:35:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:2:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:54:0,1:engine:28:0,2:weapon:0:1,3:sensor:14:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:10:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:45:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:6:0,3:sensor:0:1|0:core:45:0,1:engine:28:0,2:weapon:15:0,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:46:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:6:0,3:sensor:5:0|0:core:19:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:38:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:8:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:44:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:28:0,6:sensor:0:1,7:shield:70:0|0:core:0:1,1:engine:39:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:6:0,6:sensor:0:1,7:shield:70:0|0:core:96:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:64:0|0:core:0:1,1:engine:55:0,2:engine:39:0,3:weapon:0:1,4:weapon:15:0,5:weapon:45:0,6:sensor:0:1,7:shield:35:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:13:0,5:weapon:0:1,6:sensor:0:1,7:shield:26:0|0:core:82:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:55:0,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:54:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:70:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:12:0,6:sensor:0:1,7:shield:20:0|0:core:87:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:30:0,5:weapon:45:0,6:sensor:0:1,7:shield:4:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:39:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:40:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:0:1,11:shield:0:1,12:armor:0:1,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:105:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0",
  // v4-defensive-retreat
  'v4-defensive-retreat': "winner=A|reason=combatDisabled|tick=305|maxTicks=3600|A=5|B=11|destroyed=5:7|disabled=0:11|escaped=0:0|remainingFleetValue=1445:303|totalDamage=1655:497|shipHash=34f9c0b7|compHash=153b7ba1|ships=0:A:fortress:1:normal:1845:-1:-55.53,-39.12|1:A:fortress:1:normal:1845:-1:-45.71,-34.07|2:A:support:1:normal:578:-1:-68.08,-35.57|3:A:support:1:normal:578:-1:-59.98,-29.64|4:A:support:1:normal:578:-1:-70.68,-24.92|5:A:scout:0:destroyed:65:-1:-32.88,-8.33|6:A:scout:0:destroyed:65:-1:-33.34,1.75|7:A:scout:0:destroyed:65:-1:-32.30,9.15|8:A:scout:0:destroyed:65:-1:-34.77,21.52|9:A:scout:0:destroyed:85:-1:-34.66,27.62|10:B:interceptor:0:destroyed:28:-1:-7.00,-39.55|11:B:interceptor:1:disabled:98:-1:-6.09,-14.06|12:B:interceptor:0:destroyed:28:-1:0.62,-24.06|13:B:interceptor:0:destroyed:35:-1:-16.54,-11.00|14:B:interceptor:0:destroyed:67:-1:7.86,-13.87|15:B:interceptor:0:destroyed:67:-1:14.00,-12.43|16:B:interceptor:1:disabled:123:-1:24.63,-17.71|17:B:interceptor:1:disabled:93:-1:24.42,-10.37|18:B:interceptor:1:disabled:43:-1:22.93,-3.54|19:B:interceptor:1:disabled:53:-1:12.22,4.01|20:B:interceptor:1:disabled:113:-1:8.43,10.06|21:B:interceptor:1:disabled:62:-1:-0.93,12.47|22:B:interceptor:0:destroyed:36:-1:-21.05,-18.66|23:B:interceptor:1:disabled:78:-1:-27.37,-7.00|24:B:interceptor:1:disabled:95:-1:-22.57,4.64|25:B:interceptor:1:disabled:60:-1:-42.28,-3.31|26:B:interceptor:1:disabled:56:-1:-33.63,-2.10|27:B:interceptor:0:destroyed:19:-1:-42.06,2.36|comps=0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:20:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:7:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:7:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:0:1|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:13:0,1:engine:28:0,2:weapon:0:1,3:sensor:3:0|0:core:24:0,1:engine:28:0,2:weapon:1:0,3:sensor:0:1|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:34:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:8:0,3:sensor:0:1|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:4:0|0:core:32:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:28:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:19:0,2:weapon:0:1,3:sensor:0:1",
  // v4-focusFire-vs-screen
  'v4-focusFire-vs-screen': "winner=A|reason=retreat|tick=1253|maxTicks=3600|A=2|B=1|destroyed=3:11|disabled=0:1|escaped=5:2|remainingFleetValue=350:130|totalDamage=3021:627|shipHash=234d86a9|compHash=60fb79d8|ships=0:A:standard:1:normal:1600:-1:-41.66,-33.92|1:A:standard:1:normal:1596:-1:-7.53,-58.14|2:A:standard:0:escaped:96:179:-47.32,-22.14|3:A:standard:0:destroyed:38:-1:-14.87,-21.41|4:A:standard:0:escaped:96:164:-47.25,-11.70|5:A:standard:0:escaped:96:137:-47.18,-5.49|6:A:standard:0:destroyed:82:-1:-26.12,0.77|7:A:standard:0:escaped:96:167:-47.04,-1.36|8:A:standard:0:escaped:120:87:-47.22,20.03|9:A:standard:0:destroyed:58:-1:-22.22,4.53|10:B:interceptor:0:escaped:69:30:47.17,-45.50|11:B:interceptor:0:destroyed:22:-1:40.17,-30.27|12:B:interceptor:0:destroyed:60:-1:16.24,-20.29|13:B:interceptor:0:destroyed:82:-1:15.82,-14.14|14:B:interceptor:0:destroyed:37:-1:15.43,-7.56|15:B:interceptor:0:destroyed:38:-1:14.83,-1.37|16:B:interceptor:0:destroyed:0:-1:22.07,-10.39|17:B:interceptor:0:destroyed:32:-1:0.82,-3.91|18:B:interceptor:0:destroyed:54:-1:-8.03,-15.77|19:B:interceptor:0:destroyed:54:-1:-17.52,-5.01|20:B:standard:0:destroyed:111:-1:33.89,-8.26|21:B:standard:0:destroyed:133:-1:16.78,-1.52|22:B:standard:0:escaped:233:1216:47.03,-0.00|23:B:standard:1:disabled:404:-1:5.28,-1.17|comps=0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:116:0,12:armor:130:0,13:armor:130:0|0:core:62:0,1:engine:28:0,2:weapon:0:1,3:sensor:6:0|0:core:0:1,1:engine:0:1,2:weapon:16:0,3:sensor:22:0|0:core:62:0,1:engine:28:0,2:weapon:0:1,3:sensor:6:0|0:core:14:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:14:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:70:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:24:0,3:sensor:6:0|0:core:41:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:6:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:15:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:10:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:0:1,4:weapon:12:0,5:weapon:45:0,6:sensor:0:1,7:shield:55:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:25:0,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:18:0|0:core:121:0,1:engine:31:0,2:engine:31:0,3:weapon:0:1,4:weapon:0:1,5:weapon:45:0,6:sensor:0:1,7:shield:5:0|0:core:129:0,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:45:0,7:shield:70:0",
  // v4-antiCapital-vs-swarm
  'v4-antiCapital-vs-swarm': "winner=A|reason=retreat|tick=1293|maxTicks=3600|A=3|B=1|destroyed=2:7|disabled=0:1|escaped=4:7|remainingFleetValue=1580:1643|totalDamage=2318:606|shipHash=38f71022|compHash=801840be|ships=0:A:fortress:1:normal:1845:-1:5.20,11.80|1:A:fortress:1:normal:1845:-1:-21.59,22.54|2:A:fortress:1:normal:1845:-1:11.13,28.81|3:A:standard:0:escaped:120:98:-47.16,-32.59|4:A:standard:0:escaped:63:275:-47.05,-34.80|5:A:standard:0:destroyed:1:-1:-43.21,-37.04|6:A:standard:0:escaped:56:361:-47.11,-29.82|7:A:standard:0:destroyed:21:-1:-4.39,-30.32|8:A:standard:0:escaped:99:201:-47.11,-5.62|9:B:carrier:0:escaped:161:1052:47.03,-48.46|10:B:carrier:0:escaped:310:723:47.14,-51.62|11:B:carrier:0:escaped:432:281:55.16,-47.78|12:B:scout:1:disabled:89:-1:-39.53,-4.64|13:B:scout:0:destroyed:62:-1:31.16,8.75|14:B:scout:0:destroyed:28:-1:-5.58,-8.98|15:B:scout:0:destroyed:65:-1:45.38,14.61|16:B:scout:0:destroyed:73:-1:-24.58,-8.79|17:B:scout:0:escaped:98:1164:47.30,52.99|18:B:scout:0:escaped:96:1212:47.23,-15.19|19:B:scout:0:destroyed:29:-1:14.15,53.29|20:B:scout:0:escaped:78:1262:47.14,-15.48|21:B:scout:0:destroyed:28:-1:-19.39,32.91|22:B:scout:0:escaped:94:1085:47.28,9.18|23:B:scout:0:destroyed:43:-1:-41.97,23.28|comps=0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:70:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:35:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:1:0|0:core:46:0,1:engine:10:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:21:0,3:sensor:0:1|0:core:57:0,1:engine:28:0,2:weapon:13:0,3:sensor:0:1|0:core:19:0,1:engine:1:0,2:engine:21:0,3:weapon:50:0,4:weapon:45:0,5:weapon:0:1,6:sensor:25:0,7:shield:0:1|0:core:93:0,1:engine:45:0,2:engine:55:0,3:weapon:30:0,4:weapon:0:1,5:weapon:45:0,6:sensor:0:1,7:shield:41:0|0:core:149:0,1:engine:55:0,2:engine:43:0,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:0:1,7:shield:70:0|0:core:24:0,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:13:0,2:weapon:32:0,3:sensor:18:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:12:0,3:sensor:33:0|0:core:5:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:55:0,1:engine:28:0,2:weapon:0:1,3:sensor:13:0|0:core:0:1,1:engine:28:0,2:weapon:1:0,3:sensor:0:1|0:core:4:0,1:engine:28:0,2:weapon:12:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:1:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:12:0,3:sensor:2:0",
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

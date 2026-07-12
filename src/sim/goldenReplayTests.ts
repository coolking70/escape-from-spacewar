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
// 黄金基线指纹（由 generateGoldenReplayValues() 生成后人工核对再内嵌；任何模拟层变更
// 都必须保持这些指纹稳定）。缺失的键会导致 runGoldenReplayTests() 直接判失败。
export const GOLDEN_EXPECTED: Record<string, string> = {
    'v4-small-balanced': "winner=B|reason=retreat|tick=2593|maxTicks=3600|A=0|B=1|destroyed=4:1|disabled=0:0|escaped=1:3|remainingFleetValue=50:215|totalDamage=844:1126|shipHash=a071a780|compHash=95b09857|ships=0:A:standard:0:destroyed:54:-1:-20.16,11.73|1:A:standard:0:destroyed:54:-1:-29.10,-42.62|2:A:standard:0:destroyed:82:-1:-20.15,18.65|3:A:standard:0:escaped:352:354:-47.13,1.42|4:A:standard:0:destroyed:199:-1:-45.18,114.27|5:B:interceptor:0:escaped:77:926:47.37,88.33|6:B:interceptor:0:escaped:20:1075:47.04,100.62|7:B:interceptor:0:escaped:83:846:47.19,88.43|8:B:standard:1:normal:469:-1:1.99,73.56|9:B:standard:0:destroyed:213:-1:17.01,101.34|comps=0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:125:0,1:engine:47:0,2:engine:45:0,3:weapon:1:0,4:weapon:45:0,5:weapon:24:0,6:sensor:0:1,7:shield:64:0|0:core:0:1,1:engine:30:0,2:engine:30:0,3:weapon:49:0,4:weapon:0:1,5:weapon:45:0,6:sensor:45:0,7:shield:0:1|0:core:3:0,1:engine:28:0,2:weapon:25:0,3:sensor:22:0|0:core:10:0,1:engine:10:0,2:weapon:0:1,3:sensor:0:1|0:core:10:0,1:engine:28:0,2:weapon:32:0,3:sensor:13:0|0:core:149:0,1:engine:55:0,2:engine:55:0,3:weapon:38:0,4:weapon:26:0,5:weapon:45:0,6:sensor:35:0,7:shield:66:0|0:core:0:1,1:engine:37:0,2:engine:37:0,3:weapon:59:0,4:weapon:45:0,5:weapon:0:1,6:sensor:34:0,7:shield:0:1",
    'v4-large-mixed': "winner=B|reason=retreat|tick=733|maxTicks=3600|A=0|B=5|destroyed=7:4|disabled=0:2|escaped=3:0|remainingFleetValue=275:1455|totalDamage=1685:3707|shipHash=5533a793|compHash=8eebac42|ships=0:A:standard:0:escaped:1060:545:-47.11,-36.90|1:A:standard:0:escaped:779:733:-47.29,-25.22|2:A:support:0:escaped:132:144:-47.03,-15.98|3:A:support:0:destroyed:279:-1:-28.42,-16.02|4:A:support:0:destroyed:248:-1:-31.40,-8.82|5:A:scout:0:destroyed:46:-1:-16.19,-11.06|6:A:scout:0:destroyed:42:-1:-23.88,-7.39|7:A:scout:0:destroyed:93:-1:-17.51,-3.24|8:A:scout:0:destroyed:28:-1:-15.50,4.55|9:A:scout:0:destroyed:93:-1:-18.83,0.69|10:B:fortress:1:normal:1845:-1:8.07,-45.66|11:B:fortress:1:normal:1785:-1:13.31,-28.24|12:B:carrier:1:normal:1600:-1:11.74,-11.53|13:B:carrier:0:destroyed:880:-1:14.64,-6.60|14:B:interceptor:1:disabled:113:-1:32.84,-1.03|15:B:interceptor:1:disabled:34:-1:25.11,1.68|16:B:interceptor:0:destroyed:44:-1:18.54,1.95|17:B:interceptor:0:destroyed:19:-1:12.10,3.13|18:B:interceptor:0:destroyed:28:-1:12.91,8.81|comps=0:core:296:0,1:engine:95:0,2:engine:76:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:22:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:89:0,11:shield:120:0,12:armor:130:0,13:armor:77:0|0:core:219:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:42:0,5:weapon:50:0,6:weapon:0:1,7:weapon:0:1,8:sensor:0:1,9:sensor:5:0,10:shield:0:1,11:shield:0:1,12:armor:96:0,13:armor:82:0|0:core:30:0,1:engine:0:1,2:engine:38:0,3:weapon:0:1,4:weapon:0:1,5:weapon:45:0,6:sensor:0:1,7:shield:19:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:36:0,2:engine:43:0,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:18:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:14:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:47:0,8:sensor:71:0,9:sensor:75:0,10:shield:146:0,11:shield:145:0,12:armor:163:0,13:armor:163:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:105:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:6:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:16:0|0:core:0:1,1:engine:19:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1",
    'v4-kite-vs-screen': "winner=B|reason=retreat|tick=578|maxTicks=3600|A=2|B=5|destroyed=3:2|disabled=2:0|escaped=5:3|remainingFleetValue=660:2100|totalDamage=411:2349|shipHash=df918b93|compHash=716c702d|ships=0:A:support:0:destroyed:91:-1:-36.15,-24.85|1:A:support:0:escaped:325:484:-47.01,-20.12|2:A:support:0:escaped:309:292:-47.03,-15.83|3:A:support:0:escaped:338:105:-47.06,-16.27|4:A:scout:1:disabled:98:-1:-27.70,14.03|5:A:scout:0:escaped:106:143:-47.29,3.71|6:A:scout:0:destroyed:19:-1:-23.73,8.98|7:A:scout:0:destroyed:40:-1:-27.00,15.08|8:A:scout:1:disabled:84:-1:-34.88,47.82|9:A:scout:0:escaped:75:568:-47.20,20.71|10:B:fortress:1:normal:1845:-1:19.99,3.25|11:B:fortress:1:normal:1845:-1:22.30,21.10|12:B:carrier:1:normal:1600:-1:7.97,11.86|13:B:carrier:1:normal:1600:-1:1.64,36.81|14:B:interceptor:0:escaped:113:116:47.13,-24.40|15:B:interceptor:0:destroyed:54:-1:10.37,6.74|16:B:interceptor:0:escaped:75:158:47.19,-7.91|17:B:interceptor:1:damaged:103:-1:3.30,19.89|18:B:interceptor:0:destroyed:57:-1:4.03,3.30|19:B:interceptor:0:escaped:98:160:47.26,11.48|comps=0:core:0:1,1:engine:6:0,2:engine:40:0,3:weapon:0:1,4:weapon:0:1,5:weapon:45:0,6:sensor:0:1,7:shield:0:1|0:core:41:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:61:0,1:engine:29:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:74:0|0:core:54:0,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:45:0,1:engine:0:1,2:weapon:32:0,3:sensor:21:0|0:core:54:0,1:engine:28:0,2:weapon:24:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:18:0,3:sensor:1:0|0:core:0:1,1:engine:7:0,2:weapon:19:0,3:sensor:14:0|0:core:56:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:25:0,1:engine:28:0,2:weapon:18:0,3:sensor:5:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:44:0,1:engine:28:0,2:weapon:0:1,3:sensor:3:0|0:core:27:0,1:engine:22:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:7:0,3:sensor:22:0|0:core:44:0,1:engine:28:0,2:weapon:26:0,3:sensor:0:1",
    'v4-25v25': "winner=B|reason=retreat|tick=753|maxTicks=3600|A=1|B=19|destroyed=23:6|disabled=1:10|escaped=1:0|remainingFleetValue=690:3303|totalDamage=2635:8334|shipHash=d35130ba|compHash=e6962c73|ships=0:A:standard:0:destroyed:67:-1:-36.07,-56.63|1:A:standard:0:destroyed:26:-1:-25.44,-57.07|2:A:standard:0:destroyed:58:-1:-31.21,-44.83|3:A:standard:0:destroyed:4:-1:-29.41,-53.92|4:A:standard:0:destroyed:54:-1:-30.25,-36.34|5:A:standard:0:destroyed:52:-1:-24.24,-31.84|6:A:standard:0:destroyed:26:-1:-45.71,-12.02|7:A:standard:0:destroyed:54:-1:-38.20,-9.37|8:A:standard:0:destroyed:28:-1:-31.86,-6.44|9:A:standard:0:destroyed:59:-1:-31.06,-6.99|10:A:standard:0:destroyed:14:-1:-29.74,-8.06|11:A:standard:0:destroyed:82:-1:-30.24,1.50|12:A:standard:0:destroyed:82:-1:-27.57,4.47|13:A:standard:0:destroyed:28:-1:-28.40,7.61|14:A:standard:0:destroyed:28:-1:-27.43,14.00|15:A:support:0:destroyed:298:-1:-50.65,23.43|16:A:support:0:destroyed:211:-1:-37.64,26.47|17:A:support:0:destroyed:63:-1:-30.88,30.43|18:A:support:0:destroyed:284:-1:-32.38,40.62|19:A:support:0:destroyed:202:-1:-38.21,41.84|20:A:support:0:destroyed:284:-1:-33.62,56.29|21:A:fortress:0:destroyed:919:-1:-57.45,49.32|22:A:fortress:0:escaped:897:540:-54.96,73.62|23:A:fortress:0:destroyed:868:-1:-69.27,86.17|24:A:fortress:1:disabled:1471:-1:-69.33,110.72|25:B:interceptor:1:disabled:71:-1:-41.86,79.60|26:B:interceptor:1:disabled:30:-1:-50.29,56.33|27:B:interceptor:1:disabled:71:-1:-32.12,54.56|28:B:interceptor:1:disabled:80:-1:-53.74,50.42|29:B:interceptor:0:destroyed:28:-1:-30.81,52.92|30:B:interceptor:1:disabled:80:-1:-46.88,32.19|31:B:interceptor:1:disabled:93:-1:-28.65,29.55|32:B:interceptor:1:disabled:58:-1:-51.18,24.59|33:B:interceptor:1:disabled:45:-1:-24.44,3.13|34:B:interceptor:0:destroyed:28:-1:-41.82,14.96|35:B:interceptor:0:destroyed:28:-1:-7.10,-14.51|36:B:interceptor:1:disabled:94:-1:-6.87,-13.44|37:B:interceptor:0:destroyed:41:-1:-3.03,-4.89|38:B:interceptor:0:destroyed:33:-1:2.60,6.03|39:B:interceptor:0:destroyed:28:-1:8.02,15.11|40:B:carrier:1:normal:1600:-1:-23.33,22.43|41:B:carrier:1:normal:1600:-1:-11.39,44.82|42:B:carrier:1:normal:1600:-1:-26.88,38.23|43:B:carrier:1:normal:1600:-1:-17.92,56.21|44:B:carrier:1:normal:1600:-1:-20.33,47.08|45:B:carrier:1:normal:1600:-1:-12.72,66.80|46:B:standard:1:normal:1328:-1:-21.92,63.16|47:B:standard:1:normal:1600:-1:-11.91,75.88|48:B:standard:1:disabled:1131:-1:-0.38,73.36|49:B:standard:1:normal:1600:-1:-12.49,94.33|comps=0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:7:0|0:core:0:1,1:engine:20:0,2:weapon:0:1,3:sensor:6:0|0:core:0:1,1:engine:4:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:4:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:16:0,3:sensor:9:0|0:core:0:1,1:engine:4:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:20:0,2:weapon:18:0,3:sensor:22:0|0:core:0:1,1:engine:14:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:41:0,2:engine:21:0,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:35:0,7:shield:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:0:1,4:weapon:45:0,5:weapon:0:1,6:sensor:18:0,7:shield:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:0:1,1:engine:15:0,2:engine:18:0,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:58:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:102:0,11:shield:128:0,12:armor:163:0,13:armor:163:0|0:core:335:0,1:engine:87:0,2:engine:74:0,3:engine:18:0,4:weapon:33:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:36:0,9:sensor:66:0,10:shield:0:1,11:shield:0:1,12:armor:25:0,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:123:0,11:shield:68:0,12:armor:149:0,13:armor:163:0|0:core:456:0,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:2:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:30:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:45:0,1:engine:28:0,2:weapon:0:1,3:sensor:7:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:2:0|0:core:30:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:17:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:44:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:13:0|0:core:0:1,1:engine:28:0,2:weapon:5:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:339:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:16:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:48:0,9:sensor:20:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:226:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0",
    'v4-50v50': "winner=B|reason=retreat|tick=808|maxTicks=6000|A=1|B=43|destroyed=45:7|disabled=1:2|escaped=4:0|remainingFleetValue=1375:7383|totalDamage=4044:18676|shipHash=aa5dc587|compHash=f9748db7|ships=0:A:standard:0:destroyed:22:-1:-25.15,-148.33|1:A:standard:0:destroyed:58:-1:-30.47,-144.42|2:A:standard:0:destroyed:52:-1:-43.85,-120.46|3:A:standard:0:escaped:106:136:-47.30,-141.57|4:A:standard:0:destroyed:38:-1:-43.48,-106.13|5:A:standard:0:destroyed:58:-1:-35.70,-107.05|6:A:standard:0:destroyed:24:-1:-32.57,-103.81|7:A:standard:0:destroyed:46:-1:-25.68,-102.29|8:A:standard:0:destroyed:54:-1:-31.50,-87.70|9:A:standard:0:destroyed:16:-1:-28.18,-98.90|10:A:standard:0:destroyed:38:-1:-26.49,-81.50|11:A:standard:0:destroyed:54:-1:-46.24,-79.17|12:A:standard:0:destroyed:49:-1:-42.81,-52.89|13:A:standard:0:destroyed:51:-1:-28.72,-61.34|14:A:standard:0:destroyed:54:-1:-42.98,-44.95|15:A:standard:0:destroyed:58:-1:-24.73,-57.35|16:A:standard:0:destroyed:54:-1:-49.73,-24.46|17:A:standard:0:destroyed:41:-1:-26.66,-37.36|18:A:standard:0:destroyed:32:-1:-37.35,-22.45|19:A:standard:0:destroyed:56:-1:-29.72,-21.41|20:A:standard:0:destroyed:31:-1:-44.63,-0.78|21:A:standard:0:destroyed:58:-1:-25.26,-17.25|22:A:standard:0:destroyed:14:-1:-44.95,13.14|23:A:standard:0:destroyed:0:-1:-38.35,15.06|24:A:standard:0:destroyed:28:-1:-24.64,-1.29|25:A:standard:0:destroyed:40:-1:-34.47,7.34|26:A:standard:0:destroyed:54:-1:-28.56,9.80|27:A:standard:0:destroyed:54:-1:-28.14,13.75|28:A:standard:0:destroyed:28:-1:-29.14,21.03|29:A:standard:0:destroyed:28:-1:-28.76,27.10|30:A:support:0:escaped:341:428:-49.47,38.08|31:A:support:0:destroyed:205:-1:-43.29,41.34|32:A:support:0:destroyed:45:-1:-32.08,47.81|33:A:support:0:destroyed:155:-1:-39.30,48.71|34:A:support:0:destroyed:224:-1:-41.57,63.46|35:A:support:0:destroyed:226:-1:-34.82,66.13|36:A:support:0:destroyed:270:-1:-30.49,79.76|37:A:support:0:destroyed:169:-1:-39.39,75.55|38:A:support:0:destroyed:189:-1:-34.36,94.54|39:A:support:0:destroyed:205:-1:-36.25,90.40|40:A:support:0:destroyed:169:-1:-41.96,102.65|41:A:support:0:destroyed:273:-1:-34.71,114.76|42:A:fortress:0:destroyed:1015:-1:-60.77,105.87|43:A:fortress:0:destroyed:869:-1:-64.28,121.26|44:A:fortress:0:destroyed:223:-1:-33.45,133.28|45:A:fortress:0:escaped:1081:639:-70.96,134.91|46:A:fortress:0:destroyed:998:-1:-45.39,148.62|47:A:fortress:0:escaped:929:721:-75.27,149.10|48:A:fortress:0:destroyed:568:-1:-37.91,169.64|49:A:fortress:1:disabled:937:-1:-80.50,166.12|50:B:interceptor:1:normal:145:-1:-73.76,12.66|51:B:interceptor:1:normal:145:-1:-19.55,34.01|52:B:interceptor:1:normal:145:-1:-73.02,23.20|53:B:interceptor:1:normal:136:-1:-19.77,42.06|54:B:interceptor:1:normal:128:-1:-66.13,32.32|55:B:interceptor:1:normal:136:-1:-37.58,38.78|56:B:interceptor:1:normal:127:-1:-69.10,26.47|57:B:interceptor:1:normal:136:-1:-22.50,52.61|58:B:interceptor:1:normal:145:-1:-31.09,41.23|59:B:interceptor:1:normal:118:-1:-25.59,60.49|60:B:interceptor:1:damaged:91:-1:-71.05,55.19|61:B:interceptor:1:normal:145:-1:-26.92,67.48|62:B:interceptor:1:normal:130:-1:-72.03,62.86|63:B:interceptor:1:normal:109:-1:-41.50,85.24|64:B:interceptor:1:normal:145:-1:-70.20,72.29|65:B:interceptor:1:normal:109:-1:-34.99,85.16|66:B:interceptor:1:normal:127:-1:-71.82,93.94|67:B:interceptor:1:normal:145:-1:-40.52,108.14|68:B:interceptor:1:normal:100:-1:-74.81,104.13|69:B:interceptor:1:normal:119:-1:-59.36,101.06|70:B:interceptor:1:normal:145:-1:-53.15,102.72|71:B:interceptor:1:normal:100:-1:-80.02,115.00|72:B:interceptor:1:normal:128:-1:-73.84,113.46|73:B:interceptor:0:destroyed:64:-1:-19.46,-6.83|74:B:interceptor:1:critical:78:-1:-72.98,120.23|75:B:interceptor:0:destroyed:28:-1:-8.88,12.37|76:B:interceptor:1:disabled:58:-1:-21.41,-8.28|77:B:interceptor:0:destroyed:41:-1:-9.35,17.92|78:B:interceptor:0:destroyed:28:-1:-1.41,15.97|79:B:interceptor:0:destroyed:28:-1:9.33,32.00|80:B:carrier:1:normal:1600:-1:-8.19,50.05|81:B:carrier:1:normal:1600:-1:-3.07,69.70|82:B:carrier:1:normal:1600:-1:-18.20,63.55|83:B:carrier:1:normal:1600:-1:-17.71,76.83|84:B:carrier:1:normal:1600:-1:-5.49,84.85|85:B:carrier:1:normal:1600:-1:-2.94,98.92|86:B:carrier:1:normal:1600:-1:-28.95,88.80|87:B:carrier:1:normal:1600:-1:2.58,113.23|88:B:carrier:1:normal:1600:-1:-28.88,98.50|89:B:carrier:1:normal:1476:-1:-30.81,112.09|90:B:carrier:1:normal:1600:-1:-18.57,106.61|91:B:carrier:1:normal:1600:-1:-26.24,127.95|92:B:standard:1:normal:1600:-1:-22.21,120.74|93:B:standard:1:normal:1600:-1:-16.44,135.87|94:B:standard:1:disabled:938:-1:-5.18,128.36|95:B:standard:0:destroyed:905:-1:-7.48,144.65|96:B:standard:1:normal:1600:-1:-19.60,145.00|97:B:standard:1:normal:1600:-1:-21.19,154.52|98:B:standard:0:destroyed:905:-1:-18.27,160.85|99:B:standard:1:normal:1600:-1:-22.89,175.49|comps=0:core:0:1,1:engine:12:0,2:weapon:3:0,3:sensor:7:0|0:core:0:1,1:engine:4:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:12:0,2:weapon:32:0,3:sensor:9:0|0:core:62:0,1:engine:28:0,2:weapon:16:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:16:0,3:sensor:22:0|0:core:0:1,1:engine:12:0,2:weapon:24:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:24:0,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:16:0,3:sensor:0:1|0:core:0:1,1:engine:12:0,2:weapon:19:0,3:sensor:7:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:13:0,2:weapon:20:0,3:sensor:17:0|0:core:0:1,1:engine:5:0,2:weapon:32:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:16:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:20:0,2:weapon:7:0,3:sensor:14:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:0:1|0:core:0:1,1:engine:21:0,2:weapon:32:0,3:sensor:3:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:3:0|0:core:0:1,1:engine:28:0,2:weapon:16:0,3:sensor:14:0|0:core:0:1,1:engine:6:0,2:weapon:0:1,3:sensor:8:0|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:8:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:72:0,1:engine:49:0,2:engine:50:0,3:weapon:70:0,4:weapon:0:1,5:weapon:45:0,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:48:0,2:engine:55:0,3:weapon:0:1,4:weapon:0:1,5:weapon:45:0,6:sensor:0:1,7:shield:56:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:0:1,4:weapon:45:0,5:weapon:0:1,6:sensor:0:1,7:shield:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:40:0,7:shield:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:20:0,4:weapon:0:1,5:weapon:45:0,6:sensor:48:0,7:shield:0:1|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:57:0|0:core:0:1,1:engine:55:0,2:engine:41:0,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:23:0,6:sensor:0:1,7:shield:11:0|0:core:0:1,1:engine:29:0,2:engine:55:0,3:weapon:22:0,4:weapon:45:0,5:weapon:0:1,6:sensor:54:0,7:shield:0:1|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:0:1,6:sensor:0:1,7:shield:14:0|0:core:0:1,1:engine:55:0,2:engine:55:0,3:weapon:0:1,4:weapon:45:0,5:weapon:34:0,6:sensor:0:1,7:shield:84:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:148:0,11:shield:97:0,12:armor:163:0,13:armor:95:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:0:1,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:0:1,11:shield:0:1,12:armor:163:0,13:armor:0:1|0:core:376:0,1:engine:95:0,2:engine:78:0,3:engine:73:0,4:weapon:0:1,5:weapon:60:0,6:weapon:28:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:95:0,11:shield:26:0,12:armor:163:0,13:armor:87:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:58:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:268:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:29:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:15:0,11:shield:71:0,12:armor:163:0,13:armor:38:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:15:0,5:weapon:20:0,6:weapon:60:0,7:weapon:0:1,8:sensor:52:0,9:sensor:22:0,10:shield:67:0,11:shield:92:0,12:armor:78:0,13:armor:163:0|0:core:379:0,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:95:0,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:37:0,11:shield:53:0,12:armor:163:0,13:armor:0:1|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:54:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:54:0,1:engine:28:0,2:weapon:24:0,3:sensor:22:0|0:core:54:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:14:0,3:sensor:22:0|0:core:54:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:45:0,1:engine:28:0,2:weapon:32:0,3:sensor:13:0|0:core:27:0,1:engine:28:0,2:weapon:14:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:57:0,1:engine:28:0,2:weapon:32:0,3:sensor:13:0|0:core:45:0,1:engine:28:0,2:weapon:23:0,3:sensor:13:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:36:0,1:engine:28:0,2:weapon:23:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:23:0,3:sensor:13:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:45:0,1:engine:28:0,2:weapon:23:0,3:sensor:4:0|0:core:54:0,1:engine:28:0,2:weapon:24:0,3:sensor:13:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:36:0,1:engine:28:0,2:weapon:14:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:15:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:14:0,3:sensor:22:0|0:core:16:0,1:engine:28:0,2:weapon:12:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:30:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:13:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:92:0,5:weapon:60:0,6:weapon:60:0,7:weapon:28:0,8:sensor:42:0,9:sensor:29:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:33:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:380:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0",
    'v4-defensive-retreat': "winner=A|reason=combatDisabled|tick=311|maxTicks=3600|A=5|B=9|destroyed=5:9|disabled=0:9|escaped=0:0|remainingFleetValue=1445:248|totalDamage=1809:548|shipHash=8df7add0|compHash=70e84d11|ships=0:A:fortress:1:normal:1845:-1:-54.07,-39.39|1:A:fortress:1:normal:1845:-1:-51.15,-32.45|2:A:support:1:normal:578:-1:-67.36,-19.35|3:A:support:1:normal:578:-1:-58.59,-24.57|4:A:support:1:normal:578:-1:-73.45,-10.14|5:A:scout:0:destroyed:65:-1:-27.81,-7.21|6:A:scout:0:destroyed:65:-1:-34.03,-1.57|7:A:scout:0:destroyed:65:-1:-30.72,7.39|8:A:scout:0:destroyed:57:-1:-32.07,19.62|9:A:scout:0:destroyed:44:-1:-32.65,26.12|10:B:interceptor:0:destroyed:28:-1:-2.70,-37.62|11:B:interceptor:0:destroyed:13:-1:-12.03,-12.47|12:B:interceptor:0:destroyed:58:-1:2.35,-24.75|13:B:interceptor:0:destroyed:28:-1:-25.95,-12.46|14:B:interceptor:1:disabled:73:-1:13.38,-20.03|15:B:interceptor:0:destroyed:67:-1:1.03,0.02|16:B:interceptor:1:disabled:123:-1:24.94,-17.67|17:B:interceptor:1:disabled:93:-1:24.42,-10.37|18:B:interceptor:1:disabled:57:-1:22.93,-3.54|19:B:interceptor:0:destroyed:63:-1:12.22,5.25|20:B:interceptor:1:disabled:91:-1:7.72,9.66|21:B:interceptor:0:destroyed:19:-1:-6.66,11.65|22:B:interceptor:0:destroyed:40:-1:-8.26,1.55|23:B:interceptor:1:disabled:32:-1:-26.16,-5.83|24:B:interceptor:1:disabled:82:-1:-18.36,9.06|25:B:interceptor:1:disabled:58:-1:-35.42,-2.27|26:B:interceptor:0:destroyed:28:-1:-33.09,-2.15|27:B:interceptor:1:disabled:78:-1:-34.65,15.43|comps=0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:475:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:60:0,7:weapon:70:0,8:sensor:75:0,9:sensor:75:0,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:54:0,7:shield:84:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:33:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:25:0|0:core:0:1,1:engine:12:0,2:weapon:8:0,3:sensor:25:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:13:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:8:0,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:28:0,1:engine:28:0,2:weapon:17:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:7:0|0:core:63:0,1:engine:28:0,2:weapon:32:0,3:sensor:0:1|0:core:43:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:29:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:13:0,3:sensor:22:0|0:core:63:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:19:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:8:0,3:sensor:4:0|0:core:4:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:54:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:30:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:45:0,1:engine:28:0,2:weapon:0:1,3:sensor:4:0",
    'v4-focusFire-vs-screen': "winner=B|reason=retreat|tick=1949|maxTicks=3600|A=0|B=2|destroyed=8:11|disabled=0:0|escaped=2:1|remainingFleetValue=100:155|totalDamage=2667:3131|shipHash=5d0ad902|compHash=44700025|ships=0:A:standard:0:destroyed:607:-1:-8.63,27.53|1:A:standard:0:destroyed:685:-1:-33.65,-20.71|2:A:standard:0:destroyed:20:-1:-30.18,-22.01|3:A:standard:0:destroyed:50:-1:-15.91,-18.25|4:A:standard:0:escaped:56:174:-47.02,-10.91|5:A:standard:0:destroyed:74:-1:-22.48,-5.60|6:A:standard:0:destroyed:82:-1:-26.09,0.79|7:A:standard:0:destroyed:54:-1:-45.16,-2.03|8:A:standard:0:escaped:120:87:-47.22,20.04|9:A:standard:0:destroyed:58:-1:-18.73,4.74|10:B:interceptor:0:escaped:69:30:47.17,-45.50|11:B:interceptor:0:destroyed:28:-1:44.86,-30.81|12:B:interceptor:0:destroyed:29:-1:18.88,-21.59|13:B:interceptor:0:destroyed:28:-1:20.41,-15.54|14:B:interceptor:0:destroyed:48:-1:12.34,-7.96|15:B:interceptor:0:destroyed:16:-1:2.46,-2.01|16:B:interceptor:0:destroyed:28:-1:-7.52,-9.67|17:B:interceptor:0:destroyed:0:-1:-3.69,-1.37|18:B:interceptor:0:destroyed:54:-1:-10.52,-8.88|19:B:interceptor:0:destroyed:54:-1:-18.59,3.36|20:B:standard:0:destroyed:143:-1:33.05,-6.93|21:B:standard:0:destroyed:160:-1:6.49,-3.18|22:B:standard:1:normal:428:-1:-14.43,-7.46|23:B:standard:1:normal:555:-1:-3.77,-7.53|comps=0:core:0:1,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:53:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:42:0,9:sensor:64:0,10:shield:0:1,11:shield:0:1,12:armor:0:1,13:armor:102:0|0:core:0:1,1:engine:65:0,2:engine:95:0,3:engine:90:0,4:weapon:95:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:75:0,9:sensor:75:0,10:shield:0:1,11:shield:0:1,12:armor:0:1,13:armor:130:0|0:core:0:1,1:engine:20:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:4:0,2:weapon:32:0,3:sensor:14:0|0:core:22:0,1:engine:28:0,2:weapon:0:1,3:sensor:6:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:14:0|0:core:0:1,1:engine:28:0,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:70:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:16:0,3:sensor:14:0|0:core:41:0,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:6:0,2:weapon:0:1,3:sensor:22:0|0:core:0:1,1:engine:28:0,2:weapon:1:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:26:0,3:sensor:22:0|0:core:0:1,1:engine:11:0,2:weapon:0:1,3:sensor:5:0|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:22:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:0:1,4:weapon:45:0,5:weapon:45:0,6:sensor:0:1,7:shield:53:0|0:core:0:1,1:engine:0:1,2:engine:0:1,3:weapon:70:0,4:weapon:45:0,5:weapon:0:1,6:sensor:45:0,7:shield:0:1|0:core:150:0,1:engine:55:0,2:engine:55:0,3:weapon:60:0,4:weapon:24:0,5:weapon:45:0,6:sensor:17:0,7:shield:23:0|0:core:170:0,1:engine:55:0,2:engine:55:0,3:weapon:70:0,4:weapon:45:0,5:weapon:45:0,6:sensor:45:0,7:shield:70:0",
    'v4-antiCapital-vs-swarm': "winner=B|reason=retreat|tick=1982|maxTicks=3600|A=1|B=13|destroyed=3:0|disabled=1:0|escaped=5:2|remainingFleetValue=1300:1980|totalDamage=2252:3121|shipHash=b614ddf8|compHash=dcabf758|ships=0:A:fortress:0:escaped:1553:911:-47.04,1.64|1:A:fortress:0:escaped:1313:1508:-47.07,1.85|2:A:fortress:1:disabled:1085:-1:36.36,-1.88|3:A:standard:0:escaped:88:38:-47.28,-28.13|4:A:standard:0:escaped:101:47:-47.16,-21.00|5:A:standard:0:escaped:53:132:-47.15,-20.39|6:A:standard:0:destroyed:32:-1:-30.26,-16.96|7:A:standard:0:destroyed:36:-1:-15.30,-13.27|8:A:standard:0:destroyed:28:-1:-16.52,-5.01|9:B:carrier:1:normal:1347:-1:39.07,-57.88|10:B:carrier:0:escaped:1059:1063:47.03,-46.63|11:B:carrier:0:escaped:1068:386:47.03,-46.62|12:B:scout:1:normal:163:-1:7.80,8.48|13:B:scout:1:normal:163:-1:4.63,-17.21|14:B:scout:1:normal:163:-1:9.77,3.95|15:B:scout:1:normal:163:-1:13.51,-10.45|16:B:scout:1:normal:163:-1:14.34,8.66|17:B:scout:1:normal:163:-1:10.42,-14.29|18:B:scout:1:normal:163:-1:10.89,-19.15|19:B:scout:1:normal:163:-1:16.71,-16.19|20:B:scout:1:normal:163:-1:21.31,-20.88|21:B:scout:1:normal:163:-1:6.73,-11.01|22:B:scout:1:normal:163:-1:26.85,-24.30|23:B:scout:1:normal:163:-1:9.69,12.99|comps=0:core:456:0,1:engine:72:0,2:engine:95:0,3:engine:95:0,4:weapon:95:0,5:weapon:60:0,6:weapon:28:0,7:weapon:1:0,8:sensor:0:1,9:sensor:0:1,10:shield:162:0,11:shield:162:0,12:armor:163:0,13:armor:163:0|0:core:369:0,1:engine:86:0,2:engine:88:0,3:engine:85:0,4:weapon:0:1,5:weapon:55:0,6:weapon:25:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:148:0,11:shield:150:0,12:armor:157:0,13:armor:150:0|0:core:423:0,1:engine:0:1,2:engine:0:1,3:engine:0:1,4:weapon:74:0,5:weapon:0:1,6:weapon:60:0,7:weapon:0:1,8:sensor:58:0,9:sensor:51:0,10:shield:108:0,11:shield:56:0,12:armor:91:0,13:armor:163:0|0:core:38:0,1:engine:28:0,2:weapon:0:1,3:sensor:22:0|0:core:70:0,1:engine:28:0,2:weapon:0:1,3:sensor:3:0|0:core:38:0,1:engine:15:0,2:weapon:0:1,3:sensor:0:1|0:core:0:1,1:engine:0:1,2:weapon:32:0,3:sensor:0:1|0:core:0:1,1:engine:28:0,2:weapon:0:1,3:sensor:8:0|0:core:0:1,1:engine:3:0,2:weapon:26:0,3:sensor:0:1|0:core:358:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:59:0,5:weapon:60:0,6:weapon:60:0,7:weapon:0:1,8:sensor:0:1,9:sensor:25:0,10:shield:120:0,11:shield:120:0,12:armor:130:0,13:armor:130:0|0:core:265:0,1:engine:95:0,2:engine:95:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:43:0,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:71:0,11:shield:102:0,12:armor:130:0,13:armor:103:0|0:core:361:0,1:engine:95:0,2:engine:51:0,3:engine:95:0,4:weapon:0:1,5:weapon:60:0,6:weapon:0:1,7:weapon:0:1,8:sensor:0:1,9:sensor:0:1,10:shield:120:0,11:shield:106:0,12:armor:130:0,13:armor:51:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0|0:core:70:0,1:engine:28:0,2:weapon:32:0,3:sensor:33:0",
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

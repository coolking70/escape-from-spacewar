// 一次性 v4 运行时冒烟测试（CommonJS，require 编译产物 .tmp-test）。
// 验证：core-v4 能跑到结束、不抛异常、同 seed 复现、能出现失能/撤退/脱战状态。
const { createInitialState, createSimulator, V4 } = require('../.tmp-test/src/sim/rulesets.js');
const { createPRNG } = require('../.tmp-test/src/sim/prng.js');
const { summarizeStats } = require('../.tmp-test/src/sim/battleStats.js');
const { SIM_VERSION_V5, RULESET_V4 } = require('../.tmp-test/src/sim/battleConfig.js');

function fleet(entries) {
  return entries.map((e) => ({ shipClass: e.shipClass, variant: e.variant, count: e.count }));
}
function makeV4Cfg(seed, a, b, aDoc, bDoc) {
  const team = (fl, doc) => ({ fleet: fl, formation: 'wedge', doctrine: doc });
  return {
    v: SIM_VERSION_V5,
    ruleset: RULESET_V4,
    seed: seed >>> 0,
    budget: { mode: 'unlimited', limit: 999999 },
    teamA: team(a, aDoc),
    teamB: team(b, bDoc)
  };
}

function fingerprint(state) {
  const st = summarizeStats(state);
  const states = state.ships.map((s) => `${s.id}:${s.combatState}:${s.alive ? 1 : 0}:${s.escapedTick ?? -1}`).sort().join('|');
  return `winner=${state.winner}|tick=${state.tick}|A=${state.teamACount}|B=${state.teamBCount}|dmg=${st.totalDamage.A}/${st.totalDamage.B}|states=${states}`;
}

function runToEnd(cfg, maxTicks, debug) {
  const rng = createPRNG(cfg.seed);
  const state = createInitialState(cfg, rng);
  const sim = createSimulator(state, rng);
  let guard = 0;
  let escaped = 0, retreating = 0, disabled = 0, critical = 0, damaged = 0;
  let maxBx = -Infinity;
  let maxRetreatBx = -Infinity;
  let retreatPastLineTicks = 0;
  const retreatEvents = [];
  while (!state.finished && guard <= maxTicks + 1) {
    sim.step();
    guard++;
    for (const s of state.ships) {
      if (s.team === 'B') {
        maxBx = Math.max(maxBx, s.pos.x);
        if (s.combatState === 'retreating' && s.alive) {
          maxRetreatBx = Math.max(maxRetreatBx, s.pos.x);
          if (s.pos.x >= 47) retreatPastLineTicks++;
        }
      }
      if (s.combatState === 'escaped') escaped++;
      else if (s.combatState === 'retreating') {
        retreating++;
        if (debug) retreatEvents.push({ tick: state.tick, id: s.id, x: +s.pos.x.toFixed(1), reason: s.retreatReason });
      } else if (s.combatState === 'disabled') disabled++;
      else if (s.combatState === 'critical') critical++;
      else if (s.combatState === 'damaged') damaged++;
    }
  }
  if (debug) {
    console.log('  [debug] max B x reached:', maxBx.toFixed(1), '(escape line ~47)');
    console.log('  [debug] max B x while retreating+alive:', maxRetreatBx.toFixed(1), 'ticks past line:', retreatPastLineTicks);
    console.log('  [debug] retreat events (first 12):', JSON.stringify(retreatEvents.slice(0, 12)));
    console.log('  [debug] final B ships:', state.ships.filter((s) => s.team === 'B').map((s) => `${s.id}:${s.combatState}@x${s.pos.x.toFixed(0)}:alive${s.alive?1:0}`).join(' '));
  }
  return { state, escaped, retreating, disabled, critical, damaged, guard };
}

const cfg = makeV4Cfg(12345,
  fleet([{ shipClass: 'Cruiser', variant: 'standard', count: 3 }, { shipClass: 'Frigate', variant: 'support', count: 4 }, { shipClass: 'Fighter', variant: 'scout', count: 6 }]),
  fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 2 }, { shipClass: 'Frigate', variant: 'standard', count: 5 }, { shipClass: 'Fighter', variant: 'interceptor', count: 7 }]),
  'balanced', 'aggressive');

const r1 = runToEnd(cfg, 3600);
const r2 = runToEnd(cfg, 3600);

console.log('=== v4 run #1 (balanced vs aggressive) ===');
console.log('finished:', r1.state.finished, 'tick:', r1.state.tick, 'winner:', r1.state.winner, 'victoryReason:', r1.state.victoryReason);
console.log('A/B remaining:', r1.state.teamACount, '/', r1.state.teamBCount);
console.log('escape/retreat/disabled/critical/damaged seen:', r1.escaped, r1.retreating, r1.disabled, r1.critical, r1.damaged);
console.log('=== determinism (run#1 === run#2?) ===');
const f1 = fingerprint(r1.state), f2 = fingerprint(r2.state);
console.log('match:', f1 === f2);
if (f1 !== f2) {
  console.log('fp1:', f1.slice(0, 400));
  console.log('fp2:', f2.slice(0, 400));
}
console.log(r1.state.finished && f1 === f2 ? 'V4 SMOKE OK' : 'V4 SMOKE FAIL');

// 失衡场景：验证脱战(escaped)确实可达
const cfg2 = makeV4Cfg(777,
  fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 4 }, { shipClass: 'Fighter', variant: 'interceptor', count: 8 }]),
  fleet([{ shipClass: 'Frigate', variant: 'support', count: 3 }, { shipClass: 'Cruiser', variant: 'carrier', count: 1 }, { shipClass: 'Fighter', variant: 'scout', count: 2 }]),
  'aggressive', 'screen');
{
  const rng = createPRNG(cfg2.seed);
  const st = createInitialState(cfg2, rng);
  console.log('  [debug] INITIAL B positions:', st.ships.filter((s) => s.team === 'B').map((s) => `${s.id}:x${s.pos.x.toFixed(1)}`).join(' '));
  console.log('  [debug] INITIAL A positions:', st.ships.filter((s) => s.team === 'A').map((s) => `${s.id}:x${s.pos.x.toFixed(1)}`).join(' '));
}
const r3 = runToEnd(cfg2, 3600, true);
console.log('=== v4 lopsided run (4 fortress + 8 fighters vs 3 support + 1 carrier + 2 scout) ===');
console.log('finished:', r3.state.finished, 'tick:', r3.state.tick, 'winner:', r3.state.winner, 'victoryReason:', r3.state.victoryReason);
console.log('A/B remaining:', r3.state.teamACount, '/', r3.state.teamBCount);
console.log('escaped seen (cumulative ticks):', r3.escaped, 'retreating:', r3.retreating);
const escapedShips = r3.state.ships.filter((s) => s.combatState === 'escaped').length;
console.log('ships with combatState=escaped:', escapedShips);
console.log(escapedShips > 0 ? 'V4 ESCAPE OK' : 'V4 ESCAPE NOT OBSERVED');

// 直接验证"撤退→脱战"转移：把一艘 B 方舰放到出生边界外，标记 retreating，步进一次应变为 escaped
const cfg3 = makeV4Cfg(999,
  fleet([{ shipClass: 'Fighter', variant: 'interceptor', count: 1 }]),
  fleet([{ shipClass: 'Frigate', variant: 'support', count: 1 }]),
  'balanced', 'balanced');
{
  const rng = createPRNG(cfg3.seed);
  const st = createInitialState(cfg3, rng);
  const sim = createSimulator(st, rng);
  const ship = st.ships.find((s) => s.team === 'B');
  ship.combatState = 'retreating';
  ship.retreatStartedTick = 0;
  ship.pos.x = 50; // 出生边界(+35)+ESCAPE_MARGIN(12)=47，越过即脱战
  sim.step();
  console.log('=== direct escape transition test ===');
  console.log('ship B combatState after step:', ship.combatState, 'alive:', ship.alive);
  console.log(ship.combatState === 'escaped' && !ship.alive ? 'V4 ESCAPE TRANSITION OK' : 'V4 ESCAPE TRANSITION FAIL');
}

// 弱敌场景扫描：寻找能真实产生脱战(escaped)的配置
let escapeObserved = false;
let escapeCfg = '';
const scenarios = [
  { a: fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 1 }]), b: fleet([{ shipClass: 'Frigate', variant: 'support', count: 5 }]), ad: 'defensive', bd: 'balanced' },
  { a: fleet([{ shipClass: 'Fighter', variant: 'scout', count: 1 }]), b: fleet([{ shipClass: 'Frigate', variant: 'support', count: 2 }]), ad: 'defensive', bd: 'balanced' },
  { a: fleet([{ shipClass: 'Cruiser', variant: 'fortress', count: 1 }]), b: fleet([{ shipClass: 'Cruiser', variant: 'carrier', count: 3 }]), ad: 'defensive', bd: 'balanced' }
];
outer:
for (const sc of scenarios) {
  for (let seed = 1; seed <= 30; seed++) {
    const cfg4 = makeV4Cfg(seed, sc.a, sc.b, sc.ad, sc.bd);
    const rng = createPRNG(cfg4.seed);
    const st = createInitialState(cfg4, rng);
    const sim = createSimulator(st, rng);
    let g = 0;
    while (!st.finished && g <= 3601) { sim.step(); g++; }
    const esc = st.ships.filter((s) => s.team === 'B' && s.combatState === 'escaped').length;
    if (esc > 0) {
      escapeObserved = true;
      escapeCfg = `A=${JSON.stringify(sc.a)} B=${JSON.stringify(sc.b)} seed=${seed} escaped=${esc} reason=${st.ships.find((s) => s.team === 'B' && s.combatState === 'escaped').retreatReason}`;
      break outer;
    }
  }
}
console.log('realistic escape observed:', escapeObserved ? 'YES -> ' + escapeCfg : 'NO');

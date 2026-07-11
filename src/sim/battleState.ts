// 由 ReplayConfig 构建初始战斗状态。
// 出生点位置由 formation 决定，可带少量 PRNG 抖动（纯确定性，来自同一随机流）。

import {
  BattleState,
  ReplayConfig,
  Ship,
  ShipClass,
  ShipVariant,
  Team,
  Vec3,
  FormationType,
  BattleStats,
  FleetEntry
} from './battleTypes';
import { PRNG } from './prng';
import { createShip } from './shipFactory';
import { getShipDef } from './shipVariants';
import { MAX_TICKS, SPAWN } from './battleConfig';

/** 舰种尺寸权重：越小越靠前/越靠外 */
function sizeRank(t: ShipClass): number {
  return t === 'Fighter' ? 0 : t === 'Frigate' ? 1 : 2;
}

/** 深拷贝编队项（避免后续逻辑修改 replay 原对象） */
function cloneFleet(fleet: FleetEntry[]): FleetEntry[] {
  return fleet.map((e) => ({ shipClass: e.shipClass, variant: e.variant, count: e.count }));
}

/**
 * 根据阵型计算每艘飞船的初始位置（确定性）。
 * 返回数组与传入 types 顺序一一对应。
 */
function computeSpawn(
  team: Team,
  types: ShipClass[],
  formation: FormationType,
  rng: PRNG
): Vec3[] {
  const n = types.length;
  const side = team === 'A' ? -1 : 1;
  const frontDir = team === 'A' ? 1 : -1; // A 朝 +x（敌方在 +x），B 朝 -x
  const baseX = side * SPAWN.x;
  const out: Vec3[] = new Array(n);

  const jx = () => rng.range(-SPAWN.jitterX, SPAWN.jitterX);
  const jz = () => rng.range(-SPAWN.jitterZ, SPAWN.jitterZ);

  if (formation === 'line') {
    for (let i = 0; i < n; i++) {
      out[i] = {
        x: baseX + jx(),
        y: ((i % 3) - 1) * SPAWN.yStep,
        z: (i - (n - 1) / 2) * SPAWN.spacing + jz()
      };
    }
  } else if (formation === 'wedge') {
    // 按尺寸升序排列：Fighter 在前（靠近敌方），Cruiser 在后
    const order = types.map((t, i) => ({ t, i })).sort((a, b) => sizeRank(a.t) - sizeRank(b.t));
    order.forEach((o, k) => {
      const x = baseX + frontDir * ((n - 1 - k) * SPAWN.wedgeStep);
      out[o.i] = {
        x: x + jx(),
        y: ((k % 3) - 1) * SPAWN.yStep,
        z: (k - (n - 1) / 2) * SPAWN.spacing + jz()
      };
    });
  } else if (formation === 'wall') {
    // 重型居中，小型向两翼展开
    const order = types.map((t, i) => ({ t, i })).sort((a, b) => sizeRank(b.t) - sizeRank(a.t));
    order.forEach((o, j) => {
      let z = 0;
      if (j > 0) {
        const sgn = j % 2 === 1 ? 1 : -1;
        const mag = Math.ceil(j / 2) * SPAWN.spacing;
        z = sgn * mag;
      }
      out[o.i] = {
        x: baseX + jx(),
        y: ((j % 3) - 1) * SPAWN.yStep,
        z: z + jz()
      };
    });
  } else if (formation === 'swarm') {
    // 分散更广（适合 Fighter 多的情况）
    for (let i = 0; i < n; i++) {
      out[i] = {
        x: baseX + rng.range(-SPAWN.jitterX * 2.5, SPAWN.jitterX * 2.5),
        y: ((i % 3) - 1) * SPAWN.yStep,
        z: (i - (n - 1) / 2) * SPAWN.spacing * SPAWN.swarmScale + jz() * 1.5
      };
    }
  } else {
    // random：基于 seed 的确定性随机散布
    for (let i = 0; i < n; i++) {
      out[i] = {
        x: baseX + rng.range(-5, 5),
        y: rng.range(-3, 3),
        z: rng.range(-((n - 1) / 2) * SPAWN.spacing * 1.3, ((n - 1) / 2) * SPAWN.spacing * 1.3)
      };
    }
  }

  return out;
}

function initStats(replay: ReplayConfig): BattleStats {
  return {
    ships: {},
    team: {
      A: { totalDamage: 0, kills: 0, losses: {} },
      B: { totalDamage: 0, kills: 0, losses: {} }
    },
    startCounts: {
      A: cloneFleet(replay.teamA.fleet),
      B: cloneFleet(replay.teamB.fleet)
    }
  };
}

function buildTeam(
  team: Team,
  config: ReplayConfig['teamA'],
  rng: PRNG,
  ships: Ship[],
  nextId: { v: number },
  stats: BattleStats
): void {
  // 将编队项展开为有序的 (舰体, 改型) 列表
  const units: { cls: ShipClass; variant: ShipVariant }[] = [];
  for (const e of config.fleet) {
    const n = Math.max(0, Math.floor(e.count || 0));
    for (let i = 0; i < n; i++) {
      units.push({ cls: e.shipClass, variant: e.variant });
    }
  }

  const types: ShipClass[] = units.map((u) => u.cls);
  const positions = computeSpawn(team, types, config.formation, rng);
  const heading = team === 'A' ? 0 : Math.PI;

  units.forEach((u, i) => {
    const { def, mods } = getShipDef(u.cls, u.variant);
    const pos = positions[i];
    const ship = createShip(def, u.variant, mods, nextId.v++, team, pos, heading);
    ships.push(ship);
    stats.ships[ship.id] = {
      damageDealt: 0,
      kills: 0,
      shipClass: u.cls,
      variant: u.variant
    };
  });
}

export function createInitialState(replay: ReplayConfig, rng: PRNG): BattleState {
  const ships: Ship[] = [];
  const nextId = { v: 0 };
  const stats = initStats(replay);
  buildTeam('A', replay.teamA, rng, ships, nextId, stats);
  buildTeam('B', replay.teamB, rng, ships, nextId, stats);

  let a = 0;
  let b = 0;
  for (const s of ships) {
    if (s.team === 'A') a++;
    else b++;
  }

  return {
    version: replay.v,
    seed: replay.seed >>> 0,
    tick: 0,
    maxTicks: MAX_TICKS,
    ships,
    shots: [],
    explosions: [],
    finished: false,
    winner: null,
    teamACount: a,
    teamBCount: b,
    teamFocusTarget: { A: null, B: null },
    teamDoctrine: { A: replay.teamA.doctrine, B: replay.teamB.doctrine },
    stats
  };
}

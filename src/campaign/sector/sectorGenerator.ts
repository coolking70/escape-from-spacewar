import { createPRNG } from '../../sim/prng';
import { SectorNode, SectorNodeType, SectorRegion, SectorState } from './sectorTypes';

export function hash32(...values: Array<number | string>): number {
  let h = 2166136261;
  for (const value of values) {
    for (const ch of String(value)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

function addEdge(nodes: SectorNode[], a: SectorNode, b: SectorNode): void {
  if (!a.neighbors.includes(b.id)) a.neighbors.push(b.id);
  if (!b.neighbors.includes(a.id)) b.neighbors.push(a.id);
}

function nearest(source: SectorNode, candidates: SectorNode[]): SectorNode[] {
  return [...candidates].sort((a, b) => Math.abs(a.y - source.y) - Math.abs(b.y - source.y));
}

function regionFor(seed: number, depth: number, layers: number): SectorRegion {
  if (depth <= 1) return 'safeRoute';
  if (depth >= layers - 2) return 'gateApproach';
  const regions: SectorRegion[] = ['safeRoute', 'salvageBelt', 'militaryZone', 'nebula'];
  return regions[hash32(seed, depth, 'region') % regions.length];
}

function typeFor(region: SectorRegion, roll: number): SectorNodeType {
  const tables: Record<SectorRegion, SectorNodeType[]> = {
    safeRoute: ['empty', 'resource', 'resource', 'signal', 'empty', 'hazard'],
    salvageBelt: ['resource', 'resource', 'signal', 'hazard', 'battle', 'empty'],
    militaryZone: ['battle', 'battle', 'hazard', 'signal', 'empty', 'battle'],
    nebula: ['signal', 'empty', 'hazard', 'signal', 'resource', 'empty'],
    gateApproach: ['battle', 'signal', 'empty', 'hazard', 'battle', 'resource']
  };
  const table = tables[region];
  return table[roll % table.length];
}

export function ensureRecoveryOpportunity(sector: SectorState): SectorState {
  if (sector.nodes.some((node) => node.feature === 'rescue' && !node.signalResolved)) return sector;
  const next = {
    ...sector,
    nodes: sector.nodes.map((node) => ({ ...node, neighbors: [...node.neighbors] }))
  };
  const candidate = next.nodes
    .filter((node) => node.depth > 0 && node.depth < 4 && node.type !== 'start' && node.type !== 'gate')
    .sort((a, b) => a.depth - b.depth || a.y - b.y)[0];
  if (candidate) {
    candidate.type = 'signal';
    candidate.feature = 'rescue';
  }
  return next;
}

export function generateSector(campaignSeed: number, sectorIndex: number): SectorState {
  const seed = hash32(campaignSeed, sectorIndex, 'sector-v071');
  const rng = createPRNG(seed);
  const layerCount = 7;
  const counts = [1, 3 + rng.int(2), 4 + rng.int(2), 4 + rng.int(2), 4 + rng.int(2), 3 + rng.int(2), 1];
  const nodes: SectorNode[] = [];
  const layers: SectorNode[][] = [];
  let serial = 0;

  for (let depth = 0; depth < layerCount; depth++) {
    const count = counts[depth];
    const region = regionFor(seed, depth, layerCount);
    const layer: SectorNode[] = [];
    for (let index = 0; index < count; index++) {
      const x = 7 + (depth / (layerCount - 1)) * 86 + (depth > 0 && depth < layerCount - 1 ? rng.int(5) - 2 : 0);
      const baseY = ((index + 1) / (count + 1)) * 86 + 7;
      const node: SectorNode = {
        id: `s${sectorIndex}-n${serial++}`,
        type: depth === 0 ? 'start' : depth === layerCount - 1 ? 'gate' : typeFor(region, rng.int(1000)),
        x,
        y: Math.max(7, Math.min(93, baseY + rng.int(9) - 4)),
        depth,
        region,
        neighbors: [],
        visibility: depth === 0 ? 'visited' : depth === 1 ? 'detected' : 'hidden',
        processed: depth === 0,
        gathered: false
      };
      layer.push(node);
      nodes.push(node);
    }
    layers.push(layer);
  }

  for (let depth = 0; depth < layers.length - 1; depth++) {
    const current = layers[depth];
    const next = layers[depth + 1];
    for (const node of current) {
      const ordered = nearest(node, next);
      addEdge(nodes, node, ordered[0]);
      if (ordered[1] && (depth === 0 || depth === layers.length - 2 || hash32(seed, node.id, 'fork') % 3 !== 0)) {
        addEdge(nodes, node, ordered[1]);
      }
    }
    for (const node of next) {
      if (!node.neighbors.some((id) => current.some((candidate) => candidate.id === id))) {
        addEdge(nodes, node, nearest(node, current)[0]);
      }
    }
  }

  for (let depth = 1; depth < layers.length - 1; depth++) {
    const layer = [...layers[depth]].sort((a, b) => a.y - b.y);
    for (let index = 0; index < layer.length - 1; index++) {
      if (hash32(seed, depth, index, 'cluster') % 3 === 0) addEdge(nodes, layer[index], layer[index + 1]);
    }
  }

  const shortcutDepth = 1 + (hash32(seed, 'shortcut-depth') % 3);
  const from = layers[shortcutDepth][hash32(seed, 'shortcut-from') % layers[shortcutDepth].length];
  const toLayer = layers[shortcutDepth + 2];
  const to = nearest(from, toLayer)[0];
  addEdge(nodes, from, to);

  if (sectorIndex === 1) {
    const early = layers[1];
    if (early[0]) early[0].type = 'resource';
    if (early[1]) {
      early[1].type = 'signal';
      early[1].feature = 'rescue';
    }
    for (const node of [...layers[1], ...layers[2]]) {
      if (node.type === 'battle') node.type = hash32(seed, node.id, 'safe-start') % 2 ? 'resource' : 'signal';
    }
  }

  const state: SectorState = {
    seed,
    nodes,
    currentNodeId: layers[0][0].id,
    gateKnown: false,
    threat: { value: 0, level: 0 }
  };
  return sectorIndex === 1 ? ensureRecoveryOpportunity(state) : state;
}

export function isReachable(sector: SectorState, fromId: string, targetId: string): boolean {
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === targetId) return true;
    const node = sector.nodes.find((candidate) => candidate.id === id);
    for (const next of node?.neighbors ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

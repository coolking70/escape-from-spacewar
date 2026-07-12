import { createPRNG } from '../../sim/prng';
import { SectorNode, SectorNodeType, SectorState } from './sectorTypes';

export function hash32(...values: Array<number | string>): number {
  let h = 2166136261;
  for (const value of values) for (const ch of String(value)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function addEdge(nodes: SectorNode[], a: number, b: number): void {
  const aid = nodes[a].id, bid = nodes[b].id;
  if (!nodes[a].neighbors.includes(bid)) nodes[a].neighbors.push(bid);
  if (!nodes[b].neighbors.includes(aid)) nodes[b].neighbors.push(aid);
}

export function generateSector(campaignSeed: number, sectorIndex: number): SectorState {
  const seed = hash32(campaignSeed, sectorIndex, 'sector');
  const rng = createPRNG(seed);
  const count = 20 + rng.int(11);
  const nodes: SectorNode[] = Array.from({ length: count }, (_, i) => ({
    id: `s${sectorIndex}-n${i}`, type: 'empty' as SectorNodeType,
    x: 8 + (i % 7) * 14 + rng.int(7), y: 12 + Math.floor(i / 7) * 22 + rng.int(9),
    neighbors: [], visibility: i === 0 ? 'visited' : i === 1 ? 'detected' : 'hidden', processed: i === 0, gathered: false
  }));
  nodes[0].type = 'start'; nodes[count - 1].type = 'gate';
  for (let i = 1; i < count; i++) addEdge(nodes, i - 1, i); // guaranteed main path
  for (let i = 2; i < count - 2; i += 3) addEdge(nodes, i, Math.min(count - 1, i + 2 + rng.int(2))); // loops
  const kinds: SectorNodeType[] = ['empty', 'resource', 'resource', 'battle', 'hazard', 'signal'];
  for (let i = 1; i < count - 1; i++) nodes[i].type = kinds[rng.int(kinds.length)];
  return { seed, nodes, currentNodeId: nodes[0].id, gateKnown: false, threat: { value: 0, level: 0 } };
}

export function isReachable(sector: SectorState, fromId: string, targetId: string): boolean {
  const seen = new Set<string>([fromId]); const queue = [fromId];
  while (queue.length) { const id = queue.shift()!; if (id === targetId) return true; const node = sector.nodes.find((n) => n.id === id); for (const next of node?.neighbors ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); } }
  return false;
}

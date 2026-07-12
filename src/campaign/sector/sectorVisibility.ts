import { SectorState } from './sectorTypes';
export function revealNeighbors(sector: SectorState, nodeId: string): SectorState {
  const nodes = sector.nodes.map((n) => ({ ...n, neighbors: [...n.neighbors] })); const current = nodes.find((n) => n.id === nodeId);
  for (const id of current?.neighbors ?? []) { const node = nodes.find((n) => n.id === id)!; if (node.visibility === 'hidden') node.visibility = 'detected'; }
  return { ...sector, nodes };
}
export function scanNearby(sector: SectorState): SectorState {
  const nodes = sector.nodes.map((n) => ({ ...n, neighbors: [...n.neighbors] })); const current = nodes.find((n) => n.id === sector.currentNodeId)!;
  for (const id of current.neighbors) { const node = nodes.find((n) => n.id === id)!; if (node.visibility === 'detected') node.visibility = 'scanned'; }
  return { ...sector, nodes };
}

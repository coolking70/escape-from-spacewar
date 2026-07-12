import { SectorState } from './sectorTypes';

export interface VisibleSectorGraph {
  nodeIds: string[];
  edges: Array<[string, string]>;
}

export function visibleSectorGraph(sector: SectorState): VisibleSectorGraph {
  const visible = new Set(
    sector.nodes.filter((node) => node.visibility !== 'hidden').map((node) => node.id)
  );
  return {
    nodeIds: [...visible],
    edges: sector.nodes.flatMap((node) =>
      visible.has(node.id)
        ? node.neighbors
            .filter((id) => visible.has(id) && node.id < id)
            .map((id) => [node.id, id] as [string, string])
        : []
    )
  };
}

export function revealNeighbors(sector: SectorState, nodeId: string): SectorState {
  // 保留当前节点对象的引用：调用方在 reveal 之后仍会继续写入 visited/processed/hazardResolved。
  // 其余节点保持不可变式克隆，避免修改传入 sector 的相邻节点状态。
  const nodes = sector.nodes.map((node) =>
    node.id === nodeId ? node : { ...node, neighbors: [...node.neighbors] }
  );
  const current = nodes.find((node) => node.id === nodeId);
  for (const id of current?.neighbors ?? []) {
    const node = nodes.find((candidate) => candidate.id === id)!;
    if (node.visibility === 'hidden') node.visibility = 'detected';
  }
  return { ...sector, nodes };
}

export function scanNearby(sector: SectorState): SectorState {
  const nodes = sector.nodes.map((node) => ({ ...node, neighbors: [...node.neighbors] }));
  const current = nodes.find((node) => node.id === sector.currentNodeId)!;
  for (const id of current.neighbors) {
    const node = nodes.find((candidate) => candidate.id === id)!;
    if (node.visibility === 'detected') node.visibility = 'scanned';
  }
  return { ...sector, nodes };
}

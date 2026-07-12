export type SectorNodeType = 'start' | 'empty' | 'resource' | 'battle' | 'hazard' | 'signal' | 'gate';
export type NodeVisibility = 'hidden' | 'detected' | 'scanned' | 'visited';

export interface SectorNode {
  id: string;
  type: SectorNodeType;
  x: number;
  y: number;
  neighbors: string[];
  visibility: NodeVisibility;
  processed: boolean;
  gathered: boolean;
  signalResolved?: boolean;
  hazardResolved?: boolean;
}

export interface SectorThreat { value: number; level: 0 | 1 | 2 | 3 | 4 | 5; }
export interface SectorState {
  seed: number;
  nodes: SectorNode[];
  currentNodeId: string;
  gateKnown: boolean;
  threat: SectorThreat;
}

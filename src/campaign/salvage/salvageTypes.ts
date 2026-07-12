import { CargoStack } from '../cargo/cargoTypes';

export type SalvageOptionId = 'quick' | 'thorough' | 'leave';

export interface SalvageOption {
  id: SalvageOptionId;
  label: string;
  description: string;
  turns: number;
  threat: number;
  items: CargoStack[];
}

export interface SalvageSummary {
  enemyDestroyed: number;
  enemyDisabled: number;
  ownDestroyed: number;
}

export interface PendingSalvage {
  nodeId: string;
  battleIndex: number;
  summary: SalvageSummary;
  options: SalvageOption[];
}

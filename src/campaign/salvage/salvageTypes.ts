import { ShipClass, ShipVariant } from '../../sim/battleTypes';
import { CargoStack } from '../cargo/cargoTypes';

export type SalvageOptionId = 'quick' | 'thorough' | 'recover' | 'leave';

export interface RecoverableShip {
  shipClass: ShipClass;
  variant: ShipVariant;
  componentRatio: number;
}

export interface SalvageOption {
  id: SalvageOptionId;
  label: string;
  description: string;
  turns: number;
  threat: number;
  items: CargoStack[];
  recoveredShip?: RecoverableShip;
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

export type CargoItemType = 'supplyCrate' | 'fuelCell' | 'repairParts' | 'relic';

export interface CargoStack {
  type: CargoItemType;
  quantity: number;
}

export interface CampaignCargo {
  capacity: number;
  items: CargoStack[];
}

export interface CargoTransferResult {
  cargo: CampaignCargo;
  accepted: CargoStack[];
  rejected: CargoStack[];
}

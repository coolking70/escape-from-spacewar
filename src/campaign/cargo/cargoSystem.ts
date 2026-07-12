import { CampaignCargo, CargoItemType, CargoStack, CargoTransferResult } from './cargoTypes';

export const CARGO_ITEM_WEIGHT: Record<CargoItemType, number> = {
  supplyCrate: 1,
  fuelCell: 1,
  repairParts: 1,
  relic: 3
};

export const CARGO_ITEM_LABEL: Record<CargoItemType, string> = {
  supplyCrate: '补给箱',
  fuelCell: '燃料电池',
  repairParts: '维修零件',
  relic: '高价值遗物'
};

export function createEmptyCargo(capacity = 18): CampaignCargo {
  return { capacity, items: [] };
}

export function cargoQuantity(cargo: CampaignCargo, type: CargoItemType): number {
  return cargo.items.find((stack) => stack.type === type)?.quantity ?? 0;
}

export function cargoUsed(cargo: CampaignCargo): number {
  return cargo.items.reduce(
    (total, stack) => total + stack.quantity * CARGO_ITEM_WEIGHT[stack.type],
    0
  );
}

function normalize(items: CargoStack[]): CargoStack[] {
  const totals = new Map<CargoItemType, number>();
  for (const stack of items) {
    if (!Number.isInteger(stack.quantity) || stack.quantity <= 0) continue;
    totals.set(stack.type, (totals.get(stack.type) ?? 0) + stack.quantity);
  }
  return Array.from(totals, ([type, quantity]) => ({ type, quantity }));
}

export function addCargo(cargo: CampaignCargo, incoming: CargoStack[]): CargoTransferResult {
  const next: CampaignCargo = {
    capacity: cargo.capacity,
    items: cargo.items.map((stack) => ({ ...stack }))
  };
  const accepted: CargoStack[] = [];
  const rejected: CargoStack[] = [];
  let free = Math.max(0, next.capacity - cargoUsed(next));

  for (const stack of normalize(incoming)) {
    const weight = CARGO_ITEM_WEIGHT[stack.type];
    const acceptedQuantity = Math.min(stack.quantity, Math.floor(free / weight));
    if (acceptedQuantity > 0) {
      const existing = next.items.find((item) => item.type === stack.type);
      if (existing) existing.quantity += acceptedQuantity;
      else next.items.push({ type: stack.type, quantity: acceptedQuantity });
      accepted.push({ type: stack.type, quantity: acceptedQuantity });
      free -= acceptedQuantity * weight;
    }
    if (acceptedQuantity < stack.quantity) {
      rejected.push({ type: stack.type, quantity: stack.quantity - acceptedQuantity });
    }
  }

  next.items = normalize(next.items);
  return { cargo: next, accepted, rejected };
}

export function removeCargo(
  cargo: CampaignCargo,
  type: CargoItemType,
  quantity: number
): CampaignCargo | null {
  if (!Number.isInteger(quantity) || quantity <= 0 || cargoQuantity(cargo, type) < quantity) {
    return null;
  }
  const next: CampaignCargo = {
    capacity: cargo.capacity,
    items: cargo.items.map((stack) => ({ ...stack }))
  };
  const stack = next.items.find((item) => item.type === type)!;
  stack.quantity -= quantity;
  next.items = next.items.filter((item) => item.quantity > 0);
  return next;
}

export function cargoSummary(stacks: CargoStack[]): string {
  if (!stacks.length) return '无';
  return stacks.map((stack) => `${CARGO_ITEM_LABEL[stack.type]}×${stack.quantity}`).join('、');
}

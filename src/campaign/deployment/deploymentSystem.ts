import { PersistentFleet } from '../fleet/persistentFleet';

export interface DeploymentSelection {
  selectedShipIds: string[];
}

export function defaultDeployment(fleet: PersistentFleet): DeploymentSelection {
  return {
    selectedShipIds: fleet.ships
      .filter((ship) => !ship.disabled)
      .map((ship) => ship.campaignShipId)
      .sort()
  };
}

export function normalizeDeployment(
  fleet: PersistentFleet,
  selectedShipIds: string[] | undefined
): DeploymentSelection {
  const eligible = new Set(
    fleet.ships.filter((ship) => !ship.disabled).map((ship) => ship.campaignShipId)
  );
  const selected = [...new Set(selectedShipIds ?? [])]
    .filter((id) => eligible.has(id))
    .sort();
  return selected.length ? { selectedShipIds: selected } : defaultDeployment(fleet);
}

function applySelection(fleet: PersistentFleet, selection: DeploymentSelection): void {
  const selected = new Set(selection.selectedShipIds);
  for (const ship of fleet.ships) {
    ship.deployed = !ship.disabled && selected.has(ship.campaignShipId);
  }
}

export function toggleDeploymentShip(
  fleet: PersistentFleet,
  selection: DeploymentSelection,
  campaignShipId: string
): DeploymentSelection {
  const ship = fleet.ships.find((item) => item.campaignShipId === campaignShipId);
  if (!ship || ship.disabled) return normalizeDeployment(fleet, selection.selectedShipIds);

  const selected = new Set(normalizeDeployment(fleet, selection.selectedShipIds).selectedShipIds);
  if (selected.has(campaignShipId)) {
    if (selected.size > 1) selected.delete(campaignShipId);
  } else {
    selected.add(campaignShipId);
  }
  const next = { selectedShipIds: [...selected].sort() };
  applySelection(fleet, next);
  return next;
}

export function deploymentFleet(
  fleet: PersistentFleet,
  selection: DeploymentSelection | undefined
): PersistentFleet {
  const normalized = normalizeDeployment(fleet, selection?.selectedShipIds);
  const selected = new Set(normalized.selectedShipIds);
  return { ...fleet, ships: fleet.ships.filter((ship) => selected.has(ship.campaignShipId)) };
}

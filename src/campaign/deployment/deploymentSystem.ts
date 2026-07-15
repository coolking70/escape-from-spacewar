import { isShipDeployable, isShipEligibleForDeployment, PersistentFleet } from '../fleet/persistentFleet';

export interface DeploymentSelection {
  selectedShipIds: string[];
}

export function defaultDeployment(fleet: PersistentFleet): DeploymentSelection {
  return {
    selectedShipIds: fleet.ships
      .filter(isShipDeployable)
      .map((ship) => ship.campaignShipId)
      .sort()
  };
}

export function normalizeDeployment(
  fleet: PersistentFleet,
  selectedShipIds: string[] | undefined
): DeploymentSelection {
  // UI 编辑辅助：过滤已经失效的选择，并在没有有效选择时恢复当前默认部署。
  // 战斗入口不得使用此函数吞掉非法显式输入；deploymentFleet 会执行严格校验。
  const eligible = new Set(
    fleet.ships.filter(isShipEligibleForDeployment).map((ship) => ship.campaignShipId)
  );
  const selected = [...new Set(selectedShipIds ?? [])]
    .filter((id) => eligible.has(id))
    .sort();
  return selected.length ? { selectedShipIds: selected } : defaultDeployment(fleet);
}

function applySelection(fleet: PersistentFleet, selection: DeploymentSelection): void {
  const selected = new Set(selection.selectedShipIds);
  for (const ship of fleet.ships) ship.deployed = isShipEligibleForDeployment(ship) && selected.has(ship.campaignShipId);
}

export function toggleDeploymentShip(
  fleet: PersistentFleet,
  selection: DeploymentSelection,
  campaignShipId: string
): DeploymentSelection {
  const ship = fleet.ships.find((item) => item.campaignShipId === campaignShipId);
  if (!ship || !isShipEligibleForDeployment(ship)) return normalizeDeployment(fleet, selection.selectedShipIds);

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
  const selectedShipIds = selection?.selectedShipIds ?? defaultDeployment(fleet).selectedShipIds;
  if (!selectedShipIds.length) throw new Error('部署不能为空（至少须选择一艘可参战舰）。');
  if (new Set(selectedShipIds).size !== selectedShipIds.length) throw new Error('部署包含重复的舰船 ID。');

  const ships = new Map(fleet.ships.map((ship) => [ship.campaignShipId, ship]));
  for (const campaignShipId of selectedShipIds) {
    const ship = ships.get(campaignShipId);
    if (!ship) throw new Error(`部署引用了不存在的舰船 ID：${campaignShipId}。`);
    if (!isShipDeployable(ship)) throw new Error(`舰船 ${campaignShipId} 当前不可参战（失能、已逃脱或未部署）。`);
  }

  const selected = new Set(selectedShipIds);
  return { ...fleet, ships: fleet.ships.filter((ship) => selected.has(ship.campaignShipId)) };
}

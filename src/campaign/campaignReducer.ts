import { BattleState } from '../sim/battleTypes';
import { getShipDef } from '../sim/shipVariants';
import { addCargo, cargoSummary, removeCargo } from './cargo/cargoSystem';
import { MAX_SECTOR_INDEX } from './campaignConfig';
import { CampaignAction, CampaignState } from './campaignTypes';
import { CampaignBattleBinding } from './fleet/battleAdapter';
import { importBattleResult } from './fleet/battleResultImporter';
import { activeShips, disabledShips, movementFuelCost, PersistentShip } from './fleet/persistentFleet';
import { canFieldRepair, fieldRepairShip } from './repair/repairSystem';
import { generatePendingSalvage } from './salvage/salvageGenerator';
import { hazardOutcome, resourceReward, signalOutcome } from './sector/sectorActions';
import { generateSector } from './sector/sectorGenerator';
import { revealNeighbors, scanNearby } from './sector/sectorVisibility';
import { addThreat } from './sector/threatSystem';

export interface CampaignActionAvailability {
  move: boolean; scan: boolean; gather: boolean; resolveSignal: boolean;
  resolveSalvage: boolean; enterGate: boolean; wait: boolean;
}

function clone(s: CampaignState): CampaignState {
  return {
    ...s,
    resources: { ...s.resources },
    cargo: { ...s.cargo, items: s.cargo.items.map((x) => ({ ...x })) },
    fleet: { ...s.fleet, ships: s.fleet.ships.map((x) => ({ ...x, componentHp: x.componentHp ? [...x.componentHp] : undefined })) },
    sector: { ...s.sector, threat: { ...s.sector.threat }, nodes: s.sector.nodes.map((x) => ({ ...x, neighbors: [...x.neighbors] })) },
    history: [...s.history],
    pendingSalvage: s.pendingSalvage ? {
      ...s.pendingSalvage,
      summary: { ...s.pendingSalvage.summary },
      options: s.pendingSalvage.options.map((x) => ({ ...x, items: x.items.map((y) => ({ ...y })) }))
    } : undefined
  };
}

function fail(s: CampaignState, text: string): CampaignState {
  return { ...s, history: [...s.history, { turn: s.turn, text }] };
}

const noActions = (): CampaignActionAvailability => ({
  move: false, scan: false, gather: false, resolveSignal: false,
  resolveSalvage: false, enterGate: false, wait: false
});

export function getAvailableCampaignActions(s: CampaignState): CampaignActionAvailability {
  const none = noActions();
  if (s.status !== 'active' || s.pendingBattle) return none;
  if (s.pendingSalvage) return { ...none, resolveSalvage: true };
  const here = s.sector.nodes.find((n) => n.id === s.sector.currentNodeId);
  if (!here) return none;
  const neighbors = here.neighbors.map((id) => s.sector.nodes.find((n) => n.id === id)).filter(Boolean);
  return {
    move: s.resources.fuel >= movementFuelCost(s.fleet) && neighbors.length > 0,
    scan: neighbors.some((n) => n?.visibility === 'detected'),
    gather: here.type === 'resource' && !here.gathered,
    resolveSignal: here.type === 'signal' && !here.signalResolved,
    resolveSalvage: false,
    enterGate: here.type === 'gate',
    wait: s.resources.supplies > 0
  };
}

export function evaluateCampaignStatus(s: CampaignState): CampaignState {
  const n = clone(s);
  if (n.status !== 'active') return n;
  if (!n.commander.alive || activeShips(n.fleet).length === 0) n.status = 'defeat';
  else if (n.resources.supplies === 0 && n.resources.fuel === 0 && !n.pendingBattle && !n.pendingSalvage && !Object.values(getAvailableCampaignActions(n)).some(Boolean)) n.status = 'defeat';
  return n;
}

function finishTurn(s: CampaignState, text: string, threat = 1, turns = 1): CampaignState {
  const n = clone(s);
  for (let i = 0; i < turns; i++) {
    n.turn++;
    n.resources.supplies = Math.max(0, n.resources.supplies - (n.sector.threat.level >= 5 ? 3 : 1));
  }
  n.sector.threat = addThreat(n.sector.threat, threat);
  n.history.push({ turn: n.turn, text });
  return n;
}

function componentHp(ship: PersistentShip): number[] {
  if (!ship.componentHp) ship.componentHp = getShipDef(ship.shipClass, ship.variant).def.components.map((c) => c.maxHp);
  return ship.componentHp;
}

function resolveSalvage(s: CampaignState, action: Extract<CampaignAction, { type: 'resolveSalvage' }>): CampaignState {
  if (!s.pendingSalvage) return fail(s, '当前没有待处理的战后打捞。');
  const option = s.pendingSalvage.options.find((x) => x.id === action.optionId);
  if (!option) return fail(s, '未知的打捞方案。');
  const n = finishTurn(s, `执行战后方案：${option.label}。`, option.threat, option.turns);
  const transfer = addCargo(n.cargo, option.items);
  n.cargo = transfer.cargo;
  n.history.push({ turn: n.turn, nodeId: n.pendingSalvage!.nodeId, text: `获得 ${cargoSummary(transfer.accepted)}；因货舱不足放弃 ${cargoSummary(transfer.rejected)}。` });
  n.pendingSalvage = undefined;
  return evaluateCampaignStatus(n);
}

function useCargo(s: CampaignState, action: Extract<CampaignAction, { type: 'useCargo' }>): CampaignState {
  if (action.itemType !== 'supplyCrate' && action.itemType !== 'fuelCell') return fail(s, '该物品不能直接使用。');
  const cargo = removeCargo(s.cargo, action.itemType, 1);
  if (!cargo) return fail(s, '货舱中没有对应物资。');
  const n = clone(s); n.cargo = cargo;
  if (action.itemType === 'supplyCrate') n.resources.supplies += 3; else n.resources.fuel += 2;
  n.history.push({ turn: n.turn, text: `使用了一份${action.itemType === 'supplyCrate' ? '补给箱' : '燃料电池'}。` });
  return n;
}

function repair(s: CampaignState, id: string): CampaignState {
  const parts = removeCargo(s.cargo, 'repairParts', 1);
  const target = s.fleet.ships.find((x) => x.campaignShipId === id);
  if (!parts) return fail(s, '缺少维修零件。');
  if (!target || !canFieldRepair(target)) return fail(s, '该舰船当前无法进行战地维修。');
  const result = fieldRepairShip(target)!;
  const n = finishTurn(s, `对 ${id} 进行战地维修。`, 2); n.cargo = parts;
  n.fleet.ships = n.fleet.ships.map((x) => x.campaignShipId === id ? result.ship : x);
  n.history.push({ turn: n.turn, text: `恢复组件 #${result.componentIndex} 的 ${result.restoredHp} 点 HP。` });
  return evaluateCampaignStatus(n);
}

function disabledAction(s: CampaignState, action: Extract<CampaignAction, { type: 'towShip' | 'dismantleShip' | 'abandonShip' }>): CampaignState {
  const target = s.fleet.ships.find((x) => x.campaignShipId === action.campaignShipId);
  if (!target?.disabled) return fail(s, '只能处理失能舰船。');
  const n = clone(s);
  if (action.type === 'towShip') {
    const ship = n.fleet.ships.find((x) => x.campaignShipId === target.campaignShipId)!;
    ship.towed = !ship.towed;
    n.history.push({ turn: n.turn, text: `${ship.towed ? '开始' : '停止'}拖曳 ${ship.campaignShipId}。` });
  } else {
    n.fleet.ships = n.fleet.ships.filter((x) => x.campaignShipId !== target.campaignShipId);
    if (action.type === 'dismantleShip') {
      const transfer = addCargo(n.cargo, [{ type: 'repairParts', quantity: 2 }]); n.cargo = transfer.cargo;
      n.history.push({ turn: n.turn, text: `拆解 ${target.campaignShipId}，回收 ${cargoSummary(transfer.accepted)}。` });
    } else n.history.push({ turn: n.turn, text: `永久放弃 ${target.campaignShipId}。` });
  }
  return evaluateCampaignStatus(n);
}

export function applyCampaignAction(s: CampaignState, action: CampaignAction): CampaignState {
  if (s.status !== 'active' || s.pendingBattle) return fail(s, '当前无法执行该行动。');
  if (s.pendingSalvage && action.type !== 'resolveSalvage') return fail(s, '必须先决定如何处理战场残骸。');
  if (action.type === 'resolveSalvage') return resolveSalvage(s, action);
  if (action.type === 'useCargo') return useCargo(s, action);
  if (action.type === 'fieldRepair') return repair(s, action.campaignShipId);
  if (action.type === 'towShip' || action.type === 'dismantleShip' || action.type === 'abandonShip') return disabledAction(s, action);

  const here = s.sector.nodes.find((x) => x.id === s.sector.currentNodeId)!;
  const available = getAvailableCampaignActions(s);
  if (action.type === 'move') {
    const target = s.sector.nodes.find((x) => x.id === action.targetNodeId);
    if (!target || !here.neighbors.includes(action.targetNodeId)) return fail(s, '只能移动到相邻节点。');
    if (!available.move) return fail(s, '燃料不足，无法移动或拖曳。');
    const n = finishTurn(s, `移动至未知节点 ${target.id}。`, 2);
    n.resources.fuel -= movementFuelCost(n.fleet); n.sector.currentNodeId = target.id;
    const node = n.sector.nodes.find((x) => x.id === target.id)!;
    node.visibility = 'visited'; node.processed = node.type === 'empty'; n.sector = revealNeighbors(n.sector, target.id);
    if (node.type === 'hazard' && !node.hazardResolved) {
      const hazard = hazardOutcome(n, node.id);
      n.resources.supplies = Math.max(0, n.resources.supplies + hazard.supplies);
      n.resources.fuel = Math.max(0, n.resources.fuel + hazard.fuel);
      n.sector.threat = addThreat(n.sector.threat, hazard.threat);
      const ships = activeShips(n.fleet), ship = ships.length ? ships[hazard.damageIndex % ships.length] : undefined;
      if (ship) { const hp = componentHp(ship), index = hazard.componentIndex % hp.length; hp[index] = Math.max(0, hp[index] - hazard.damage); }
      node.hazardResolved = node.processed = true;
      n.history.push({ turn: n.turn, text: `${hazard.name}：资源受损，威胁上升。`, nodeId: node.id });
    }
    if (node.type === 'gate') n.sector.gateKnown = true;
    if (node.type === 'battle' || (node.type === 'empty' && n.sector.threat.level >= 3)) n.pendingBattle = { nodeId: target.id, battleIndex: n.turn, reason: node.type === 'battle' ? '遭遇战斗节点' : '巡逻战斗' };
    return evaluateCampaignStatus(n);
  }
  if (action.type === 'scan') {
    if (!available.scan) return fail(s, '附近没有可进一步扫描的节点。');
    const n = finishTurn(s, '扫描附近节点，获得情报。', 2); n.sector = scanNearby(n.sector); return evaluateCampaignStatus(n);
  }
  if (action.type === 'gather') {
    if (!available.gather) return fail(s, '当前节点没有可采集的资源。');
    const n = finishTurn(s, '采集星域资源。', 3), node = n.sector.nodes.find((x) => x.id === here.id)!, gain = resourceReward(n, node.id);
    n.resources.supplies += gain.supplies; n.resources.fuel += gain.fuel; n.resources.materials += gain.materials;
    node.gathered = node.processed = true;
    n.history.push({ turn: n.turn, text: `获得补给 ${gain.supplies}、燃料 ${gain.fuel}、材料 ${gain.materials}。`, nodeId: node.id });
    return evaluateCampaignStatus(n);
  }
  if (action.type === 'resolveSignal') {
    if (!available.resolveSignal) return fail(s, '当前节点没有待处理信号。');
    const n = finishTurn(s, '处理特殊信号。', 1), node = n.sector.nodes.find((x) => x.id === here.id)!, outcome = signalOutcome(n, node.id, action.optionId);
    n.resources.supplies = Math.max(0, n.resources.supplies + outcome.supplies); n.resources.fuel = Math.max(0, n.resources.fuel + outcome.fuel); n.resources.materials += outcome.materials;
    n.sector.threat = addThreat(n.sector.threat, outcome.threat); node.signalResolved = node.processed = true;
    if (outcome.gateClue) { n.sector.gateKnown = true; const gate = n.sector.nodes.find((x) => x.type === 'gate')!; if (gate.visibility === 'hidden') gate.visibility = 'detected'; n.history.push({ turn: n.turn, text: '发现星门信号。', nodeId: gate.id }); }
    if (outcome.battle) n.pendingBattle = { nodeId: node.id, battleIndex: n.turn, reason: '信号伏击' };
    return evaluateCampaignStatus(n);
  }
  if (action.type === 'enterGate') {
    if (!available.enterGate) return fail(s, '必须位于星门节点才能撤离。');
    if (disabledShips(s.fleet).some((x) => !x.towed)) return fail(s, '存在未拖曳的失能舰船；请拖曳、拆解或放弃后再撤离。');
    if (s.sector.threat.level >= 4 && !here.processed) { const n = finishTurn(s, '高威胁星门出现守卫。', 2); n.pendingBattle = { nodeId: here.id, battleIndex: n.turn, reason: '星门守卫' }; return evaluateCampaignStatus(n); }
    const n = finishTurn(s, '穿越星门，离开当前星域。', 0);
    if (n.sectorIndex >= MAX_SECTOR_INDEX) { n.status = 'victory'; n.history.push({ turn: n.turn, text: '成功穿越第三个星域，战役胜利。' }); return n; }
    n.sectorIndex++; n.turn = 0; n.sector = generateSector(n.campaignSeed, n.sectorIndex);
    n.history.push({ turn: 0, text: `进入第 ${n.sectorIndex} 星域；舰损、货舱和拖曳状态已保留。` }); return evaluateCampaignStatus(n);
  }
  if (!available.wait) return fail(s, '补给耗尽，等待已无法带来有效进展。');
  return evaluateCampaignStatus(finishTurn(s, '等待并观察星域动态。', 1));
}

export function applyCampaignBattleResult(s: CampaignState, battle: BattleState, bindings: CampaignBattleBinding[]): CampaignState {
  if (!s.pendingBattle) return s;
  const n = clone(s), pending = n.pendingBattle!;
  const node = n.sector.nodes.find((x) => x.id === pending.nodeId)!;
  const ownBefore = n.fleet.ships.length;
  n.fleet = importBattleResult(n.fleet, battle, bindings); node.processed = true; n.sector.threat = addThreat(n.sector.threat, 2);
  n.pendingSalvage = generatePendingSalvage(n.campaignSeed, n.sectorIndex, pending.nodeId, pending.battleIndex, battle, ownBefore, n.fleet.ships.length);
  n.history.push({ turn: n.turn, nodeId: node.id, text: `战斗结束：${battle.winner === 'A' ? '舰队获胜' : '舰队遭受挫败'}，剩余舰船 ${n.fleet.ships.length}；等待打捞决策。` });
  n.pendingBattle = undefined;
  return evaluateCampaignStatus(n);
}

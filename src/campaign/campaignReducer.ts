import { BattleState } from '../sim/battleTypes';
import { getShipDef } from '../sim/shipVariants';
import { addCargo, cargoSummary, removeCargo } from './cargo/cargoSystem';
import { MAX_SECTOR_INDEX } from './campaignConfig';
import { CampaignAction, CampaignState, SectorSummary } from './campaignTypes';
import { defaultDeployment, toggleDeploymentShip } from './deployment/deploymentSystem';
import { buildExtractionPlan, jettisonCargo, resolveExtraction } from './extraction/extractionSystem';
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
  move: boolean;
  scan: boolean;
  gather: boolean;
  resolveSignal: boolean;
  resolveSalvage: boolean;
  enterGate: boolean;
  wait: boolean;
}

function clone(state: CampaignState): CampaignState {
  return {
    ...state,
    resources: { ...state.resources },
    cargo: { ...state.cargo, items: state.cargo.items.map((item) => ({ ...item })) },
    fleet: {
      ...state.fleet,
      ships: state.fleet.ships.map((ship) => ({
        ...ship,
        componentHp: ship.componentHp ? [...ship.componentHp] : undefined
      }))
    },
    sector: {
      ...state.sector,
      threat: { ...state.sector.threat },
      nodes: state.sector.nodes.map((node) => ({ ...node, neighbors: [...node.neighbors] }))
    },
    history: [...state.history],
    pendingBattle: state.pendingBattle
      ? {
          ...state.pendingBattle,
          deployment: state.pendingBattle.deployment
            ? { selectedShipIds: [...state.pendingBattle.deployment.selectedShipIds] }
            : undefined
        }
      : undefined,
    pendingSalvage: state.pendingSalvage
      ? {
          ...state.pendingSalvage,
          summary: { ...state.pendingSalvage.summary },
          options: state.pendingSalvage.options.map((option) => ({
            ...option,
            items: option.items.map((item) => ({ ...item }))
          }))
        }
      : undefined,
    lastSectorSummary: state.lastSectorSummary
      ? { ...state.lastSectorSummary, damagedInJump: [...state.lastSectorSummary.damagedInJump] }
      : undefined
  };
}

function fail(state: CampaignState, text: string): CampaignState {
  return { ...state, history: [...state.history, { turn: state.turn, text }] };
}

function emptyAvailability(): CampaignActionAvailability {
  return {
    move: false,
    scan: false,
    gather: false,
    resolveSignal: false,
    resolveSalvage: false,
    enterGate: false,
    wait: false
  };
}

export function getAvailableCampaignActions(state: CampaignState): CampaignActionAvailability {
  const none = emptyAvailability();
  if (state.status !== 'active' || state.pendingBattle) return none;
  if (state.pendingSalvage) return { ...none, resolveSalvage: true };
  const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId);
  if (!current) return none;
  const neighbors = current.neighbors
    .map((id) => state.sector.nodes.find((node) => node.id === id))
    .filter(Boolean);
  return {
    move: state.resources.fuel >= movementFuelCost(state.fleet) && neighbors.length > 0,
    scan: neighbors.some((node) => node?.visibility === 'detected'),
    gather: current.type === 'resource' && !current.gathered,
    resolveSignal: current.type === 'signal' && !current.signalResolved,
    resolveSalvage: false,
    enterGate: current.type === 'gate',
    wait: state.resources.supplies > 0
  };
}

export function evaluateCampaignStatus(state: CampaignState): CampaignState {
  const next = clone(state);
  if (next.status !== 'active') return next;
  if (!next.commander.alive || activeShips(next.fleet).length === 0) {
    next.status = 'defeat';
  } else if (
    next.resources.supplies === 0 &&
    next.resources.fuel === 0 &&
    !next.pendingBattle &&
    !next.pendingSalvage &&
    !Object.values(getAvailableCampaignActions(next)).some(Boolean)
  ) {
    next.status = 'defeat';
  }
  return next;
}

function finishTurn(state: CampaignState, text: string, threat = 1, turns = 1): CampaignState {
  const next = clone(state);
  for (let index = 0; index < turns; index++) {
    next.turn++;
    next.resources.supplies = Math.max(
      0,
      next.resources.supplies - (next.sector.threat.level >= 5 ? 3 : 1)
    );
  }
  next.sector.threat = addThreat(next.sector.threat, threat);
  next.history.push({ turn: next.turn, text });
  return next;
}

function ensureComponentHp(ship: PersistentShip): number[] {
  if (!ship.componentHp) {
    ship.componentHp = getShipDef(ship.shipClass, ship.variant).def.components.map(
      (component) => component.maxHp
    );
  }
  return ship.componentHp;
}

function resolveSalvage(
  state: CampaignState,
  action: Extract<CampaignAction, { type: 'resolveSalvage' }>
): CampaignState {
  if (!state.pendingSalvage) return fail(state, '当前没有待处理的战后打捞。');
  const option = state.pendingSalvage.options.find((item) => item.id === action.optionId);
  if (!option) return fail(state, '未知的打捞方案。');
  const next = finishTurn(
    state,
    `执行战后方案：${option.label}。`,
    option.threat,
    option.turns
  );
  const transfer = addCargo(next.cargo, option.items);
  next.cargo = transfer.cargo;
  next.history.push({
    turn: next.turn,
    nodeId: next.pendingSalvage!.nodeId,
    text: `获得 ${cargoSummary(transfer.accepted)}；因货舱不足放弃 ${cargoSummary(transfer.rejected)}。`
  });
  next.pendingSalvage = undefined;
  return evaluateCampaignStatus(next);
}

function useCargo(
  state: CampaignState,
  action: Extract<CampaignAction, { type: 'useCargo' }>
): CampaignState {
  if (action.itemType !== 'supplyCrate' && action.itemType !== 'fuelCell') {
    return fail(state, '该物品不能直接使用。');
  }
  const cargo = removeCargo(state.cargo, action.itemType, 1);
  if (!cargo) return fail(state, '货舱中没有对应物资。');
  const next = clone(state);
  next.cargo = cargo;
  if (action.itemType === 'supplyCrate') next.resources.supplies += 3;
  else next.resources.fuel += 2;
  next.history.push({
    turn: next.turn,
    text: `使用了一份${action.itemType === 'supplyCrate' ? '补给箱' : '燃料电池'}。`
  });
  return next;
}

function repairShip(state: CampaignState, campaignShipId: string): CampaignState {
  const parts = removeCargo(state.cargo, 'repairParts', 1);
  const target = state.fleet.ships.find((ship) => ship.campaignShipId === campaignShipId);
  if (!parts) return fail(state, '缺少维修零件。');
  if (!target || !canFieldRepair(target)) return fail(state, '该舰船当前无法进行战地维修。');
  const result = fieldRepairShip(target)!;
  const next = finishTurn(state, `对 ${campaignShipId} 进行战地维修。`, 2);
  next.cargo = parts;
  next.fleet.ships = next.fleet.ships.map((ship) =>
    ship.campaignShipId === campaignShipId ? result.ship : ship
  );
  next.history.push({
    turn: next.turn,
    text: `恢复组件 #${result.componentIndex} 的 ${result.restoredHp} 点 HP。`
  });
  return evaluateCampaignStatus(next);
}

function handleDisabledShip(
  state: CampaignState,
  action: Extract<CampaignAction, { type: 'towShip' | 'dismantleShip' | 'abandonShip' }>
): CampaignState {
  const target = state.fleet.ships.find(
    (ship) => ship.campaignShipId === action.campaignShipId
  );
  if (!target?.disabled) return fail(state, '只能处理失能舰船。');
  const next = clone(state);
  if (action.type === 'towShip') {
    const ship = next.fleet.ships.find(
      (item) => item.campaignShipId === target.campaignShipId
    )!;
    ship.towed = !ship.towed;
    next.history.push({
      turn: next.turn,
      text: `${ship.towed ? '开始' : '停止'}拖曳 ${ship.campaignShipId}。`
    });
  } else {
    next.fleet.ships = next.fleet.ships.filter(
      (ship) => ship.campaignShipId !== target.campaignShipId
    );
    if (action.type === 'dismantleShip') {
      const transfer = addCargo(next.cargo, [{ type: 'repairParts', quantity: 2 }]);
      next.cargo = transfer.cargo;
      next.history.push({
        turn: next.turn,
        text: `拆解 ${target.campaignShipId}，回收 ${cargoSummary(transfer.accepted)}。`
      });
    } else {
      next.history.push({ turn: next.turn, text: `永久放弃 ${target.campaignShipId}。` });
    }
  }
  return evaluateCampaignStatus(next);
}

function buildSectorSummary(
  state: CampaignState,
  mode: 'normal' | 'emergency',
  risk: SectorSummary['extractionRisk'],
  jettisonedUnits: number,
  damagedInJump: string[]
): SectorSummary {
  return {
    sectorIndex: state.sectorIndex,
    turns: state.turn,
    visitedNodes: state.sector.nodes.filter((node) => node.visibility === 'visited').length,
    totalNodes: state.sector.nodes.length,
    shipsRemaining: state.fleet.ships.length,
    disabledShips: disabledShips(state.fleet).length,
    cargoUsed: state.cargo.items.reduce((sum, item) => sum + item.quantity, 0),
    cargoCapacity: state.cargo.capacity,
    threatLevel: state.sector.threat.level,
    extractionMode: mode,
    extractionRisk: risk,
    jettisonedUnits,
    damagedInJump
  };
}

function enterGate(
  state: CampaignState,
  mode: 'normal' | 'emergency'
): CampaignState {
  const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
  if (current.type !== 'gate') return fail(state, '必须位于星门节点才能撤离。');
  if (state.sector.threat.level >= 4 && !current.processed) {
    const guarded = finishTurn(state, '高威胁星门出现守卫。', 2);
    guarded.pendingBattle = {
      nodeId: current.id,
      battleIndex: guarded.turn,
      reason: '星门守卫',
      deployment: defaultDeployment(guarded.fleet)
    };
    return evaluateCampaignStatus(guarded);
  }

  const plan = buildExtractionPlan(state);
  const resolution = resolveExtraction(state, mode);
  if (!resolution) {
    if (plan.untowedDisabled > 0) {
      return fail(state, '存在未拖曳的失能舰船；请拖曳、拆解或放弃后再撤离。');
    }
    if (state.resources.fuel < plan.fuelCost) {
      return fail(state, `跃迁燃料不足，需要 ${plan.fuelCost}。`);
    }
    return fail(state, '当前载荷超过普通跃迁安全上限；请抛弃货物或选择紧急跃迁。');
  }

  let next = finishTurn(
    resolution.state,
    mode === 'normal' ? '执行稳定星门跃迁。' : '执行紧急星门跃迁。',
    0
  );
  const jettisonedUnits = resolution.jettisoned.reduce(
    (sum, stack) => sum + stack.quantity,
    0
  );
  next.lastSectorSummary = buildSectorSummary(
    next,
    mode,
    plan.risk,
    jettisonedUnits,
    resolution.damagedShipIds
  );
  next.history.push({
    turn: next.turn,
    text: `撤离结算：风险 ${plan.risk}，抛弃 ${jettisonedUnits} 件货物，跃迁受损舰 ${resolution.damagedShipIds.length}。`
  });

  if (next.sectorIndex >= MAX_SECTOR_INDEX) {
    next.status = 'victory';
    next.history.push({ turn: next.turn, text: '成功穿越第三个星域，战役胜利。' });
    return next;
  }

  next.sectorIndex++;
  next.turn = 0;
  next.sector = generateSector(next.campaignSeed, next.sectorIndex);
  next.extractionPrepared = false;
  next.history.push({
    turn: 0,
    text: `进入第 ${next.sectorIndex} 星域；舰损、货舱和拖曳状态已保留。`
  });
  return evaluateCampaignStatus(next);
}

export function applyCampaignAction(state: CampaignState, action: CampaignAction): CampaignState {
  if (state.status !== 'active') return fail(state, '当前无法执行该行动。');

  if (state.pendingBattle) {
    if (action.type !== 'toggleDeployment') return fail(state, '必须先处理当前战斗。');
    const next = clone(state);
    const deployment = next.pendingBattle!.deployment ?? defaultDeployment(next.fleet);
    next.pendingBattle!.deployment = toggleDeploymentShip(
      next.fleet,
      deployment,
      action.campaignShipId
    );
    return next;
  }

  if (state.pendingSalvage && action.type !== 'resolveSalvage') {
    return fail(state, '必须先决定如何处理战场残骸。');
  }
  if (action.type === 'resolveSalvage') return resolveSalvage(state, action);
  if (action.type === 'useCargo') return useCargo(state, action);
  if (action.type === 'jettisonCargo') {
    return jettisonCargo(state, action.itemType, action.quantity ?? 1) ?? fail(state, '货舱中没有足够物资可抛弃。');
  }
  if (action.type === 'fieldRepair') return repairShip(state, action.campaignShipId);
  if (
    action.type === 'towShip' ||
    action.type === 'dismantleShip' ||
    action.type === 'abandonShip'
  ) {
    return handleDisabledShip(state, action);
  }
  if (action.type === 'toggleDeployment') return fail(state, '当前没有待配置的战斗。');
  if (action.type === 'prepareExtraction') {
    const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId);
    if (current?.type !== 'gate') return fail(state, '只有在星门节点才能准备跃迁。');
    const next = finishTurn(state, '完成跃迁校准与载荷固定。', 1);
    next.extractionPrepared = true;
    return evaluateCampaignStatus(next);
  }

  const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
  const available = getAvailableCampaignActions(state);

  if (action.type === 'move') {
    const target = state.sector.nodes.find((node) => node.id === action.targetNodeId);
    if (!target || !current.neighbors.includes(action.targetNodeId)) {
      return fail(state, '只能移动到相邻节点。');
    }
    if (!available.move) return fail(state, '燃料不足，无法移动或拖曳。');
    const next = finishTurn(state, `移动至未知节点 ${target.id}。`, 2);
    next.extractionPrepared = false;
    next.resources.fuel -= movementFuelCost(next.fleet);
    next.sector.currentNodeId = target.id;
    const node = next.sector.nodes.find((item) => item.id === target.id)!;
    node.visibility = 'visited';
    node.processed = node.type === 'empty';
    next.sector = revealNeighbors(next.sector, target.id);

    if (node.type === 'hazard' && !node.hazardResolved) {
      const hazard = hazardOutcome(next, node.id);
      next.resources.supplies = Math.max(0, next.resources.supplies + hazard.supplies);
      next.resources.fuel = Math.max(0, next.resources.fuel + hazard.fuel);
      next.sector.threat = addThreat(next.sector.threat, hazard.threat);
      const candidates = activeShips(next.fleet);
      const ship = candidates.length
        ? candidates[hazard.damageIndex % candidates.length]
        : undefined;
      if (ship) {
        const hp = ensureComponentHp(ship);
        const componentIndex = hazard.componentIndex % hp.length;
        hp[componentIndex] = Math.max(0, hp[componentIndex] - hazard.damage);
      }
      node.hazardResolved = true;
      node.processed = true;
      next.history.push({
        turn: next.turn,
        text: `${hazard.name}：资源受损，威胁上升。`,
        nodeId: node.id
      });
    }

    if (node.type === 'gate') next.sector.gateKnown = true;
    if (node.type === 'battle' || (node.type === 'empty' && next.sector.threat.level >= 3)) {
      next.pendingBattle = {
        nodeId: target.id,
        battleIndex: next.turn,
        reason: node.type === 'battle' ? '遭遇战斗节点' : '巡逻战斗',
        deployment: defaultDeployment(next.fleet)
      };
    }
    return evaluateCampaignStatus(next);
  }

  if (action.type === 'scan') {
    if (!available.scan) return fail(state, '附近没有可进一步扫描的节点。');
    const next = finishTurn(state, '扫描附近节点，获得情报。', 2);
    next.sector = scanNearby(next.sector);
    return evaluateCampaignStatus(next);
  }

  if (action.type === 'gather') {
    if (!available.gather) return fail(state, '当前节点没有可采集的资源。');
    const next = finishTurn(state, '采集星域资源。', 3);
    const node = next.sector.nodes.find((item) => item.id === current.id)!;
    const gain = resourceReward(next, node.id);
    next.resources.supplies += gain.supplies;
    next.resources.fuel += gain.fuel;
    next.resources.materials += gain.materials;
    node.gathered = true;
    node.processed = true;
    next.history.push({
      turn: next.turn,
      text: `获得补给 ${gain.supplies}、燃料 ${gain.fuel}、材料 ${gain.materials}。`,
      nodeId: node.id
    });
    return evaluateCampaignStatus(next);
  }

  if (action.type === 'resolveSignal') {
    if (!available.resolveSignal) return fail(state, '当前节点没有待处理信号。');
    const next = finishTurn(state, '处理特殊信号。', 1);
    const node = next.sector.nodes.find((item) => item.id === current.id)!;
    const outcome = signalOutcome(next, node.id, action.optionId);
    next.resources.supplies = Math.max(0, next.resources.supplies + outcome.supplies);
    next.resources.fuel = Math.max(0, next.resources.fuel + outcome.fuel);
    next.resources.materials += outcome.materials;
    next.sector.threat = addThreat(next.sector.threat, outcome.threat);
    node.signalResolved = true;
    node.processed = true;
    if (outcome.gateClue) {
      next.sector.gateKnown = true;
      const gate = next.sector.nodes.find((item) => item.type === 'gate')!;
      if (gate.visibility === 'hidden') gate.visibility = 'detected';
      next.history.push({ turn: next.turn, text: '发现星门信号。', nodeId: gate.id });
    }
    if (outcome.battle) {
      next.pendingBattle = {
        nodeId: node.id,
        battleIndex: next.turn,
        reason: '信号伏击',
        deployment: defaultDeployment(next.fleet)
      };
    }
    return evaluateCampaignStatus(next);
  }

  if (action.type === 'enterGate') return enterGate(state, action.mode ?? 'normal');
  if (!available.wait) return fail(state, '补给耗尽，等待已无法带来有效进展。');
  return evaluateCampaignStatus(finishTurn(state, '等待并观察星域动态。', 1));
}

export function applyCampaignBattleResult(
  state: CampaignState,
  battle: BattleState,
  bindings: CampaignBattleBinding[]
): CampaignState {
  if (!state.pendingBattle) return state;
  const next = clone(state);
  const pending = next.pendingBattle!;
  const node = next.sector.nodes.find((item) => item.id === pending.nodeId)!;
  const ownBefore = next.fleet.ships.length;
  next.fleet = importBattleResult(next.fleet, battle, bindings);
  node.processed = true;
  next.sector.threat = addThreat(next.sector.threat, 2);
  next.pendingBattle = undefined;

  // A destroyed or otherwise non-operational fleet cannot perform salvage.  In
  // particular, do not create a pendingSalvage on a defeat state: terminal
  // campaign saves deliberately reject actions that can no longer be resolved.
  const resolved = evaluateCampaignStatus(next);
  if (resolved.status !== 'active') {
    resolved.history.push({
      turn: resolved.turn,
      nodeId: node.id,
      text: `战斗结束：舰队已无法继续远征，剩余舰船 ${resolved.fleet.ships.length}。`
    });
    return resolved;
  }

  resolved.pendingSalvage = generatePendingSalvage(
    resolved.campaignSeed,
    resolved.sectorIndex,
    pending.nodeId,
    pending.battleIndex,
    battle,
    ownBefore,
    resolved.fleet.ships.length
  );
  resolved.history.push({
    turn: resolved.turn,
    nodeId: node.id,
    text: `战斗结束：${battle.winner === 'A' ? '舰队获胜' : '舰队遭受挫败'}，剩余舰船 ${resolved.fleet.ships.length}；等待打捞决策。`
  });
  return resolved;
}

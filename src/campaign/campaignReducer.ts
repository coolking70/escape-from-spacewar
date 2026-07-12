import { MAX_SECTOR_INDEX } from './campaignConfig';
import { CampaignAction, CampaignState } from './campaignTypes';
import { activeShips, PersistentShip } from './fleet/persistentFleet';
import { generateSector } from './sector/sectorGenerator';
import { revealNeighbors, scanNearby } from './sector/sectorVisibility';
import { addThreat } from './sector/threatSystem';
import { hazardOutcome, resourceReward, signalOutcome } from './sector/sectorActions';
import { BattleState } from '../sim/battleTypes';
import { importBattleResult } from './fleet/battleResultImporter';
import { CampaignBattleBinding } from './fleet/battleAdapter';
import { getShipDef } from '../sim/shipVariants';

export interface CampaignActionAvailability {
  move: boolean;
  scan: boolean;
  gather: boolean;
  resolveSignal: boolean;
  enterGate: boolean;
  wait: boolean;
}

function clone(state: CampaignState): CampaignState {
  return {
    ...state,
    resources: { ...state.resources },
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
    history: [...state.history]
  };
}

function fail(state: CampaignState, message: string): CampaignState {
  return { ...state, history: [...state.history, { turn: state.turn, text: message }] };
}

export function getAvailableCampaignActions(state: CampaignState): CampaignActionAvailability {
  const none: CampaignActionAvailability = {
    move: false,
    scan: false,
    gather: false,
    resolveSignal: false,
    enterGate: false,
    wait: false
  };
  if (state.status !== 'active' || state.pendingBattle) return none;

  const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId);
  if (!current) return none;
  const neighbors = current.neighbors
    .map((id) => state.sector.nodes.find((node) => node.id === id))
    .filter((node): node is NonNullable<typeof node> => !!node);

  return {
    move: state.resources.fuel >= 1 && neighbors.length > 0,
    scan: neighbors.some((node) => node.visibility === 'detected'),
    gather: current.type === 'resource' && !current.gathered,
    resolveSignal: current.type === 'signal' && !current.signalResolved,
    enterGate: current.type === 'gate',
    // 当前 V0.6 的等待只消耗补给并提升威胁；补给耗尽后不再视为有效行动。
    wait: state.resources.supplies > 0
  };
}

function hasAvailableCampaignAction(state: CampaignState): boolean {
  return Object.values(getAvailableCampaignActions(state)).some(Boolean);
}

export function evaluateCampaignStatus(state: CampaignState): CampaignState {
  const next = clone(state);
  if (next.status !== 'active') return next;

  if (!next.commander.alive || activeShips(next.fleet).length === 0) {
    next.status = 'defeat';
    return next;
  }

  const resourcesExhausted = next.resources.supplies === 0 && next.resources.fuel === 0;
  if (resourcesExhausted && !next.pendingBattle && !hasAvailableCampaignAction(next)) {
    next.status = 'defeat';
  }
  return next;
}

function finishTurn(state: CampaignState, text: string, threat = 1): CampaignState {
  const next = clone(state);
  next.turn++;
  next.resources.supplies = Math.max(
    0,
    next.resources.supplies - (next.sector.threat.level >= 5 ? 3 : 1)
  );
  next.sector.threat = addThreat(next.sector.threat, threat);
  next.history.push({ turn: next.turn, text });
  return next;
}

function ensureComponentHp(ship: PersistentShip): number[] {
  if (!ship.componentHp) {
    const { def } = getShipDef(ship.shipClass, ship.variant);
    ship.componentHp = def.components.map((component) => component.maxHp);
  }
  return ship.componentHp;
}

export function applyCampaignAction(state: CampaignState, action: CampaignAction): CampaignState {
  if (state.status !== 'active' || state.pendingBattle) {
    return fail(state, '当前无法执行该行动。');
  }

  const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
  const available = getAvailableCampaignActions(state);

  if (action.type === 'move') {
    const target = state.sector.nodes.find((node) => node.id === action.targetNodeId);
    if (!target || !current.neighbors.includes(action.targetNodeId)) {
      return fail(state, '只能移动到相邻节点。');
    }
    if (!available.move) return fail(state, '燃料不足，无法移动。');

    const next = finishTurn(state, `移动至未知节点 ${target.id}。`, 2);
    next.resources.fuel--;
    next.sector.currentNodeId = target.id;
    const node = next.sector.nodes.find((candidate) => candidate.id === target.id)!;
    node.visibility = 'visited';
    node.processed = node.type === 'empty';
    next.sector = revealNeighbors(next.sector, target.id);

    if (node.type === 'hazard' && !node.hazardResolved) {
      const hazard = hazardOutcome(next, node.id);
      next.resources.supplies = Math.max(0, next.resources.supplies + hazard.supplies);
      next.resources.fuel = Math.max(0, next.resources.fuel + hazard.fuel);
      next.sector.threat = addThreat(next.sector.threat, hazard.threat);

      const candidates = activeShips(next.fleet);
      const ship = candidates.length ? candidates[hazard.damageIndex % candidates.length] : undefined;
      if (ship) {
        const componentHp = ensureComponentHp(ship);
        const componentIndex = hazard.componentIndex % componentHp.length;
        componentHp[componentIndex] = Math.max(
          0,
          componentHp[componentIndex] - hazard.damage
        );
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
        reason: node.type === 'battle' ? '遭遇战斗节点' : '巡逻战斗'
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
    const node = next.sector.nodes.find((candidate) => candidate.id === current.id)!;
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
    const node = next.sector.nodes.find((candidate) => candidate.id === current.id)!;
    const outcome = signalOutcome(next, node.id, action.optionId);
    next.resources.supplies = Math.max(0, next.resources.supplies + outcome.supplies);
    next.resources.fuel = Math.max(0, next.resources.fuel + outcome.fuel);
    next.resources.materials += outcome.materials;
    next.sector.threat = addThreat(next.sector.threat, outcome.threat);
    node.signalResolved = true;
    node.processed = true;

    if (outcome.gateClue) {
      next.sector.gateKnown = true;
      const gate = next.sector.nodes.find((candidate) => candidate.type === 'gate')!;
      if (gate.visibility === 'hidden') gate.visibility = 'detected';
      next.history.push({ turn: next.turn, text: '发现星门信号。', nodeId: gate.id });
    }
    if (outcome.battle) {
      next.pendingBattle = {
        nodeId: node.id,
        battleIndex: next.turn,
        reason: '信号伏击'
      };
    }
    return evaluateCampaignStatus(next);
  }

  if (action.type === 'enterGate') {
    if (!available.enterGate) return fail(state, '必须位于星门节点才能撤离。');
    if (state.sector.threat.level >= 4 && !current.processed) {
      const next = finishTurn(state, '高威胁星门出现守卫。', 2);
      const gate = next.sector.nodes.find((node) => node.id === current.id)!;
      next.pendingBattle = {
        nodeId: gate.id,
        battleIndex: next.turn,
        reason: '星门守卫'
      };
      return evaluateCampaignStatus(next);
    }

    const next = finishTurn(state, '穿越星门，离开当前星域。', 0);
    if (next.sectorIndex >= MAX_SECTOR_INDEX) {
      next.status = 'victory';
      next.history.push({ turn: next.turn, text: '成功穿越第三个星域，战役胜利。' });
      return next;
    }

    next.sectorIndex++;
    next.turn = 0;
    next.sector = generateSector(next.campaignSeed, next.sectorIndex);
    next.history.push({ turn: 0, text: `进入第 ${next.sectorIndex} 星域。` });
    return evaluateCampaignStatus(next);
  }

  if (!available.wait) return fail(state, '补给耗尽，等待已无法带来有效进展。');
  return evaluateCampaignStatus(finishTurn(state, '等待并观察星域动态。', 1));
}

/** 战役只读取 core-v4 最终 BattleState，写回损失后返回星域地图。 */
export function applyCampaignBattleResult(
  state: CampaignState,
  battle: BattleState,
  bindings: CampaignBattleBinding[]
): CampaignState {
  if (!state.pendingBattle) return state;
  const next = clone(state);
  const node = next.sector.nodes.find((candidate) => candidate.id === next.pendingBattle!.nodeId)!;
  next.fleet = importBattleResult(next.fleet, battle, bindings);
  node.processed = true;
  next.sector.threat = addThreat(next.sector.threat, 2);
  next.history.push({
    turn: next.turn,
    nodeId: node.id,
    text: `战斗结束：${battle.winner === 'A' ? '舰队获胜' : '舰队遭受挫败'}，剩余舰船 ${next.fleet.ships.length}。`
  });
  next.pendingBattle = undefined;
  return evaluateCampaignStatus(next);
}

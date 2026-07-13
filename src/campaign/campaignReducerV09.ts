import type { BattleState } from '../sim/battleTypes';
import { cargoUsed } from './cargo/cargoSystem';
import { commanderSupplyUpkeepModifier } from './commander/commanderHealth';
import type { CampaignAction, CampaignState } from './campaignTypes';
import {
  applyCampaignAction as applyBaseCampaignAction,
  applyCampaignBattleResult as applyBaseCampaignBattleResult,
  evaluateCampaignStatus as evaluateBaseCampaignStatus,
  getAvailableCampaignActions as getBaseAvailableCampaignActions,
  type CampaignActionAvailability
} from './campaignReducerBase';
import type { CampaignBattleBinding } from './fleet/battleAdapter';
import { movementFuelCost } from './fleet/persistentFleet';
import {
  canResolveOrganizationEvent,
  generateOrganizationEvent,
  resolveOrganizationEvent
} from './organization/organizationEvents';
import {
  changeOrganizationStability,
  organizationCargoBonus,
  organizationEmergencyRefuelCost,
  organizationGatherBonus,
  organizationRepairThreat,
  organizationResearchGain,
  organizationScanThreat,
  organizationTreatmentCost
} from './organization/organizationSystem';
import {
  addResearchResources,
  hasInstalledTechnology,
  installTechnology,
  TECHNOLOGY_DEFINITIONS,
  unlockTechnology,
  uninstallTechnology
} from './organization/technologySystem';

type TechnologyAction = Extract<CampaignAction, {
  type: 'unlockTechnology' | 'installTechnology' | 'uninstallTechnology';
}>;

function cloneOrganizationState(state: CampaignState): CampaignState {
  return {
    ...state,
    organization: {
      ...state.organization,
      values: [...state.organization.values],
      reputation: { ...state.organization.reputation },
      research: {
        ...state.organization.research,
        resources: { ...state.organization.research.resources },
        unlocked: [...state.organization.research.unlocked],
        installed: [...state.organization.research.installed]
      }
    },
    pendingOrganizationEvent: state.pendingOrganizationEvent
      ? {
          ...state.pendingOrganizationEvent,
          options: state.pendingOrganizationEvent.options.map((option) => ({
            ...option,
            effect: {
              ...option.effect,
              reputation: option.effect.reputation ? { ...option.effect.reputation } : undefined,
              research: option.effect.research ? { ...option.effect.research } : undefined
            }
          }))
        }
      : undefined
  };
}

function noActions(): CampaignActionAvailability {
  return {
    move: false,
    scan: false,
    gather: false,
    resolveSignal: false,
    resolveSalvage: false,
    enterGate: false,
    emergencyRefuel: false,
    wait: false
  };
}

function rejectAction(state: CampaignState, text: string): CampaignState {
  const next = cloneOrganizationState(state);
  next.history = [...state.history, { turn: state.turn, text }];
  return next;
}

function setThreatValue(state: CampaignState, value: number): void {
  const normalized = Math.max(0, value);
  state.sector.threat.value = normalized;
  state.sector.threat.level = Math.min(5, Math.floor(normalized / 5)) as CampaignState['sector']['threat']['level'];
}

export function getAvailableCampaignActions(state: CampaignState): CampaignActionAvailability {
  if (state.pendingOrganizationEvent) return noActions();
  const available = getBaseAvailableCampaignActions(state);
  if (!available.emergencyRefuel) {
    const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId);
    const fuelCost = movementFuelCost(state.fleet);
    const hasRoute = (current?.neighbors.length ?? 0) > 0;
    available.emergencyRefuel = hasRoute && state.resources.fuel < fuelCost &&
      state.resources.supplies >= organizationEmergencyRefuelCost(state.organization);
  }
  return available;
}

function actionSucceeded(before: CampaignState, after: CampaignState, action: CampaignAction): boolean {
  if (after.history.length <= before.history.length) return false;
  const newText = after.history.slice(before.history.length).map((entry) => entry.text).join(' ');
  if (action.type === 'scan') return newText.includes('扫描附近节点');
  if (action.type === 'gather') return newText.includes('采集星域资源');
  if (action.type === 'resolveSignal') return newText.includes('处理特殊信号');
  if (action.type === 'resolveSalvage') return !!before.pendingSalvage && !after.pendingSalvage;
  if (action.type === 'fieldRepair') return newText.includes('战地维修');
  if (action.type === 'treatCommander') return newText.includes('治疗指挥官');
  if (action.type === 'enterGate') return after.sectorIndex > before.sectorIndex || after.status === 'victory';
  return false;
}

function applyResearchForAction(before: CampaignState, after: CampaignState, action: CampaignAction): void {
  if (!actionSucceeded(before, after, action)) return;
  let researchAction: Parameters<typeof organizationResearchGain>[1] | null = null;
  if (action.type === 'scan') researchAction = 'scan';
  else if (action.type === 'gather') researchAction = 'gather';
  else if (action.type === 'resolveSignal') researchAction = 'signal';
  else if (action.type === 'resolveSalvage') researchAction = 'salvage';
  else if (action.type === 'fieldRepair') researchAction = 'repair';
  else if (action.type === 'treatCommander') researchAction = 'treat';
  else if (action.type === 'enterGate') researchAction = 'extract';
  if (!researchAction) return;
  addResearchResources(after.organization, organizationResearchGain(after.organization, researchAction));
}

function applyActionModifiers(before: CampaignState, after: CampaignState, action: CampaignAction): void {
  if (!actionSucceeded(before, after, action)) return;
  if (action.type === 'scan') {
    setThreatValue(after, before.sector.threat.value + organizationScanThreat(after.organization));
  }
  if (action.type === 'gather') {
    const bonus = organizationGatherBonus(after.organization);
    after.resources.supplies += bonus.supplies;
    after.resources.fuel += bonus.fuel;
    after.resources.materials += bonus.materials;
    if (bonus.supplies || bonus.fuel || bonus.materials) {
      after.history.push({
        turn: after.turn,
        text: `组织专长额外获得补给 ${bonus.supplies}、燃料 ${bonus.fuel}、材料 ${bonus.materials}。`
      });
    }
  }
  if (action.type === 'fieldRepair') {
    setThreatValue(after, before.sector.threat.value + organizationRepairThreat(after.organization));
  }
  if (action.type === 'enterGate' && after.sectorIndex > before.sectorIndex && after.status === 'active') {
    after.pendingOrganizationEvent = generateOrganizationEvent(after);
  }
}

function treatmentUpkeep(state: CampaignState): number {
  const base = state.sector.threat.level >= 5 ? 3 : 1;
  return Math.max(0, base + commanderSupplyUpkeepModifier(state.commander, state.campaignSeed));
}

function applyTreatment(state: CampaignState): CampaignState {
  const cost = organizationTreatmentCost(state.organization);
  const upkeep = treatmentUpkeep(state);
  if (state.resources.supplies < cost + upkeep) {
    const next = cloneOrganizationState(state);
    next.history = [...state.history, { turn: state.turn, text: `治疗需要医疗补给 ${cost}，并承担本回合维护 ${upkeep}。` }];
    return next;
  }
  const adjusted = cloneOrganizationState(state);
  adjusted.resources = { ...state.resources, supplies: state.resources.supplies + Math.max(0, 2 - cost) };
  const result = applyBaseCampaignAction(adjusted, { type: 'treatCommander' });
  if (!actionSucceeded(adjusted, result, { type: 'treatCommander' })) return result;
  result.resources.supplies = Math.max(0, state.resources.supplies - cost - upkeep);
  return result;
}

function applyEmergencyRefuel(state: CampaignState): CampaignState {
  const cost = organizationEmergencyRefuelCost(state.organization);
  if (state.resources.supplies < cost) {
    const next = cloneOrganizationState(state);
    next.history = [...state.history, { turn: state.turn, text: `应急燃料调配需要补给 ${cost}。` }];
    return next;
  }
  const adjusted = cloneOrganizationState(state);
  adjusted.resources = { ...state.resources, supplies: Math.max(2, state.resources.supplies + Math.max(0, 2 - cost)) };
  const result = applyBaseCampaignAction(adjusted, { type: 'emergencyRefuel' });
  const success = result.turn > state.turn && result.resources.fuel > state.resources.fuel;
  if (success) result.resources.supplies = Math.max(0, state.resources.supplies - cost);
  return result;
}

function isTechnologyAction(action: CampaignAction): action is TechnologyAction {
  return action.type === 'unlockTechnology' || action.type === 'installTechnology' || action.type === 'uninstallTechnology';
}

function technologyAction(state: CampaignState, action: CampaignAction): CampaignState | null {
  if (!isTechnologyAction(action)) return null;
  const next = cloneOrganizationState(state);
  const id = action.technologyId;
  if (action.type === 'unlockTechnology') {
    if (!unlockTechnology(next.organization, id)) {
      next.history = [...state.history, { turn: state.turn, text: `无法解锁科技：${TECHNOLOGY_DEFINITIONS[id].label}。` }];
      return next;
    }
    next.history = [...state.history, { turn: state.turn, text: `解锁组织科技：${TECHNOLOGY_DEFINITIONS[id].label}。` }];
    return next;
  }
  if (action.type === 'installTechnology') {
    const beforeBonus = organizationCargoBonus(next.organization);
    if (!installTechnology(next.organization, id)) {
      next.history = [...state.history, { turn: state.turn, text: `无法装配科技：${TECHNOLOGY_DEFINITIONS[id].label}。` }];
      return next;
    }
    const afterBonus = organizationCargoBonus(next.organization);
    next.cargo = { ...next.cargo, capacity: next.cargo.capacity + afterBonus - beforeBonus };
    next.history = [...state.history, { turn: state.turn, text: `装配组织科技：${TECHNOLOGY_DEFINITIONS[id].label}。` }];
    return next;
  }
  const beforeBonus = organizationCargoBonus(next.organization);
  const nextCapacity = next.cargo.capacity - (id === 'modularCargo' && beforeBonus > 0 ? 4 : 0);
  if (id === 'modularCargo' && cargoUsed(next.cargo) > nextCapacity) {
    next.history = [...state.history, { turn: state.turn, text: '当前货舱载荷过高，无法卸下模块化货舱。' }];
    return next;
  }
  if (!uninstallTechnology(next.organization, id)) {
    next.history = [...state.history, { turn: state.turn, text: `无法卸下科技：${TECHNOLOGY_DEFINITIONS[id].label}。` }];
    return next;
  }
  const afterBonus = organizationCargoBonus(next.organization);
  next.cargo = { ...next.cargo, capacity: next.cargo.capacity + afterBonus - beforeBonus };
  next.history = [...state.history, { turn: state.turn, text: `卸下组织科技：${TECHNOLOGY_DEFINITIONS[id].label}。` }];
  return next;
}

export function evaluateCampaignStatus(state: CampaignState): CampaignState {
  const next = evaluateBaseCampaignStatus(cloneOrganizationState(state));
  if (next.status === 'active' && next.organization.stability <= 0) {
    next.status = 'defeat';
    next.history.push({ turn: next.turn, text: '组织稳定度归零，远征体系崩溃。' });
  }
  return next;
}

export function applyCampaignAction(state: CampaignState, action: CampaignAction): CampaignState {
  if (state.status !== 'active') return rejectAction(state, '当前无法执行该行动。');
  if (action.type === 'resolveOrganizationEvent') {
    const next = cloneOrganizationState(state);
    const option = next.pendingOrganizationEvent?.options.find((candidate) => candidate.id === action.optionId);
    if (!option || !canResolveOrganizationEvent(next, option)) {
      next.history = [...state.history, { turn: state.turn, text: '该组织事件选项当前不可用。' }];
      return next;
    }
    const text = resolveOrganizationEvent(next, action.optionId)!;
    next.history = [...state.history, { turn: state.turn, text }];
    return evaluateCampaignStatus(next);
  }
  if (state.pendingOrganizationEvent) {
    return rejectAction(state, '必须先处理当前组织事件。');
  }
  if (
    (state.pendingBattle || state.pendingSalvage || state.pendingRecruitment || state.pendingSuccession) &&
    (isTechnologyAction(action) || action.type === 'treatCommander' || action.type === 'emergencyRefuel')
  ) return rejectAction(state, '必须先处理当前待决事件。');
  const technology = technologyAction(state, action);
  if (technology) return evaluateCampaignStatus(technology);
  if (action.type === 'treatCommander') {
    const result = applyTreatment(state);
    applyResearchForAction(state, result, action);
    return evaluateCampaignStatus(result);
  }
  if (action.type === 'emergencyRefuel') return evaluateCampaignStatus(applyEmergencyRefuel(state));

  const prepared = cloneOrganizationState(state);
  const result = applyBaseCampaignAction(prepared, action);
  applyActionModifiers(state, result, action);
  applyResearchForAction(state, result, action);
  return evaluateCampaignStatus(result);
}

export function applyCampaignBattleResult(
  state: CampaignState,
  battle: BattleState,
  bindings: CampaignBattleBinding[]
): CampaignState {
  const prepared = cloneOrganizationState(state);
  const result = applyBaseCampaignBattleResult(prepared, battle, bindings);
  if (battle.winner === 'A') {
    addResearchResources(result.organization, organizationResearchGain(result.organization, 'battle'));
    result.organization.reputation.military += 1;
  } else {
    const coordinated = hasInstalledTechnology(result.organization, 'retreatCoordination');
    changeOrganizationStability(result.organization, coordinated ? -2 : -4);
  }
  return evaluateCampaignStatus(result);
}

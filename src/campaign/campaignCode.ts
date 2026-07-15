import { validateFleetEntry } from '../sim/fleetValidator';
import { cargoUsed, createEmptyCargo } from './cargo/cargoSystem';
import { CargoItemType } from './cargo/cargoTypes';
import { CAMPAIGN_VERSION, STARTING_CARGO_CAPACITY } from './campaignConfig';
import { isCommanderAvailable } from './commander/commanderHealth';
import {
  COMMANDER_TRAITS,
  ensureCommanderProfile
} from './commander/commanderSystem';
import type {
  CommanderConditionId,
  CommanderDomain,
  CommanderInjuryId
} from './commander/commanderTypes';
import { CampaignCommander, CampaignState, RetreatPolicy } from './campaignTypes';
import {
  GOVERNMENT_TYPES,
  ORGANIZATION_ARCHETYPES,
  ORGANIZATION_VALUES,
  ensureOrganization,
  organizationCargoBonus
} from './organization/organizationSystem';
import type {
  OrganizationEventEffect,
  PendingOrganizationEvent,
  ResearchResourceKey
} from './organization/organizationTypes';
import { RESEARCH_RESOURCE_KEYS, TECHNOLOGY_IDS } from './organization/technologySystem';
import { SectorRegion } from './sector/sectorTypes';

export interface CampaignSaveEnvelope {
  type: 'spacewar-campaign';
  v: '0.3';
  state: CampaignState;
}

const FORMATIONS = ['line', 'wedge', 'wall', 'swarm', 'random'];
const DOCTRINES = ['balanced', 'aggressive', 'defensive', 'kite', 'focusFire', 'antiCapital', 'screen'];
const NODE_TYPES = ['start', 'empty', 'resource', 'battle', 'hazard', 'signal', 'gate'];
const VISIBILITIES = ['hidden', 'detected', 'scanned', 'visited'];
const REGIONS: SectorRegion[] = ['safeRoute', 'salvageBelt', 'militaryZone', 'nebula', 'gateApproach'];
const RETREAT_POLICIES: RetreatPolicy[] = ['never', 'loss25', 'loss50', 'lastShip', 'critical'];
const CARGO_TYPES: CargoItemType[] = ['supplyCrate', 'fuelCell', 'repairParts', 'relic'];
const SALVAGE_OPTIONS = ['quick', 'thorough', 'recover', 'leave'];
const EXTRACTION_MODES = ['normal', 'emergency'];
const EXTRACTION_RISKS = ['low', 'medium', 'high', 'critical'];
const COMMANDER_DOMAINS: CommanderDomain[] = ['combat', 'exploration', 'logistics', 'survival'];
const COMMANDER_CONDITIONS: CommanderConditionId[] = ['fatigued', 'shaken', 'wounded', 'scarred'];
const COMMANDER_INJURIES: CommanderInjuryId[] = ['wound', 'burn', 'fracture', 'trauma', 'fatal'];
const SAVE_VERSIONS = ['0.1', '0.2', '0.3'];

function b64(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(source: string): string {
  let value = source.replace(/-/g, '+').replace(/_/g, '/');
  value += '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function inferredRegion(node: any): SectorRegion {
  if (node?.type === 'gate') return 'gateApproach';
  const depth = Number.isInteger(node?.depth) ? node.depth : Math.max(0, Math.round(((Number(node?.x) || 7) - 7) / 14));
  if (depth <= 1) return 'safeRoute';
  if (node?.type === 'battle') return 'militaryZone';
  if (node?.type === 'resource') return 'salvageBelt';
  if (node?.type === 'signal') return 'nebula';
  return 'safeRoute';
}

function migratePendingOrganizationEvent(value: unknown): PendingOrganizationEvent | undefined {
  const raw = value as PendingOrganizationEvent | undefined;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.options)) return undefined;
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    options: raw.options.map((option) => ({
      ...option,
      effect: {
        ...option.effect,
        reputation: option.effect?.reputation ? { ...option.effect.reputation } : undefined,
        research: option.effect?.research ? { ...option.effect.research } : undefined
      }
    }))
  };
}

export function migrateCampaignState(value: unknown): CampaignState | null {
  const raw = value as any;
  if (!raw || typeof raw !== 'object' || !SAVE_VERSIONS.includes(raw.version)) return null;
  // Current-format saves are strict. The only retained V0.9 compatibility path
  // fills fields introduced during the V0.7.1/V0.8 rollout. Organization and
  // technology data are never normalized here: malformed V0.9 content is
  // rejected instead of being silently repaired.
  if (raw.version === CAMPAIGN_VERSION) {
    if (!validateOrganization({ organization: raw.organization, pendingOrganizationEvent: raw.pendingOrganizationEvent } as CampaignState)) {
      return null;
    }
    const nodes = Array.isArray(raw.sector?.nodes)
      ? raw.sector.nodes.map((node: any) => ({
          ...node,
          depth: Number.isInteger(node.depth) && node.depth >= 0
            ? node.depth
            : Math.max(0, Math.round(((Number(node.x) || 7) - 7) / 14)),
          region: REGIONS.includes(node.region) ? node.region : inferredRegion(node),
          feature: node.feature === 'rescue' ? 'rescue' : undefined
        }))
      : [];
    const candidate = {
      ...raw,
      commander: ensureCommanderProfile(raw.commander ?? {}, raw.campaignSeed >>> 0),
      reserveCommanders: Array.isArray(raw.reserveCommanders)
        ? raw.reserveCommanders.map((commander: any) => ensureCommanderProfile(commander, raw.campaignSeed >>> 0))
        : [],
      pendingSuccession: typeof raw.pendingSuccession === 'boolean' ? raw.pendingSuccession : false,
      sector: { ...raw.sector, nodes }
    };
    return validateCampaignState(candidate) ? candidate : null;
  }
  const legacyV06 = raw.version === '0.1';
  const preV09 = raw.version !== '0.3';
  const seed = Number.isInteger(raw.campaignSeed) ? raw.campaignSeed >>> 0 : 0;
  const organization = ensureOrganization(raw.organization, seed);
  const nodes = Array.isArray(raw.sector?.nodes)
    ? raw.sector.nodes.map((node: any) => ({
        ...node,
        depth: Number.isInteger(node.depth) && node.depth >= 0
          ? node.depth
          : Math.max(0, Math.round(((Number(node.x) || 7) - 7) / 14)),
        region: REGIONS.includes(node.region) ? node.region : inferredRegion(node),
        feature: node.feature === 'rescue' ? 'rescue' : undefined
      }))
    : [];
  const pendingBattle = raw.pendingBattle
    ? {
        ...raw.pendingBattle,
        originNodeId: typeof raw.pendingBattle.originNodeId === 'string' ? raw.pendingBattle.originNodeId : undefined,
        retreatPolicy: RETREAT_POLICIES.includes(raw.pendingBattle.retreatPolicy) ? raw.pendingBattle.retreatPolicy : 'loss50'
      }
    : undefined;
  const pendingSalvage = legacyV06 || !raw.pendingSalvage
    ? undefined
    : {
        ...raw.pendingSalvage,
        options: Array.isArray(raw.pendingSalvage.options)
          ? raw.pendingSalvage.options.map((option: any) => ({
              ...option,
              recoveredShip: option?.recoveredShip ? { ...option.recoveredShip } : undefined
            }))
          : []
      };
  const commander = ensureCommanderProfile(raw.commander ?? {}, seed);
  const reserveCommanders = Array.isArray(raw.reserveCommanders)
    ? raw.reserveCommanders.map((candidate: any) => ensureCommanderProfile(candidate, seed))
    : [];
  const pendingRecruitment = raw.pendingRecruitment && typeof raw.pendingRecruitment === 'object'
    ? {
        nodeId: raw.pendingRecruitment.nodeId,
        supplyCost: Number.isInteger(raw.pendingRecruitment.supplyCost) ? raw.pendingRecruitment.supplyCost : 2,
        candidates: Array.isArray(raw.pendingRecruitment.candidates)
          ? raw.pendingRecruitment.candidates.map((candidate: any) => ensureCommanderProfile(candidate, seed))
          : []
      }
    : undefined;
  const migratedCargo = legacyV06
    ? createEmptyCargo(STARTING_CARGO_CAPACITY + organizationCargoBonus(organization))
    : raw.cargo;
  const history = Array.isArray(raw.history) ? [...raw.history] : [];
  if (legacyV06) history.push({ turn: Number.isInteger(raw.turn) ? raw.turn : 0, text: '存档已从 V0.6 迁移到持久战役格式。' });
  if (preV09) history.push({ turn: Number.isInteger(raw.turn) ? raw.turn : 0, text: '存档已迁移到 V0.9 组织与科技格式。' });
  return {
    ...raw,
    version: CAMPAIGN_VERSION,
    campaignSeed: seed,
    commander,
    reserveCommanders,
    pendingRecruitment,
    pendingSuccession: typeof raw.pendingSuccession === 'boolean' ? raw.pendingSuccession : false,
    organization,
    pendingOrganizationEvent: migratePendingOrganizationEvent(raw.pendingOrganizationEvent),
    cargo: migratedCargo,
    extractionPrepared: typeof raw.extractionPrepared === 'boolean' ? raw.extractionPrepared : false,
    fleet: {
      ...raw.fleet,
      ships: Array.isArray(raw.fleet?.ships)
        ? raw.fleet.ships.map((ship: any) => ({
            ...ship,
            towed: typeof ship.towed === 'boolean' ? ship.towed : false,
            deployed: typeof ship.deployed === 'boolean' ? ship.deployed : true
          }))
        : []
    },
    sector: { ...raw.sector, nodes },
    pendingBattle,
    pendingSalvage,
    history
  } as CampaignState;
}

function validateSummary(state: CampaignState): boolean {
  const summary = state.lastSectorSummary;
  if (!summary) return true;
  const nonNegativeInteger = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  return (
    Number.isInteger(summary.sectorIndex) && summary.sectorIndex >= 1 &&
    nonNegativeInteger(summary.turns) &&
    nonNegativeInteger(summary.visitedNodes) &&
    nonNegativeInteger(summary.totalNodes) && summary.visitedNodes <= summary.totalNodes &&
    nonNegativeInteger(summary.shipsRemaining) &&
    nonNegativeInteger(summary.disabledShips) && summary.disabledShips <= summary.shipsRemaining &&
    nonNegativeInteger(summary.cargoUsed) &&
    nonNegativeInteger(summary.cargoCapacity) && summary.cargoUsed <= summary.cargoCapacity &&
    Number.isInteger(summary.threatLevel) && summary.threatLevel >= 0 && summary.threatLevel <= 5 &&
    EXTRACTION_MODES.includes(summary.extractionMode) &&
    EXTRACTION_RISKS.includes(summary.extractionRisk) &&
    nonNegativeInteger(summary.jettisonedUnits) &&
    Array.isArray(summary.damagedInJump) &&
    summary.damagedInJump.every((id) => typeof id === 'string' && id.length > 0)
  );
}

export function validateCampaignCommander(commander: CampaignCommander): boolean {
  const finite = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate);
  if (
    !commander || typeof commander.id !== 'string' || !commander.id ||
    typeof commander.name !== 'string' || !commander.name ||
    !Number.isInteger(commander.level) || commander.level < 1 ||
    !finite(commander.experience) || commander.experience < 0 ||
    typeof commander.alive !== 'boolean' || !commander.attributes || !commander.domainExperience ||
    !Array.isArray(commander.traits) || commander.traits.length !== 2 || new Set(commander.traits).size !== 2 ||
    commander.traits.some((trait) => !COMMANDER_TRAITS.includes(trait)) ||
    !Array.isArray(commander.conditions) || !Array.isArray(commander.injuries)
  ) return false;
  if (!['command', 'tactics', 'logistics', 'resolve'].every((key) => {
    const candidate = commander.attributes![key as keyof typeof commander.attributes];
    return Number.isInteger(candidate) && candidate >= 1 && candidate <= 10;
  })) return false;
  if (!COMMANDER_DOMAINS.every((domain) => finite(commander.domainExperience![domain]) && commander.domainExperience![domain] >= 0)) return false;
  if (commander.conditions.some((condition) =>
    !COMMANDER_CONDITIONS.includes(condition.id) || ![1, 2, 3].includes(condition.severity) ||
    !Number.isInteger(condition.remainingTurns) || condition.remainingTurns < 0
  )) return false;
  return !commander.injuries.some((injury) =>
    !COMMANDER_INJURIES.includes(injury.id) || ![1, 2, 3].includes(injury.severity) ||
    !Number.isInteger(injury.acquiredTurn) || injury.acquiredTurn < 0 ||
    typeof injury.permanent !== 'boolean' || (injury.cause !== undefined && typeof injury.cause !== 'string')
  );
}

function validateEventEffect(effect: OrganizationEventEffect): boolean {
  if (!effect || typeof effect !== 'object') return false;
  const finiteInteger = (candidate: unknown) => candidate === undefined || (typeof candidate === 'number' && Number.isInteger(candidate));
  if (![effect.stability, effect.supplies, effect.fuel, effect.materials, effect.threat].every(finiteInteger)) return false;
  if (effect.reputation && !['civilian', 'military', 'frontier'].every((key) => finiteInteger(effect.reputation![key as keyof typeof effect.reputation]))) return false;
  return !effect.research || RESEARCH_RESOURCE_KEYS.every((key) => finiteInteger(effect.research![key]));
}

function validateOrganizationEvent(event: PendingOrganizationEvent | undefined): boolean {
  if (!event) return true;
  if (
    typeof event.id !== 'string' || !event.id || typeof event.title !== 'string' || !event.title ||
    typeof event.description !== 'string' || !event.description || !Array.isArray(event.options) ||
    event.options.length < 2 || event.options.length > 4 || new Set(event.options.map((option) => option.id)).size !== event.options.length
  ) return false;
  return event.options.every((option) =>
    typeof option.id === 'string' && !!option.id && typeof option.label === 'string' && !!option.label &&
    typeof option.description === 'string' && !!option.description &&
    (option.requiredValue === undefined || ORGANIZATION_VALUES.includes(option.requiredValue)) && validateEventEffect(option.effect)
  );
}

function validateOrganization(state: CampaignState): boolean {
  const organization = state.organization;
  if (
    !organization || typeof organization.id !== 'string' || !organization.id ||
    typeof organization.name !== 'string' || !organization.name ||
    !ORGANIZATION_ARCHETYPES.includes(organization.archetype) || !GOVERNMENT_TYPES.includes(organization.government) ||
    !Array.isArray(organization.values) || organization.values.length !== 2 || new Set(organization.values).size !== 2 ||
    organization.values.some((value) => !ORGANIZATION_VALUES.includes(value)) ||
    !Number.isInteger(organization.stability) || organization.stability < 0 || organization.stability > 100 ||
    !organization.reputation || !organization.research
  ) return false;
  if (!['civilian', 'military', 'frontier'].every((key) => Number.isInteger(organization.reputation[key as keyof typeof organization.reputation]))) return false;
  if (
    !organization.research.resources || !RESEARCH_RESOURCE_KEYS.every((key) => Number.isInteger(organization.research.resources[key]) && organization.research.resources[key] >= 0) ||
    !Number.isInteger(organization.research.slots) || organization.research.slots < 1 || organization.research.slots > 4 ||
    !Array.isArray(organization.research.unlocked) || !Array.isArray(organization.research.installed) ||
    new Set(organization.research.unlocked).size !== organization.research.unlocked.length ||
    new Set(organization.research.installed).size !== organization.research.installed.length ||
    organization.research.unlocked.some((id) => !TECHNOLOGY_IDS.includes(id)) ||
    organization.research.installed.some((id) => !organization.research.unlocked.includes(id)) ||
    organization.research.installed.length > organization.research.slots
  ) return false;
  return validateOrganizationEvent(state.pendingOrganizationEvent);
}

export function validateCampaignState(value: unknown): value is CampaignState {
  const state = value as CampaignState;
  const finite = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate);
  const nonNegativeInteger = (candidate: unknown): candidate is number => finite(candidate) && Number.isInteger(candidate) && candidate >= 0;
  if (
    !state || state.version !== CAMPAIGN_VERSION || !nonNegativeInteger(state.campaignSeed) || state.campaignSeed > 0xffffffff ||
    !Number.isInteger(state.sectorIndex) || state.sectorIndex < 1 || !nonNegativeInteger(state.turn) ||
    !['active', 'victory', 'defeat'].includes(state.status) || typeof state.extractionPrepared !== 'boolean' ||
    typeof state.pendingSuccession !== 'boolean' || !validateOrganization(state)
  ) return false;
  if (state.pendingOrganizationEvent && state.status !== 'active') return false;
  if (!state.resources || ![state.resources.supplies, state.resources.fuel, state.resources.materials].every((candidate) => finite(candidate) && candidate >= 0)) return false;
  if (
    !state.cargo || !nonNegativeInteger(state.cargo.capacity) || !Array.isArray(state.cargo.items) ||
    state.cargo.items.some((stack) => !CARGO_TYPES.includes(stack.type) || !Number.isInteger(stack.quantity) || stack.quantity <= 0) ||
    new Set(state.cargo.items.map((stack) => stack.type)).size !== state.cargo.items.length || cargoUsed(state.cargo) > state.cargo.capacity
  ) return false;
  if (!validateCampaignCommander(state.commander) || !Array.isArray(state.reserveCommanders) || state.reserveCommanders.length > 3) return false;
  const commanderIds = [state.commander.id, ...state.reserveCommanders.map((commander) => commander.id)];
  if (new Set(commanderIds).size !== commanderIds.length || state.reserveCommanders.some((commander) => !validateCampaignCommander(commander))) return false;
  if (state.pendingSuccession && !state.reserveCommanders.some((commander) => isCommanderAvailable(commander, state.campaignSeed))) return false;

  if (!state.fleet || !Array.isArray(state.fleet.ships) || !FORMATIONS.includes(state.fleet.formation) || !DOCTRINES.includes(state.fleet.doctrine)) return false;
  const shipIds = state.fleet.ships.map((ship) => ship.campaignShipId);
  if (new Set(shipIds).size !== shipIds.length) return false;
  if (state.fleet.ships.some((ship) =>
    typeof ship.campaignShipId !== 'string' || !ship.campaignShipId ||
    typeof ship.disabled !== 'boolean' || typeof ship.escaped !== 'boolean' ||
    typeof ship.towed !== 'boolean' || typeof ship.deployed !== 'boolean' ||
    (!ship.disabled && ship.towed) ||
    !validateFleetEntry({ shipClass: ship.shipClass, variant: ship.variant, count: 1 }).valid ||
    (ship.componentHp !== undefined && (!Array.isArray(ship.componentHp) || ship.componentHp.some((hp) => !finite(hp) || hp < 0)))
  )) return false;
  if (
    !state.sector || !nonNegativeInteger(state.sector.seed) || !Array.isArray(state.sector.nodes) ||
    !finite(state.sector.threat?.value) || state.sector.threat.value < 0 ||
    !Number.isInteger(state.sector.threat.level) || state.sector.threat.level < 0 || state.sector.threat.level > 5 ||
    Math.min(5, Math.floor(state.sector.threat.value / 5)) !== state.sector.threat.level ||
    typeof state.sector.gateKnown !== 'boolean'
  ) return false;
  const ids = new Set(state.sector.nodes.map((node) => node.id));
  if (
    ids.size !== state.sector.nodes.length || !ids.has(state.sector.currentNodeId) ||
    state.sector.nodes.filter((node) => node.type === 'start').length !== 1 ||
    state.sector.nodes.filter((node) => node.type === 'gate').length !== 1
  ) return false;
  if (state.sector.nodes.some((node) => {
    if (
      typeof node.id !== 'string' || !node.id || !NODE_TYPES.includes(node.type) || !VISIBILITIES.includes(node.visibility) ||
      !finite(node.x) || !finite(node.y) || !nonNegativeInteger(node.depth) || !REGIONS.includes(node.region) ||
      (node.feature !== undefined && node.feature !== 'rescue') || typeof node.processed !== 'boolean' ||
      typeof node.gathered !== 'boolean' || (node.signalResolved !== undefined && typeof node.signalResolved !== 'boolean') ||
      (node.hazardResolved !== undefined && typeof node.hazardResolved !== 'boolean') ||
      !Array.isArray(node.neighbors) || new Set(node.neighbors).size !== node.neighbors.length
    ) return true;
    return node.neighbors.some((neighborId) => {
      if (neighborId === node.id || !ids.has(neighborId)) return true;
      return !state.sector.nodes.find((candidate) => candidate.id === neighborId)?.neighbors.includes(node.id);
    });
  })) return false;
  if (state.pendingRecruitment) {
    const candidateIds = state.pendingRecruitment.candidates.map((candidate) => candidate.id);
    if (
      state.status !== 'active' || !ids.has(state.pendingRecruitment.nodeId) ||
      !nonNegativeInteger(state.pendingRecruitment.supplyCost) ||
      !Array.isArray(state.pendingRecruitment.candidates) || state.pendingRecruitment.candidates.length < 1 || state.pendingRecruitment.candidates.length > 2 ||
      new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => commanderIds.includes(id)) ||
      state.pendingRecruitment.candidates.some((candidate) => !validateCampaignCommander(candidate))
    ) return false;
  }
  if (state.pendingBattle) {
    const deployment = state.pendingBattle.deployment;
    if (
      state.status !== 'active' || !ids.has(state.pendingBattle.nodeId) ||
      (state.pendingBattle.originNodeId !== undefined && !ids.has(state.pendingBattle.originNodeId)) ||
      !nonNegativeInteger(state.pendingBattle.battleIndex) || typeof state.pendingBattle.reason !== 'string' ||
      !state.pendingBattle.reason || !RETREAT_POLICIES.includes(state.pendingBattle.retreatPolicy ?? 'loss50') || !!state.pendingSalvage
    ) return false;
    if (deployment) {
      const selected = deployment.selectedShipIds;
      const eligible = new Set(state.fleet.ships.filter((ship) => !ship.disabled).map((ship) => ship.campaignShipId));
      if (!Array.isArray(selected) || selected.length < 1 || new Set(selected).size !== selected.length || selected.some((id) => typeof id !== 'string' || !eligible.has(id))) return false;
    }
  }
  if (state.pendingSalvage) {
    const salvage = state.pendingSalvage;
    if (
      state.status !== 'active' || !ids.has(salvage.nodeId) || !nonNegativeInteger(salvage.battleIndex) || !salvage.summary ||
      ![salvage.summary.enemyDestroyed, salvage.summary.enemyDisabled, salvage.summary.ownDestroyed].every(nonNegativeInteger) ||
      !Array.isArray(salvage.options) || salvage.options.length < 3 || salvage.options.length > 4 ||
      new Set(salvage.options.map((option) => option.id)).size !== salvage.options.length ||
      salvage.options.some((option) =>
        !SALVAGE_OPTIONS.includes(option.id) || typeof option.label !== 'string' || typeof option.description !== 'string' ||
        !nonNegativeInteger(option.turns) || !nonNegativeInteger(option.threat) || !Array.isArray(option.items) ||
        option.items.some((item) => !CARGO_TYPES.includes(item.type) || !Number.isInteger(item.quantity) || item.quantity <= 0) ||
        (option.recoveredShip !== undefined && (
          !validateFleetEntry({ shipClass: option.recoveredShip.shipClass, variant: option.recoveredShip.variant, count: 1 }).valid ||
          !finite(option.recoveredShip.componentRatio) || option.recoveredShip.componentRatio <= 0 || option.recoveredShip.componentRatio > 1
        ))
      )
    ) return false;
  }
  return validateSummary(state) && Array.isArray(state.history) && state.history.every((entry) =>
    nonNegativeInteger(entry.turn) && typeof entry.text === 'string' && entry.text.length > 0
  );
}

export function encodeCampaign(state: CampaignState): string {
  if (!validateCampaignState(state)) throw new Error('战役状态无效，无法导出。');
  return b64(JSON.stringify({ type: 'spacewar-campaign', v: CAMPAIGN_VERSION, state } satisfies CampaignSaveEnvelope));
}

export function decodeCampaign(code: string): CampaignState {
  let raw: unknown;
  try { raw = JSON.parse(unb64(code.trim())); }
  catch { throw new Error('战役码格式无法解析。'); }
  const envelope = raw as { type?: string; v?: string; state?: unknown };
  if (envelope.type === 'spacewar-fleet') throw new Error('这是一段舰队方案码，不是战役码。');
  if (envelope.type === 'spacewar-battle' || !envelope.type) throw new Error('这是一段战斗录像码，不是战役码。');
  if (envelope.type !== 'spacewar-campaign') throw new Error('战役码内容无效或版本不支持。');
  const migrated = migrateCampaignState(envelope.state);
  if (!migrated || !validateCampaignState(migrated) || !SAVE_VERSIONS.includes(envelope.v ?? '')) {
    throw new Error('战役码内容无效或版本不支持。');
  }
  return migrated;
}

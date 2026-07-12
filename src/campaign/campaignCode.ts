import { CampaignState } from './campaignTypes';
import { validateFleetEntry } from '../sim/fleetValidator';

export interface CampaignSaveEnvelope {
  type: 'spacewar-campaign';
  v: '0.1';
  state: CampaignState;
}

const FORMATIONS = ['line', 'wedge', 'wall', 'swarm', 'random'];
const DOCTRINES = ['balanced', 'aggressive', 'defensive', 'kite', 'focusFire', 'antiCapital', 'screen'];
const NODE_TYPES = ['start', 'empty', 'resource', 'battle', 'hazard', 'signal', 'gate'];
const VISIBILITIES = ['hidden', 'detected', 'scanned', 'visited'];

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

export function validateCampaignState(value: unknown): value is CampaignState {
  const state = value as CampaignState;
  const finite = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate);
  const nonNegativeInteger = (candidate: unknown): candidate is number =>
    finite(candidate) && Number.isInteger(candidate) && candidate >= 0;

  if (
    !state ||
    state.version !== '0.1' ||
    !nonNegativeInteger(state.campaignSeed) ||
    state.campaignSeed > 0xffffffff ||
    !Number.isInteger(state.sectorIndex) ||
    state.sectorIndex < 1 ||
    !nonNegativeInteger(state.turn) ||
    !['active', 'victory', 'defeat'].includes(state.status)
  ) {
    return false;
  }

  if (
    !state.resources ||
    ![state.resources.supplies, state.resources.fuel, state.resources.materials].every(
      (candidate) => finite(candidate) && candidate >= 0
    )
  ) {
    return false;
  }

  if (
    !state.commander ||
    typeof state.commander.id !== 'string' ||
    !state.commander.id ||
    typeof state.commander.name !== 'string' ||
    !state.commander.name ||
    !Number.isInteger(state.commander.level) ||
    state.commander.level < 1 ||
    !finite(state.commander.experience) ||
    state.commander.experience < 0 ||
    typeof state.commander.alive !== 'boolean'
  ) {
    return false;
  }

  if (
    !state.fleet ||
    !Array.isArray(state.fleet.ships) ||
    !FORMATIONS.includes(state.fleet.formation) ||
    !DOCTRINES.includes(state.fleet.doctrine)
  ) {
    return false;
  }

  const campaignShipIds = state.fleet.ships.map((ship) => ship.campaignShipId);
  if (new Set(campaignShipIds).size !== campaignShipIds.length) return false;
  if (
    state.fleet.ships.some(
      (ship) =>
        typeof ship.campaignShipId !== 'string' ||
        !ship.campaignShipId ||
        typeof ship.disabled !== 'boolean' ||
        typeof ship.escaped !== 'boolean' ||
        !validateFleetEntry({ shipClass: ship.shipClass, variant: ship.variant, count: 1 }).valid ||
        (ship.componentHp !== undefined &&
          (!Array.isArray(ship.componentHp) ||
            ship.componentHp.some((hp) => !finite(hp) || hp < 0)))
    )
  ) {
    return false;
  }

  if (
    !state.sector ||
    !nonNegativeInteger(state.sector.seed) ||
    !Array.isArray(state.sector.nodes) ||
    !finite(state.sector.threat?.value) ||
    state.sector.threat.value < 0 ||
    !Number.isInteger(state.sector.threat.level) ||
    state.sector.threat.level < 0 ||
    state.sector.threat.level > 5 ||
    Math.min(5, Math.floor(state.sector.threat.value / 5)) !== state.sector.threat.level ||
    typeof state.sector.gateKnown !== 'boolean'
  ) {
    return false;
  }

  const ids = new Set(state.sector.nodes.map((node) => node.id));
  if (
    ids.size !== state.sector.nodes.length ||
    !ids.has(state.sector.currentNodeId) ||
    state.sector.nodes.filter((node) => node.type === 'start').length !== 1 ||
    state.sector.nodes.filter((node) => node.type === 'gate').length !== 1
  ) {
    return false;
  }

  if (
    state.sector.nodes.some((node) => {
      if (
        typeof node.id !== 'string' ||
        !node.id ||
        !NODE_TYPES.includes(node.type) ||
        !VISIBILITIES.includes(node.visibility) ||
        !finite(node.x) ||
        !finite(node.y) ||
        typeof node.processed !== 'boolean' ||
        typeof node.gathered !== 'boolean' ||
        (node.signalResolved !== undefined && typeof node.signalResolved !== 'boolean') ||
        (node.hazardResolved !== undefined && typeof node.hazardResolved !== 'boolean') ||
        !Array.isArray(node.neighbors) ||
        new Set(node.neighbors).size !== node.neighbors.length
      ) {
        return true;
      }
      return node.neighbors.some((neighborId) => {
        if (neighborId === node.id || !ids.has(neighborId)) return true;
        const neighbor = state.sector.nodes.find((candidate) => candidate.id === neighborId);
        return !neighbor?.neighbors.includes(node.id);
      });
    })
  ) {
    return false;
  }

  if (state.pendingBattle) {
    if (
      state.status !== 'active' ||
      !ids.has(state.pendingBattle.nodeId) ||
      !nonNegativeInteger(state.pendingBattle.battleIndex) ||
      typeof state.pendingBattle.reason !== 'string' ||
      !state.pendingBattle.reason
    ) {
      return false;
    }
  }

  return true;
}

export function encodeCampaign(state: CampaignState): string {
  if (!validateCampaignState(state)) throw new Error('战役状态无效，无法导出。');
  return b64(
    JSON.stringify({ type: 'spacewar-campaign', v: '0.1', state } satisfies CampaignSaveEnvelope)
  );
}

export function decodeCampaign(code: string): CampaignState {
  let raw: unknown;
  try {
    raw = JSON.parse(unb64(code.trim()));
  } catch {
    throw new Error('战役码格式无法解析。');
  }

  const envelope = raw as { type?: string; v?: string; state?: unknown };
  if (envelope.type === 'spacewar-fleet') {
    throw new Error('这是一段舰队方案码，不是战役码。');
  }
  if (envelope.type === 'spacewar-battle' || !envelope.type) {
    throw new Error('这是一段战斗录像码，不是战役码。');
  }
  if (
    envelope.type !== 'spacewar-campaign' ||
    envelope.v !== '0.1' ||
    !validateCampaignState(envelope.state)
  ) {
    throw new Error('战役码内容无效或版本不支持。');
  }
  return envelope.state;
}

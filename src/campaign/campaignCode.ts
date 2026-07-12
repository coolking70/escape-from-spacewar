import { CampaignState } from './campaignTypes';
import { validateFleetEntry } from '../sim/fleetValidator';
export interface CampaignSaveEnvelope { type: 'spacewar-campaign'; v: '0.1'; state: CampaignState; }
function b64(s: string) { const bytes = new TextEncoder().encode(s); let text = ''; for (const b of bytes) text += String.fromCharCode(b); return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64(s: string) { let v = s.replace(/-/g, '+').replace(/_/g, '/'); v += '='.repeat((4 - v.length % 4) % 4); const bin = atob(v); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }
export function validateCampaignState(value: unknown): value is CampaignState {
  const s = value as CampaignState; const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!s || s.version !== '0.1' || !finite(s.campaignSeed) || !Number.isInteger(s.sectorIndex) || s.sectorIndex < 1 || !finite(s.turn) || !['active','victory','defeat'].includes(s.status)) return false;
  if (!s.resources || ![s.resources.supplies,s.resources.fuel,s.resources.materials].every((v) => finite(v) && v >= 0) || !s.commander || !s.commander.id || !s.commander.name || !finite(s.commander.level) || !finite(s.commander.experience)) return false;
  if (!s.fleet || !Array.isArray(s.fleet.ships) || new Set(s.fleet.ships.map((ship) => ship.campaignShipId)).size !== s.fleet.ships.length || s.fleet.ships.some((ship) => !ship.campaignShipId || !validateFleetEntry({ shipClass: ship.shipClass, variant: ship.variant, count: 1 }).valid || ship.componentHp?.some((hp) => !finite(hp) || hp < 0))) return false;
  if (!s.sector || !Array.isArray(s.sector.nodes) || !finite(s.sector.threat.value) || Math.floor(s.sector.threat.value / 5) !== s.sector.threat.level) return false;
  const ids = new Set(s.sector.nodes.map((node) => node.id)); if (ids.size !== s.sector.nodes.length || !ids.has(s.sector.currentNodeId) || s.sector.nodes.filter((node) => node.type === 'start').length !== 1 || s.sector.nodes.filter((node) => node.type === 'gate').length !== 1) return false;
  if (s.sector.nodes.some((node) => !node.id || !['start','empty','resource','battle','hazard','signal','gate'].includes(node.type) || !['hidden','detected','scanned','visited'].includes(node.visibility) || node.neighbors.some((id) => !ids.has(id) || !s.sector.nodes.find((other) => other.id === id)!.neighbors.includes(node.id)))) return false;
  return !s.pendingBattle || ids.has(s.pendingBattle.nodeId);
}
export function encodeCampaign(state: CampaignState): string { if (!validateCampaignState(state)) throw new Error('战役状态无效，无法导出。'); return b64(JSON.stringify({ type: 'spacewar-campaign', v: '0.1', state } satisfies CampaignSaveEnvelope)); }
export function decodeCampaign(code: string): CampaignState { let raw: unknown; try { raw = JSON.parse(unb64(code.trim())); } catch { throw new Error('战役码格式无法解析。'); } const e = raw as { type?: string; v?: string; state?: unknown }; if (e.type === 'spacewar-fleet') throw new Error('这是一段舰队方案码，不是战役码。'); if (e.type === 'spacewar-battle' || !e.type) throw new Error('这是一段战斗录像码，不是战役码。'); if (e.type !== 'spacewar-campaign' || e.v !== '0.1' || !validateCampaignState(e.state)) throw new Error('战役码内容无效或版本不支持。'); return e.state; }

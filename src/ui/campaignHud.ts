import { cargoUsed } from '../campaign/cargo/cargoSystem';
import {
  COMMANDER_TRAIT_LABEL,
  ensureCommanderProfile
} from '../campaign/commander/commanderSystem';
import { CampaignState } from '../campaign/campaignTypes';
import { disabledShips, towedShipCount } from '../campaign/fleet/persistentFleet';
import {
  GOVERNMENT_LABEL,
  ORGANIZATION_ARCHETYPE_LABEL
} from '../campaign/organization/organizationSystem';
import { escapeHtml } from './html';

export function campaignHud(state: CampaignState): string {
  const disabled = disabledShips(state.fleet).length;
  const towed = towedShipCount(state.fleet);
  const commander = ensureCommanderProfile(state.commander, state.campaignSeed);
  const traits = commander.traits.map((trait) => COMMANDER_TRAIT_LABEL[trait]).join(' / ');
  const attrs = commander.attributes;
  const organization = state.organization;
  return `<div class="campaign-hud"><b>星域 ${state.sectorIndex}/3</b><span>回合 ${state.turn}</span><span>威胁 L${state.sector.threat.level} (${state.sector.threat.value})</span><span>补给 ${state.resources.supplies}</span><span>燃料 ${state.resources.fuel}</span><span>材料 ${state.resources.materials}</span><span>货舱 ${cargoUsed(state.cargo)}/${state.cargo.capacity}</span><span>舰船 ${state.fleet.ships.length}</span><span>失能 ${disabled}</span><span>拖曳 ${towed}</span><span>组织稳定 ${organization.stability}</span><span class="organization-summary"><b>${escapeHtml(organization.name)}</b> · ${ORGANIZATION_ARCHETYPE_LABEL[organization.archetype]} / ${GOVERNMENT_LABEL[organization.government]}</span><span class="commander-summary"><b>${escapeHtml(commander.name)}</b> Lv.${commander.level} · 指挥 ${attrs.command} / 战术 ${attrs.tactics} / 后勤 ${attrs.logistics} / 意志 ${attrs.resolve} · ${traits}</span></div>`;
}

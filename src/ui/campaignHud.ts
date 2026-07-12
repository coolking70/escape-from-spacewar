import { cargoUsed } from '../campaign/cargo/cargoSystem';
import { CampaignState } from '../campaign/campaignTypes';
import { disabledShips, towedShipCount } from '../campaign/fleet/persistentFleet';

export function campaignHud(state: CampaignState): string {
  const disabled = disabledShips(state.fleet).length;
  const towed = towedShipCount(state.fleet);
  return `<div class="campaign-hud"><b>星域 ${state.sectorIndex}/3</b><span>回合 ${state.turn}</span><span>威胁 L${state.sector.threat.level} (${state.sector.threat.value})</span><span>补给 ${state.resources.supplies}</span><span>燃料 ${state.resources.fuel}</span><span>材料 ${state.resources.materials}</span><span>货舱 ${cargoUsed(state.cargo)}/${state.cargo.capacity}</span><span>舰船 ${state.fleet.ships.length}</span><span>失能 ${disabled}</span><span>拖曳 ${towed}</span></div>`;
}

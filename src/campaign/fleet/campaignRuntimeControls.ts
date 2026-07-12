import { BattleState } from '../../sim/battleTypes';
import { RetreatPolicy } from '../campaignTypes';

interface RuntimeSimulator {
  step: () => unknown;
  __campaignRetreatWrapped?: boolean;
}

interface AppRuntime {
  battleOrigin: 'single' | 'campaign';
  state: BattleState | null;
  sim: RuntimeSimulator | null;
  campaign: { pendingBattle?: { retreatPolicy?: RetreatPolicy } } | null;
  campaignBattleContext: { battleSeed: number; bindings: unknown[] } | null;
  hudRoot: HTMLElement;
}

export function shouldOrderCampaignRetreat(
  state: BattleState,
  policy: RetreatPolicy,
  initialShips: number
): boolean {
  if (policy === 'never' || state.finished || initialShips <= 0) return false;
  const present = state.ships.filter(
    (ship) => ship.team === 'A' && ship.combatState !== 'destroyed' && ship.combatState !== 'escaped'
  );
  if (policy === 'loss25') return present.length <= Math.max(1, Math.floor(initialShips * 0.75));
  if (policy === 'loss50') return present.length <= Math.max(1, Math.floor(initialShips * 0.5));
  if (policy === 'lastShip') return present.length <= 1;
  return present.some((ship) => {
    const core = ship.components.find((component) => component.def.type === 'core');
    return !!core && core.hp / core.maxHp <= 0.35;
  });
}

export function orderTeamRetreat(state: BattleState, reason = '玩家下令全舰撤退'): number {
  let ordered = 0;
  for (const ship of state.ships) {
    if (
      ship.team !== 'A' ||
      ship.combatState === 'destroyed' ||
      ship.combatState === 'escaped' ||
      ship.mobilityDisabled
    ) continue;
    if (ship.retreatStartedTick === undefined) {
      ship.retreatStartedTick = state.tick;
      ship.retreatReason = reason;
      if (ship.combatState !== 'disabled') ship.combatState = 'retreating';
      ordered++;
    }
  }
  return ordered;
}

function ensureButton(runtime: AppRuntime): HTMLButtonElement | null {
  const controls = runtime.hudRoot?.querySelector('.hud-controls');
  if (!controls) return null;
  let button = runtime.hudRoot.querySelector('#hudCampaignRetreat') as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement('button');
    button.id = 'hudCampaignRetreat';
    button.className = 'btn ctrl danger';
    button.textContent = '全舰撤退';
    controls.appendChild(button);
  }
  return button;
}

function wrapAutomaticRetreat(runtime: AppRuntime): void {
  const sim = runtime.sim;
  const context = runtime.campaignBattleContext;
  if (!sim || !context || sim.__campaignRetreatWrapped) return;

  const originalStep = sim.step.bind(sim);
  let retreatOrdered = false;
  sim.step = () => {
    const result = originalStep();
    const state = runtime.state;
    if (
      !retreatOrdered &&
      runtime.battleOrigin === 'campaign' &&
      state &&
      !state.finished
    ) {
      const policy = runtime.campaign?.pendingBattle?.retreatPolicy ?? 'loss50';
      if (shouldOrderCampaignRetreat(state, policy, context.bindings.length)) {
        retreatOrdered = orderTeamRetreat(state, `自动撤退策略：${policy}`) > 0;
      }
    }
    return result;
  };
  sim.__campaignRetreatWrapped = true;
}

export function installCampaignRuntimeControls(app: unknown): void {
  const runtime = app as AppRuntime;

  const loop = () => {
    const state = runtime.state;
    const context = runtime.campaignBattleContext;
    const campaignBattle = runtime.battleOrigin === 'campaign' && !!state && !!context;
    const button = ensureButton(runtime);
    if (button) {
      button.style.display = campaignBattle && !state?.finished ? '' : 'none';
      button.onclick = () => {
        if (!runtime.state || runtime.battleOrigin !== 'campaign') return;
        orderTeamRetreat(runtime.state);
      };
    }
    if (campaignBattle) wrapAutomaticRetreat(runtime);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

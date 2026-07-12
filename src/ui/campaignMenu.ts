import { queueCommanderCreation } from '../campaign/campaignGenerator';
import {
  COMMANDER_FOCUSES,
  COMMANDER_FOCUS_LABEL
} from '../campaign/commander/commanderSystem';
import type { CommanderCreationOptions, CommanderFocus } from '../campaign/commander/commanderTypes';

export class CampaignMenu {
  constructor(
    private root: HTMLElement,
    private cb: {
      onSingle: () => void;
      onNew: (options: CommanderCreationOptions) => void;
      onContinue: () => void;
      onImport: (code: string) => void;
      hasSave: () => boolean;
    }
  ) {}

  show(): void {
    const focuses = COMMANDER_FOCUSES.map(
      (focus) => `<option value="${focus}">${COMMANDER_FOCUS_LABEL[focus]}</option>`
    ).join('');
    this.root.innerHTML = `<div class="campaign-menu"><h1>Escape from SpaceWar</h1><p>星域 Roguelike 战役</p><div class="commander-create"><h2>创建指挥官</h2><label>姓名 <input id="cm-name" maxlength="24" value="星域指挥官"></label><label>初始专长 <select id="cm-focus">${focuses}</select></label><small>专长会调整初始属性并保证一个对应特质；其余属性仍由战役 seed 确定。</small><button class="btn primary" id="cm-new">开始新战役</button></div><button class="btn" id="cm-continue" ${this.cb.hasSave() ? '' : 'disabled'}>继续战役</button><button class="btn" id="cm-single">单场战斗</button><textarea id="cm-import" placeholder="粘贴 Campaign Code"></textarea><button class="btn" id="cm-import-btn">导入战役码</button></div>`;
    (this.root.querySelector('#cm-new') as HTMLButtonElement).onclick = () => {
      const options: CommanderCreationOptions = {
        name: (this.root.querySelector('#cm-name') as HTMLInputElement).value.trim() || '星域指挥官',
        focus: (this.root.querySelector('#cm-focus') as HTMLSelectElement).value as CommanderFocus
      };
      queueCommanderCreation(options);
      this.cb.onNew(options);
    };
    (this.root.querySelector('#cm-continue') as HTMLButtonElement).onclick = this.cb.onContinue;
    (this.root.querySelector('#cm-single') as HTMLButtonElement).onclick = this.cb.onSingle;
    (this.root.querySelector('#cm-import-btn') as HTMLButtonElement).onclick = () =>
      this.cb.onImport((this.root.querySelector('#cm-import') as HTMLTextAreaElement).value);
  }

  hide(): void {
    this.root.innerHTML = '';
  }
}

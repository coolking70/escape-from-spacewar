import { queueCommanderCreation, queueOrganizationCreation } from '../campaign/campaignGenerator';
import {
  COMMANDER_FOCUSES,
  COMMANDER_FOCUS_LABEL
} from '../campaign/commander/commanderSystem';
import type { CommanderCreationOptions, CommanderFocus } from '../campaign/commander/commanderTypes';
import {
  GOVERNMENT_LABEL,
  GOVERNMENT_TYPES,
  ORGANIZATION_ARCHETYPE_LABEL,
  ORGANIZATION_ARCHETYPES,
  ORGANIZATION_VALUE_LABEL,
  ORGANIZATION_VALUES
} from '../campaign/organization/organizationSystem';
import type {
  GovernmentType,
  OrganizationArchetype,
  OrganizationCreationOptions,
  OrganizationValue
} from '../campaign/organization/organizationTypes';

export class CampaignMenu {
  constructor(
    private root: HTMLElement,
    private cb: {
      onSingle: () => void;
      onNew: (options: CommanderCreationOptions) => void;
      onContinue: () => void;
      onImport: (code: string) => void;
      hasSave: () => boolean;
      onStrategicNew: (factionName: string) => void;
      onStrategicContinue: () => void;
      onStrategicImport: (code: string) => void;
      hasStrategicSave: () => boolean;
    }
  ) {}

  show(): void {
    const focuses = COMMANDER_FOCUSES.map(
      (focus) => `<option value="${focus}">${COMMANDER_FOCUS_LABEL[focus]}</option>`
    ).join('');
    const archetypes = ORGANIZATION_ARCHETYPES.map(
      (archetype) => `<option value="${archetype}">${ORGANIZATION_ARCHETYPE_LABEL[archetype]}</option>`
    ).join('');
    const governments = GOVERNMENT_TYPES.map(
      (government) => `<option value="${government}">${GOVERNMENT_LABEL[government]}</option>`
    ).join('');
    const values = ORGANIZATION_VALUES.map(
      (value) => `<option value="${value}">${ORGANIZATION_VALUE_LABEL[value]}</option>`
    ).join('');
    this.root.innerHTML = `<div class="campaign-menu"><h1>Escape from SpaceWar</h1><p>单场战斗、FTL 式远征与战略宇宙实验模式</p><div class="commander-create"><h2>FTL 式星域战役</h2><label>指挥官姓名 <input id="cm-name" maxlength="24" value="星域指挥官"></label><label>初始专长 <select id="cm-focus">${focuses}</select></label><small>保留现有七层航道、战斗、打捞、指挥官和组织科技玩法。</small></div><div class="organization-create"><h2>创建远征组织</h2><label>组织名称 <input id="cm-org-name" maxlength="32" value="深空远征团"></label><label>组织原型 <select id="cm-org-archetype">${archetypes}</select></label><label>政体 <select id="cm-org-government">${governments}</select></label><div class="organization-values"><label>价值观一 <select id="cm-org-value-a">${values}</select></label><label>价值观二 <select id="cm-org-value-b">${values}</select></label></div></div><button class="btn primary" id="cm-new">开始星域战役</button><button class="btn" id="cm-continue" ${this.cb.hasSave() ? '' : 'disabled'}>继续星域战役</button><textarea id="cm-import" placeholder="粘贴 Campaign Code"></textarea><button class="btn" id="cm-import-btn">导入战役码</button><div class="strategic-create"><h2>战略宇宙 · V1.0 垂直切片</h2><p>生成持久星系、行星、空间站和资源带，经营一个轨道基地并推进建造与科研队列。</p><label>势力名称 <input id="cm-strategy-name" maxlength="32" value="深空开拓局"></label><button class="btn primary" id="cm-strategy-new">创建战略宇宙</button><button class="btn" id="cm-strategy-continue" ${this.cb.hasStrategicSave() ? '' : 'disabled'}>继续战略宇宙</button><textarea id="cm-strategy-import" placeholder="粘贴 Strategic Universe Code"></textarea><button class="btn" id="cm-strategy-import-btn">导入战略宇宙码</button></div><button class="btn" id="cm-single">单场战斗</button></div>`;
    (this.root.querySelector('#cm-org-value-a') as HTMLSelectElement).value = 'knowledge';
    (this.root.querySelector('#cm-org-value-b') as HTMLSelectElement).value = 'unity';
    (this.root.querySelector('#cm-new') as HTMLButtonElement).onclick = () => {
      const options: CommanderCreationOptions = {
        name: (this.root.querySelector('#cm-name') as HTMLInputElement).value.trim() || '星域指挥官',
        focus: (this.root.querySelector('#cm-focus') as HTMLSelectElement).value as CommanderFocus
      };
      const valueA = (this.root.querySelector('#cm-org-value-a') as HTMLSelectElement).value as OrganizationValue;
      const valueB = (this.root.querySelector('#cm-org-value-b') as HTMLSelectElement).value as OrganizationValue;
      if (valueA === valueB) {
        alert('组织必须选择两项不同的价值观。');
        return;
      }
      const organization: OrganizationCreationOptions = {
        name: (this.root.querySelector('#cm-org-name') as HTMLInputElement).value.trim() || '深空远征团',
        archetype: (this.root.querySelector('#cm-org-archetype') as HTMLSelectElement).value as OrganizationArchetype,
        government: (this.root.querySelector('#cm-org-government') as HTMLSelectElement).value as GovernmentType,
        values: [valueA, valueB]
      };
      queueCommanderCreation(options);
      queueOrganizationCreation(organization);
      this.cb.onNew(options);
    };
    (this.root.querySelector('#cm-continue') as HTMLButtonElement).onclick = this.cb.onContinue;
    (this.root.querySelector('#cm-import-btn') as HTMLButtonElement).onclick = () =>
      this.cb.onImport((this.root.querySelector('#cm-import') as HTMLTextAreaElement).value);
    (this.root.querySelector('#cm-strategy-new') as HTMLButtonElement).onclick = () =>
      this.cb.onStrategicNew((this.root.querySelector('#cm-strategy-name') as HTMLInputElement).value.trim() || '深空开拓局');
    (this.root.querySelector('#cm-strategy-continue') as HTMLButtonElement).onclick = this.cb.onStrategicContinue;
    (this.root.querySelector('#cm-strategy-import-btn') as HTMLButtonElement).onclick = () =>
      this.cb.onStrategicImport((this.root.querySelector('#cm-strategy-import') as HTMLTextAreaElement).value);
    (this.root.querySelector('#cm-single') as HTMLButtonElement).onclick = this.cb.onSingle;
  }

  hide(): void {
    this.root.innerHTML = '';
  }
}

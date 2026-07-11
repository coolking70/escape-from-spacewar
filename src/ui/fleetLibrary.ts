// 舰队库 UI：管理舰队方案的保存 / 载入 / 导入 / 导出 / 重命名 / 复制 / 删除。
// 区分"内置预设"（只读）与"用户方案"（localStorage 持久化）。
// 舰队码格式与战斗录像码完全独立，互相误粘贴会给出明确提示。

import { TeamConfig, FleetEntry, FormationType, DoctrineType } from '../sim/battleTypes';
import { FleetPreset, encodeFleet, decodeFleet, makeFleetPreset } from '../sim/fleetPreset';
import {
  loadPresets,
  savePreset,
  deletePreset,
  renamePreset,
  duplicatePreset
} from '../sim/fleetRepository';
import { VARIANT_CN, SHIP_CN } from '../sim/shipVariants';
import { PRESETS } from './setupPanel';

export interface FleetLibraryCallbacks {
  onClose: () => void;
  getTeamConfigs: () => { teamA: TeamConfig; teamB: TeamConfig };
  applyPreset: (
    team: 'a' | 'b',
    fleet: FleetEntry[],
    formation: FormationType,
    doctrine: DoctrineType
  ) => void;
}

interface BuiltinPreset {
  id: string;
  name: string;
  fleet: FleetEntry[];
  formation: FormationType;
  doctrine: DoctrineType;
}

const BUILTIN: BuiltinPreset[] = PRESETS.map((p, i) => ({
  id: 'builtin-' + i,
  name: p.name,
  fleet: p.build(),
  formation: 'line',
  doctrine: 'balanced'
}));

export class FleetLibrary {
  private root: HTMLElement;
  private cb: FleetLibraryCallbacks;
  private overlay!: HTMLElement;

  constructor(root: HTMLElement, cb: FleetLibraryCallbacks) {
    this.root = root;
    this.cb = cb;
    this.render();
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="fleet-lib" id="flRoot" style="display:none">
        <div class="fl-modal">
          <div class="bl-head">
            <h2>舰队库</h2>
            <button class="btn" id="flClose">关闭</button>
          </div>
          <div class="bl-body">
            <div class="fl-save">
              <input id="flName" type="text" placeholder="方案名称（如：我的均衡舰队）" />
              <button class="btn primary" id="flSaveA">保存当前舰队A</button>
              <button class="btn primary" id="flSaveB">保存当前舰队B</button>
            </div>

            <div class="fl-io">
              <textarea id="flCode" placeholder="在此粘贴舰队方案码以导入；导出时此处显示可分享的舰队码"></textarea>
              <div class="fl-io-actions">
                <button class="btn" id="flImport">导入舰队码</button>
                <button class="btn" id="flCopy">复制框内码</button>
              </div>
              <div id="flMsg" class="fl-msg"></div>
            </div>

            <div class="fl-section">
              <div class="bl-section-title">内置预设</div>
              <div id="flBuiltin" class="fl-list"></div>
            </div>
            <div class="fl-section">
              <div class="bl-section-title">我的方案（本地保存）</div>
              <div id="flUser" class="fl-list"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    (this.root.querySelector('#flClose') as HTMLButtonElement).addEventListener('click', () => this.cb.onClose());
    (this.root.querySelector('#flSaveA') as HTMLButtonElement).addEventListener('click', () => this.saveCurrent('a'));
    (this.root.querySelector('#flSaveB') as HTMLButtonElement).addEventListener('click', () => this.saveCurrent('b'));
    (this.root.querySelector('#flImport') as HTMLButtonElement).addEventListener('click', () => this.importCode());
    (this.root.querySelector('#flCopy') as HTMLButtonElement).addEventListener('click', () => this.copyCode());

    this.overlay = this.root.querySelector('#flRoot') as HTMLElement;
  }

  show(): void {
    this.overlay.style.display = 'flex';
    (this.root.querySelector('#flMsg') as HTMLElement).textContent = '';
    this.renderLists();
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  private msg(text: string, isError = false): void {
    const el = this.root.querySelector('#flMsg') as HTMLElement;
    el.textContent = text;
    el.className = 'fl-msg' + (isError ? ' fl-err' : '');
  }

  private fleetSummary(fleet: FleetEntry[]): string {
    if (fleet.length === 0) return '（空）';
    return fleet
      .map((e) => `${SHIP_CN[e.shipClass] ?? e.shipClass}${VARIANT_CN[e.variant] ?? e.variant}×${e.count}`)
      .join('，');
  }

  private renderLists(): void {
    const builtinEl = this.root.querySelector('#flBuiltin') as HTMLElement;
    builtinEl.innerHTML = BUILTIN.map(
      (p) => `
      <div class="fl-item">
        <div class="fl-info">
          <div class="fl-name">${p.name}</div>
          <div class="fl-sum">${this.fleetSummary(p.fleet)} · ${p.formation}/${p.doctrine}</div>
        </div>
        <div class="fl-btns">
          <button class="btn small" data-apply="a" data-id="${p.id}">→A</button>
          <button class="btn small" data-apply="b" data-id="${p.id}">→B</button>
          <button class="btn small" data-export="${p.id}">导出</button>
        </div>
      </div>`
    ).join('');

    const res = loadPresets();
    const userEl = this.root.querySelector('#flUser') as HTMLElement;
    if (!res.ok) {
      userEl.innerHTML = `<div class="fl-msg fl-err">读取本地方案失败：${res.error ?? ''}</div>`;
    } else if (res.presets.length === 0) {
      userEl.innerHTML = '<div class="fl-empty">还没有保存的方案，使用上方"保存当前舰队"创建。</div>';
    } else {
      userEl.innerHTML = res.presets
        .map(
          (p) => `
        <div class="fl-item">
          <div class="fl-info">
            <div class="fl-name">${p.name}</div>
            <div class="fl-sum">${this.fleetSummary(p.fleet)} · ${p.formation}/${p.doctrine}</div>
          </div>
          <div class="fl-btns">
            <button class="btn small" data-apply="a" data-pid="${p.id}">→A</button>
            <button class="btn small" data-apply="b" data-pid="${p.id}">→B</button>
            <button class="btn small" data-export-pid="${p.id}">导出</button>
            <button class="btn small" data-dup="${p.id}">复制</button>
            <button class="btn small" data-rename="${p.id}">改名</button>
            <button class="btn small danger" data-del="${p.id}">删除</button>
          </div>
        </div>`
        )
        .join('');
    }

    // 绑定内置按钮
    builtinEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = btn as HTMLButtonElement;
        const id = b.dataset.id!;
        const p = BUILTIN.find((x) => x.id === id)!;
        if (b.dataset.apply) this.cb.applyPreset(b.dataset.apply as 'a' | 'b', p.fleet, p.formation, p.doctrine);
        else if (b.dataset.export) this.exportPreset(makeFleetPreset({ name: p.name, fleet: p.fleet, formation: p.formation, doctrine: p.doctrine }));
      });
    });

    // 绑定用户按钮
    userEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = btn as HTMLButtonElement;
        const pid = b.dataset.pid || b.dataset.exportPid || b.dataset.dup || b.dataset.rename || b.dataset.del;
        if (!pid) return;
        if (b.dataset.apply) this.applyUser(pid, b.dataset.apply as 'a' | 'b');
        else if (b.dataset.exportPid) this.exportUser(pid);
        else if (b.dataset.dup) this.dupUser(pid);
        else if (b.dataset.rename) this.renameUser(pid);
        else if (b.dataset.del) this.delUser(pid);
      });
    });
  }

  private saveCurrent(team: 'a' | 'b'): void {
    const name = (this.root.querySelector('#flName') as HTMLInputElement).value.trim();
    if (!name) {
      this.msg('请先填写方案名称', true);
      return;
    }
    const cfg = this.cb.getTeamConfigs()[team === 'a' ? 'teamA' : 'teamB'];
    const preset = makeFleetPreset({
      name,
      fleet: cfg.fleet,
      formation: cfg.formation,
      doctrine: cfg.doctrine
    });
    const err = savePreset(preset);
    if (err) this.msg('保存失败：' + err, true);
    else {
      this.msg(`已保存「${name}」（来自舰队${team.toUpperCase()}）`);
      (this.root.querySelector('#flName') as HTMLInputElement).value = '';
      this.renderLists();
    }
  }

  private applyUser(pid: string, team: 'a' | 'b'): void {
    const res = loadPresets();
    if (!res.ok) return;
    const p = res.presets.find((x) => x.id === pid);
    if (!p) return;
    this.cb.applyPreset(team, p.fleet, p.formation, p.doctrine);
    this.msg(`已将「${p.name}」应用到舰队${team.toUpperCase()}`);
  }

  private exportUser(pid: string): void {
    const res = loadPresets();
    if (!res.ok) return;
    const p = res.presets.find((x) => x.id === pid);
    if (!p) return;
    this.exportPreset(p);
  }

  private exportPreset(p: FleetPreset): void {
    const code = encodeFleet(p);
    (this.root.querySelector('#flCode') as HTMLTextAreaElement).value = code;
    this.msg(`已生成「${p.name}」的舰队码，可复制分享`);
  }

  private dupUser(pid: string): void {
    const err = duplicatePreset(pid);
    if (err) this.msg('复制失败：' + err, true);
    else {
      this.msg('已复制为副本');
      this.renderLists();
    }
  }

  private renameUser(pid: string): void {
    const res = loadPresets();
    if (!res.ok) return;
    const p = res.presets.find((x) => x.id === pid);
    if (!p) return;
    const name = window.prompt('重命名方案', p.name);
    if (!name || !name.trim()) return;
    const err = renamePreset(pid, name.trim());
    if (err) this.msg('改名失败：' + err, true);
    else {
      this.msg('已重命名');
      this.renderLists();
    }
  }

  private delUser(pid: string): void {
    const res = loadPresets();
    if (!res.ok) return;
    const p = res.presets.find((x) => x.id === pid);
    if (!p) return;
    if (!window.confirm(`确定删除方案「${p.name}」？此操作不可撤销。`)) return;
    const err = deletePreset(pid);
    if (err) this.msg('删除失败：' + err, true);
    else {
      this.msg('已删除');
      this.renderLists();
    }
  }

  private importCode(): void {
    const code = (this.root.querySelector('#flCode') as HTMLTextAreaElement).value.trim();
    if (!code) {
      this.msg('请先在框内粘贴舰队方案码', true);
      return;
    }
    try {
      const preset = decodeFleet(code);
      const res = loadPresets();
      const existing = res.ok ? res.presets : [];
      const finalName = preset.name && !existing.some((p) => p.name === preset.name)
        ? preset.name
        : (preset.name || '导入的舰队') + '（导入）';
      const toSave = { ...preset, name: finalName };
      const err = savePreset(toSave);
      if (err) this.msg('导入保存失败：' + err, true);
      else {
        this.msg(`已导入并保存「${finalName}」`);
        this.renderLists();
      }
    } catch (e) {
      this.msg('导入失败：' + (e as Error).message, true);
    }
  }

  private copyCode(): void {
    const ta = this.root.querySelector('#flCode') as HTMLTextAreaElement;
    if (!ta.value) {
      this.msg('框内没有可复制的码', true);
      return;
    }
    ta.select();
    navigator.clipboard?.writeText(ta.value).then(
      () => this.msg('已复制'),
      () => this.msg('复制失败，请手动复制')
    );
  }
}

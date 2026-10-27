import { Controller } from './controller';
import { allowedRoute, routePath } from './adapter';
import { legacyRoute } from './legacy-adapter';
import { legacyComponents } from './legacy-angular';
import { components } from './vue';
import { defaults, Halt, type Adapter, type Settings, type Unit } from './model';
import { Store } from './storage';

declare const __APP_VERSION__: string;
const labels: Record<string, string> = { idle: '待开始', running: '运行中', pausing: '正在暂停', paused: '已暂停',
  stopped: '已停止', done: '已完成' };

const styles = `
:host{all:initial!important;position:fixed!important;right:18px!important;bottom:18px!important;z-index:2147483647!important;display:block!important;color-scheme:light!important;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif!important;color:#263044!important}
*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;border:1px solid #d6dce7;border-radius:7px;background:#fff;color:#263044;padding:5px 11px}button:hover{background:#edf1fa}button:disabled{opacity:.45;cursor:default}.primary{background:#6c37a5;color:white;border-color:#6c37a5}.primary:hover{background:#572a89}
.panel{width:min(365px,calc(100vw - 36px));max-height:85vh;overflow:auto;background:white;border:1px solid #dbe0e9;border-radius:14px;box-shadow:0 8px 38px #1c183d33}.header{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:#f6f1fb;border-radius:14px 14px 0 0}.header strong{font-size:15px}.header button{padding:0 8px;font-size:19px}.body{padding:14px 16px}.hint{font-size:12px;color:#697285;margin:8px 0}.status{font-weight:650;color:#67369b}.message{overflow-wrap:anywhere;white-space:pre-wrap;font-size:13px;min-height:42px}.progress{margin:8px 0;width:100%;accent-color:#6c37a5}.row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:9px 0}select{width:100%;border:1px solid #d6dce7;border-radius:7px;padding:7px;background:white;color:inherit}input[type=number]{width:65px;border:1px solid #d6dce7;border-radius:5px;padding:3px}label{font-size:13px}input[type=checkbox]{accent-color:#6c37a5}details{border-top:1px solid #edf0f4;margin-top:10px;padding-top:8px}summary{cursor:pointer;font-size:12px;color:#697285}.logs{max-height:150px;overflow:auto;margin:7px 0;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#aa3040}.mini{border-radius:25px;background:#6c37a5;color:white;padding:10px 16px;box-shadow:0 4px 20px #33174933}.hidden{display:none!important}.actions button{flex:1}.pending{font-size:12px;color:#aa3040;max-height:70px;overflow:auto}.toolbar button{font-size:12px;padding:4px 8px}input[type=text],input[type=password]{width:100%;border:1px solid #d6dce7;border-radius:5px;padding:5px;margin:3px 0}details label{display:block;margin:6px 0}
`;

export class Panel {
  readonly host = document.createElement('tsinghua-exercise-helper');
  private shadow = this.host.attachShadow({ mode: 'open' });
  private units: Unit[] = [];
  private settings: Settings;
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  private observer?: MutationObserver;
  private unsubscribe: () => void;
  private keydown = (e: KeyboardEvent) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyT') { e.preventDefault(); this.reveal(); }
  };
  constructor(private controller: Controller, private adapter: Adapter, private store: Store) {
    this.settings = store.settings();
    this.host.id = 'tsinghua-online-auto';
    const style = document.createElement('style'); style.textContent = styles;
    this.shadow.append(style);
    const frame = document.createElement('div');
    // All variable content is inserted with textContent, never with HTML from the page or answers.
    frame.innerHTML = `
      <button class="mini hidden" id="mini" title="展开练习助手（Alt+Shift+T）">练习助手</button>
      <section class="panel" id="panel" aria-label="清华社练习助手">
        <header class="header"><strong>清华社 · 练习助手 <small id="version"></small></strong><button id="collapse" title="收起">−</button></header>
        <div class="body"><div class="status" id="status" role="status" aria-live="polite"></div>
          <p class="message" id="message"></p>
          <label for="units">当前练习</label><select id="units" aria-label="当前练习"></select>
          <div class="row"><label><input id="all" type="checkbox"> 处理本章节全部已加载练习块</label></div>
          <div class="row"><label>口语录音时长 <input id="seconds" type="number" min="3" max="180" step="1"> 秒</label></div>
          <div class="row"><label>角色扮演/跟读录音来源<select id="rolePlayMode">
            <option value="original">原题音频 → Chivox 评测（生成评分）</option>
            <option value="sample">原题音频直填（不评分）</option>
            <option value="microphone">真实麦克风</option>
          </select></label></div>
          <p class="hint">type 9 有原题音频时默认灌入原站 Chivox 生成评分；type 18 角色扮演使用 MiMo TTS 合成台词后再评测。跟读和单词题遵循页面时长。</p>
          <details><summary>MiMo TTS 配置（legacy_18）</summary>
            <label>API Key <input id="mimoApiKey" type="password" autocomplete="off"></label>
            <label>API Base <input id="mimoApiBase" type="text"></label>
            <label>TTS 模型 <input id="mimoTtsModel" type="text"></label>
            <label>TTS 音色 <input id="mimoTtsVoice" type="text"></label>
            <p class="hint">API Key 只保存在当前标签页会话。legacy_18 缺少配置时会暂停，不会退回麦克风。</p>
          </details>
          <progress id="progress" class="progress" value="0" max="1"></progress><div class="hint" id="counts"></div>
          <div class="actions row"><button class="primary" id="start">开始</button><button id="pause">暂停</button><button id="stop">停止</button></div>
          <div id="pending" class="pending"></div>
          <div class="toolbar row"><button id="refresh">重新检测</button><button id="export">导出诊断</button><button id="reset">重置本练习记录</button></div>
          <details><summary>运行日志</summary><div class="logs" id="logs"></div></details>
          <p class="hint">收起后可点右下角按钮，或按 Alt+Shift+T 恢复。</p>
        </div>
      </section>`;
    this.shadow.append(frame);
    this.el('version').textContent = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
    this.input('all').checked = this.settings.allLoaded;
    this.input('seconds').value = String(this.settings.recordingSeconds);
    (this.el('rolePlayMode') as HTMLSelectElement).value = this.settings.rolePlayAudioMode;
    this.input('mimoApiKey').value = this.settings.mimoApiKey;
    this.input('mimoApiBase').value = this.settings.mimoApiBase;
    this.input('mimoTtsModel').value = this.settings.mimoTtsModel;
    this.input('mimoTtsVoice').value = this.settings.mimoTtsVoice;
    this.el('collapse').addEventListener('click', () => {
      this.el('panel').classList.add('hidden'); this.el('mini').classList.remove('hidden');
    });
    this.el('mini').addEventListener('click', () => this.reveal());
    this.el('refresh').addEventListener('click', () => this.refresh(true));
    this.el('export').addEventListener('click', () => this.download());
    this.el('start').addEventListener('click', () => {
      const unit = this.selected();
      if (!unit) { this.controller.report('NO_UNIT', '请打开教材或课程的日常练习页后重新检测', true); return; }
      try {
        const raw = Number(this.input('seconds').value);
        const mode = (this.el('rolePlayMode') as HTMLSelectElement).value;
        this.settings = { ...defaults, allLoaded: this.input('all').checked,
          recordingSeconds: Number.isFinite(raw) ? Math.min(180, Math.max(3, raw)) : defaults.recordingSeconds,
          rolePlayAudioMode: ['original', 'sample', 'microphone'].includes(mode) ?
            mode as Settings['rolePlayAudioMode'] : defaults.rolePlayAudioMode,
          mimoApiKey: this.input('mimoApiKey').value.trim(),
          mimoApiBase: this.input('mimoApiBase').value.trim() || defaults.mimoApiBase,
          mimoTtsModel: this.input('mimoTtsModel').value.trim() || defaults.mimoTtsModel,
          mimoTtsVoice: this.input('mimoTtsVoice').value.trim() || defaults.mimoTtsVoice };
        this.input('seconds').value = String(this.settings.recordingSeconds);
        this.store.saveSettings(this.settings);
        void this.controller.start(unit, this.settings);
      } catch (e) { this.error(e); }
    });
    this.el('pause').addEventListener('click', () => this.controller.pause());
    this.el('stop').addEventListener('click', () => this.controller.pause(true));
    this.el('reset').addEventListener('click', () => {
      const unit = this.selected();
      if (!unit || this.controller.busy) return;
      if (!window.confirm('请先在网页核查作答是否已保存。重置本地记录后可能再次提交本练习，是否继续？')) return;
      try { this.controller.reset(unit); } catch (e) { this.error(e); }
    });
    this.unsubscribe = this.controller.subscribe(() => this.render());
    this.render();
  }
  private el(id: string): HTMLElement { return this.shadow.getElementById(id)!; }
  private input(id: string): HTMLInputElement { return this.el(id) as HTMLInputElement; }
  private error(e: unknown): void {
    this.controller.report(e instanceof Halt ? e.code : 'PANEL_ERROR', e instanceof Halt ? e.message : '页面检测异常，请导出诊断', true);
  }
  private selected(): Unit | undefined {
    return this.units.find(u => u.key === (this.el('units') as HTMLSelectElement).value);
  }
  reveal(): void { this.el('panel').classList.remove('hidden'); this.el('mini').classList.add('hidden'); }
  mount(): void {
    const attach = () => {
      if (!this.disposed && document.body && !this.host.isConnected) document.body.append(this.host);
    };
    attach();
    // Mount does not depend on window.load and also recovers after the SPA replaces the page body.
    this.observer = new MutationObserver(attach);
    this.observer.observe(document.documentElement || document, { childList: true, subtree: true });
    document.addEventListener('keydown', this.keydown);
    this.refresh();
    this.timer = setInterval(() => { if (!this.controller.busy) this.refresh(); }, 3_000);
  }
  refresh(manual = false): void {
    if (this.controller.busy) return;
    try {
      const previous = (this.el('units') as HTMLSelectElement).value;
      this.units = this.adapter.discover();
      const select = this.el('units') as HTMLSelectElement;
      const keys = this.units.map(u => `${u.key}=${u.title}`).join('|');
      if (select.dataset.keys !== keys) {
        select.replaceChildren(); select.dataset.keys = keys;
        for (const unit of this.units) {
          const option = document.createElement('option'); option.value = unit.key; option.textContent = unit.title;
          select.append(option);
        }
        if (!this.units.length) {
          const option = document.createElement('option'); option.value = ''; option.textContent = '未检测到可用练习'; select.append(option);
        }
      }
      const visible = this.units.find(u => { const r = u.root.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      select.value = this.units.some(u => u.key === previous) ? previous : (visible || this.units[0])?.key || '';
      const conflict = this.adapter.conflict();
      if (manual) this.controller.report(conflict ? 'SCRIPT_CONFLICT' : 'DETECTED', conflict ||
        (this.units.length ? `检测到 ${this.units.length} 个练习块` : this.noUnitMessage()), !!conflict);
      else if (this.controller.progress.status === 'idle') {
        this.el('message').textContent = conflict || (this.units.length ? '已检测到日常练习，可以开始' : this.noUnitMessage());
      }
      this.render(false);
    } catch (e) { if (manual) this.error(e); }
  }
  private noUnitMessage(): string {
    if (legacyRoute()) return '已进入旧版课程。请打开习题；若仍未检测到，请刷新网页并导出诊断（旧版组件尚未就绪或网站版本已变化）。';
    if (!allowedRoute()) return '助手已运行。请进入课程或教材的日常练习页；考试页面不会执行。';
    if (!components().length) return '面板已加载，但无法访问页面组件。请确认脚本在页面环境运行，并刷新网页。';
    return '正在等待练习组件。请展开含习题的章节，或点击重新检测。';
  }
  private render(message = true): void {
    const p = this.controller.progress, busy = this.controller.busy;
    this.el('status').textContent = `${labels[p.status]}${p.phase ? ' · ' + p.phase : ''}`;
    if (message) this.el('message').textContent = p.message;
    this.el('counts').textContent = `题目 ${p.completed}/${p.total} · 练习块 ${p.unitsDone}/${p.unitsTotal}${p.type ? ' · ' + p.type : ''}`;
    const progress = this.el('progress') as HTMLProgressElement;
    progress.max = Math.max(p.total, 1); progress.value = p.completed;
    for (const id of ['units', 'seconds', 'all', 'rolePlayMode', 'mimoApiKey', 'mimoApiBase', 'mimoTtsModel', 'mimoTtsVoice', 'refresh', 'reset']) (this.el(id) as HTMLInputElement | HTMLSelectElement).disabled = busy;
    (this.el('start') as HTMLButtonElement).disabled = busy || !this.units.length;
    this.el('start').textContent = p.status === 'paused' || p.status === 'stopped' ? '继续' : '开始';
    (this.el('pause') as HTMLButtonElement).disabled = !busy;
    (this.el('stop') as HTMLButtonElement).disabled = !busy;
    this.el('pending').textContent = p.pending.map(t => `题 ${t.questionId} · ${t.type}：${t.reason}`).join('\n');
    const logs = this.el('logs'); logs.replaceChildren();
    for (const log of this.controller.logs.slice(-35)) {
      const line = document.createElement('div');
      if (log.level === 'error') line.className = 'error';
      line.textContent = `${log.time.slice(11, 19)} [${log.code}] ${log.message}`; logs.append(line);
    }
  }
  diagnostics(): object {
    let units: { catalogId: string; contentId: string }[] = [], componentCount = 0;
    try { units = this.adapter.discover().map(u => ({ catalogId: u.catalogId, contentId: u.contentId })); componentCount = components().length; } catch { /* partial report */ }
    return {
      version: typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__, generatedAt: new Date().toISOString(),
      route: routePath().replace(/(\/legacy\/course-study-student)\/.*/, '$1/[redacted]'), allowedRoute: allowedRoute() || legacyRoute(), readyState: document.readyState,
      platform: legacyRoute() ? 'legacy-angular' : 'modern-vue', legacyComponentCount: legacyComponents().length,
      componentCount, units, scriptConflict: this.adapter.conflict(),
      browser: { microphone: !!navigator.mediaDevices?.getUserMedia, webLocks: !!navigator.locks, secureContext: window.isSecureContext },
      progress: { ...this.controller.progress }, logs: this.controller.logs,
    };
  }
  private download(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.diagnostics(), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'tsinghua-helper-diagnostics.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  dispose(): void {
    this.disposed = true; this.controller.pause(true); this.unsubscribe();
    clearInterval(this.timer); this.observer?.disconnect(); document.removeEventListener('keydown', this.keydown); this.host.remove();
  }
}

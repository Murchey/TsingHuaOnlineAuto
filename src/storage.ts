import { defaults, Halt, type Settings } from './model';

const prefix = 'thoa:v1:';
export interface Checkpoint {
  version: 1;
  key: string;
  fingerprint: string;
  baseline: number;
  expected: Record<string, string>;
  phase: 'pending' | 'verified';
  updatedAt: number;
}

function settingString(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

export class Store {
  constructor(private storage: Storage = localStorage,
    private session: Storage = typeof sessionStorage === 'undefined' ? localStorage : sessionStorage) {}
  settings(): Settings {
    try {
      const raw = JSON.parse(this.storage.getItem(prefix + 'settings') || '{}');
      const mode = ['original', 'sample', 'microphone'].includes(raw.rolePlayAudioMode) ? raw.rolePlayAudioMode :
        (raw.rolePlayExampleAudio === false ? 'microphone' : defaults.rolePlayAudioMode);
      const provider = ['mimo', 'openai'].includes(raw.ttsProvider) ? raw.ttsProvider : defaults.ttsProvider;
      return {
        allLoaded: raw.allLoaded === true,
        continuous: raw.continuous !== false,
        autoRechallenge: raw.autoRechallenge !== false,
        recordingSeconds: typeof raw.recordingSeconds === 'number' && Number.isFinite(raw.recordingSeconds) ?
          Math.min(180, Math.max(3, raw.recordingSeconds)) : defaults.recordingSeconds,
        rolePlayAudioMode: mode,
        aiAnswers: raw.aiAnswers === true,
        aiApiKey: this.readSession(prefix + 'aiApiKey'),
        aiApiBase: settingString(raw.aiApiBase, defaults.aiApiBase, 300),
        aiModel: settingString(raw.aiModel, defaults.aiModel, 120),
        asrApiKey: this.readSession(prefix + 'asrApiKey'),
        asrApiBase: settingString(raw.asrApiBase, defaults.asrApiBase, 300),
        asrModel: settingString(raw.asrModel, defaults.asrModel, 120),
        ttsProvider: provider,
        ttsApiKey: this.readSession(prefix + 'ttsApiKey') || this.readSession(prefix + 'mimoApiKey'),
        ttsApiBase: settingString(raw.ttsApiBase ?? raw.mimoApiBase, defaults.ttsApiBase, 300),
        ttsModel: settingString(raw.ttsModel ?? raw.mimoTtsModel, defaults.ttsModel, 120),
        ttsVoice: settingString(raw.ttsVoice ?? raw.mimoTtsVoice, defaults.ttsVoice, 120),
        timeoutMs: defaults.timeoutMs, intervalMs: defaults.intervalMs,
      };
    } catch {
      return { ...defaults, aiApiKey: this.readSession(prefix + 'aiApiKey'),
        asrApiKey: this.readSession(prefix + 'asrApiKey'),
        ttsApiKey: this.readSession(prefix + 'ttsApiKey') || this.readSession(prefix + 'mimoApiKey') };
    }
  }
  saveSettings(settings: Settings): void {
    const { aiApiKey, asrApiKey, ttsApiKey, ...persisted } = settings;
    this.write(prefix + 'settings', persisted);
    try {
      this.session.setItem(prefix + 'aiApiKey', aiApiKey);
      this.session.setItem(prefix + 'asrApiKey', asrApiKey);
      this.session.setItem(prefix + 'ttsApiKey', ttsApiKey);
    } catch { throw new Halt('STORAGE_WRITE', '无法保存 API Key 到当前会话，请检查浏览器存储设置'); }
  }
  private readSession(key: string): string {
    try { return this.session.getItem(key) || ''; } catch { return ''; }
  }
  read(key: string): Checkpoint | undefined {
    try {
      const raw = this.storage.getItem(prefix + key);
      if (!raw) return undefined;
      const c = JSON.parse(raw) as Checkpoint;
      if (c.version !== 1 || c.key !== key || !['pending', 'verified'].includes(c.phase) ||
          typeof c.fingerprint !== 'string' || !Number.isInteger(c.baseline) || c.baseline < 0 ||
          !c.expected || Array.isArray(c.expected) || typeof c.expected !== 'object' ||
          !Object.entries(c.expected).length || Object.entries(c.expected).some(([k, v]) => !/^[\w-]{1,128}$/.test(k) || !/^[0-9a-f]+$/.test(v))) throw Error();
      return c;
    } catch { throw new Halt('STORAGE_READ', '本地提交记录无法读取；请先在网页核查作答结果，再重置记录'); }
  }
  save(checkpoint: Checkpoint): void { this.write(prefix + checkpoint.key, checkpoint); }
  clearCourse(unitKey: string): void {
    const parts = unitKey.split(':');
    parts.pop();
    const keyPrefix = prefix + parts.join(':') + ':';
    try {
      for (let index = this.storage.length - 1; index >= 0; index--) {
        const key = this.storage.key(index);
        if (key?.startsWith(keyPrefix)) this.storage.removeItem(key);
      }
    } catch { throw new Halt('STORAGE_WRITE', '无法清理目标旧记录，请检查浏览器存储设置'); }
  }
  // The site intermittently renders an exercise without its answer controls. A reload
  // repairs it, so remember only the intent to resume, plus a bounded retry budget.
  requestResume(now = Date.now()): boolean {
    const saved = this.resumeState();
    const state = saved && now - saved.since < 10 * 60_000 ? saved : { count: 0, since: now, requested: false };
    if (state.count >= 3) return false;
    try {
      this.session.setItem(prefix + 'resume', JSON.stringify({ count: state.count + 1, since: state.since, requested: true }));
      return true;
    } catch { return false; }
  }
  takeResume(): boolean {
    const state = this.resumeState();
    if (!state?.requested) return false;
    try { this.session.setItem(prefix + 'resume', JSON.stringify({ ...state, requested: false })); }
    catch { /* ignore */ }
    return true;
  }
  resetResume(): void {
    try { this.session.removeItem(prefix + 'resume'); } catch { /* ignore */ }
  }
  private resumeState(): { count: number; since: number; requested: boolean } | null {
    try {
      const value = JSON.parse(this.session.getItem(prefix + 'resume') || 'null') as
        { count?: unknown; since?: unknown; requested?: unknown } | null;
      if (!value || typeof value !== 'object' || typeof value.count !== 'number' || typeof value.since !== 'number') return null;
      return { count: value.count, since: value.since, requested: value.requested === true };
    } catch { return null; }
  }
  clear(key: string): void {
    try { this.storage.removeItem(prefix + key); }
    catch { throw new Halt('STORAGE_WRITE', '无法重置本地记录，请检查浏览器存储设置'); }
  }
  private write(key: string, value: unknown): void {
    try { this.storage.setItem(key, JSON.stringify(value)); }
    catch { throw new Halt('STORAGE_WRITE', '无法保存本地进度，已暂停以避免重复提交'); }
  }
}

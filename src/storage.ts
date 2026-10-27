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

export class Store {
  constructor(private storage: Storage = localStorage) {}
  settings(): Settings {
    try {
      const raw = JSON.parse(this.storage.getItem(prefix + 'settings') || '{}');
      const mode = ['original', 'sample', 'microphone'].includes(raw.rolePlayAudioMode) ? raw.rolePlayAudioMode :
        (raw.rolePlayExampleAudio === false ? 'microphone' : defaults.rolePlayAudioMode);
      return {
        allLoaded: raw.allLoaded === true,
        recordingSeconds: typeof raw.recordingSeconds === 'number' && Number.isFinite(raw.recordingSeconds) ?
          Math.min(180, Math.max(3, raw.recordingSeconds)) : defaults.recordingSeconds,
        rolePlayAudioMode: mode,
        timeoutMs: defaults.timeoutMs, intervalMs: defaults.intervalMs,
      };
    } catch { return { ...defaults }; }
  }
  saveSettings(settings: Settings): void { this.write(prefix + 'settings', settings); }
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
  clear(key: string): void {
    try { this.storage.removeItem(prefix + key); }
    catch { throw new Halt('STORAGE_WRITE', '无法重置本地记录，请检查浏览器存储设置'); }
  }
  private write(key: string, value: unknown): void {
    try { this.storage.setItem(key, JSON.stringify(value)); }
    catch { throw new Halt('STORAGE_WRITE', '无法保存本地进度，已暂停以避免重复提交'); }
  }
}

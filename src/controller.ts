import { answerHashes, fingerprint, hasCompleteResponse, isSaved, leaves, planTasks } from './answers';
import { bounded, check, sleep } from './async';
import { Halt, type Adapter, type ExerciseData, type Settings, type Unit } from './model';
import { Store, type Checkpoint } from './storage';

export type Status = 'idle' | 'running' | 'pausing' | 'paused' | 'stopped' | 'done';
export interface Progress {
  status: Status; message: string; phase: string; type: string;
  completed: number; total: number; unitsDone: number; unitsTotal: number;
  pending: { questionId: string; type: string; reason: string }[];
}
export interface Log { time: string; level: 'info' | 'error'; code: string; message: string }
export type WithLock = (key: string, job: () => Promise<void>) => Promise<void>;

export const browserLock: WithLock = async (key, job) => {
  if (!navigator.locks) throw new Halt('NO_LOCK', '此浏览器未提供多标签页互斥锁，请使用新版 Chromium');
  await navigator.locks.request('thoa:' + key, { ifAvailable: true }, async lock => {
    if (!lock) throw new Halt('BUSY_TAB', '另一个标签页正在处理此课程，请先在那里停止');
    await job();
  });
};

function completedOnServer(data: ExerciseData): boolean {
  const records = data.questionAnswerItemVOList || [];
  const qs = leaves(data.questionVOList);
  return (data.answerCount || 0) > 0 && qs.length > 0 && qs.every(q => {
    const rs = records.filter(r => String(r.questionId) === String(q.id));
    if (rs.length !== 1) return false;
    return hasCompleteResponse(q, rs[0].userAnswer);
  });
}

export class Controller {
  progress: Progress = { status: 'idle', message: '请选择当前练习后开始', phase: '', type: '', completed: 0,
    total: 0, unitsDone: 0, unitsTotal: 0, pending: [] };
  logs: Log[] = [];
  private abort?: AbortController;
  private active = false;
  private stopStatus: 'paused' | 'stopped' = 'paused';
  private listeners = new Set<() => void>();
  constructor(public adapter: Adapter, public store: Store, private withLock: WithLock = browserLock,
    private reload: () => void = () => location.reload()) {}
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  // A disposed or broken panel must never turn a worked run into an unhandled rejection.
  private emit(): void { this.listeners.forEach(fn => { try { fn(); } catch { /* UI only */ } }); }
  private update(value: Partial<Progress>): void { Object.assign(this.progress, value); this.emit(); }
  report(code: string, message: string, error = false): void {
    this.logs.push({ time: new Date().toISOString(), level: error ? 'error' : 'info', code, message });
    this.logs = this.logs.slice(-120); this.update({ message });
  }
  get busy(): boolean { return this.active; }
  pause(stopped = false): void {
    if (!this.active) { this.update({ status: stopped ? 'stopped' : 'paused' }); return; }
    this.stopStatus = stopped ? 'stopped' : 'paused';
    this.update({ status: 'pausing', message: '正在中断等待；已发出的提交会在下次运行时重新核对' });
    this.abort?.abort();
  }
  reset(unit: Unit): void {
    if (this.active) throw new Halt('BUSY', '请先停止任务再重置记录');
    this.store.clear(unit.key); this.report('RESET', '本练习的本地提交记录已重置');
  }

  async start(selected: Unit, settings: Settings): Promise<void> {
    if (this.active) return;
    this.active = true; this.abort = new AbortController(); this.stopStatus = 'paused';
    const signal = this.abort.signal;
    this.update({ status: 'running', completed: 0, total: 0, unitsDone: 0, unitsTotal: 0, pending: [], type: '', phase: '检查' });
    try {
      await this.withLock(selected.key.split(':').slice(0, -2).join(':'), async () => {
        check(signal); this.adapter.assertContext(selected);
        let units = settings.allLoaded ? this.adapter.discover().filter(u => u.catalogId === selected.catalogId) : [selected];
        if (!units.some(u => u.key === selected.key)) throw new Halt('STALE_PAGE', '所选练习已离开页面');
        this.update({ unitsTotal: units.length });
        const seen = new Set(units.map(entry => entry.key));
        let index = 0;
        while (index < units.length) {
          const unit = units[index++];
          check(signal); this.adapter.assertContext(unit);
          await this.runUnit(unit, settings, signal);
          this.update({ unitsDone: this.progress.unitsDone + 1 });
          // Legacy course pages expose a first-party next button; follow it until the
          // course reports no reachable next page. Modern Vue blocks keep their old behavior.
          if (settings.continuous && this.adapter.next) {
            const next = await this.adapter.next(unit, signal, settings, () => {
              this.store.clearCourse(unit.key);
              // A genuine Rechallenge intentionally restarts the goal, so those pages
              // may be revisited once. Plain navigation cycles must not.
              seen.clear();
            });
            if (next) {
              if (seen.has(next.key)) {
                throw new Halt('PAGE_CYCLE', '练习在未 Rechallenge 的情况下回到已完成的页面，已停止以避免重复提交');
              }
              seen.add(next.key); units.push(next); this.update({ unitsTotal: units.length });
            }
          }
        }
      });
      check(signal);
      this.update({ status: 'done', phase: '完成', message: '所选练习已完成并重新读取核对' });
    } catch (error) {
      const halt = error instanceof Halt ? error : new Halt('UNEXPECTED', '运行异常，已暂停；请导出诊断并检查页面');
      if (signal.aborted) {
        const status = this.stopStatus as 'paused' | 'stopped';
        this.update({ status, message: status === 'stopped' ? '已停止' : '已暂停，可继续重新核对' });
      }
      else if (halt.code === 'NEEDS_RELOAD') {
        // The legacy page occasionally renders an exercise without its answer controls.
        // A reload repairs it; the resume flag survives the navigation in sessionStorage.
        if (this.store.requestResume()) {
          this.report('RELOAD', '页面作答控件未渲染，正在自动刷新并继续', true);
          this.reload();
        } else {
          this.update({ status: 'paused' });
          this.report('RELOAD_LIMIT', `${halt.message}；已自动刷新 3 次仍未恢复，请手动刷新页面`, true);
        }
      }
      else { this.update({ status: 'paused' }); this.report(halt.code, halt.message, true); }
    } finally { this.active = false; this.emit(); }
  }

  private async runUnit(unit: Unit, settings: Settings, signal: AbortSignal): Promise<void> {
    this.update({ phase: '读取', message: `正在读取${unit.title}`, completed: 0 });
    let data = await this.adapter.load(unit, signal);
    const old = this.store.read(unit.key);
    if (old) {
      if (isSaved(data, old.baseline, old.expected, old.fingerprint)) {
        this.store.save({ ...old, phase: 'verified', updatedAt: Date.now() });
        this.update({ completed: Object.keys(old.expected).length, total: Object.keys(old.expected).length });
        this.report('RECONCILED', '已核对服务器上的提交记录，跳过重复提交');
        this.store.resetResume(); return;
      }
      if (old.phase === 'pending') {
        throw new Halt('PENDING_SUBMIT', '上次提交结果尚不能确认，已阻止再次提交；请在网页核查后重置本地记录');
      }
      // A previously verified checkpoint never authorizes skipping a changed server record.
      // The site does, however, reset a goal's answers while keeping its submit counter;
      // when nothing on the server is complete any more, a fresh attempt is safe.
      const answered = leaves(data.questionVOList).some(question => {
        const record = (data.questionAnswerItemVOList || []).find(entry => String(entry.questionId) === String(question.id));
        return !!record && hasCompleteResponse(question, record.userAnswer);
      });
      // A vanished record (counter 0) stays a hard stop; only a site-side reset that kept
      // the submission counter is safe to retry automatically.
      if (answered || (data.answerCount || 0) <= 0) {
        throw new Halt('RECORD_CHANGED', '服务器作答记录与本地记录不一致，请核查后重置本地记录');
      }
      this.store.clear(unit.key);
    }
    if (completedOnServer(data)) {
      this.update({ completed: leaves(data.questionVOList).length, total: leaves(data.questionVOList).length });
      this.report('ALREADY_SAVED', '服务器已有完整作答记录，保持现有结果');
      this.store.resetResume(); return;
    }
    this.update({ phase: '解析', total: leaves(data.questionVOList).length });
    // Preflight the entire block: no partial random answers or trial submissions to reveal keys.
    let tasks;
    try { tasks = planTasks(data, { allowMissing: settings.aiAnswers }); }
    catch (error) {
      // Some legacy questions ship without a parseable answer. With an AI key present,
      // treat those blanks as missing and let the model generate them instead of pausing.
      if (error instanceof Halt && ['NO_ANSWER', 'AMBIGUOUS'].includes(error.code) && settings.aiApiKey.trim()) {
        tasks = planTasks(data, { allowMissing: true });
        this.report('AI_FALLBACK', '部分题目没有可解析的答案，已改用 AI 生成');
      } else {
        this.update({ pending: leaves(data.questionVOList).map(q => ({ questionId: String(q.id), type: q.type,
          reason: error instanceof Halt ? error.message : '解析失败' })) });
        throw error;
      }
    }
    const mark = fingerprint(data), values = new Map<string, unknown>();
    for (const task of tasks) {
      check(signal); this.adapter.assertContext(unit);
      this.update({ phase: task.kind === 'recording' ? '录音' : '填写', type: task.question.type,
        message: `正在处理题目 ${task.question.id}` });
      const value = task.kind === 'recording' ? await this.adapter.record(unit, task, settings, signal) :
        await this.adapter.fill(unit, task, settings, signal);
      check(signal); values.set(String(task.question.id), value);
      this.update({ completed: values.size });
      await sleep(settings.intervalMs, signal);
    }
    // Recheck the server before any mutation; a manual submission in another window is observable here.
    const latest = await this.adapter.load(unit, signal);
    if (fingerprint(latest) !== mark || (latest.answerCount || 0) !== (data.answerCount || 0)) {
      throw new Halt('DATA_CHANGED', '题目或服务器作答记录在运行期间发生变化，已暂停');
    }
    data = latest;
    const checkpoint: Checkpoint = { version: 1, key: unit.key, fingerprint: mark, baseline: data.answerCount || 0,
      expected: answerHashes(data, values), phase: 'pending', updatedAt: Date.now() };
    check(signal); this.adapter.assertContext(unit);
    this.update({ phase: '提交', message: '正在提交当前练习块' });
    this.store.save(checkpoint);
    // Persist intent before the click, including cases where the page later reports an error.
    await this.adapter.submit(unit, signal);
    this.update({ phase: '核对', message: '正在重新读取服务器作答记录' });
    const deadline = Date.now() + settings.timeoutMs;
    do {
      check(signal); this.adapter.assertContext(unit);
      const saved = await bounded(this.adapter.load(unit, signal), Math.max(1, deadline - Date.now()), signal);
      if (isSaved(saved, checkpoint.baseline, checkpoint.expected, checkpoint.fingerprint)) {
        check(signal);
        this.store.save({ ...checkpoint, phase: 'verified', updatedAt: Date.now() });
        this.report('VERIFIED', '提交成功，已重新读取并逐题核对作答记录');
        this.store.resetResume(); return;
      }
      await sleep(Math.min(1_000, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() < deadline);
    throw new Halt('UNCONFIRMED', '提交结果未能确认，已保留待核对记录并停止；不会自动重复提交');
  }
}

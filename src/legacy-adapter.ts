import { bounded, check, sleep, until } from './async';
import { canonical, object, stable } from './answers';
import { scoreWithChivox } from './chivox';
import { routePath, shown, TsinghuaAdapter } from './adapter';
import { legacyComponents, runInLegacyZone, type LegacyComponent } from './legacy-angular';
import { legacyData, legacyValue, richText } from './legacy-data';
import { Halt, type Adapter, type ExerciseData, type Settings, type Task, type Unit } from './model';

export function legacyRoute(): boolean {
  return /^\/legacy\/course-study-student\/\d+\/\d+\/\d+\/[\w-]+\/?$/.test(routePath());
}

export class LegacyAdapter implements Adapter {
  constructor(private components = legacyComponents) {}
  discover(): Unit[] {
    if (!legacyRoute()) return [];
    return this.components().filter(({ component: c, root }) => root.matches('app-course-task-stu') && shown(root) &&
      root.isConnected && typeof c.loadDoRecord === 'function' && /^[\w-]+$/.test(String(c.pageId || ''))).map(({ component: c, root }) => ({
      key: `${routePath()}:${c.courseId}:${c.pageId}`, catalogId: String(c.courseId), contentId: String(c.pageId), root,
      title: `旧版 · ${String(c.pageTitle || '当前练习')}（${c.exerciseStatus === 1 ? '待作答' : '已提交/结果页'}）`,
    }));
  }
  private instance(unit: Unit): LegacyComponent {
    const matches = this.components().filter(({ component: c, root }) => root === unit.root &&
      String(c.pageId) === unit.contentId && String(c.courseId) === unit.catalogId);
    if (matches.length !== 1) throw new Halt('STALE_PAGE', '旧版练习已切换，请重新检测');
    return matches[0].component;
  }
  assertContext(unit: Unit): void {
    if (!legacyRoute() || !unit.key.startsWith(routePath() + ':') || !unit.root.isConnected || !shown(unit.root)) {
      throw new Halt('PAGE_CHANGED', '页面或课程发生变化，请重新检测');
    }
    const c = this.instance(unit);
    if (c.role !== 4 || c.status !== 1 || ![1, 2].includes(c.flag) ||
        [2, 4, 5].includes(c.data?.isVisiable)) throw new Halt('NOT_PRACTICE', '仅处理开放课程中的学生日常练习');
    const conflict = this.conflict();
    if (conflict) throw new Halt('SCRIPT_CONFLICT', conflict);
  }
  conflict(): string | null { return new TsinghuaAdapter().conflict(); }
  async load(unit: Unit, signal: AbortSignal): Promise<ExerciseData> {
    check(signal); this.assertContext(unit);
    let last: Halt | undefined;
    // The legacy endpoint intermittently returns HTTP 530 for two reads made within
    // the same second. A bounded backoff preserves the pre-submit recheck instead of
    // turning a transient server-busy response into a paused exercise.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(attempt === 1 ? 1_200 : 2_400, signal);
      try { return await this.loadOnce(unit, signal); }
      catch (error) {
        if (!(error instanceof Halt) || error.code !== 'LOAD_FAILED' || !/HTTP 530/.test(error.message)) throw error;
        last = error;
      }
    }
    throw last ?? new Halt('LOAD_FAILED', '旧版练习接口读取失败，已暂停，请检查网络后重试');
  }
  private async loadOnce(unit: Unit, signal: AbortSignal): Promise<ExerciseData> {
    check(signal); this.assertContext(unit);
    const c = this.instance(unit);
    // Use the site's HttpClient so its normal session/interceptors remain in charge.
    // This is the same read-only POST that loadDoRecord uses; never call loadDoRecord here,
    // since it would discard answers being entered in the current component.
    const source = c.http?.post(`/tsenglish/exercise/record_for_detail?courseId=${encodeURIComponent(c.courseId)}&pageId=${encodeURIComponent(c.pageId)}&userId=${encodeURIComponent(c.userId)}`, {});
    if (typeof source?.subscribe !== 'function') throw new Halt('NO_LOADER', '无法访问旧版页面的正常练习读取方法');
    let subscription: { unsubscribe(): void } | undefined;
    try {
      const response = await bounded(new Promise<unknown>((resolve, reject) => {
        subscription = source.subscribe({ next: resolve, error: reject });
      }), 30_000, signal);
      check(signal); this.assertContext(unit);
      const p = object(response);
      if (p.status === false) throw new Halt('LOAD_FAILED', '网站返回练习读取失败，请检查网页提示');
      return legacyData(p.object);
    } catch (error) {
      if (error instanceof Halt) throw error;
      const status = Number(object(error).status);
      throw new Halt([401, 403].includes(status) ? 'LOGIN' : 'LOAD_FAILED',
        [401, 403].includes(status) ? '登录失效或无课程权限，请重新登录' : `旧版练习接口读取失败${status ? `（HTTP ${status}）` : ''}，已暂停，请检查网络后重试`);
    } finally { subscription?.unsubscribe(); }
  }
  private editable(unit: Unit): LegacyComponent {
    this.assertContext(unit);
    const c = this.instance(unit);
    if (c.exerciseStatus !== 1 || c.submitLoading) throw new Halt('READ_ONLY', '当前为已提交的结果页；保持现有结果，请手动选择待作答练习');
    return c;
  }
  private leaf(unit: Unit, task: Task): { component: LegacyComponent; root: HTMLElement } {
    this.editable(unit);
    const rolePlay = task.question.type === 'legacy_9';
    const matches = this.components().filter(({ component: c, root }) => unit.root.contains(root) && root.isConnected &&
      typeof c.doRecordChange?.emit === 'function' && shown(root) &&
      (String(c.exercise?.id) === String(task.question.id) ||
       (rolePlay && (Number(c.exercise?.type) === 9 ||
         typeof c.selectRole === 'function' || typeof c.start === 'function' || typeof c.playVadio === 'function'))));
    const usable = matches.filter(({ component: c }) => ![14, 15, 16, 25].includes(Number(c.exercise?.type)));
    if (!usable.length) throw new Halt('QUESTION_DOM', '旧版作答组件未就绪，请等待题目加载');
    const ranked = usable.map(entry => {
      const c = entry.component;
      let score = 0;
      if (rolePlay) {
        if (Number(c.exercise?.type) === 9) score += 5;
        if (typeof c.selectRole === 'function') score += 4;
        if (typeof c.start === 'function') score += 4;
        if (typeof c.playVadio === 'function') score += 4;
      } else if (!entry.root.tagName.startsWith('LIB-ADAP-')) score += 2;
      score += entry.root.tagName.startsWith('LIB-') ? 1 : 0;
      return { ...entry, score };
    }).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || (ranked.length > 1 && best.score === ranked[1].score)) {
      throw new Halt('QUESTION_DOM', '旧版作答组件未就绪或存在重复，请重新检测');
    }
    if (best.component.status !== 1) throw new Halt('READ_ONLY', '题目不处于可作答状态');
    return best;
  }
  private run(unit: Unit, job: () => void): void {
    this.editable(unit);
    runInLegacyZone(job);
  }
  async fill(unit: Unit, task: Task, signal: AbortSignal): Promise<unknown> {
    check(signal);
    const { component: c, root } = this.leaf(unit, task);
    if (task.kind === 'choice') {
      if (typeof c.answerChange !== 'function') throw new Halt('QUESTION_DOM', '旧版选择题控件已变化');
      const expected = Array.isArray(task.value) ? task.value : [task.value];
      const current = Array.isArray(c.doRecord.answer) ? c.doRecord.answer : [c.doRecord.answer];
      const ids = c.exercise.choices.map((o: any) => o.id);
      if (new Set(ids).size !== ids.length || expected.some(id => !ids.includes(id))) throw new Halt('AMBIGUOUS', '选项无法唯一匹配');
      this.run(unit, () => {
        if (task.question.type === 'choice_single') c.answerChange(task.value);
        else for (const id of ids) if (expected.includes(id) !== current.includes(id)) c.answerChange(id);
      });
    } else if (task.kind === 'fill') {
      const items = task.value as { idx: string; answer: string }[];
      if (c.exercise.type === 24) {
        if (typeof c.drag !== 'function' || typeof c.delAnswer !== 'function') throw new Halt('QUESTION_DOM', '拖拽控件已变化');
        if (new Set(items.map(i => i.answer)).size !== items.length) throw new Halt('AMBIGUOUS', '拖拽答案存在重复选项，已暂停');
        this.run(unit, () => {
          for (const { idx } of items) if (c.doRecord.answer[idx]?.choiceId) c.delAnswer(idx);
          for (const { idx, answer } of items) c.drag({ previousContainer: { id: answer, data: {} }, container: { id: idx, data: {} } });
        });
      } else {
        const fields = items.map(item => {
          const matches = [...root.querySelectorAll<HTMLElement>('[contenteditable="true"]')].filter(e => e.id === `a-${item.idx}`);
          if (matches.length !== 1) throw new Halt('QUESTION_DOM', `填空 ${item.idx} 未找到唯一输入框`);
          return { item, field: matches[0] };
        });
        for (const { item, field } of fields) {
          check(signal); field.focus(); field.innerText = item.answer;
          field.dispatchEvent(new Event('input', { bubbles: true })); field.blur();
        }
      }
    } else if (task.kind === 'writing') {
      const fields = root.querySelectorAll('textarea');
      if (fields.length !== 1) throw new Halt('QUESTION_DOM', '问答输入框不唯一或尚未加载');
      const field = fields[0];
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, object(task.value).answer);
      field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); field.blur();
    }
    await sleep(80, signal); this.editable(unit);
    const actual = legacyValue(task.question, c.doRecord);
    if (stable(canonical(task.question, actual)) !== stable(canonical(task.question, task.value))) {
      throw new Halt('FILL_UNCONFIRMED', '网页尚未接收填写结果，已暂停');
    }
    return actual;
  }
  async record(unit: Unit, task: Task, settings: Settings, signal: AbortSignal): Promise<unknown> {
    const { component: c, root } = this.leaf(unit, task);
    if (![9, 20].includes(Number(c.exercise.type))) throw new Halt('UNSUPPORTED', '此旧版评测题尚未适配，请手动作答');
    if (Number(c.exercise.type) === 9) return this.recordRolePlay(unit, task, settings, signal, c, root);
    if (!navigator.mediaDevices?.getUserMedia) throw new Halt('MICROPHONE', '浏览器未提供麦克风');
    let cancelled = false;
    try {
      const stream = await bounded(navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (cancelled) stream.getTracks().forEach(t => t.stop());
        return stream;
      }), settings.timeoutMs, signal);
      stream.getTracks().forEach(t => t.stop());
    } catch { throw new Halt('MICROPHONE', '麦克风权限被拒绝、取消或设备不可用'); }
    finally { cancelled = true; }
    this.editable(unit); check(signal);
    const start = root.querySelector<HTMLElement>('img[title="录音"]');
    if (!start) throw new Halt('RECORD_CONTROL', '未找到真实录音控件');
    const before = c.doRecord.answer;
    try {
      start.click();
      await until(() => c.isStart && c.recorder?.state === 'recording' ? true : undefined, 8_000, signal);
      await sleep(settings.recordingSeconds * 1_000, signal);
      this.editable(unit);
      const stop = root.querySelector<HTMLElement>('img[title="停止"]');
      if (!stop) throw new Halt('RECORD_CONTROL', '未找到停止录音控件');
      stop.click();
      await until(() => !c.isStart && typeof c.doRecord.answer === 'string' && c.doRecord.answer && c.doRecord.answer !== before ? true : undefined,
        settings.timeoutMs, signal);
      return legacyValue(task.question, c.doRecord);
    } finally {
      if (c.recorder?.state === 'recording') { clearTimeout(c.timer); c.recorder.reset(); c.isStart = false; }
    }
  }
  private async recordRolePlay(unit: Unit, task: Task, settings: Settings, signal: AbortSignal,
    c: LegacyComponent, root: HTMLElement): Promise<unknown> {
    const taskExt = object(task.question.extension);
    const nativeExt = object(legacyRoleExtension(c.exercise));
    const nativeItems = Array.isArray(nativeExt.sentItems) ? nativeExt.sentItems : [];
    const taskItems = Array.isArray(taskExt.sentItems) ? taskExt.sentItems : [];
    const items = (nativeItems.length ? nativeItems : taskItems).map((value): Record<string, unknown> => {
      const item = object(value);
      return { ...item, id: item.id ?? item.idx };
    });
    const roles = (Array.isArray(nativeExt.roles) && nativeExt.roles.length ? nativeExt.roles :
      (Array.isArray(taskExt.roles) ? taskExt.roles : [])).map(object);
    const roleStart = root.querySelector<HTMLButtonElement>('.lib-role-select-start button');
    const selectableRolePlay = typeof c.selectRole === 'function' && (typeof c.start === 'function' || !!roleStart);
    const listenRepeat = typeof c.sayBy === 'function';
    if (!items.length || (!selectableRolePlay && !listenRepeat)) {
      throw new Halt('RECORDING_DOM', '未识别角色扮演/跟读组件：缺少角色、句子或原生作答回调');
    }
    let target = items;
    if (selectableRolePlay) {
      if (!roles.length) throw new Halt('RECORDING_DOM', '角色扮演题没有可选角色');
      const roleId = c.doRecord?.roleId ||
        roles.find(role => items.some(item => String(item.roleId) === String(role.id)))?.id || roles[0].id;
      if (!roleId) throw new Halt('RECORDING_DOM', '角色扮演题没有可选角色');
      target = items.filter(item => String(item.roleId) === String(roleId));
      if (!target.length) throw new Halt('RECORDING_DOM', '所选角色没有可录音句子');
      this.run(unit, () => c.selectRole(roleId));
    }
    if (target.some(item => !item.id) ||
        new Set(target.map(item => String(item.id))).size !== target.length) {
      throw new Halt('RECORDING_DOM', '待录音句子的标识缺失、重复或无法匹配');
    }
    const answers = () => object(object(c.doRecord).answer);
    const done = (item: Record<string, unknown>) => {
      const answer = object(answers()[String(item.id)]);
      return typeof answer.recordAudio === 'string' && !!answer.recordAudio;
    };
    const complete = () => target.every(done);
    if (complete()) return legacyValue(task.question, c.doRecord);

    if (settings.rolePlayAudioMode === 'original' || settings.rolePlayAudioMode === 'sample') {
      if (settings.rolePlayAudioMode === 'original') {
        const speech = this.speechAssessment();
        for (const item of target) {
          if (done(item)) continue;
          const result = await this.scoreOriginalItem(c, item, speech, settings, signal);
          check(signal); this.editable(unit);
          this.run(unit, () => {
            const record = object(c.doRecord);
            if (!record.answer || typeof record.answer !== 'object' || Array.isArray(record.answer)) record.answer = {};
            const current = record.answer as Record<string, unknown>;
            const id = String(item.id);
            current[id] = { ...roleAnswer(), ...object(current[id]), ...result };
            if (typeof c.dataChange === 'function') c.dataChange();
            else c.doRecordChange.emit(record);
          });
          await sleep(80, signal);
        }
      } else {
        const urls = await Promise.all(target.map(item => this.resolveAudioUrl(c, item, settings, signal)));
        check(signal); this.editable(unit);
        this.run(unit, () => {
          const record = object(c.doRecord);
          if (!record.answer || typeof record.answer !== 'object' || Array.isArray(record.answer)) record.answer = {};
          const current = record.answer as Record<string, unknown>;
          const targetIds = new Set(target.map(item => String(item.id)));
          for (const id of Object.keys(current)) {
            if (!targetIds.has(id) && !object(current[id]).recordAudio) delete current[id];
          }
          target.forEach((item, index) => {
            const id = String(item.id);
            current[id] = { ...roleAnswer(), ...object(current[id]), recordAudio: urls[index] };
          });
          if (typeof c.dataChange === 'function') c.dataChange();
          else c.doRecordChange.emit(record);
        });
      }
      await sleep(80, signal); this.editable(unit);
      if (!complete()) throw new Halt('AUDIO_RESOLVE', '音频已处理，但网页未接收跟读作答，请导出诊断');
      return legacyValue(task.question, c.doRecord);
    }

    if (!navigator.mediaDevices?.getUserMedia) throw new Halt('MICROPHONE', '浏览器未提供麦克风');
    let cancelled = false;
    try {
      const stream = await bounded(navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
        if (cancelled) s.getTracks().forEach(t => t.stop()); return s;
      }), settings.timeoutMs, signal);
      stream.getTracks().forEach(t => t.stop());
    } catch (error) {
      if (error instanceof Halt && error.code === 'CANCELLED') throw error;
      throw new Halt('MICROPHONE', '麦克风权限被拒绝、取消或设备不可用');
    } finally { cancelled = true; }
    this.editable(unit);

    if (selectableRolePlay) {
      if (roleStart) roleStart.click();
      else this.run(unit, () => c.start());
      // Let the site's own changeAudioUrl() play the other role and start each of the
      // selected role's Chivox recordings. Do not call playVadio() per sentence here:
      // that toggles sample playback and races the site's recorder state machine.
      const budget = Math.min(600_000, items.reduce((total, item) => {
        const seconds = Number(item.audioTime);
        return total + Math.max(3, Math.min(45, Number.isFinite(seconds) && seconds > 0 ? seconds : 9)) * 1_000;
      }, 0) + 30_000);
      try {
        await until(() => complete() ? true : undefined, budget, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const missing = target.filter(item => !done(item)).map(item => String(item.id));
        throw new Halt('RECORD_TIMEOUT', `等待角色扮演录音超时（未完成句子：${missing.join('、')}），请检查麦克风和页面提示`);
      }
    } else {
      // Listen-and-repeat variant: it has one native sayBy(item) callback per sentence
      // instead of selectRole/start. Example mode bypasses this; microphone mode keeps
      // the original per-sentence workflow and waits for each native Chivox result.
      sessionStorage.setItem('tsinghua-english-lib-audio', '0');
      for (const item of target) {
        check(signal);
        if (done(item)) continue;
        this.run(unit, () => c.sayBy(item));
        const seconds = Number(item.audioTime);
        const budget = Math.max(3, Math.min(45, Number.isFinite(seconds) && seconds > 0 ? seconds : 9)) * 1_000 + 30_000;
        try {
          await until(() => done(item) ? true : undefined, budget, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Halt('RECORD_TIMEOUT', `等待句子 ${String(item.id)} 录音超时，请检查麦克风和页面提示`);
        }
      }
    }
    return legacyValue(task.question, c.doRecord);
  }
  private speechAssessment(): LegacyComponent {
    const found = this.components().find(({ component: c }) =>
      c.chivoxRecorder?.context && typeof c.speechService?.startSentence === 'function');
    if (!found) throw new Halt('SPEECH_INIT', '原站 Chivox 语音评测组件尚未初始化，请刷新页面后重试');
    return found.component;
  }
  private async scoreOriginalItem(c: LegacyComponent, item: Record<string, unknown>, speech: LegacyComponent,
    settings: Settings, signal: AbortSignal): Promise<Record<string, unknown>> {
    const source = item.audio ?? item.audioUrl ?? item.resId;
    if (typeof source !== 'string' || !source.trim()) {
      throw new Halt('ORIGINAL_AUDIO', `句子 ${String(item.id)} 没有原题音频，请切换为真实麦克风模式`);
    }
    const text = richText(item.styleText ?? item.text ?? item.content);
    if (!text) throw new Halt('ORIGINAL_AUDIO', `句子 ${String(item.id)} 没有可评测文本`);
    const url = await this.resolveAudioUrl(c, item, settings, signal);
    let audio: ArrayBuffer;
    try {
      audio = await bounded(fetch(url, { credentials: 'omit' }).then(response => {
        if (!response.ok) throw new Halt('ORIGINAL_AUDIO', `原题音频下载失败（HTTP ${response.status}）`);
        return response.arrayBuffer();
      }), settings.timeoutMs, signal);
    } catch (error) {
      if (error instanceof Halt) throw error;
      throw new Halt('ORIGINAL_AUDIO', '原题音频下载失败，请检查网络或登录状态');
    }
    return scoreWithChivox(speech, text, audio, settings.timeoutMs, signal) as unknown as Record<string, unknown>;
  }
  private async resolveAudioUrl(c: LegacyComponent, item: Record<string, unknown>, settings: Settings,
    signal: AbortSignal): Promise<string> {
    const raw = item.audio ?? item.audioUrl ?? item.resId;
    if (typeof raw === 'string') {
      const direct = absoluteAudio(raw);
      if (direct) return direct;
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Halt('AUDIO_RESOLVE', `角色扮演句子 ${String(item.id)} 缺少音频`);
    }
    const service = c.getWebUrlService ?? c.webUrlService;
    const source = typeof service?.getResUrl === 'function' ? service.getResUrl(raw, 2) : undefined;
    if (typeof source?.subscribe !== 'function') {
      throw new Halt('AUDIO_RESOLVE', '页面未提供音频解析服务，请关闭“角色扮演使用音频”后重试');
    }
    let subscription: { unsubscribe(): void } | undefined;
    try {
      const response = await bounded(new Promise<unknown>((resolve, reject) => {
        subscription = source.subscribe({ next: resolve, error: reject });
      }), settings.timeoutMs, signal);
      const url = object(response).url;
      if (typeof url === 'string' && url.trim()) return new URL(url, location.href).href;
      throw new Halt('AUDIO_RESOLVE', `角色扮演句子 ${String(item.id)} 的音频地址为空`);
    } catch (error) {
      if (error instanceof Halt) throw error;
      const status = Number(object(error).status);
      throw new Halt('AUDIO_RESOLVE', `角色扮演音频解析失败${status ? `（HTTP ${status}）` : ''}，请检查网络或关闭音频模式`);
    } finally { subscription?.unsubscribe(); }
  }
  async submit(unit: Unit, signal: AbortSignal): Promise<void> {
    check(signal); this.editable(unit);
    const buttons = [...unit.root.querySelectorAll<HTMLButtonElement>('button')].filter(b =>
      /^Submit$/i.test(b.textContent?.trim() || '') && !b.disabled && shown(b));
    if (buttons.length !== 1) throw new Halt('SUBMIT_CONTROL', '无法唯一识别旧版 Submit 按钮，已暂停');
    buttons[0].click();
  }
  async next(unit: Unit, signal: AbortSignal): Promise<Unit | undefined> {
    check(signal); this.assertContext(unit);
    const right = [...document.querySelectorAll<HTMLElement>('.page-next')].find(el =>
      !!el.querySelector('img[src*="tx_page_right"]') && shown(el));
    if (!right || right.getAttribute('aria-disabled') === 'true' || right.classList.contains('disabled')) return undefined;
    const oldKey = unit.key;
    right.click();
    await until(() => {
      const found = this.discover()[0];
      return found && found.key !== oldKey ? found : undefined;
    }, 20_000, signal);
    return this.discover()[0];
  }
}

function roleAnswer(): Record<string, unknown> {
  return { score: 0, accuracy: 0, fluency: 0, senseGroup: 0, speed: 0, stress: 0,
    integrity: 0, rhythm: 0, pron: 0, recordAudio: '', words: [], ccode: {}, result: '' };
}

function absoluteAudio(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('/') || /\.(mp3|wav|m4a|aac)(\?|#|$)/i.test(raw)) {
    try { return new URL(raw, location.href).href; } catch { return raw; }
  }
  return '';
}

function legacyRoleExtension(exercise: unknown): unknown {
  const e = object(exercise);
  const findArray = (keys: string[]): unknown[] => {
    for (const key of keys) {
      const value = e[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
    }
    for (const key of ['exercise', 'object', 'item', 'data']) {
      const found = findArrayAt(e[key], keys);
      if (found.length) return found;
    }
    return [];
  };
  const roles = findArray(['roles', 'roleList']);
  const sentItems = findArray(['sentItems', 'sentenceItems', 'items']);
  return { roles, sentItems };
}

function findArrayAt(value: unknown, keys: string[]): unknown[] {
  const e = object(value);
  if (!Object.keys(e).length) return [];
  for (const key of keys) {
    const current = e[key];
    if (Array.isArray(current)) return current;
    if (current && typeof current === 'object') return Object.values(current as Record<string, unknown>);
  }
  for (const key of ['exercise', 'object', 'item', 'data']) {
    const found = findArrayAt(e[key], keys);
    if (found.length) return found;
  }
  return [];
}

import { bounded, check, sleep, until } from './async';
import { canonical, object, stable } from './answers';
import { routePath, shown, TsinghuaAdapter } from './adapter';
import { legacyComponents, runInLegacyZone, type LegacyComponent } from './legacy-angular';
import { legacyData, legacyValue } from './legacy-data';
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
    const matches = this.components().filter(({ component: c, root }) => unit.root.contains(root) &&
      String(c.exercise?.id) === String(task.question.id) && root.tagName.startsWith('LIB-') &&
      typeof c.doRecordChange?.emit === 'function' && !root.tagName.startsWith('LIB-ADAP-') &&
      ![14, 15, 16, 25].includes(Number(c.exercise?.type)) && shown(root));
    if (matches.length !== 1) throw new Halt('QUESTION_DOM', '旧版作答组件未就绪或存在重复，请重新检测');
    if (matches[0].component.status !== 1) throw new Halt('READ_ONLY', '题目不处于可作答状态');
    return matches[0];
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
    if (!navigator.mediaDevices?.getUserMedia) throw new Halt('MICROPHONE', '浏览器未提供麦克风');
    let cancelled = false;
    try {
      const stream = await bounded(navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
        if (cancelled) s.getTracks().forEach(t => t.stop()); return s;
      }), settings.timeoutMs, signal);
      stream.getTracks().forEach(t => t.stop());
    } catch { throw new Halt('MICROPHONE', '麦克风权限被拒绝、取消或设备不可用'); }
    finally { cancelled = true; }
    const ext = object(task.question.extension), items = Array.isArray(ext.sentItems) ? ext.sentItems.map(object) : [];
    const roles = Array.isArray(ext.roles) ? ext.roles.map(object) : [];
    if (!items.length || !roles.length || typeof c.selectRole !== 'function' || typeof c.start !== 'function') {
      throw new Halt('RECORDING_DOM', '角色扮演题缺少角色、句子或启动控件');
    }
    const roleId = c.doRecord?.roleId || roles[0].id;
    if (!roleId) throw new Halt('RECORDING_DOM', '角色扮演题没有可选角色');
    this.run(unit, () => c.selectRole(roleId));
    const roleStart = root.querySelector<HTMLButtonElement>('.lib-role-select-start button');
    if (roleStart && !c.isClose) roleStart.click();
    else this.run(unit, () => c.start());
    await until(() => c.isClose === true || c.readingIndex != null ? true : undefined, 12_000, signal);
    for (const item of items) {
      check(signal); this.editable(unit);
      const answer: any = object(c.doRecord.answer)[String(item.id)] || {};
      if (answer.recordAudio) continue;
      const target = [...root.querySelectorAll<HTMLElement>('[data-id], .lib-role-play-item, .lib-role-play-sentence')]
        .find(el => el.getAttribute('data-id') === String(item.id) || el.textContent?.includes(String(item.text || '').slice(0, 18)));
      const recordButton = target?.querySelector<HTMLElement>('img[title="录音"],button[title="录音"]') ||
        root.querySelector<HTMLElement>(`[data-id="${String(item.id).replace(/"/g, '')}"] img`);
      if (!recordButton && typeof c.playVadio !== 'function') throw new Halt('RECORD_CONTROL', `角色扮演句子 ${item.id} 没有录音控件`);
      if (typeof c.playVadio === 'function') this.run(unit, () => c.playVadio(item));
      else recordButton!.click();
      const timeout = Math.min(180_000, (Number(item.audioTime) > 35 ? 39 : Number(item.audioTime) || 9) * 1000 + 10_000);
      await until(() => {
        const current: any = object(c.doRecord.answer)[String(item.id)];
        return current && current.recordAudio ? true : undefined;
      }, timeout, signal);
    }
    return legacyValue(task.question, c.doRecord);
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

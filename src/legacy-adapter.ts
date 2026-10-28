import { bounded, check, sleep, until } from './async';
import { canonical, object, stable, text } from './answers';
import { scoreWithChivox } from './chivox';
import { answerWithAi, synthesizeSpeech, transcribeAudio } from './api';
import { routePath, shown, TsinghuaAdapter } from './adapter';
import { legacyComponents, runInLegacyZone, type LegacyComponent } from './legacy-angular';
import { legacyData, legacyValue, richText, scriptFillAnswers } from './legacy-data';
import { Halt, type Adapter, type ExerciseData, type Settings, type Task, type Unit } from './model';

export function legacyRoute(): boolean {
  return /^\/legacy\/course-study-student\/\d+\/\d+\/\d+\/[\w-]+\/?$/.test(routePath());
}

export class LegacyAdapter implements Adapter {
  private rechallengeCounts = new Map<string, number>();
  private visited = new Set<string>();
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
    const rolePlay = task.question.type === 'legacy_9' || task.question.type === 'legacy_18';
    const matches = this.components().filter(({ component: c, root }) => unit.root.contains(root) && root.isConnected &&
      typeof c.doRecordChange?.emit === 'function' && shown(root) &&
      (String(c.exercise?.id) === String(task.question.id) ||
       (rolePlay && ([9, 18].includes(Number(c.exercise?.type)) ||
         typeof c.selectRole === 'function' || typeof c.start === 'function' || typeof c.playVadio === 'function'))));
    const usable = matches.filter(({ component: c }) => ![14, 15, 16, 25].includes(Number(c.exercise?.type)));
    if (!usable.length) throw new Halt('QUESTION_DOM', '旧版作答组件未就绪，请等待题目加载');
    const ranked = usable.map(entry => {
      const c = entry.component;
      let score = 0;
      if (rolePlay) {
        if ([9, 18].includes(Number(c.exercise?.type))) score += 5;
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
  async fill(unit: Unit, task: Task, settings: Settings, signal: AbortSignal): Promise<unknown> {
    check(signal);
    await this.ready(unit, signal);
    const { component: c, root } = await this.leafOrReload(unit, task, signal);
    task = await this.aiTask(task, root, c, settings, signal);
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
      const items = task.value as { idx: string; answer?: string; answers?: string[] }[];
      if (task.question.type === 'legacy_22') {
        if (typeof c.selectOption !== 'function') throw new Halt('QUESTION_DOM', '判断题控件已变化');
        const pairs = items.map(value => {
          const pair = object(value);
          return { idx: String(pair.idx), answer: String(pair.answer ?? '') };
        });
        this.run(unit, () => {
          const record = object(c.doRecord);
          if (!record.answer || typeof record.answer !== 'object' || Array.isArray(record.answer)) record.answer = {};
          const answers = record.answer as Record<string, unknown>;
          for (const pair of pairs) if (!answers[pair.idx]) answers[pair.idx] = { id: '', score: 0 };
          for (const pair of pairs) c.selectOption(pair.idx, pair.answer);
        });
      } else if (task.question.type === 'legacy_11') {
        if (typeof c.drag !== 'function') throw new Halt('QUESTION_DOM', '分类拖拽控件已变化');
        const groups = items.map(value => {
          const group = object(value);
          return { idx: String(group.idx), answers: Array.isArray(group.answers) ? (group.answers as unknown[]).map(String) : [] };
        });
        // Reset the target buckets, then reuse the site's own drag handler for each item.
        this.run(unit, () => {
          const record = object(c.doRecord);
          if (!record.answer || typeof record.answer !== 'object' || Array.isArray(record.answer)) record.answer = {};
          const answers = record.answer as Record<string, unknown>;
          for (const group of groups) answers[group.idx] = { ...object(answers[group.idx]), id: group.idx, choiceIds: [], score: 0 };
        });
        const boxes = new Map(groups.flatMap(group => group.answers).map(id => [id,
          root.querySelector<HTMLElement>('[class~="' + id + '"]') ?? document.createElement('div')]));
        this.run(unit, () => {
          for (const group of groups) for (const id of group.answers) {
            c.drag({ previousContainer: { id, data: [] }, container: { id: group.idx, data: [] },
              item: { element: { nativeElement: boxes.get(id) } } });
          }
          if (typeof c.answerChange === 'function') c.answerChange();
          else c.doRecordChange.emit(c.doRecord);
        });
      } else if (c.exercise.type === 24) {
        if (typeof c.drag !== 'function' || typeof c.delAnswer !== 'function') throw new Halt('QUESTION_DOM', '拖拽控件已变化');
        if (new Set(items.map(i => i.answer)).size !== items.length) throw new Halt('AMBIGUOUS', '拖拽答案存在重复选项，已暂停');
        this.run(unit, () => {
          for (const { idx } of items) if (c.doRecord.answer[idx]?.choiceId) c.delAnswer(idx);
          for (const { idx, answer } of items) c.drag({ previousContainer: { id: answer, data: {} }, container: { id: idx, data: {} } });
        });
      } else {
        // Type 19 starts from an empty answer map; initialise each slot before the
        // inline handler writes into it, then let the site's own (input) binding run.
        this.run(unit, () => {
          const record = object(c.doRecord);
          if (!record.answer || typeof record.answer !== 'object' || Array.isArray(record.answer)) record.answer = {};
          const answers = record.answer as Record<string, unknown>;
          for (const { idx } of items) {
            if (!answers[idx] || typeof answers[idx] !== 'object') answers[idx] = { id: idx, score: 0, content: '' };
          }
        });
        const fields = items.map(item => {
          const matches = [...root.querySelectorAll<HTMLElement>('[contenteditable="true"]')].filter(e => e.id === `a-${item.idx}`);
          if (matches.length !== 1) throw new Halt('QUESTION_DOM', `填空 ${item.idx} 未找到唯一输入框`);
          return { item, field: matches[0] };
        });
        for (const { item, field } of fields) {
          check(signal); field.focus(); field.innerText = item.answer ?? '';
          field.dispatchEvent(new Event('input', { bubbles: true })); field.blur();
        }
      }
    } else if (task.kind === 'writing') {
      const fields = root.querySelectorAll('textarea');
      if (fields.length !== 1) throw new Halt('QUESTION_DOM', '问答输入框不唯一或尚未加载');
      const field = fields[0], answer = object(task.value).answer;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, answer);
      field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); field.blur();
      if (String(c.doRecord.answer ?? '') !== String(answer)) {
        this.run(unit, () => {
          c.doRecord.answer = answer;
          if (typeof c.dataChange === 'function') c.dataChange();
          else c.doRecordChange.emit(c.doRecord);
        });
      }
    }
    await sleep(80, signal); this.editable(unit);
    const actual = legacyValue(task.question, c.doRecord);
    if (stable(canonical(task.question, actual)) !== stable(canonical(task.question, task.value))) {
      throw new Halt('FILL_UNCONFIRMED', '网页尚未接收填写结果，已暂停');
    }
    return actual;
  }
  async record(unit: Unit, task: Task, settings: Settings, signal: AbortSignal): Promise<unknown> {
    await this.ready(unit, signal);
    const { component: c, root } = await this.leafOrReload(unit, task, signal);
    if (![8, 9, 18, 20].includes(Number(c.exercise.type))) throw new Halt('UNSUPPORTED', '此旧版评测题尚未适配，请手动作答');
    if (Number(c.exercise.type) === 8) return this.recordOralBrief(unit, task, settings, signal, c);
    if (Number(c.exercise.type) === 9) return this.recordRolePlay(unit, task, settings, signal, c, root);
    if (Number(c.exercise.type) === 18) return this.recordRolePlayTts(unit, task, settings, signal, c);
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
  private async recordOralBrief(unit: Unit, task: Task, settings: Settings, signal: AbortSignal,
    c: LegacyComponent): Promise<unknown> {
    const q = task.question;
    let answer = typeof q.answer === 'string' ? q.answer.trim() : '';
    if (settings.aiAnswers) {
      if (!settings.aiApiKey.trim()) throw new Halt('AI_CONFIG', '口语简答题需要 AI 生成回答，请填写 AI API Key');
      let transcript = '';
      if (q.audio?.length && settings.asrApiKey.trim()) {
        // The transcript only enriches the prompt; a failing ASR must not block an
        // otherwise answerable speaking task.
        try { transcript = await this.transcribeQuestionAudio(c, q.audio, settings, signal); }
        catch (error) { if (error instanceof Halt && error.code === 'CANCELLED') throw error; }
      }
      const prompt = `你是英语口语考试助手。请根据题目写一个自然、简洁、适合朗读的英语回答，2-4 句。只返回 JSON：{"answer":"..."}。
题目: ${q.instruction || q.stem || ''}
页面文本:
${(q.stem || '').slice(0, 3000)}
听力转写: ${transcript || '（无）'}`;
      const result = object(await answerWithAi(prompt, settings, signal));
      answer = typeof result.answer === 'string' ? result.answer.trim() : '';
      if (!answer) throw new Halt('AI_ANSWER', 'AI 没有返回口语简答题答案');
    }
    if (!answer) throw new Halt('NO_ANSWER', '口语简答题没有页面答案；请启用 AI 答题或手动填写');
    const audio = await synthesizeSpeech(answer, settings, signal);
    const id = await this.uploadOralAudio(c, audio, settings, signal);
    this.run(unit, () => {
      c.doRecord.answer = id;
      c.doRecord.ossOrVod = 2;
      if (typeof c.dataChange === 'function') c.dataChange();
      else c.doRecordChange.emit(c.doRecord);
    });
    await sleep(80, signal); this.editable(unit);
    return legacyValue(task.question, c.doRecord);
  }
  private async uploadOralAudio(c: LegacyComponent, audio: ArrayBuffer, settings: Settings,
    signal: AbortSignal): Promise<string> {
    const upload = c.vodUploadService;
    if (typeof upload?.vodStartUpload !== 'function' || typeof upload?.onVodComplete?.subscribe !== 'function' ||
        typeof upload?.onVodError?.subscribe !== 'function') {
      throw new Halt('ORAL_DOM', '原站 VOD 上传服务尚未初始化，请刷新页面后重试');
    }
    let completeSub: { unsubscribe(): void } | undefined, errorSub: { unsubscribe(): void } | undefined;
    try {
      return await bounded(new Promise<string>((resolve, reject) => {
        completeSub = upload.onVodComplete.subscribe((result: unknown) => {
          const id = object(result).id;
          if (typeof id === 'string' && id) resolve(id);
          else reject(new Halt('UPLOAD_FAILED', 'VOD 上传完成但没有返回音频 ID'));
        });
        errorSub = upload.onVodError.subscribe((error: unknown) => {
          const message = typeof error === 'string' ? error : String(object(error).message || '');
          reject(new Halt('UPLOAD_FAILED', `VOD 上传失败${message ? `：${message.slice(0, 160)}` : ''}`));
        });
        upload.vodStartUpload({ name: `thoa-${Date.now()}.mp3`,
          blob: new Blob([audio], { type: 'audio/mpeg' }) }, true);
      }), Math.max(60_000, settings.timeoutMs), signal);
    } finally {
      completeSub?.unsubscribe(); errorSub?.unsubscribe();
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
  private async startRolePlaySession(unit: Unit, c: LegacyComponent, signal: AbortSignal): Promise<void> {
    if (typeof c.start !== 'function') return;
    const answerCount = Object.keys(object(object(c.doRecord).answer)).length;
    if (answerCount > 0 && c.showSelectRole === false && c.isClose === true) return;
    if (c.showSelectRole === true && c.isClose === false) {
      await until(() => c.showSelectRole === false && c.isClose === true ? true : undefined, 10_000, signal);
      return;
    }
    const originalChange = c.changeAudioUrl;
    this.run(unit, () => {
      // start() initializes the selected role's answer slots and the role-play UI.
      // Suppress its automatic microphone recording; TTS/original audio is injected later.
      c.changeAudioUrl = () => {};
      c.start();
    });
    try {
      await until(() => {
        const ready = c.showSelectRole === false && c.isClose === true;
        const initialized = Object.keys(object(object(c.doRecord).answer)).length > 0;
        return ready && initialized ? true : undefined;
      }, 10_000, signal);
    } catch {
      throw new Halt('ROLE_START', '角色扮演启动超时，请检查页面角色选择和倒计时');
    } finally {
      this.run(unit, () => { c.changeAudioUrl = originalChange; });
    }
  }
  private async recordRolePlayTts(unit: Unit, task: Task, settings: Settings, signal: AbortSignal,
    c: LegacyComponent): Promise<unknown> {
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
    if (!items.length || !roles.length || typeof c.selectRole !== 'function') {
      throw new Halt('RECORDING_DOM', 'legacy_18 缺少角色、句子或角色选择控件');
    }
    const roleId = c.doRecord?.roleId ||
      roles.find(role => items.some(item => String(item.roleId) === String(role.id)))?.id || roles[0].id;
    if (!roleId) throw new Halt('RECORDING_DOM', 'legacy_18 没有可选角色');
    const target = items.filter(item => String(item.roleId) === String(roleId));
    if (!target.length || target.some(item => !item.id) ||
        new Set(target.map(item => String(item.id))).size !== target.length) {
      throw new Halt('RECORDING_DOM', 'legacy_18 所选角色句子标识缺失、重复或无法匹配');
    }
    this.run(unit, () => c.selectRole(roleId));
    if (!target.every(item => {
      const answer = object(object(object(c.doRecord).answer)[String(item.id)]);
      return typeof answer.recordAudio === 'string' && !!answer.recordAudio;
    })) await this.startRolePlaySession(unit, c, signal);
    const answers = () => object(object(c.doRecord).answer);
    const done = (item: Record<string, unknown>) => {
      const answer = object(answers()[String(item.id)]);
      return typeof answer.recordAudio === 'string' && !!answer.recordAudio;
    };
    if (target.every(done)) return legacyValue(task.question, c.doRecord);
    if (!settings.ttsApiKey.trim()) {
      throw new Halt('TTS_CONFIG', 'legacy_18 需要 TTS：请先在面板的 API 设置中填写 TTS API Key');
    }
    const speech = this.speechAssessment();
    for (const item of target) {
      check(signal);
      if (done(item)) continue;
      const text = richText(item.styleText ?? item.text ?? item.content);
      if (!text) throw new Halt('TTS_TEXT', `句子 ${String(item.id)} 没有可合成文本`);
      const audio = await synthesizeSpeech(text, settings, signal);
      const result = await scoreWithChivox(speech, text, audio, settings.timeoutMs, signal);
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
    this.run(unit, () => {
      if (typeof c.selectNowRole === 'function') c.selectNowRole();
      c.showSelectRole = false;
      c.showTime = false;
      c.isClose = true;
      if (typeof c.dataChange === 'function') c.dataChange();
      else c.doRecordChange.emit(c.doRecord);
    });
    if (!target.every(done)) throw new Halt('TTS_SCORE', 'TTS 已处理，但网页未接收角色扮演作答，请导出诊断');
    return legacyValue(task.question, c.doRecord);
  }
  // The legacy page sometimes renders before its own record request finishes, which
  // leaves the exercise in the initial read-only state with no inputs. Re-run the
  // site's own loader inside Angular's zone, then reopen an empty result record.
  private async ready(unit: Unit, signal: AbortSignal): Promise<LegacyComponent> {
    this.assertContext(unit);
    const c = this.instance(unit);
    if (Number(c.exerciseStatus) === 1) return c;
    if (Number(c.exerciseStatus) === 0 && typeof c.loadDoRecord === 'function') {
      for (let attempt = 0; attempt < 3; attempt++) {
        runInLegacyZone(() => c.loadDoRecord());
        try {
          await until(() => Number(c.exerciseStatus) !== 0 ? true : undefined, 6_000, signal);
          break;
        } catch (error) {
          if (signal.aborted || (error instanceof Halt && error.code !== 'PAGE_TIMEOUT')) throw error;
          if (attempt < 2) await sleep(1_200, signal);
        }
      }
    }
    if (Number(c.exerciseStatus) === 0) {
      throw new Halt('NEEDS_RELOAD', '练习作答控件未渲染（页面偶发空白，需要刷新）');
    }
    if (Number(c.exerciseStatus) === 2 && this.emptyRecord(c)) {
      runInLegacyZone(() => {
        if (typeof c.retry === 'function') c.retry();
        else { c.exerciseStatus = 1; c.doRecord = { type: c.exercise?.type }; }
      });
      await until(() => Number(c.exerciseStatus) === 1 ? true : undefined, 5_000, signal);
    }
    if (Number(c.exerciseStatus) !== 1) throw new Halt('READ_ONLY', '当前为已提交的结果页；保持现有结果，请手动选择待作答练习');
    return c;
  }
  // A rendered-but-empty exercise may still lack its controls. One native reload of the
  // record is cheap; if that fails the controller refreshes the page and resumes.
  private async leafOrReload(unit: Unit, task: Task, signal: AbortSignal):
    Promise<{ component: LegacyComponent; root: HTMLElement }> {
    try { return this.leaf(unit, task); }
    catch (error) {
      if (!(error instanceof Halt) || error.code !== 'QUESTION_DOM') throw error;
      const c = this.instance(unit);
      // Only a rendered-but-unbound page justifies a reload; a stale page with another
      // exercise id is a genuine mismatch and must keep failing closed.
      if (String(c.exercise?.id ?? '') !== String(task.question.id)) throw error;
      if (typeof c.loadDoRecord === 'function') {
        runInLegacyZone(() => c.loadDoRecord());
        try {
          await until(() => { try { this.leaf(unit, task); return true; } catch { return undefined; } }, 4_000, signal);
        } catch { throw new Halt('NEEDS_RELOAD', '练习作答控件未渲染（页面偶发空白，需要刷新）'); }
      }
      return this.leaf(unit, task);
    }
  }
  private emptyRecord(c: LegacyComponent): boolean {
    if (c.isEmptyDoRecord === true) return true;
    const record = object(c.doRecord), answers = record.answer;
    if (answers == null) return true;
    if (typeof answers === 'string') return !answers.trim();
    if (Array.isArray(answers)) return answers.length === 0;
    const values = Object.values(object(answers));
    if (!values.length) return true;
    return values.every(value => {
      const entry = object(value);
      const content = entry.content ?? entry.recordAudio ?? entry.choiceId ?? entry.answer;
      if (typeof content === 'string') return !content.trim();
      if (Array.isArray(content)) return content.length === 0;
      return content == null;
    });
  }
  private hasTaskAnswers(task: Task): boolean {
    const value = task.value;
    if (task.kind === 'choice') return Array.isArray(value) ? value.length > 0 :
      typeof value === 'string' && !!value.trim();
    if (task.kind === 'fill') {
      const items = Array.isArray(value) ? value.map(object) : [];
      if (!items.length) return false;
      return items.every(item => Array.isArray(item.answers) ? item.answers.length > 0 :
        typeof item.answer === 'string' && !!item.answer.trim());
    }
    if (task.kind === 'writing') return typeof object(value).answer === 'string' && !!String(object(value).answer).trim();
    return false;
  }
  private async aiTask(task: Task, root: HTMLElement, c: LegacyComponent, settings: Settings,
    signal: AbortSignal): Promise<Task> {
    const ext = object(task.question.extension);
    // Type 19 carries the official listening script, so its blanks can be restored
    // verbatim. This is exact source text and far safer than a paraphrase; AI is
    // still used whenever the script cannot resolve every blank.
    if (task.kind === 'fill' && Number(ext.legacyType) === 19) {
      const scripted = scriptFillAnswers(task.question);
      if (scripted) return { ...task, value: scripted };
    }
    // Never let a generative answer replace an answer the exercise already carries
    // (for example judge optionId): AI is only a fallback for missing data.
    if (task.kind !== 'recording' && this.hasTaskAnswers(task)) return task;
    if (task.kind === 'recording') return task;
    if (!settings.aiApiKey.trim()) {
      if (settings.aiAnswers) throw new Halt('AI_CONFIG', '已启用 AI 答题，但未填写 AI API Key');
      throw new Halt('NO_ANSWER', '题目没有可解析的答案，且未配置 AI API Key');
    }
    const q = task.question;
    const script = typeof ext.audioScript === 'string' ? ext.audioScript : '';
    const dialogue = Array.isArray(ext.dialogue) ? ext.dialogue.map(line => {
      const entry = object(line);
      return `${String(entry.role || '')}: ${String(entry.text || '')}`;
    }) : [];
    // The legacy listening exercises expose their script; ASR is only a fallback.
    const transcript = script || (q.audio?.length ? await this.transcribeQuestionAudio(c, q.audio, settings, signal) : '');
    const options = Array.isArray(q.extension) ? q.extension.map(option => ({
      id: String(object(option).idx), text: text(object(option).val),
    })) : [];
    const blanks = Array.isArray(task.value) ? task.value.map(object).map(blank => ({ idx: String(blank.idx) })) : [];
    // Composite listening pages render their word box / image outside the child question
    // component, so the leaf innerText alone can omit the options the answer must use.
    const pageRoot = (root.closest('app-course-task-stu') as HTMLElement | null) ?? root;
    const pageText = (pageRoot.innerText || pageRoot.textContent || root.innerText || root.textContent || '').slice(0, 8000);
    const judge = Number(ext.legacyType) === 22 ? {
      items: (Array.isArray(ext.items) ? ext.items : []).map(item => ({ id: String(object(item).id), text: String(object(item).text ?? '') })),
      options: (Array.isArray(ext.options) ? ext.options : []).map(option => ({ id: String(object(option).id), text: String(object(option).text ?? '') })),
    } : null;
    const catalog = Number(ext.legacyType) === 11 ? {
      targets: (Array.isArray(ext.targets) ? ext.targets : []).map(target => ({ id: String(object(target).id), text: String(object(target).text ?? '') })),
      items: (Array.isArray(ext.items) ? ext.items : []).map(item => ({ id: String(object(item).id), text: String(object(item).text ?? '') })),
    } : null;
    const schema = task.kind === 'choice' ? '{"choice":["选项ID", ...]}' :
      (task.kind === 'fill' ? (Number(ext.legacyType) === 11 ? '{"fill":[{"idx":"目标ID","answers":["项目ID", ...]}]}' :
        '{"fill":[{"idx":"空位ID","answer":"答案"}]}') : '{"answer":"完整答案文本"}');
    const prompt = `你正在完成清华社英语旧版练习。只返回一个 JSON 对象，不要 Markdown。
题型: ${q.type}（${task.kind}）
题目说明: ${q.instruction || ''}
对话（[[空位ID]] 为待填空格）: ${dialogue.length ? '\n' + dialogue.join('\n') : '（无）'}
页面可见文本（含词库/图片说明）:
${pageText}
选项: ${JSON.stringify(options)}
空位: ${JSON.stringify(blanks)}
${catalog ? `分类目标: ${JSON.stringify(catalog.targets)}
待分类项: ${JSON.stringify(catalog.items)}` : ''}
${judge ? `判断题句子: ${JSON.stringify(judge.items)}
判断选项: ${JSON.stringify(judge.options)}` : ''}
听力转写: ${transcript || '（无）'}
返回格式: ${schema}
${q.type === 'fill_base' && object(q.extension).legacyType === 24 ? '拖拽填空的 answer 必须使用选项中的 ID。' : ''}
${q.type === 'fill_base' && object(q.extension).legacyType === 19 ? '对话填空必须逐字摘录听力原文中的片段，保留原词，不要改写或翻译。' : ''}
${Number(ext.legacyType) === 11 ? '每个待分类项必须且只能放入一个目标，全部项目都要分配。' : ''}
${Number(ext.legacyType) === 22 ? '判断题每条句子必须选择一个判断选项 ID，使用选项的 id 字段；不要返回 T/F/NI 字母或 true/false，除非该字母本身就是选项 id。' : ''}
${task.kind === 'fill' ? '若页面出现词库或选项框，填空答案必须从词库中选择原样文本，不要自创词。' : ''}
必须严格回答当前题目。`;
    const result = await answerWithAi(prompt, settings, signal);
    try { return { ...task, value: this.validateAiValue(task, result) }; }
    catch (error) {
      // Judge answers are often written as T/F/NI text; retry once with the allowed ids
      // spelled out before pausing the whole run.
      if (Number(ext.legacyType) === 22 && error instanceof Halt && error.code === 'AI_ANSWER') {
        const allowed = (Array.isArray(ext.options) ? ext.options : []).map(option => {
          const entry = object(option);
          return { id: String(entry.id), text: String(entry.text ?? '') };
        });
        const retry = await answerWithAi(`${prompt}\n\n上一次返回不符合要求：${JSON.stringify(result).slice(0, 800)}\n只能使用这些选项 id：${JSON.stringify(allowed)}\n请重新返回 {"fill":[{"idx":"句子ID","answer":"选项ID"}]}。`,
          settings, signal);
        return { ...task, value: this.validateAiValue(task, retry) };
      }
      throw error;
    }
  }
  private async transcribeQuestionAudio(c: LegacyComponent, audioIds: string[], settings: Settings,
    signal: AbortSignal): Promise<string> {
    if (!settings.asrApiKey.trim()) throw new Halt('ASR_CONFIG', '听力题需要 ASR：请先在面板填写 ASR API Key');
    const transcripts: string[] = [];
    for (let index = 0; index < audioIds.length; index++) {
      const url = await this.resolveAudioUrl(c, { id: `audio-${index}`, audio: audioIds[index] }, settings, signal);
      let audio: ArrayBuffer;
      try {
        audio = await bounded(fetch(url, { credentials: 'omit' }).then(response => {
          if (!response.ok) throw new Halt('ASR_AUDIO', `听力音频下载失败（HTTP ${response.status}）`);
          return response.arrayBuffer();
        }), settings.timeoutMs, signal);
      } catch (error) {
        if (error instanceof Halt) throw error;
        throw new Halt('ASR_AUDIO', '听力音频下载失败，请检查网络或登录状态');
      }
      transcripts.push(await transcribeAudio(audio, `question-${index}.mp3`, settings, signal));
    }
    return [...new Set(transcripts.filter(Boolean))].join('\n');
  }
  private validateAiValue(task: Task, value: unknown): unknown {
    const result = object(value), q = task.question;
    if (task.kind === 'choice') {
      const options = Array.isArray(q.extension) ? q.extension.map(option => String(object(option).idx)) : [];
      const selected = Array.isArray(result.choice) ? result.choice.map(String) : [];
      if (!selected.length || selected.some(id => !options.includes(id)) ||
          new Set(selected).size !== selected.length || (q.type !== 'choice_multiple' && selected.length !== 1)) {
        throw new Halt('AI_ANSWER', 'AI 返回的选项不符合当前选择题');
      }
      return q.type === 'choice_multiple' ? selected : selected[0];
    }
    if (task.kind === 'fill' && Number(object(q.extension).legacyType) === 22) {
      const ext = object(q.extension);
      const options = (Array.isArray(ext.options) ? ext.options : []).map(object);
      const items = Array.isArray(task.value) ? task.value.map(object) : [];
      const raw = [result.fill, result.judge, result.answers].find(Array.isArray) as unknown[] | undefined;
      const rows = (raw || []).map(entry => typeof entry === 'object' && entry !== null ?
        object(entry) : { answer: entry });
      const byId = new Map(rows.map(row => [String(row.idx ?? ''), row.answer ?? row.value]));
      const text = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase()
        .replace(/[.。!！]/g, '') : typeof value === 'boolean' ? (value ? 'true' : 'false') : '';
      const match = (value: unknown): string | undefined => {
        const rawValue = text(value);
        if (!rawValue) return undefined;
        const exact = options.find(option => String(option.id) === String(value).trim());
        if (exact) return String(exact.id);
        const sameText = options.find(option => text(option.text) === rawValue);
        if (sameText) return String(sameText.id);
        const pick = (aliases: string[]): string | undefined => {
          const hit = options.find(option => aliases.includes(text(option.text)));
          return hit ? String(hit.id) : undefined;
        };
        if (['t', 'true', 'yes', '正确', '对', '√'].includes(rawValue)) return pick(['t', 'true', 'yes', '正确']);
        if (['f', 'false', 'no', '错误', '错', '×'].includes(rawValue)) return pick(['f', 'false', 'no', '错误']);
        if (['ni', 'no information', 'not given', '未提及'].includes(rawValue)) return pick(['ni', 'no information', 'not given']);
        return undefined;
      };
      if (!options.length || !items.length) throw new Halt('AI_ANSWER', '判断题选项或句子为空');
      return items.map((item, index) => {
        const idx = String(item.idx);
        const resolved = match(byId.get(idx)) ??
          (rows.length === items.length ? match(rows[index]?.answer ?? rows[index]?.value) : undefined);
        if (!resolved) throw new Halt('AI_ANSWER', `AI 返回的判断题答案缺失或不是有效选项（句子 ${idx}）`);
        return { idx, answer: resolved };
      });
    }
    if (task.kind === 'fill' && Number(object(q.extension).legacyType) === 11) {
      const ext = object(q.extension);
      const itemIds = new Set((Array.isArray(ext.items) ? ext.items : []).map(item => String(object(item).id)));
      const targets = Array.isArray(task.value) ? task.value.map(object) : [];
      const fill = Array.isArray(result.fill) ? result.fill.map(object) : [];
      const byId = new Map(fill.map(entry => [String(entry.idx),
        Array.isArray(entry.answers) ? (entry.answers as unknown[]).map(String) : []]));
      const seen = new Set<string>();
      const value = targets.map(target => {
        const idx = String(target.idx), answers = byId.get(idx) ?? [];
        if (!answers.length) throw new Halt('AI_ANSWER', `AI 返回的分类目标 ${idx} 为空`);
        for (const id of answers) {
          if (!itemIds.has(id) || seen.has(id)) throw new Halt('AI_ANSWER', 'AI 返回的分类项缺失、重复或不属于本题');
          seen.add(id);
        }
        return { idx, answers };
      });
      if (seen.size !== itemIds.size) throw new Halt('AI_ANSWER', 'AI 返回的分类没有覆盖全部选项');
      return value;
    }
    if (task.kind === 'fill') {
      const blanks = Array.isArray(task.value) ? task.value.map(object) : [];
      const fill = Array.isArray(result.fill) ? result.fill.map(object) : [];
      const byId = new Map(fill.map(item => [String(item.idx), String(item.answer ?? '').trim()]));
      const dragOptions = object(q.extension).legacyType === 24 ? object(q.extension).options : null;
      if (!blanks.length || blanks.some(blank => {
        const answer = byId.get(String(blank.idx));
        return !answer || (Array.isArray(dragOptions) && !dragOptions.includes(answer));
      })) throw new Halt('AI_ANSWER', 'AI 返回的填空答案缺失、为空或不符合空位/选项');
      return blanks.map(blank => ({ idx: String(blank.idx), answer: byId.get(String(blank.idx))! }));
    }
    if (task.kind === 'writing') {
      const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
      if (!answer) throw new Halt('AI_ANSWER', 'AI 返回的主观题答案为空');
      return { answer, annex: [] };
    }
    return task.value;
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
    const service = c.getWebUrlService ?? c.webUrlService ??
      this.components().map(({ component }) => component.getWebUrlService ?? component.webUrlService)
        .find(value => typeof value?.getResUrl === 'function');
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
  private challengeModal(): { modal: HTMLElement; text: string } | null {
    const modal = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
      .find(el => shown(el) && /闯关|Rechallenge|Review/.test(el.innerText || el.textContent || ''));
    return modal ? { modal, text: modal.innerText || modal.textContent || '' } : null;
  }
  private goalFailure(): string | null {
    const found = this.challengeModal();
    if (!found || !/闯关失败/.test(found.text)) return null;
    const score = /本次成绩[:：]\s*(\d+)\s*分/.exec(found.text)?.[1];
    return `目标闯关未通过${score ? `（${score}分）` : ''}，请手动 Rechallenge 或调整答案后重试`;
  }
  async next(unit: Unit, signal: AbortSignal, settings?: Settings,
    beforeRechallenge?: () => void): Promise<Unit | undefined> {
    check(signal); this.assertContext(unit);
    this.visited.add(unit.key);
    const failed = this.goalFailure();
    if (failed) return this.rechallenge(unit, signal, failed, settings, beforeRechallenge);
    const successModal = this.challengeModal();
    if (successModal && /闯关成功/.test(successModal.text)) {
      this.rechallengeCounts.delete(unit.key);
      successModal.modal.querySelector<HTMLElement>('.ant-modal-close')?.click();
      await sleep(300, signal);
    }
    const right = [...document.querySelectorAll<HTMLElement>('.page-next')].find(el =>
      !!el.querySelector('img[src*="tx_page_right"]') && shown(el));
    if (!right || right.getAttribute('aria-disabled') === 'true' || right.classList.contains('disabled')) {
      return this.catalogNext(unit, signal);
    }
    const oldKey = unit.key;
    right.click();
    try {
      await until(() => {
        const failure = this.goalFailure();
        if (failure) throw new Halt('GOAL_FAILURE_DETECTED', failure);
        const found = this.discover()[0];
        return found && found.key !== oldKey ? found : undefined;
      }, 20_000, signal);
    } catch (error) {
      if (error instanceof Halt && error.code === 'GOAL_FAILURE_DETECTED') {
        return this.rechallenge(unit, signal, error.message, settings, beforeRechallenge);
      }
      throw error;
    }
    const found = this.discover()[0];
    // The right arrow loops inside a section (A→B→C→D→A) when the goal check fails.
    // If the catalog already unlocked the next section, use it instead of repeating.
    if (found && this.visited.has(found.key)) {
      const moved = await this.catalogNext(unit, signal);
      if (moved && !this.visited.has(moved.key)) return moved;
    }
    if (found) this.visited.add(found.key);
    return found;
  }
  // Walk the course catalog in display order and open the next clickable page after the
  // current one. Locked pages (isClick=false) are skipped, so a failed goal still stops.
  private async catalogNext(unit: Unit, signal: AbortSignal): Promise<Unit | undefined> {
    const c = this.instance(unit);
    const list = c.courseStudyService?.catalogList?.[c.courseId];
    if (!list) return undefined;
    const pages: { key: string; click: boolean; vis: number }[] = [];
    const walk = (node: Record<string, unknown>): void => {
      const children = Array.isArray(node.children) ? node.children : [];
      for (const raw of children) {
        const child = object(raw);
        if (typeof child.key === 'string' && child.pageId) {
          pages.push({ key: child.key, click: child.isClick !== false, vis: Number(child.isVisiable ?? 1) });
        }
        if (Array.isArray(child.children) && child.children.length) walk(child);
      }
    };
    walk(object(list));
    const current = routePath().split('/').filter(Boolean).pop() || '';
    const index = pages.findIndex(page => page.key === current);
    if (index < 0) return undefined;
    const next = pages.slice(index + 1).find(page => page.click && page.vis !== 2);
    if (!next) return undefined;
    runInLegacyZone(() => { void c.router?.navigate?.(
      ['/course-study-student', String(c.textbookId), String(c.courseId), String(c.userId), next.key]); });
    try {
      await until(() => {
        const found = this.discover()[0];
        return found && found.key !== unit.key ? found : undefined;
      }, 20_000, signal);
    } catch { return undefined; }
    const found = this.discover()[0];
    if (found) this.visited.add(found.key);
    return found;
  }
  private async rechallenge(unit: Unit, signal: AbortSignal, reason: string, settings?: Settings,
    beforeRechallenge?: () => void): Promise<Unit | undefined> {
    if (!settings?.autoRechallenge) throw new Halt('GOAL_FAILED', reason);
    const count = (this.rechallengeCounts.get(unit.key) || 0) + 1;
    if (count > 2) throw new Halt('GOAL_RETRY_LIMIT', `${reason}；已自动 Rechallenge 2 次，暂停`);
    const modal = this.challengeModal();
    if (!modal) throw new Halt('GOAL_FAILED', reason);
    const again = [...modal.modal.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => /rechallenge/i.test(button.textContent || ''));
    if (!again) throw new Halt('GOAL_FAILED', `${reason}；未找到 Rechallenge 按钮`);
    this.rechallengeCounts.set(unit.key, count);
    this.visited.clear();
    beforeRechallenge?.();
    again.click();
    await until(() => {
      const found = this.discover()[0];
      return found && found.key !== unit.key ? found : undefined;
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

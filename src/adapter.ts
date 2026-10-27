import { bounded, check, sleep, until } from './async';
import { canonical, object, parse, stable } from './answers';
import { Halt, type Adapter, type ExerciseData, type Question, type Settings, type Task, type Unit } from './model';
import { components, elementOf, nameOf, type Component } from './vue';

const leafNames = new Set(['SingleChoiceCourseDo', 'FillBlankCourseDo', 'WritingCourseDo',
  'OralBriefCourseDo', 'ListenAndRepeatCourseDo', 'WordsCourseDo']);

export function routePath(): string {
  return (location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname).split('?')[0];
}

export function allowedRoute(): boolean {
  return /^\/course_center\/reader\/(student_course|public_course|textbook)\/[^/]+\/?$/.test(routePath());
}

function id(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }

export function shown(el: HTMLElement): boolean {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    if (p.hidden || p.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(p);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function enabled(el: HTMLElement): boolean {
  return shown(el) && !el.closest('[disabled],[aria-disabled="true"],.ant-btn-loading,.disabled,.ly-button-disabled');
}

function dataShape(value: unknown): ExerciseData {
  const d = object(value);
  if (!Array.isArray(d.questionVOList) || (d.answerCount !== undefined &&
      (!Number.isInteger(d.answerCount) || Number(d.answerCount) < 0)) ||
      (d.questionAnswerItemVOList !== undefined && !Array.isArray(d.questionAnswerItemVOList))) {
    throw new Halt('DATA_SHAPE', '习题数据格式已变化，已暂停；请导出诊断');
  }
  return JSON.parse(JSON.stringify(d)) as ExerciseData;
}

export class TsinghuaAdapter implements Adapter {
  discover(): Unit[] {
    if (!allowedRoute()) return [];
    const units = components().filter(c => nameOf(c) === 'UnitExercisePreview').flatMap(c => {
      const root = elementOf(c);
      const catalogId = id(c.props.catalogId), contentId = id(c.props.contentId);
      if (!root?.isConnected || !root.matches('.unit-exercise-preview') || !shown(root) ||
          !/^\d+$/.test(catalogId) || !/^\d+$/.test(contentId)) return [];
      return [{ key: `${routePath()}:${catalogId}:${contentId}`, catalogId, contentId, root,
        title: `章节 ${catalogId} · 练习 ${contentId}` }];
    });
    const keys = units.map(u => u.key);
    if (new Set(keys).size !== keys.length) throw new Halt('DUPLICATE_UNIT', '页面出现重复练习块，已暂停');
    return units.sort((a, b) => a.root === b.root ? 0 :
      a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }

  private instance(unit: Unit): Component {
    const candidates = components().filter(c => nameOf(c) === 'UnitExercisePreview' &&
      id(c.props.catalogId) === unit.catalogId && id(c.props.contentId) === unit.contentId && elementOf(c) === unit.root);
    if (candidates.length !== 1) throw new Halt('STALE_PAGE', '练习页面发生变化，请重新选择练习');
    return candidates[0];
  }

  assertContext(unit: Unit): void {
    if (!allowedRoute() || !unit.key.startsWith(routePath() + ':') || !unit.root.isConnected || !shown(unit.root)) {
      throw new Halt('PAGE_CHANGED', '当前页面或课程已改变，已暂停');
    }
    const { props } = this.instance(unit);
    const textbook = object(props.textbookInfo);
    if (props.mode !== 'user' || ![6, 8].includes(Number(props.userType)) ||
        !['student_course', 'public_course', 'textbook'].includes(String(props.readerType)) ||
        props.interactionMode === 'teacher_student_review' || Number(textbook.courseStatus) === -1 ||
        Number(textbook.publicCourseStatus) === -1) {
      throw new Halt('NOT_PRACTICE', '仅支持学生日常练习，不处理考试、教师预览或已关闭课程');
    }
    if (props.currentCatalogId != null && id(props.currentCatalogId) !== unit.catalogId) {
      throw new Halt('CATALOG_CHANGED', '当前练习不属于正在学习的章节');
    }
    const conflict = this.conflict();
    if (conflict) throw new Halt('SCRIPT_CONFLICT', conflict);
  }

  conflict(): string | null {
    if (document.querySelector('.yunPanel')) return '检测到旧版 Yun 答题面板，请停用旧脚本并刷新后运行';
    if (window.XMLHttpRequest?.name === 'myXMLHttpRequest' || window.WebSocket?.name === 'myWebSocket') {
      return '检测到旧版脚本的网络钩子，请停用旧脚本并刷新后运行';
    }
    const w = window as Window & { yunAiRecorder?: unknown; yunPlayer?: unknown };
    if (w.yunAiRecorder || w.yunPlayer) return '检测到旧版脚本的播放器或录音钩子，请停用旧脚本并刷新';
    return null;
  }

  async load(unit: Unit, signal: AbortSignal): Promise<ExerciseData> {
    check(signal); this.assertContext(unit);
    const callback = this.instance(unit).props.onLoadExercise;
    if (typeof callback !== 'function') throw new Halt('NO_LOADER', '页面未提供练习读取方法');
    try {
      const value = await bounded(Promise.resolve(callback(Number(unit.contentId))), 30_000, signal);
      check(signal); this.assertContext(unit);
      return dataShape(value);
    } catch (error) {
      if (error instanceof Halt) throw error;
      const e = object(error);
      if ([401, 403].includes(Number(e.status)) || [401, 403].includes(Number(object(e.data).code))) {
        throw new Halt('LOGIN', '登录已失效或无课程权限，请重新登录');
      }
      throw new Halt('LOAD_FAILED', '读取练习失败，请检查网络和页面提示');
    }
  }

  private leaf(unit: Unit, q: Question): Component {
    const matches = components().filter(c => leafNames.has(nameOf(c)) &&
      id(object(c.props.exercise).id) === String(q.id) &&
      !!(c.subTree?.el || c.vnode?.el) && unit.root.contains((c.subTree?.el || c.vnode?.el)!));
    if (matches.length !== 1) throw new Halt('QUESTION_DOM', `题目 ${q.id} 的作答组件未就绪或不唯一`);
    if (Number(matches[0].props.status) !== 10) throw new Halt('READ_ONLY', `题目 ${q.id} 当前不是可作答状态`);
    return matches[0];
  }

  private scope(unit: Unit, q: Question): HTMLElement {
    const leaf = this.leaf(unit, q);
    const el = elementOf(leaf);
    if (el) return el;
    const indexed = [...unit.root.querySelectorAll<HTMLElement>('[data-child-question-id],[id]')]
      .filter(el => el.dataset.childQuestionId === String(q.id) || el.id === `do_${q.id}`);
    // A nested question wrapper can contain its own stem; prefer the stem for fill-in-the-blank.
    const stem = indexed.find(el => el.id === `do_${q.id}`);
    if (q.type === 'fill_base' && stem) return stem;
    const nested = indexed.filter(el => el.dataset.childQuestionId === String(q.id));
    if (nested.length === 1) return nested[0];
    const wrapper = components().filter(c => nameOf(c) === 'AdaptExerciseCourseDo' &&
      id(object(c.props.exercise).id) === String(q.id)).map(elementOf)
      .filter((el): el is HTMLElement => !!el && unit.root.contains(el));
    if (wrapper.length === 1) return wrapper[0];
    throw new Halt('QUESTION_DOM', `无法确定题目 ${q.id} 的填写区域`);
  }

  private local(unit: Unit, q: Question): unknown { return object(this.leaf(unit, q).props.exercise).doRecord; }

  private control(unit: Unit, signal: AbortSignal): void { check(signal); this.assertContext(unit); }

  async fill(unit: Unit, task: Task, signal: AbortSignal): Promise<unknown> {
    this.control(unit, signal);
    const scope = this.scope(unit, task.question);
    if (task.kind === 'choice') {
      const selected = new Set(Array.isArray(task.value) ? task.value : [task.value]);
      const inputs = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"],input[type="checkbox"]')];
      if (!inputs.length || [...selected].some(v => inputs.filter(el => el.value === v).length !== 1)) {
        throw new Halt('CHOICE_DOM', '选项控件与答案标识不匹配');
      }
      for (const input of inputs) {
        this.control(unit, signal);
        if (!enabled(input)) throw new Halt('DISABLED', '选项控件不可操作');
        const desired = selected.has(input.value);
        if (input.type === 'checkbox' ? input.checked !== desired : desired && !input.checked) input.click();
      }
    } else if (task.kind === 'fill') {
      await until(() => scope.dataset.teFillBlankContainerInited === '1' ||
        scope.querySelector('[data-te-fill-blank-container-inited="1"]') ? true : undefined, 5_000, signal);
      for (const value of task.value as { idx: string; answer: string }[]) {
        this.control(unit, signal);
        const fields = [...scope.querySelectorAll<HTMLElement>('span.zty-exercise-item-fill-blank-do[contenteditable="true"]')]
          .filter(el => el.id === value.idx);
        if (fields.length !== 1 || !enabled(fields[0])) throw new Halt('FILL_DOM', '填空控件未找到或存在重复标识');
        const field = fields[0];
        field.focus(); field.textContent = value.answer;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
        field.blur();
      }
    } else if (task.kind === 'writing') {
      const fields = scope.matches('textarea') ? [scope as HTMLTextAreaElement] :
        [...scope.querySelectorAll<HTMLTextAreaElement>('textarea')];
      if (fields.length !== 1 || !enabled(fields[0])) throw new Halt('WRITING_DOM', '问答输入框未找到或不唯一');
      const field = fields[0];
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, object(task.value).answer);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      field.blur();
    } else throw new Halt('WRONG_HANDLER', '录音题需要录音处理器');
    return until(() => {
      this.control(unit, signal);
      const value = this.local(unit, task.question);
      return stable(canonical(task.question, value)) === stable(canonical(task.question, task.value)) ? value : undefined;
    }, 5_000, signal);
  }

  async record(unit: Unit, task: Task, settings: Settings, signal: AbortSignal): Promise<unknown> {
    this.control(unit, signal);
    if (!navigator.mediaDevices?.getUserMedia) throw new Halt('NO_MIC', '浏览器不支持麦克风录音');
    // Let the real permission prompt finish before starting the site's recording timer.
    const permission = navigator.mediaDevices.getUserMedia({ audio: true });
    // The permission probe never retains a stream, including permission arriving after timeout/cancel.
    void permission.then(stream => stream.getTracks().forEach(t => t.stop()), () => {});
    let stream: MediaStream;
    try { stream = await bounded(permission, settings.timeoutMs, signal); }
    catch (e) {
      if (e instanceof Halt) throw e;
      throw new Halt('MIC_DENIED', '麦克风授权失败，请在网站设置中允许麦克风');
    }
    stream.getTracks().forEach(t => t.stop());
    const q = task.question;
    const scope = this.scope(unit, q);
    const extension = parse(q.extension);
    const items = q.type === 'oral_follow_along' ? object(extension).sentItems :
      q.type === 'oral_vocabulary_learning' ? extension : [null];
    if (!Array.isArray(items) || !items.length) throw new Halt('RECORDING_DOM', '录音题的句子或单词列表为空');
    if (q.type !== 'oral_simple_speak' && (new Set(items.map(i => object(i).idx)).size !== items.length ||
        items.some(i => typeof object(i).idx !== 'string' || !object(i).idx))) {
      throw new Halt('RECORDING_DOM', '录音项目标识缺失或重复');
    }
    for (let index = 0; index < items.length; index++) {
      this.control(unit, signal);
      const rows = q.type === 'oral_follow_along' ? [...scope.querySelectorAll<HTMLElement>('.dialogue-view-item')] :
        q.type === 'oral_vocabulary_learning' ? [...scope.querySelectorAll<HTMLElement>('.word-item')] : [scope];
      if (rows.length !== items.length) throw new Halt('RECORDING_DOM', '录音按钮与句子数量不匹配');
      const row = rows[index];
      const find = (recording: boolean) => [...row.querySelectorAll<HTMLImageElement>('img')]
        .find(img => img.getAttribute('src')?.split('?')[0].endsWith(recording ? '/recording.gif' : '/record.png'));
      const stop = () => { const button = find(true); if (button) button.click(); };
      const initial = find(false);
      if (!initial || !enabled(initial)) throw new Halt('RECORDING_DOM', '录音按钮未就绪或被禁用');
      const previous = stable(this.local(unit, q));
      let stopped = false;
      signal.addEventListener('abort', stop, { once: true });
      try {
        initial.click();
        await until(() => { this.control(unit, signal); return find(true) ? true : undefined; }, settings.timeoutMs, signal);
        const duration = q.type === 'oral_simple_speak' ? settings.recordingSeconds * 1_000 :
          q.type === 'oral_vocabulary_learning' ? 5_000 :
          Math.min((Number(object(items[index]).audioTime) < 6 ? (Number(object(items[index]).audioTime) || 0) + 3 :
            Number(object(items[index]).audioTime) * 1.5) * 1_000, 180_000);
        const deadline = Date.now() + duration;
        while (Date.now() < deadline && find(true)) { this.control(unit, signal); await sleep(150, signal); }
        this.control(unit, signal);
        stop(); stopped = true;
        await until(() => {
          this.control(unit, signal);
          const value = parse(this.local(unit, q));
          if (stable(value) === previous) return undefined;
          const audio = q.type === 'oral_simple_speak' ? object(value) :
            object((Array.isArray(value) ? value.map(object) : []).find(v => v.idx === object(items[index]).idx)?.answer);
          return typeof audio.audio === 'string' && audio.audio ? true : undefined;
        }, settings.timeoutMs, signal);
      } finally {
        signal.removeEventListener('abort', stop);
        if (!stopped) stop();
      }
    }
    return this.local(unit, q);
  }

  async submit(unit: Unit, signal: AbortSignal): Promise<void> {
    this.control(unit, signal);
    const buttons = [...unit.root.querySelectorAll<HTMLButtonElement>('.exercise-actions button')]
      .filter(b => /^(Submit|提交)$/i.test(b.textContent?.trim() || '') && enabled(b));
    if (buttons.length !== 1) throw new Halt('SUBMIT_DOM', '没有唯一可用的日常练习提交按钮');
    buttons[0].click();
  }
}

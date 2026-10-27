import { vi } from 'vitest';
import { defaults, type Adapter, type ExerciseData, type Question, type Settings, type Task, type Unit } from '../src/model';
import { parse, object } from '../src/answers';
import type { Component, VNode } from '../src/vue';

export const choice: Question = { id: 101, type: 'choice_single', stem: '<p>Choose blue.</p>',
  extension: JSON.stringify([{ idx: 'a', val: 'Red' }, { idx: 'b', val: 'Blue' }]), answer: 'b' };
export const fill: Question = { id: 102, type: 'fill_base',
  stem: '<p><span id="blank-2" class="zty-exercise-item-fill-blank"></span> <span id="blank-1" class="zty-exercise-item-fill-blank"></span></p>',
  answer: JSON.stringify([{ idx: 'blank-1', val: 'world;earth' }, { idx: 'blank-2', val: 'hello', standardAnswer: 'Hello' }]) };
export const writing: Question = { id: 103, type: 'essay_questions_answers',
  stem: '<p>Say hello.</p>', answer: JSON.stringify({ answer: '<p>Hello.</p><p>Nice to meet you.</p>', annex: [] }) };
export const oral: Question = { id: 104, type: 'oral_simple_speak', stem: '<p>Speak.</p>' };
export const data = (...qs: Question[]): ExerciseData => ({ questionVOList: structuredClone(qs), answerCount: 0, questionAnswerItemVOList: [] });
export const settings: Settings = { ...defaults, intervalMs: 1, timeoutMs: 60 };

export function unit(): Unit {
  const root = document.createElement('div'); root.className = 'unit-exercise-preview'; document.body.append(root);
  return { key: '/course_center/reader/student_course/12:20:30', catalogId: '20', contentId: '30', title: '测试练习', root };
}

export function fakeAdapter(initial: ExerciseData) {
  const u = unit();
  let server = structuredClone(initial);
  const values = new Map<string, unknown>();
  const adapter: Adapter = {
    discover: vi.fn(() => [u]), assertContext: vi.fn(), conflict: vi.fn(() => null),
    load: vi.fn(async () => structuredClone(server)),
    fill: vi.fn(async (_u: Unit, task: Task) => { values.set(String(task.question.id), task.value); return task.value; }),
    record: vi.fn(async (_u: Unit, task: Task) => {
      const value = { audio: 'https://example.invalid/audio/test.mp3', score: 0 };
      values.set(String(task.question.id), value); return value;
    }),
    submit: vi.fn(async () => {
      server.answerCount = (server.answerCount || 0) + 1;
      server.questionAnswerItemVOList = [...values].map(([questionId, value]) => ({ questionId,
        userAnswer: typeof value === 'string' ? value : JSON.stringify(value) }));
    }),
  };
  return { adapter, unit: u, values, get server() { return server; }, set server(value: ExerciseData) { server = value; } };
}

export function mountPage(initial: ExerciseData) {
  history.replaceState({}, '', '/course_center/reader/student_course/12');
  document.body.innerHTML = '<div id="app" data-v-app></div>';
  const app = document.getElementById('app')! as HTMLElement & { _vnode: VNode };
  const root = document.createElement('div'); root.className = 'unit-exercise-preview'; app.append(root);
  const qComponents: Component[] = [];
  const nodes: VNode[] = [];
  for (const q of initial.questionVOList) {
    const wrapper = document.createElement('div'); wrapper.className = 'exercise-view'; root.append(wrapper);
    const current: Question = { ...q, doRecord: q.type === 'fill_base' ? [] : '' };
    let el: Node;
    let name: string;
    if (q.type.startsWith('choice_') || q.type === 'judge_basic') {
      name = 'SingleChoiceCourseDo';
      const scope = document.createElement('div'); scope.className = 'choices'; wrapper.append(scope); el = scope;
      const options = q.type === 'judge_basic' ? [{ idx: '1' }, { idx: '0' }] : parse(q.extension) as { idx: string }[];
      for (const option of options) {
        const input = document.createElement('input'); input.type = q.type === 'choice_multiple' ? 'checkbox' : 'radio';
        input.value = option.idx; input.name = 'question-' + q.id; scope.append(input);
        input.addEventListener('change', () => {
          current.doRecord = q.type === 'choice_multiple' ? [...scope.querySelectorAll<HTMLInputElement>('input:checked')].map(i => i.value) : input.value;
        });
      }
    } else if (q.type === 'fill_base') {
      name = 'FillBlankCourseDo';
      const scope = document.createElement('div'); scope.id = `do_${q.id}`; scope.dataset.teFillBlankContainerInited = '1';
      scope.innerHTML = q.stem || '';
      for (const span of scope.querySelectorAll('span')) { span.className = 'zty-exercise-item-fill-blank-do'; span.setAttribute('contenteditable', 'true'); }
      scope.addEventListener('focusout', () => { current.doRecord = [...scope.querySelectorAll('span')].map(span => ({ idx: span.id, answer: span.textContent })); });
      wrapper.append(scope); el = document.createComment('null render'); wrapper.append(el);
    } else if (q.type.startsWith('essay_')) {
      name = 'WritingCourseDo';
      const textarea = document.createElement('textarea'); wrapper.append(textarea);
      textarea.addEventListener('focusout', () => { current.doRecord = { answer: textarea.value, annex: [] }; });
      el = document.createTextNode(''); wrapper.prepend(el);
    } else {
      name = 'OralBriefCourseDo';
      const scope = document.createElement('div'); scope.className = 'oral-brief-course-do'; wrapper.append(scope); el = scope;
      const image = document.createElement('img'); image.src = '/speech-assess/img/record.png'; scope.append(image);
      image.addEventListener('click', () => {
        if (image.src.endsWith('recording.gif')) {
          current.doRecord = { audio: 'https://example.invalid/record.mp3', score: 0 };
          image.src = '/speech-assess/img/record.png';
        } else image.src = '/speech-assess/img/recording.gif';
      });
    }
    const c: Component = { type: { __name: name }, props: { exercise: current, status: 10 }, subTree: { el } };
    const wrapping: Component = { type: { __name: 'AdaptExerciseCourseDo' }, props: { exercise: current }, subTree: { el: wrapper, children: [{ component: c }] } };
    qComponents.push(c); nodes.push({ component: wrapping });
  }
  const actions = document.createElement('div'); actions.className = 'exercise-actions';
  const button = document.createElement('button'); button.textContent = 'Submit'; actions.append(button); root.append(actions);
  const submit = vi.fn(); button.addEventListener('click', submit);
  const load = vi.fn(async () => structuredClone(initial));
  const c: Component = { type: { __name: 'UnitExercisePreview' }, props: { catalogId: 20, contentId: 30,
    userType: 6, readerType: 'student_course', mode: 'user', textbookInfo: { learnMode: 1 },
    onLoadExercise: load }, subTree: { el: root, children: nodes } };
  app._vnode = { component: c };
  return { root, component: c, qComponents, load, submit,
    findQuestion: (id: number) => qComponents.find(c => object(c.props.exercise).id === id)! };
}

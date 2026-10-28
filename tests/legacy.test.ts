import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyAdapter, legacyRoute } from '../src/legacy-adapter';
import { legacyData, scriptFillAnswers } from '../src/legacy-data';
import { planTasks, hasCompleteResponse } from '../src/answers';
import { Controller } from '../src/controller';
import { Store } from '../src/storage';
import { defaults } from '../src/model';
import { scoreWithChivox } from '../src/chivox';
import { answerWithAi, fetchImage, synthesizeSpeech, transcribeAudio } from '../src/api';

vi.mock('../src/chivox', () => ({ scoreWithChivox: vi.fn() }));
vi.mock('../src/api', () => ({ synthesizeSpeech: vi.fn(), answerWithAi: vi.fn(), transcribeAudio: vi.fn(),
  fetchImage: vi.fn() }));

const path = '/legacy/course-study-student/10/20/30/example-key';
const signal = () => new AbortController().signal;
const exercise = () => ({ id: 'exercise-uuid', type: 24, contentString: 'Match.',
  fillBlanks: [{ id: 'blank-a', answer: 'option-b' }, { id: 'blank-b', answer: 'option-a' }],
  dragged: [{ id: 'option-a' }, { id: 'option-b' }] });

function fixture(saved = false) {
  document.body.innerHTML = '<app-course-task-stu><lib-fill-blank-drag-exercise-cs-stu-do></lib-fill-blank-drag-exercise-cs-stu-do><button>Submit</button></app-course-task-stu>';
  const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
  const server = { exercise: exercise(), submitNum: saved ? 1 : 0, doRecord: saved ? { type: 24,
    answer: { 'blank-a': { choiceId: 'option-b' }, 'blank-b': { choiceId: 'option-a' } } } : null as any };
  const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
    exerciseStatus: saved ? 3 : 1, data: { isVisiable: 1 }, exercise: exercise(), pageTitle: 'Sample',
    doRecord: server.doRecord ? structuredClone(server.doRecord) : { type: 24, answer: {} }, loadDoRecord() {},
    http: { post: vi.fn(() => ({ subscribe: ({ next }: any) => {
      next({ status: true, object: structuredClone(server) }); return { unsubscribe: vi.fn() };
    } })) },
  };
  const changes = vi.fn();
  const leaf: any = { status: 1, exercise: c.exercise, doRecord: c.doRecord, doRecordChange: { emit: changes },
    delAnswer(id: string) { this.doRecord.answer[id] = { choiceId: '' }; changes(this.doRecord); },
    drag(event: any) { this.doRecord.answer[event.container.id] = { choiceId: event.previousContainer.id, score: 0 }; changes(this.doRecord); },
  };
  const submit = vi.fn(() => { server.submitNum++; server.doRecord = structuredClone(c.doRecord); c.exerciseStatus = 3; });
  root.querySelector('button')!.addEventListener('click', submit);
  const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: root.firstElementChild as HTMLElement, component: leaf }]);
  return { adapter, server, c, leaf, submit, changes, root, unit: adapter.discover()[0] };
}

const exercise19 = () => ({ id: 'q-19', type: 19, contentString: 'Listen to the conversation again. Fill in the blanks with the information you hear.',
  audio: 'audio-19', audioName: 'B2U1R1.mp3',
  dialogueContents: [
    { role: 'Adrian', content: { paragraphs: [{ contentItems: [
      { type: 1, text: 'Hey, Kris! I’ve noticed ' }, { type: 2, id: 'b-1', group: 1 }, { type: 1, text: '. Why do you like it?' }] }] } },
    { role: 'Kris', content: { paragraphs: [{ contentItems: [
      { type: 1, text: 'I hate to be indoors all the time. And ' }, { type: 2, id: 'b-2', group: 2 }, { type: 1, text: '.' }] }] } },
    { role: 'Kris', content: { paragraphs: [{ contentItems: [
      { type: 1, text: 'Me neither! ' }, { type: 2, id: 'b-3', group: 3 },
      { type: 1, text: '. I make sure I use the right equipment, follow safety protocols, and ' },
      { type: 2, id: 'b-4', group: 4 }, { type: 1, text: '.' }] }] } },
    { role: 'Kris', content: { paragraphs: [{ contentItems: [
      { type: 1, text: 'Yes, and ' }, { type: 2, id: 'b-5', group: 5 }, { type: 1, text: '.' }] }] } },
    { role: 'Adrian', content: { paragraphs: [{ contentItems: [
      { type: 1, text: 'So ' }, { type: 2, id: 'b-6', group: 6 }, { type: 1, text: '!' }] }] } },
  ],
  fillBlanks: ['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'b-6'].map((id, index) => ({ id, group: index + 1, answer: '', standardAnswer: '' })),
  audioScript: "<p><strong>Adrian:</strong>&nbsp;Hey, Kris! I've noticed you are really passionate about rock climbing. Why do you like it?</p>" +
    "<p><strong>Kris:</strong>&nbsp;I hate to be indoors all the time. And rock climbing is such an exciting and challenging sport for me.</p>" +
    "<p><strong>Kris:</strong>&nbsp;Me neither! That's why safety is always a top priority. I make sure I use the right equipment, follow safety protocols, and climb with experienced partners.</p>" +
    "<p><strong>Kris:</strong>&nbsp;Yes, and it costs a lot of money.</p>" +
    "<p><strong>Adrian:</strong>&nbsp;So it’s expensive and dangerous!</p>" });

const exercise11 = () => ({ id: 'q-11', type: 11, contentString: 'Match each sport to the correct place in the diagram. Drag and drop.', ifDigi: true,
  drag: [
    { id: 't-ind', content: 'Individual Sports', styleContent: { paragraphs: [{ contentItems: [{ text: 'Individual Sports' }] }] } },
    { id: 't-team', content: 'Team Sports', styleContent: { paragraphs: [{ contentItems: [{ text: 'Team Sports' }] }] } },
    { id: 't-both', content: 'Individual Sports & Team Sports', styleContent: { paragraphs: [{ contentItems: [{ text: 'Individual Sports & Team Sports' }] }] } },
  ],
  dragged: ['baseball', 'badminton', 'skiing', 'swimming'].map((text, index) => ({ id: 'i-' + index, content: text,
    styleContent: { paragraphs: [{ contentItems: [{ text }] }] } })) });

const exercise22 = () => ({ id: 'q-22', type: 22, contentString: 'Listen and judge.',
  sentItems: ['Statement one', 'Statement two'].map((text, index) => ({ id: 's-' + (index + 1),
    styleText: { paragraphs: [{ contentItems: [{ text }] }] } })),
  options: [{ id: 'opt-t', content: 'True', styleContent: { paragraphs: [{ contentItems: [{ text: 'True' }] }] } },
    { id: 'opt-f', content: 'False', styleContent: { paragraphs: [{ contentItems: [{ text: 'False' }] }] } }] });

const exercise10 = () => ({ id: 'q-10', type: 10, contentString: 'Match each item.',
  drag: ['Target one', 'Target two'].map((text, index) => ({ id: 't-' + (index + 1), content: text,
    styleContent: { paragraphs: [{ contentItems: [{ text }] }] } })),
  dragged: ['Option one', 'Option two'].map((text, index) => ({ id: 'i-' + (index + 1), content: text,
    styleContent: { paragraphs: [{ contentItems: [{ text }] }] } })) });

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); history.replaceState({}, '', path); });
afterEach(() => vi.unstubAllGlobals());

describe('legacy production route regression', () => {
  it('recognizes the actual legacy student route and excludes teacher and examination routes', () => {
    expect(legacyRoute()).toBe(true); expect(fixture().adapter.discover()).toHaveLength(1);
    for (const p of ['/legacy/course-study-teacher/10/20/30/key', '/legacy/exam/10', '/legacy/course-study-student/10/20']) {
      history.replaceState({}, '', p); expect(legacyRoute()).toBe(false);
    }
  });
  it('matches UUID drag assignments without relying on option order', () => {
    const data = legacyData({ exercise: exercise(), submitNum: 0 });
    expect(planTasks(data)[0].value).toEqual([{ idx: 'blank-a', answer: 'option-b' }, { idx: 'blank-b', answer: 'option-a' }]);
    expect(hasCompleteResponse(data.questionVOList[0], [{ idx: 'blank-a', answer: 'option-b' }])).toBe(false);
    const broken = exercise(); broken.fillBlanks[0].answer = 'not-an-option';
    expect(() => legacyData({ exercise: broken, submitNum: 0 })).toThrow('拖拽填空');
  });
  it('plans role-play type 9 as recording and recognizes only the selected role as complete', () => {
    const roleExercise = { id: 'role-q', type: 9,
      roles: [{ id: 'role-1', name: 'Adrian' }, { id: 'role-2', name: 'Beth' }],
      sentItems: [
        { id: 'sent-1', roleId: 'role-1', audio: 'res-1', audioTime: '3', styleText: { paragraphs: [{ contentItems: [{ text: 'Hello' }] }] } },
        { id: 'sent-2', roleId: 'role-2', audio: 'res-2', audioTime: '3' },
        { id: 'sent-3', roleId: 'role-1', audio: 'res-3', audioTime: '4' },
      ] };
    const empty = legacyData({ exercise: roleExercise, submitNum: 0 });
    expect(planTasks(empty)[0].kind).toBe('recording');
    expect((planTasks(empty)[0].question.extension as any).sentItems[0].audio).toBe('res-1');
    const selected = legacyData({ exercise: roleExercise, submitNum: 1, doRecord: { type: 9, roleId: 'role-1', answer: {
      'sent-1': { recordAudio: 'audio-1', words: [{ type: 1 }] },
      'sent-3': { recordAudio: 'audio-3', words: [{ type: 1 }] },
    } } });
    expect(hasCompleteResponse(selected.questionVOList[0], selected.questionAnswerItemVOList![0].userAnswer)).toBe(true);
    const partial = legacyData({ exercise: roleExercise, submitNum: 1, doRecord: { type: 9, roleId: 'role-1', answer: {
      'sent-1': { recordAudio: 'audio-1' },
    } } });
    expect(hasCompleteResponse(partial.questionVOList[0], partial.questionAnswerItemVOList![0].userAnswer)).toBe(false);
    const bothRoles = legacyData({ exercise: roleExercise, submitNum: 1, doRecord: { type: 9, answer: {
      'sent-1': { recordAudio: 'audio-1' }, 'sent-2': { recordAudio: 'audio-2' }, 'sent-3': { recordAudio: 'audio-3' },
    } } });
    expect(hasCompleteResponse(bothRoles.questionVOList[0], bothRoles.questionAnswerItemVOList![0].userAnswer)).toBe(true);
  });
  it('passes a composite listening script to its child questions', () => {
    const data = legacyData({ exercise: { id: 'q-15', type: 15, audioScript: '<p>Script text</p>',
      audio: 'parent-audio', image: 'parent-image',
      exerciseList: [{ id: 'c-1', type: 3, fillBlanks: [{ id: 'blank-a', answer: 'x' }] }] }, submitNum: 0 });
    const child = data.questionVOList[0].children![0];
    expect((child.extension as any).audioScript).toBe('Script text');
    expect(child.audio).toEqual(['parent-audio']);
    expect(child.images).toEqual(['parent-image']);
  });
  it('plans oral-brief type 8 as recording instead of writing', () => {
    const exercise8 = { id: 'oral-8', type: 8, contentString: 'Talk about your favorite sport.', answer: '' };
    const d = legacyData({ exercise: exercise8, submitNum: 0 });
    expect(planTasks(d)[0].kind).toBe('recording');
    expect(planTasks(d)[0].question.type).toBe('legacy_8');
    expect(hasCompleteResponse(planTasks(d)[0].question, { audio: 'vod-id' })).toBe(true);
    expect(hasCompleteResponse(planTasks(d)[0].question, { audio: '' })).toBe(false);
  });
  it('plans legacy_18 and requires the selected role answers', () => {
    const exercise18 = { id: 'role-18', type: 18,
      roles: [{ id: 'role-1', name: 'Adrian' }, { id: 'role-2', name: 'Kris' }],
      sentItems: [
        { id: 'r-1', roleId: 'role-1', audio: 'audio-1', styleText: { paragraphs: [{ contentItems: [{ text: 'One' }] }] } },
        { id: 'r-2', roleId: 'role-2', audio: 'audio-2', styleText: { paragraphs: [{ contentItems: [{ text: 'Two' }] }] } },
        { id: 'r-3', roleId: 'role-1', audio: 'audio-3', styleText: { paragraphs: [{ contentItems: [{ text: 'Three' }] }] } },
      ] };
    const data18 = legacyData({ exercise: exercise18, submitNum: 0 });
    expect(planTasks(data18)[0].kind).toBe('recording'); expect(planTasks(data18)[0].question.type).toBe('legacy_18');
    const saved18 = legacyData({ exercise: exercise18, submitNum: 1, doRecord: { type: 18, roleId: 'role-1', answer: {
      'r-1': { recordAudio: 'a-1' }, 'r-3': { recordAudio: 'a-3' },
    } } });
    expect(saved18.questionAnswerItemVOList![0].userAnswer).toEqual({ roleId: 'role-1', answers: [
      { idx: 'r-1', audio: 'a-1' }, { idx: 'r-3', audio: 'a-3' },
    ] });
    expect(hasCompleteResponse(saved18.questionVOList[0], saved18.questionAnswerItemVOList![0].userAnswer)).toBe(true);
  });
  it('finds role-play capability on the actual adap/listen component tags', () => {
    document.body.innerHTML = '<app-course-task-stu><lib-adap-exercise-cs-study></lib-adap-exercise-cs-study></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const roleExercise: any = { id: 'role-q', type: 9, roles: [{ id: 'role-1', name: 'Adrian' }],
      sentItems: [{ id: 'sent-1', roleId: 'role-1', audioTime: '3' }] };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: roleExercise, pageTitle: 'Sample',
      doRecord: { type: 9, answer: {} }, loadDoRecord() {}, doRecordChange: { emit: vi.fn() },
      selectRole: vi.fn(), start: vi.fn(), playVadio: vi.fn() };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: roleExercise, submitNum: 0 }))[0];
    expect((adapter as any).leaf(unit, task).component).toBe(c);
  });
  it('submits the selected role samples as recording results without microphone or playVadio', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-adap-exercise-cs-study></lib-adap-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const roleExercise: any = { id: 'role-q', type: 9,
      roles: [{ id: 'role-a', name: 'A' }, { id: 'role-b', name: 'B' }],
      sentItems: [
        { id: 'a-1', roleId: 'role-a', audio: 'res-a1', audioTime: '3' },
        { id: 'b-1', roleId: 'role-b', audio: 'res-b1', audioTime: '3' },
        { id: 'a-2', roleId: 'role-a', audio: 'res-a2', audioTime: '4' },
      ] };
    const changes = vi.fn();
    const getResUrl = vi.fn((id: string) => ({ subscribe: ({ next }: any) => {
      next({ url: `https://cdn.example/${id}.mp3` }); return { unsubscribe: vi.fn() };
    } }));
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: roleExercise, pageTitle: 'Role Sample',
      doRecord: { type: 9, roleId: 'role-a', answer: {} }, loadDoRecord() {},
      doRecordChange: { emit: changes }, getWebUrlService: { getResUrl },
      dataChange() { changes(this.doRecord); }, selectRole: vi.fn(), start: vi.fn(), playVadio: vi.fn() };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const data = legacyData({ exercise: roleExercise, submitNum: 0, doRecord: c.doRecord });
    const task = planTasks(data)[0];
    const value = await adapter.record(unit, task, { ...defaults, rolePlayAudioMode: 'sample' }, signal());
    expect(c.selectRole).toHaveBeenCalledWith('role-a');
    expect(c.start).not.toHaveBeenCalled(); expect(c.playVadio).not.toHaveBeenCalled();
    expect(c.doRecord.answer['b-1']).toBeUndefined();
    expect(c.doRecord.answer['a-1'].recordAudio).toBe('https://cdn.example/res-a1.mp3');
    expect(c.doRecord.answer['a-2'].recordAudio).toBe('https://cdn.example/res-a2.mp3');
    expect(value).toEqual([{ idx: 'a-1', audio: 'https://cdn.example/res-a1.mp3' },
      { idx: 'a-2', audio: 'https://cdn.example/res-a2.mp3' }]);
    expect(changes).toHaveBeenCalled();
    expect(getResUrl.mock.calls.map(call => call[0])).toEqual(['res-a1', 'res-a2']);
  });
  it('handles the listen-and-repeat type 9 variant without selectRole or start', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-listen-and-repeat-exercise-cs-study></lib-listen-and-repeat-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const roleExercise: any = { id: 'listen-q', type: 9,
      roles: [{ id: 'role-a', name: 'Adrian' }, { id: 'role-b', name: 'Kris' }],
      sentItems: [
        { id: 'l-1', roleId: 'role-a', audio: 'res-l1', audioTime: '0', styleText: { paragraphs: [{ contentItems: [{ text: 'One' }] }] } },
        { id: 'l-2', roleId: 'role-b', audio: 'res-l2', audioTime: '0', styleText: { paragraphs: [{ contentItems: [{ text: 'Two' }] }] } },
      ] };
    const empty = () => ({ score: 0, accuracy: 0, fluency: 0, senseGroup: 0, speed: 0, stress: 0,
      integrity: 0, rhythm: 0, pron: 0, recordAudio: '', words: [], ccode: {}, result: '' });
    const changes = vi.fn();
    const getResUrl = vi.fn((id: string) => ({ subscribe: ({ next }: any) => {
      next({ url: `https://cdn.example/${id}.mp3` }); return { unsubscribe: vi.fn() };
    } }));
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: roleExercise, pageTitle: 'Listen Sample',
      doRecord: { type: 9, answer: { 'l-1': empty(), 'l-2': empty() } }, loadDoRecord() {},
      doRecordChange: { emit: changes }, getWebUrlService: { getResUrl },
      dataChange() { changes(this.doRecord); }, sayBy: vi.fn(), playVadio: vi.fn() };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: roleExercise, submitNum: 0, doRecord: c.doRecord }))[0];
    const value = await adapter.record(unit, task, { ...defaults, rolePlayAudioMode: 'sample' }, signal());
    expect(c.sayBy).not.toHaveBeenCalled(); expect(c.playVadio).not.toHaveBeenCalled();
    expect(c.doRecord.answer['l-1'].recordAudio).toBe('https://cdn.example/res-l1.mp3');
    expect(c.doRecord.answer['l-2'].recordAudio).toBe('https://cdn.example/res-l2.mp3');
    expect(value).toEqual([{ idx: 'l-1', audio: 'https://cdn.example/res-l1.mp3' },
      { idx: 'l-2', audio: 'https://cdn.example/res-l2.mp3' }]);
    expect(changes).toHaveBeenCalled();
  });
  it('scores original question audio through Chivox and writes real results', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-listen-and-repeat-exercise-cs-study></lib-listen-and-repeat-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const roleExercise: any = { id: 'original-q', type: 9,
      roles: [{ id: 'role-a', name: 'A' }, { id: 'role-b', name: 'B' }],
      sentItems: [
        { id: 'o-1', roleId: 'role-a', audio: 'res-o1', audioTime: '0', styleText: { paragraphs: [{ contentItems: [{ text: 'One' }] }] } },
        { id: 'o-2', roleId: 'role-b', audio: 'res-o2', audioTime: '0', styleText: { paragraphs: [{ contentItems: [{ text: 'Two' }] }] } },
      ] };
    const empty = () => ({ score: 0, accuracy: 0, fluency: 0, senseGroup: 0, speed: 0, stress: 0,
      integrity: 0, rhythm: 0, pron: 0, recordAudio: '', words: [], ccode: {}, result: '' });
    const changes = vi.fn();
    const getResUrl = vi.fn((id: string) => ({ subscribe: ({ next }: any) => {
      next({ url: `https://cdn.example/${id}.mp3` }); return { unsubscribe: vi.fn() };
    } }));
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: roleExercise, pageTitle: 'Original Sample',
      doRecord: { type: 9, answer: { 'o-1': empty(), 'o-2': empty() } }, loadDoRecord() {},
      doRecordChange: { emit: changes }, getWebUrlService: { getResUrl },
      dataChange() { changes(this.doRecord); }, sayBy: vi.fn(), playVadio: vi.fn() };
    const speech: any = { chivoxRecorder: { context: {} }, speechService: { startSentence: vi.fn() } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c },
      { root: document.createElement('div'), component: speech }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: roleExercise, submitNum: 0, doRecord: c.doRecord }))[0];
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(scoreWithChivox).mockResolvedValueOnce({ score: 91, accuracy: 92, fluency: 90, senseGroup: 0,
      speed: 0, stress: 0, integrity: 0, rhythm: 0, pron: 0, recordAudio: 'https://chivox.example/1.mp3', words: [], ccode: {}, result: '' })
      .mockResolvedValueOnce({ score: 93, accuracy: 94, fluency: 92, senseGroup: 0,
        speed: 0, stress: 0, integrity: 0, rhythm: 0, pron: 0, recordAudio: 'https://chivox.example/2.mp3', words: [], ccode: {}, result: '' });
    const value = await adapter.record(unit, task, defaults, signal());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(scoreWithChivox).toHaveBeenCalledTimes(2);
    expect(c.doRecord.answer['o-1'].score).toBe(91);
    expect(c.doRecord.answer['o-1'].recordAudio).toBe('https://chivox.example/1.mp3');
    expect(c.doRecord.answer['o-2'].score).toBe(93);
    expect(value).toEqual([{ idx: 'o-1', audio: 'https://chivox.example/1.mp3' },
      { idx: 'o-2', audio: 'https://chivox.example/2.mp3' }]);
    expect(changes).toHaveBeenCalled();
  });
  it('pauses instead of fabricating a score when an original sentence has no audio', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-listen-and-repeat-exercise-cs-study></lib-listen-and-repeat-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const roleExercise: any = { id: 'no-audio-q', type: 9, roles: [{ id: 'role-a', name: 'A' }],
      sentItems: [{ id: 'n-1', roleId: 'role-a', audioTime: '0', styleText: { paragraphs: [{ contentItems: [{ text: 'No audio' }] }] } }] };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: roleExercise, pageTitle: 'No Audio',
      doRecord: { type: 9, answer: { 'n-1': { recordAudio: '' } } }, loadDoRecord() {},
      doRecordChange: { emit: vi.fn() }, getWebUrlService: { getResUrl: vi.fn() },
      dataChange: vi.fn(), sayBy: vi.fn() };
    const speech: any = { chivoxRecorder: { context: {} }, speechService: { startSentence: vi.fn() } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c },
      { root: document.createElement('div'), component: speech }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: roleExercise, submitNum: 0, doRecord: c.doRecord }))[0];
    await expect(adapter.record(unit, task, defaults, signal())).rejects.toThrow('没有原题音频');
  });
  it('uses MiMo TTS and Chivox for legacy_18 selected-role answers', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-role-play-exercise-cs-study></lib-role-play-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const exercise18: any = { id: 'role-18', type: 18,
      roles: [{ id: 'role-a', name: 'A' }, { id: 'role-b', name: 'B' }],
      sentItems: [
        { id: 'r-a1', roleId: 'role-a', audio: 'orig-a1', styleText: { paragraphs: [{ contentItems: [{ text: 'Role A one' }] }] } },
        { id: 'r-b1', roleId: 'role-b', audio: 'orig-b1', styleText: { paragraphs: [{ contentItems: [{ text: 'Role B one' }] }] } },
        { id: 'r-a2', roleId: 'role-a', audio: 'orig-a2', styleText: { paragraphs: [{ contentItems: [{ text: 'Role A two' }] }] } },
      ] };
    const changes = vi.fn();
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise18, pageTitle: 'Role 18',
      doRecord: { type: 18, answer: {}, roleId: '', saSentScore: 0 }, loadDoRecord() {},
      doRecordChange: { emit: changes }, dataChange() { changes(this.doRecord); },
      selectRole(id: string) { this.doRecord.roleId = id; }, start() {
        this.showSelectRole = false; this.showTime = false; this.isClose = true;
        this.doRecord.answer = { 'r-a1': { recordAudio: '' }, 'r-a2': { recordAudio: '' } };
      }, selectNowRole: vi.fn(),
      showSelectRole: true, showTime: true, isClose: true };
    const speech: any = { chivoxRecorder: { context: {} }, speechService: { startSentence: vi.fn() } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c },
      { root: document.createElement('div'), component: speech }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: exercise18, submitNum: 0, doRecord: c.doRecord }))[0];
    vi.mocked(synthesizeSpeech).mockResolvedValue(new ArrayBuffer(8));
    vi.mocked(scoreWithChivox).mockResolvedValue({ score: 90, accuracy: 91, fluency: 89, senseGroup: 0,
      speed: 0, stress: 0, integrity: 0, rhythm: 0, pron: 0, recordAudio: 'https://chivox.example/v18.mp3', words: [], ccode: {}, result: '' });
    const settings = { ...defaults, ttsApiKey: 'test-key', ttsModel: 'tts-model', ttsVoice: 'voice' };
    const value = await adapter.record(unit, task, settings, signal());
    expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(synthesizeSpeech).toHaveBeenNthCalledWith(1, 'Role A one', expect.objectContaining({ ttsApiKey: 'test-key' }), expect.anything());
    expect(scoreWithChivox).toHaveBeenCalledTimes(2);
    expect(c.doRecord.roleId).toBe('role-a');
    expect(c.doRecord.answer['r-a1'].recordAudio).toBe('https://chivox.example/v18.mp3');
    expect(c.doRecord.answer['r-a2'].recordAudio).toBe('https://chivox.example/v18.mp3');
    expect(c.doRecord.answer['r-b1']).toBeUndefined();
    expect(c.showSelectRole).toBe(false); expect(c.isClose).toBe(true);
    expect(value).toEqual({ roleId: 'role-a', answers: [
      { idx: 'r-a1', audio: 'https://chivox.example/v18.mp3' },
      { idx: 'r-a2', audio: 'https://chivox.example/v18.mp3' },
    ] });
  });
  it('requires MiMo configuration for legacy_18', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-role-play-exercise-cs-study></lib-role-play-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const exercise18: any = { id: 'role-18', type: 18, roles: [{ id: 'role-a', name: 'A' }],
      sentItems: [{ id: 'r-a1', roleId: 'role-a', audio: 'orig-a1', styleText: { paragraphs: [{ contentItems: [{ text: 'Role A one' }] }] } }] };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise18, pageTitle: 'Role 18',
      doRecord: { type: 18, answer: {}, roleId: '' }, loadDoRecord() {}, doRecordChange: { emit: vi.fn() },
      dataChange: vi.fn(), selectRole(id: string) { this.doRecord.roleId = id; } };
    const speech: any = { chivoxRecorder: { context: {} }, speechService: { startSentence: vi.fn() } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c },
      { root: document.createElement('div'), component: speech }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: exercise18, submitNum: 0, doRecord: c.doRecord }))[0];
    await expect(adapter.record(unit, task, { ...defaults, ttsApiKey: '' }, signal())).rejects.toThrow('TTS');
  });
  it('transcribes listening audio and uses the AI answer for a writing question', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-writing-sample><textarea></textarea></lib-writing-sample><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const exercise8: any = { id: 'ai-q', type: 7, contentString: 'Write a short answer.', audio: 'audio-res' };
    const changes = vi.fn();
    const getResUrl = vi.fn((id: string) => ({ subscribe: ({ next }: any) => {
      next({ url: `https://cdn.example/${id}.mp3` }); return { unsubscribe: vi.fn() };
    } }));
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise8, pageTitle: 'AI listening',
      doRecord: { type: 7, answer: '' }, loadDoRecord() {}, doRecordChange: { emit: changes },
      getWebUrlService: { getResUrl } };
    const textarea = host.querySelector('textarea')!;
    textarea.addEventListener('input', () => { c.doRecord.answer = textarea.value; });
    textarea.addEventListener('change', () => { c.doRecord.answer = textarea.value; });
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const data = legacyData({ exercise: exercise8, submitNum: 0, doRecord: c.doRecord });
    const task = planTasks(data, { allowMissing: true })[0];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })));
    vi.mocked(transcribeAudio).mockResolvedValue('listening transcript');
    vi.mocked(answerWithAi).mockResolvedValue({ answer: 'AI generated answer' });
    const settings = { ...defaults, aiAnswers: true, aiApiKey: 'ai-key', asrApiKey: 'asr-key' };
    await adapter.fill(unit, task, settings, signal());
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('listening transcript'), settings, expect.anything());
    expect(textarea.value).toBe('AI generated answer');
    expect(c.doRecord.answer).toBe('AI generated answer');
  });
  it('transcribes listening audio first and sends the rendered picture with the prompt', async () => {
    document.body.innerHTML = '<app-course-task-stu><div class="mould">' +
      '<lib-exercise-res-show><div class="show-img"><img src="https://cdn.example/picture.png"></div></lib-exercise-res-show>' +
      '<lib-questions-answers-exercise-cs-study><textarea></textarea></lib-questions-answers-exercise-cs-study>' +
      '</div><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.querySelector<HTMLElement>('lib-questions-answers-exercise-cs-study')!;
    const exercise20: any = { id: 'img-q', type: 20, contentString: 'Look at the picture and answer.', audio: 'audio-img' };
    const getResUrl = vi.fn((id: string) => ({ subscribe: ({ next }: any) => {
      next({ url: 'https://cdn.example/' + id + '.mp3' }); return { unsubscribe: vi.fn() };
    } }));
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise20, pageTitle: 'Picture',
      doRecord: { type: 20, score: 0, answer: '' }, loadDoRecord() {}, doRecordChange: { emit: vi.fn() },
      getWebUrlService: { getResUrl } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: exercise20, submitNum: 0, doRecord: c.doRecord }), { allowMissing: true })[0];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })));
    vi.mocked(transcribeAudio).mockResolvedValue('listening transcript');
    vi.mocked(fetchImage).mockResolvedValue({ mime: 'image/png', data: 'IMGDATA' });
    vi.mocked(answerWithAi).mockResolvedValue({ answer: 'The picture shows a dog.' });
    const settings = { ...defaults, aiAnswers: true, aiApiKey: 'ai-key', asrApiKey: 'asr-key' };
    await adapter.fill(unit, task, settings, signal());
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(fetchImage).toHaveBeenCalledWith('https://cdn.example/picture.png', settings, expect.anything());
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('listening transcript'), settings,
      expect.anything(), [{ mime: 'image/png', data: 'IMGDATA' }]);
    const prompt = vi.mocked(answerWithAi).mock.calls[0][0] as string;
    expect(prompt).toContain('图片');
    expect(prompt).toContain('以图片和页面文本为准');
  });
  it('resolves exercise.image resource ids to a picture when the DOM has no img', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-writing-sample><textarea></textarea></lib-writing-sample><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const exercise20: any = { id: 'img-data', type: 7, contentString: 'Write about the picture.', image: 'img-res' };
    const getResUrl = vi.fn((id: string, type: number) => ({ subscribe: ({ next }: any) => {
      next({ url: 'https://cdn.example/' + id + '-' + type + '.png' }); return { unsubscribe: vi.fn() };
    } }));
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise20, pageTitle: 'Picture data',
      doRecord: { type: 7, answer: '' }, loadDoRecord() {}, doRecordChange: { emit: vi.fn() },
      getWebUrlService: { getResUrl } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: exercise20, submitNum: 0, doRecord: c.doRecord }), { allowMissing: true })[0];
    vi.mocked(fetchImage).mockResolvedValue({ mime: 'image/png', data: 'DATAPNG' });
    vi.mocked(answerWithAi).mockResolvedValue({ answer: 'A picture answer.' });
    const settings = { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' };
    await adapter.fill(unit, task, settings, signal());
    expect(getResUrl).toHaveBeenCalledWith('img-res', 3);
    expect(fetchImage).toHaveBeenCalledWith('https://cdn.example/img-res-3.png', settings, expect.anything());
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('Write about the picture'), settings,
      expect.anything(), [{ mime: 'image/png', data: 'DATAPNG' }]);
  });
  it('keeps answering with text when the picture cannot be downloaded', async () => {
    document.body.innerHTML = '<app-course-task-stu><div class="mould">' +
      '<lib-exercise-res-show><div class="show-img"><img src="https://cdn.example/missing.png"></div></lib-exercise-res-show>' +
      '<lib-writing-sample><textarea></textarea></lib-writing-sample></div><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.querySelector<HTMLElement>('lib-writing-sample')!;
    const exercise20: any = { id: 'img-missing', type: 7, contentString: 'Write a note.' };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise20, pageTitle: 'Missing picture',
      doRecord: { type: 7, answer: '' }, loadDoRecord() {}, doRecordChange: { emit: vi.fn() } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: exercise20, submitNum: 0, doRecord: c.doRecord }), { allowMissing: true })[0];
    vi.mocked(fetchImage).mockResolvedValue(undefined);
    vi.mocked(answerWithAi).mockResolvedValue({ answer: 'Text-only answer.' });
    const settings = { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' };
    await adapter.fill(unit, task, settings, signal());
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('图片读取失败'), settings, expect.anything());
    expect(answerWithAi).toHaveBeenCalledTimes(1);
  });
  it('generates an AI oral answer, uploads its TTS audio, and writes the VOD answer', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-oral-brief-exercise-cs-study></lib-oral-brief-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const exercise8: any = { id: 'oral-8', type: 8, contentString: 'Talk about your favorite sport.', answer: '' };
    const changes = vi.fn();
    const upload = {
      onVodComplete: { subscribe: (cb: (value: unknown) => void) => { setTimeout(() => cb({ id: 'vod-audio-id' }), 0); return { unsubscribe: vi.fn() }; } },
      onVodError: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      vodStartUpload: vi.fn(),
    };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise8, pageTitle: 'Oral brief',
      doRecord: { type: 8, answer: '' }, loadDoRecord() {}, doRecordChange: { emit: changes },
      dataChange() { changes(this.doRecord); }, vodUploadService: upload };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise: exercise8, submitNum: 0, doRecord: c.doRecord }))[0];
    vi.mocked(answerWithAi).mockResolvedValue({ answer: 'My favorite sport is running because it keeps me healthy.' });
    vi.mocked(synthesizeSpeech).mockResolvedValue(new ArrayBuffer(8));
    const settings = { ...defaults, aiAnswers: true, aiApiKey: 'ai-key', ttsApiKey: 'tts-key' };
    const value = await adapter.record(unit, task, settings, signal());
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('favorite sport'), settings, expect.anything());
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(upload.vodStartUpload).toHaveBeenCalledTimes(1);
    expect(c.doRecord.answer).toBe('vod-audio-id'); expect(c.doRecord.ossOrVod).toBe(2);
    expect(value).toEqual({ audio: 'vod-audio-id' });
  });
  it('fills type 20 questions-answers textarea and updates doRecord.answer', async () => {
    document.body.innerHTML = '<app-course-task-stu><lib-questions-answers-exercise-cs-study><textarea></textarea></lib-questions-answers-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const exercise20: any = { id: 'q20', type: 20, contentString: 'Why do you like it?', answer: '' };
    const changes = vi.fn();
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: exercise20, pageTitle: 'Q&A',
      doRecord: { type: 20, score: 0, answer: '' }, loadDoRecord() {}, doRecordChange: { emit: changes },
      dataChange() { changes(this.doRecord); } };
    const adapter = new LegacyAdapter(() => [{ root, component: { ...c, loadDoRecord: c.loadDoRecord } }, { root: host, component: c }]);
    const unit = adapter.discover()[0];
    const data = legacyData({ exercise: exercise20, submitNum: 0, doRecord: c.doRecord });
    const task = planTasks(data, { allowMissing: true })[0];
    expect(task.kind).toBe('writing');
    vi.mocked(answerWithAi).mockResolvedValue({ answer: 'Because it is exciting and healthy.' });
    const settings = { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' };
    const value = await adapter.fill(unit, task, settings, signal());
    expect(host.querySelector('textarea')!.value).toBe('Because it is exciting and healthy.');
    expect(c.doRecord.answer).toBe('Because it is exciting and healthy.');
    expect(value).toEqual({ answer: 'Because it is exciting and healthy.', annex: [] });
  });
  it('restores type 19 dialogue blanks from the official audio script', () => {
    const data = legacyData({ exercise: exercise19(), submitNum: 0 });
    const question = data.questionVOList[0];
    expect(question.type).toBe('fill_base');
    expect((question.extension as any).legacyType).toBe(19);
    const plan = planTasks(data, { allowMissing: true })[0];
    expect(plan.kind).toBe('fill');
    expect((plan.value as any[]).map(v => v.idx)).toEqual(['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'b-6']);
    expect(scriptFillAnswers(question)).toEqual([
      { idx: 'b-1', answer: 'you are really passionate about rock climbing' },
      { idx: 'b-2', answer: 'rock climbing is such an exciting and challenging sport for me' },
      { idx: 'b-3', answer: "That's why safety is always a top priority" },
      { idx: 'b-4', answer: 'climb with experienced partners' },
      { idx: 'b-5', answer: 'it costs a lot of money' },
      { idx: 'b-6', answer: 'it’s expensive and dangerous' },
    ]);
    expect(() => planTasks(data)).toThrow('答案');
    expect(hasCompleteResponse(question, scriptFillAnswers(question))).toBe(true);
    const saved = legacyData({ exercise: exercise19(), submitNum: 1,
      doRecord: { type: 19, answer: Object.fromEntries(scriptFillAnswers(question)!.map(a => [a.idx, { id: a.idx, score: 2, content: a.answer }])) } });
    expect(hasCompleteResponse(saved.questionVOList[0], saved.questionAnswerItemVOList![0].userAnswer)).toBe(true);
  });
  it('fills type 19 dialogue blanks and reopens a stale read-only page', async () => {
    const exercise = exercise19();
    document.body.innerHTML = '<app-course-task-stu><lib-fill-blank-dialogue-exercise-cs-study>' +
      exercise.fillBlanks.map(b => '<span contenteditable="true" id="a-' + b.id + '"></span>').join('') +
      '</lib-fill-blank-dialogue-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const doRecord: any = { type: 19, answer: {} };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 0, data: { isVisiable: 1 }, exercise, pageTitle: 'Dialogue',
      doRecord, isEmptyDoRecord: true, loadDoRecord() { setTimeout(() => { c.exerciseStatus = 1; c.doRecord = { type: 19, answer: {} }; }, 0); },
      retry() { c.exerciseStatus = 1; c.doRecord = { type: 19, answer: {} }; } };
    const leaf: any = { status: 1, exercise, doRecord: c.doRecord, doRecordChange: { emit: vi.fn() } };
    for (const span of host.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
      span.addEventListener('input', () => {
        const id = span.id.slice(2);
        if (!leaf.doRecord.answer[id]) leaf.doRecord.answer[id] = { id };
        leaf.doRecord.answer[id].content = span.innerText;
      });
    }
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockClear();
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(c.exerciseStatus).toBe(1);
    expect(host.querySelector<HTMLElement>('#a-b-3')!.innerText).toBe("That's why safety is always a top priority");
    expect(value).toHaveLength(6);
    expect(answerWithAi).not.toHaveBeenCalled();
  });
  it('asks AI for type 19 blanks only when the audio script cannot resolve them', async () => {
    const exercise = exercise19();
    exercise.audioScript = '';
    delete (exercise as any).audio;
    document.body.innerHTML = '<app-course-task-stu><lib-fill-blank-dialogue-exercise-cs-study>' +
      exercise.fillBlanks.map(b => '<span contenteditable="true" id="a-' + b.id + '"></span>').join('') +
      '</lib-fill-blank-dialogue-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Dialogue',
      doRecord: { type: 19, answer: {} }, loadDoRecord() {} };
    const leaf: any = { status: 1, exercise, doRecord: c.doRecord, doRecordChange: { emit: vi.fn() } };
    for (const span of host.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
      span.addEventListener('input', () => {
        const id = span.id.slice(2);
        if (!leaf.doRecord.answer[id]) leaf.doRecord.answer[id] = { id };
        leaf.doRecord.answer[id].content = span.innerText;
      });
    }
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: exercise.fillBlanks.map(b => ({ idx: b.id, answer: 'answer ' + b.id })) });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).toHaveBeenCalledTimes(1);
    expect(value).toHaveLength(6);
  });
  it('plans legacy type 11 as a many-to-many classification with AI fill', async () => {
    const data = legacyData({ exercise: exercise11(), submitNum: 0 });
    const question = data.questionVOList[0];
    expect(question.type).toBe('legacy_11');
    const plan = planTasks(data, { allowMissing: true })[0];
    expect(plan.kind).toBe('fill');
    expect((plan.value as any[]).map(g => g.idx)).toEqual(['t-ind', 't-team', 't-both']);
    const complete = [{ idx: 't-ind', answers: ['i-2'] }, { idx: 't-team', answers: ['i-0'] },
      { idx: 't-both', answers: ['i-1', 'i-3'] }];
    expect(hasCompleteResponse(question, complete)).toBe(true);
    expect(hasCompleteResponse(question, complete.map(g => g.idx === 't-both' ? { ...g, answers: ['i-1'] } : g))).toBe(false);
    expect(hasCompleteResponse(question, [{ idx: 't-ind', answers: ['i-2', 'i-2'] }])).toBe(false);
  });
  it('drags each AI-classified item into its target and confirms the record', async () => {
    const exercise = exercise11();
    document.body.innerHTML = '<app-course-task-stu><lib-drag-drop-many-exercise-cs-study>' +
      exercise.dragged.map(i => '<div class="' + i.id + '"></div>').join('') +
      '</lib-drag-drop-many-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const changes = vi.fn();
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Classify',
      doRecord: { type: 11, answer: {} }, loadDoRecord() {}, doRecordChange: { emit: changes } };
    const leaf: any = { status: 1, exercise, doRecord: c.doRecord, doRecordChange: { emit: changes },
      drag(event: any) {
        const target = this.doRecord.answer[event.container.id] ||= { id: event.container.id, choiceIds: [], score: 0 };
        target.choiceIds.push(event.previousContainer.id); changes(this.doRecord);
      }, answerChange() { changes(this.doRecord); } };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: [
      { idx: 't-ind', answers: ['i-2'] }, { idx: 't-team', answers: ['i-0'] },
      { idx: 't-both', answers: ['i-1', 'i-3'] },
    ] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('待分类项'), expect.anything(), expect.anything());
    expect(leaf.doRecord.answer['t-both'].choiceIds).toEqual(['i-1', 'i-3']);
    expect(value).toEqual([{ idx: 't-ind', answers: ['i-2'] }, { idx: 't-team', answers: ['i-0'] },
      { idx: 't-both', answers: ['i-1', 'i-3'] }]);
  });
  it('gives the AI the whole page so word boxes outside the child question are included', async () => {
    const exercise: any = { id: 'q-15', type: 15, audioScript: '<p>Speaker A: I like running.</p>', exerciseList: [
      { id: 'c-1', type: 5, fillBlanks: [{ id: 'b-1', answer: '' }] }] };
    document.body.innerHTML = '<app-course-task-stu><div class="word-box">golf volleyball a marathon the soccer team</div>' +
      '<lib-fill-blank-exercise-cs-study><span contenteditable="true" id="a-b-1"></span></lib-fill-blank-exercise-cs-study>' +
      '<button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.querySelector('lib-fill-blank-exercise-cs-study') as HTMLElement;
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Composite',
      doRecord: { type: 15, answer: {} }, loadDoRecord() {} };
    const leaf: any = { status: 1, exercise: exercise.exerciseList[0], doRecord: { type: 5, answer: {} },
      doRecordChange: { emit: vi.fn() } };
    const span = host.querySelector<HTMLElement>('#a-b-1')!;
    span.addEventListener('input', () => { leaf.doRecord.answer['b-1'] = { id: 'b-1', content: span.innerText }; });
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: [{ idx: 'b-1', answer: 'a marathon' }] });
    await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('a marathon'), expect.anything(), expect.anything());
    expect(answerWithAi).toHaveBeenCalledWith(expect.stringContaining('词库'), expect.anything(), expect.anything());
  });
  it('plans legacy type 22 judge questions and validates option ids', () => {
    const data = legacyData({ exercise: exercise22(), submitNum: 0 });
    const question = data.questionVOList[0];
    expect(question.type).toBe('legacy_22');
    const plan = planTasks(data, { allowMissing: true })[0];
    expect(plan.kind).toBe('fill');
    expect((plan.value as any[]).map(v => v.idx)).toEqual(['s-1', 's-2']);
    const complete = [{ idx: 's-1', answer: 'opt-t' }, { idx: 's-2', answer: 'opt-f' }];
    expect(hasCompleteResponse(question, complete)).toBe(true);
    expect(hasCompleteResponse(question, [{ idx: 's-1', answer: 'opt-x' }, { idx: 's-2', answer: 'opt-f' }])).toBe(false);
    expect(hasCompleteResponse(question, [{ idx: 's-1', answer: 'opt-t' }])).toBe(false);
  });
  it('clicks the judge options returned by AI and confirms the record', async () => {
    const exercise = exercise22();
    document.body.innerHTML = '<app-course-task-stu><lib-judge-exercise-cs-study></lib-judge-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const changes = vi.fn();
    const leaf: any = { status: 1, exercise, doRecord: { type: 22, answer: {} }, doRecordChange: { emit: changes },
      selectOption(idx: string, option: string) {
        this.doRecord.answer[idx] = { ...(this.doRecord.answer[idx] || {}), id: option, score: 0 }; changes(this.doRecord);
      } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Judge',
      doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: [{ idx: 's-1', answer: 'opt-t' }, { idx: 's-2', answer: 'opt-f' }] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(leaf.doRecord.answer['s-1'].id).toBe('opt-t');
    expect(leaf.doRecord.answer['s-2'].id).toBe('opt-f');
    expect(value).toEqual([{ idx: 's-1', answer: 'opt-t' }, { idx: 's-2', answer: 'opt-f' }]);
  });
  it('uses the judge optionId carried by the exercise instead of asking AI', async () => {
    const exercise: any = exercise22();
    exercise.sentItems[0].optionId = 'opt-t';
    exercise.sentItems[1].optionId = 'opt-f';
    document.body.innerHTML = '<app-course-task-stu><lib-judge-exercise-cs-study></lib-judge-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const changes = vi.fn();
    const leaf: any = { status: 1, exercise, doRecord: { type: 22, answer: {} }, doRecordChange: { emit: changes },
      selectOption(idx: string, option: string) {
        this.doRecord.answer[idx] = { id: option, score: 0 }; changes(this.doRecord);
      } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Judge',
      doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockClear();
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).not.toHaveBeenCalled();
    expect(value).toEqual([{ idx: 's-1', answer: 'opt-t' }, { idx: 's-2', answer: 'opt-f' }]);
  });
  it('accepts judge answers written as option text and retries once on invalid values', async () => {
    const exercise = exercise22();
    document.body.innerHTML = '<app-course-task-stu><lib-judge-exercise-cs-study></lib-judge-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const leaf: any = { status: 1, exercise, doRecord: { type: 22, answer: {} }, doRecordChange: { emit: vi.fn() },
      selectOption(idx: string, option: string) { this.doRecord.answer[idx] = { id: option, score: 0 }; } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Judge',
      doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi)
      .mockResolvedValueOnce({ fill: [{ idx: 's-1', answer: 'maybe' }, { idx: 's-2', answer: 'False' }] })
      .mockResolvedValueOnce({ fill: [{ idx: 's-1', answer: 'True' }, { idx: 's-2', answer: 'False' }] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).toHaveBeenCalledTimes(2);
    expect(value).toEqual([{ idx: 's-1', answer: 'opt-t' }, { idx: 's-2', answer: 'opt-f' }]);
  });
  it('falls back to AI for a missing fill answer even when the AI toggle is off', async () => {
    const exercise: any = { id: 'q-fill', type: 3, fillBlanks: [{ id: 'blank-1', answer: '' }] };
    document.body.innerHTML = '<app-course-task-stu><lib-fill-blank-exercise-cs-study>' +
      '<span contenteditable="true" id="a-blank-1"></span></lib-fill-blank-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const leaf: any = { status: 1, exercise, doRecord: { type: 3, answer: {} }, doRecordChange: { emit: vi.fn() } };
    const span = host.querySelector<HTMLElement>('#a-blank-1')!;
    span.addEventListener('input', () => { leaf.doRecord.answer['blank-1'] = { id: 'blank-1', content: span.innerText }; });
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Fill',
      doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: [{ idx: 'blank-1', answer: 'ai answer' }] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: false, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).toHaveBeenCalledTimes(1);
    expect(value).toEqual([{ idx: 'blank-1', answer: 'ai answer' }]);
  });
  it('plans and fills one-to-one legacy type 10 matching questions', async () => {
    const exercise = exercise10();
    const data = legacyData({ exercise, submitNum: 0 });
    const question = data.questionVOList[0];
    expect(question.type).toBe('legacy_10');
    const plan = planTasks(data, { allowMissing: true })[0];
    expect((plan.value as any[]).map(v => v.idx)).toEqual(['t-1', 't-2']);
    const complete = [{ idx: 't-1', answer: 'i-1' }, { idx: 't-2', answer: 'i-2' }];
    expect(hasCompleteResponse(question, complete)).toBe(true);
    expect(hasCompleteResponse(question, [{ idx: 't-1', answer: 'i-1' }, { idx: 't-2', answer: 'i-1' }])).toBe(false);
    document.body.innerHTML = '<app-course-task-stu><lib-drag-drop-one-exercise-cs-study>' +
      exercise.dragged.map(i => '<div class="' + i.id + '"></div>').join('') +
      '</lib-drag-drop-one-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const changes = vi.fn();
    const leaf: any = { status: 1, exercise, doRecord: { type: 10, answer: {} }, doRecordChange: { emit: changes },
      drag(event: any) {
        this.doRecord.answer[event.container.id] = { id: event.container.id, choiceId: event.previousContainer.id, score: 0 };
        changes(this.doRecord);
      }, answerChange() { changes(this.doRecord); } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Match',
      doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: [{ idx: 't-1', answer: 'i-1' }, { idx: 't-2', answer: 'i-2' }] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(value).toEqual(complete);
    expect(leaf.doRecord.answer['t-2'].choiceId).toBe('i-2');
  });
  it('maps type 10 text or label answers back to option ids and retries once', async () => {
    const exercise: any = exercise10();
    exercise.dragged[0].styleContent = { paragraphs: [{ contentItems: [{ text: 'a. Option one' }] }] };
    exercise.dragged[1].styleContent = { paragraphs: [{ contentItems: [{ text: 'b. Option two' }] }] };
    document.body.innerHTML = '<app-course-task-stu><lib-drag-drop-one-exercise-cs-study>' +
      exercise.dragged.map((i: any) => '<div class="' + i.id + '"></div>').join('') +
      '</lib-drag-drop-one-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const leaf: any = { status: 1, exercise, doRecord: { type: 10, answer: {} }, doRecordChange: { emit: vi.fn() },
      drag(event: any) { this.doRecord.answer[event.container.id] = { id: event.container.id, choiceId: event.previousContainer.id, score: 0 }; } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Match', doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi)
      .mockResolvedValueOnce({ fill: [{ idx: 't-1', answer: 'not-an-item' }, { idx: 't-2', answer: 'b' }] })
      .mockResolvedValueOnce({ fill: [{ idx: 't-1', answer: 'b. Option two' }, { idx: 't-2', answer: 'a. Option one' }] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).toHaveBeenCalledTimes(2);
    expect(value).toEqual([{ idx: 't-1', answer: 'i-2' }, { idx: 't-2', answer: 'i-1' }]);
  });
  it('accepts type 10 assignments that leave an extra distractor item unused', async () => {
    const exercise: any = exercise10();
    exercise.dragged.push({ id: 'i-3', content: 'Option three' });
    document.body.innerHTML = '<app-course-task-stu><lib-drag-drop-one-exercise-cs-study>' +
      exercise.dragged.map((i: any) => '<div class="' + i.id + '"></div>').join('') +
      '</lib-drag-drop-one-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const leaf: any = { status: 1, exercise, doRecord: { type: 10, answer: {} }, doRecordChange: { emit: vi.fn() },
      drag(event: any) { this.doRecord.answer[event.container.id] = { id: event.container.id, choiceId: event.previousContainer.id, score: 0 }; } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Match', doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: [{ idx: 't-1', answer: 'i-2' }, { idx: 't-2', answer: 'i-1' }] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(value).toEqual([{ idx: 't-1', answer: 'i-2' }, { idx: 't-2', answer: 'i-1' }]);
  });
  it('matches type 10 rows keyed by target text and answers written as descriptions', async () => {
    const exercise: any = exercise10();
    exercise.drag[0].styleContent = { paragraphs: [{ contentItems: [{ text: 'cheese-rolling' }] }] };
    exercise.drag[1].styleContent = { paragraphs: [{ contentItems: [{ text: 'octopush' }] }] };
    exercise.dragged[0].styleContent = { paragraphs: [{ contentItems: [{ text: 'a. an underwater form of hockey' }] }] };
    exercise.dragged[1].styleContent = { paragraphs: [{ contentItems: [{ text: 'b. a sport popular in Southeast Asia' }] }] };
    document.body.innerHTML = '<app-course-task-stu><lib-drag-drop-one-exercise-cs-study>' +
      exercise.dragged.map((i: any) => '<div class="' + i.id + '"></div>').join('') +
      '</lib-drag-drop-one-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const leaf: any = { status: 1, exercise, doRecord: { type: 10, answer: {} }, doRecordChange: { emit: vi.fn() },
      drag(event: any) { this.doRecord.answer[event.container.id] = { id: event.container.id, choiceId: event.previousContainer.id, score: 0 }; } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Match', doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    const task = planTasks(legacyData({ exercise, submitNum: 0 }), { allowMissing: true })[0];
    vi.mocked(answerWithAi).mockResolvedValue({ fill: [
      { idx: 'cheese-rolling', answer: 'b. a sport popular in Southeast Asia' },
      { idx: 'octopush', answer: 'a. an underwater form of hockey' },
    ] });
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(value).toEqual([{ idx: 't-1', answer: 'i-2' }, { idx: 't-2', answer: 'i-1' }]);
  });
  it('uses type 10 answers carried by the exercise without asking AI', async () => {
    const exercise: any = exercise10();
    exercise.drag[0].answer = 'i-2';
    exercise.drag[1].answer = 'i-1';
    const data = legacyData({ exercise, submitNum: 0 });
    const task = planTasks(data, { allowMissing: true })[0];
    expect((task.value as any[]).map(v => v.answer)).toEqual(['i-2', 'i-1']);
    document.body.innerHTML = '<app-course-task-stu><lib-drag-drop-one-exercise-cs-study></lib-drag-drop-one-exercise-cs-study><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const host = root.firstElementChild as HTMLElement;
    const leaf: any = { status: 1, exercise, doRecord: { type: 10, answer: {} }, doRecordChange: { emit: vi.fn() },
      drag(event: any) { this.doRecord.answer[event.container.id] = { id: event.container.id, choiceId: event.previousContainer.id, score: 0 }; } };
    const c: any = { courseId: 20, pageId: 'page-uuid', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise, pageTitle: 'Match', doRecord: leaf.doRecord, loadDoRecord() {} };
    const adapter = new LegacyAdapter(() => [{ root, component: c }, { root: host, component: leaf }]);
    const unit = adapter.discover()[0];
    vi.mocked(answerWithAi).mockClear();
    const value = await adapter.fill(unit, task, { ...defaults, aiAnswers: true, aiApiKey: 'ai-key' }, signal());
    expect(answerWithAi).not.toHaveBeenCalled();
    expect(value).toEqual([{ idx: 't-1', answer: 'i-2' }, { idx: 't-2', answer: 'i-1' }]);
  });
  it('uses normal read POST and verifies native submission with a fresh server response', async () => {
    const f = fixture(), controller = new Controller(f.adapter, new Store(), async (_, job) => job());
    await controller.start(f.unit, { ...defaults, intervalMs: 0 });
    expect(controller.progress.status).toBe('done'); expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.server.doRecord.answer['blank-a'].choiceId).toBe('option-b');
    expect(f.c.http.post).toHaveBeenCalledTimes(3);
    expect(f.c.http.post.mock.calls[0][0]).toBe('/tsenglish/exercise/record_for_detail?courseId=20&pageId=page-uuid&userId=30');
    expect(controller.logs.some(log => log.code === 'VERIFIED')).toBe(true);
    const refreshed = new Controller(f.adapter, new Store(), async (_, job) => job());
    await refreshed.start(f.unit, defaults);
    expect(refreshed.logs.some(log => log.code === 'RECONCILED')).toBe(true);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('preserves already submitted records and does not click ReChallenge', async () => {
    const f = fixture(true), controller = new Controller(f.adapter, new Store(), async (_, job) => job());
    await controller.start(f.unit, defaults);
    expect(controller.logs.some(log => log.code === 'ALREADY_SAVED')).toBe(true);
    expect(f.submit).not.toHaveBeenCalled(); expect(f.changes).not.toHaveBeenCalled();
  });
  it('keeps local work intact when re-reading and reports HTTP530 after bounded retries', async () => {
    const f = fixture(); f.c.doRecord.answer = { 'blank-a': { choiceId: 'option-a' } };
    const local = structuredClone(f.c.doRecord);
    await f.adapter.load(f.unit, signal()); expect(f.c.doRecord).toEqual(local); f.c.http.post.mockClear();
    f.c.http.post.mockImplementation(() => ({ subscribe: ({ error }: any) => { error({ status: 530 }); return { unsubscribe() {} }; } }));
    await expect(f.adapter.load(f.unit, signal())).rejects.toThrow('HTTP 530');
    expect(f.c.http.post).toHaveBeenCalledTimes(3);
    expect(f.adapter.discover()).toHaveLength(1); expect(f.submit).not.toHaveBeenCalled();
  });
  it('retries a transient HTTP530 read instead of pausing the exercise', async () => {
    const f = fixture(); let calls = 0;
    f.c.http.post.mockImplementation(() => ({ subscribe: ({ next, error }: any) => {
      calls += 1;
      if (calls === 1) error({ status: 530 });
      else next({ status: true, object: structuredClone(f.server) });
      return { unsubscribe() {} };
    } }));
    const data = await f.adapter.load(f.unit, signal());
    expect(calls).toBe(2); expect(data.answerCount).toBe(0);
  });
  it('pauses for missing answers and for unsupported role-play without submitting', async () => {
    for (const type of [1, 9]) {
      const f = fixture(); (f.server.exercise as any) = { id: 'q-uuid', type, choices: [{ id: 'a' }] };
      const controller = new Controller(f.adapter, new Store(), async (_, job) => job());
      await controller.start(f.unit, defaults);
      expect(controller.progress.status).toBe('paused'); expect(f.submit).not.toHaveBeenCalled();
    }
  });
  it('falls back to the next catalog section when the right arrow would loop', async () => {
    history.replaceState({}, '', '/legacy/course-study-student/10/20/30/key-1');
    document.body.innerHTML = '<app-course-task-stu><button>Submit</button></app-course-task-stu>';
    const root = document.querySelector<HTMLElement>('app-course-task-stu')!;
    const c: any = { courseId: 20, pageId: 'page-1', userId: 30, role: 4, status: 1, flag: 1,
      exerciseStatus: 1, data: { isVisiable: 1 }, exercise: { id: 'q1', type: 24, fillBlanks: [], dragged: [] },
      pageTitle: 'A', loadDoRecord() {}, textbookId: 10,
      courseStudyService: { catalogList: { 20: { children: [
        { key: 'key-1', pageId: 'page-1', isClick: true, isVisiable: 1, children: [] },
        { key: 'key-2', pageId: 'page-2', isClick: true, isVisiable: 1, children: [] },
      ] } } },
      router: { navigate: vi.fn(async () => {
        history.replaceState({}, '', '/legacy/course-study-student/10/20/30/key-2'); c.pageId = 'page-2';
      }) } };
    const adapter = new LegacyAdapter(() => [{ root, component: c }]);
    const unit = adapter.discover()[0];
    const next = await adapter.next(unit, signal());
    expect(c.router.navigate).toHaveBeenCalledWith(['/course-study-student', '10', '20', '30', 'key-2']);
    expect(next?.contentId).toBe('page-2');
  });
  it('pauses continuous next on a failed goal challenge instead of hanging', async () => {
    const f = fixture();
    document.body.insertAdjacentHTML('beforeend',
      '<div class="ant-modal-wrap" style="display:block;visibility:visible"><div class="ant-modal">闯关失败！本次成绩：55分</div></div>');
    await expect(f.adapter.next(f.unit, signal())).rejects.toThrow('目标闯关未通过');
  });
  it('clicks Rechallenge, clears checkpoints, and returns the first unit of the retried goal', async () => {
    const f = fixture();
    const root2 = document.createElement('app-course-task-stu');
    const c2: any = { courseId: 20, pageId: 'page-2', loadDoRecord() {} };
    const modal = document.createElement('div');
    modal.className = 'ant-modal-wrap';
    modal.style.display = 'block';
    modal.innerHTML = '<div class="ant-modal">闯关失败！本次成绩：55分<button>Rechallenge</button></div>';
    document.body.append(modal);
    const before = vi.fn();
    modal.querySelector('button')!.addEventListener('click', () => { f.root.remove(); modal.remove(); document.body.append(root2); });
    const adapter = new LegacyAdapter(() => [{ root: f.root, component: f.c }, { root: f.root.firstElementChild as HTMLElement, component: f.leaf },
      { root: root2, component: c2 }]);
    const unit = adapter.discover()[0];
    const next = await adapter.next(unit, signal(), { ...defaults, autoRechallenge: true }, before);
    expect(before).toHaveBeenCalledTimes(1);
    expect(next?.contentId).toBe('page-2');
  });
  it('refuses a closed course and stale exercise blocks', () => {
    const f = fixture(); f.c.status = 0;
    expect(() => f.adapter.assertContext(f.unit)).toThrow('开放课程');
    f.c.status = 1; f.c.pageId = 'different-page';
    expect(() => f.adapter.assertContext(f.unit)).toThrow('已切换');
  });
});

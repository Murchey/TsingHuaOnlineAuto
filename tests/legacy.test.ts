import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyAdapter, legacyRoute } from '../src/legacy-adapter';
import { legacyData } from '../src/legacy-data';
import { planTasks, hasCompleteResponse } from '../src/answers';
import { Controller } from '../src/controller';
import { Store } from '../src/storage';
import { defaults } from '../src/model';

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

beforeEach(() => { localStorage.clear(); history.replaceState({}, '', path); });

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
    const value = await adapter.record(unit, task, defaults, signal());
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
    const value = await adapter.record(unit, task, defaults, signal());
    expect(c.sayBy).not.toHaveBeenCalled(); expect(c.playVadio).not.toHaveBeenCalled();
    expect(c.doRecord.answer['l-1'].recordAudio).toBe('https://cdn.example/res-l1.mp3');
    expect(c.doRecord.answer['l-2'].recordAudio).toBe('https://cdn.example/res-l2.mp3');
    expect(value).toEqual([{ idx: 'l-1', audio: 'https://cdn.example/res-l1.mp3' },
      { idx: 'l-2', audio: 'https://cdn.example/res-l2.mp3' }]);
    expect(changes).toHaveBeenCalled();
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
  it('refuses a closed course and stale exercise blocks', () => {
    const f = fixture(); f.c.status = 0;
    expect(() => f.adapter.assertContext(f.unit)).toThrow('开放课程');
    f.c.status = 1; f.c.pageId = 'different-page';
    expect(() => f.adapter.assertContext(f.unit)).toThrow('已切换');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserLock, Controller, type WithLock } from '../src/controller';
import { Halt } from '../src/model';
import { Store } from '../src/storage';
import { choice, data, fakeAdapter, fill, settings, writing } from './fixtures';

const lock: WithLock = async (_key, job) => job();
beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('practice execution and recovery', () => {
  it('fills all questions, submits the block once, and re-reads before marking done', async () => {
    const f = fakeAdapter(data(choice, fill, writing)), store = new Store();
    const c = new Controller(f.adapter, store, lock);
    await c.start(f.unit, settings);
    expect(c.progress.status).toBe('done'); expect(c.progress.completed).toBe(3);
    expect(f.adapter.submit).toHaveBeenCalledTimes(1); expect(f.adapter.load).toHaveBeenCalledTimes(3);
    expect(store.read(f.unit.key)?.phase).toBe('verified');
    const raw = localStorage.getItem('thoa:v1:' + f.unit.key)!;
    expect(raw).not.toContain('Hello'); expect(raw).not.toContain('Blue'); expect(raw).not.toContain('Nice to meet');
  });
  it('follows adapter next pages until the adapter reports the reachable end', async () => {
    const f = fakeAdapter(data(choice));
    const second = { ...f.unit, key: f.unit.key + ':next', contentId: '31', title: '下一题' };
    let nextCalls = 0;
    f.adapter.next = vi.fn(async () => nextCalls++ === 0 ? second : undefined);
    const c = new Controller(f.adapter, new Store(), lock);
    await c.start(f.unit, settings);
    expect(f.adapter.next).toHaveBeenCalledTimes(2);
    expect(c.progress.unitsDone).toBe(2);
  });
  it('preflights every question before changing any answer', async () => {
    const f = fakeAdapter(data(choice, { ...writing, answer: '' })), c = new Controller(f.adapter, new Store(), lock);
    await c.start(f.unit, settings);
    expect(c.progress.status).toBe('paused'); expect(c.progress.pending.length).toBeGreaterThan(0);
    expect(f.adapter.fill).not.toHaveBeenCalled(); expect(f.adapter.submit).not.toHaveBeenCalled();
  });
  it('locks repeated starts so a double click never submits twice', async () => {
    const f = fakeAdapter(data(choice)), c = new Controller(f.adapter, new Store(), lock);
    await Promise.all([c.start(f.unit, settings), c.start(f.unit, settings)]);
    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
  });
  it('reconciles a persisted checkpoint against the server after refresh', async () => {
    const f = fakeAdapter(data(choice)), store = new Store();
    await new Controller(f.adapter, store, lock).start(f.unit, settings);
    const refreshed = new Controller(f.adapter, store, lock);
    await refreshed.start(f.unit, settings);
    expect(refreshed.progress.status).toBe('done'); expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.adapter.fill).toHaveBeenCalledTimes(1);
  });
  it('persists pending intent before a submission failure and blocks automatic retry', async () => {
    const f = fakeAdapter(data(choice)), store = new Store();
    vi.mocked(f.adapter.submit).mockImplementation(async () => {
      expect(store.read(f.unit.key)?.phase).toBe('pending'); throw new Halt('NETWORK', '提交网络失败');
    });
    const c = new Controller(f.adapter, store, lock); await c.start(f.unit, settings); await c.start(f.unit, settings);
    expect(f.adapter.submit).toHaveBeenCalledTimes(1); expect(c.logs.at(-1)?.code).toBe('PENDING_SUBMIT');
  });
  it('reconciles a late successful response without submitting again', async () => {
    const f = fakeAdapter(data(choice)), store = new Store();
    vi.mocked(f.adapter.submit).mockImplementation(async () => {});
    const c = new Controller(f.adapter, store, lock); await c.start(f.unit, { ...settings, timeoutMs: 10 });
    expect(c.logs.at(-1)?.code).toBe('UNCONFIRMED');
    f.server = { ...f.server, answerCount: 1, questionAnswerItemVOList: [{ questionId: 101, userAnswer: 'b' }] };
    await c.start(f.unit, settings);
    expect(c.progress.status).toBe('done'); expect(f.adapter.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps a mismatched saved answer pending instead of declaring success', async () => {
    const f = fakeAdapter(data(choice)), store = new Store();
    vi.mocked(f.adapter.submit).mockImplementation(async () => {
      f.server = { ...f.server, answerCount: 1, questionAnswerItemVOList: [{ questionId: 101, userAnswer: 'a' }] };
    });
    const c = new Controller(f.adapter, store, lock); await c.start(f.unit, { ...settings, timeoutMs: 10 });
    expect(c.progress.status).toBe('paused'); expect(store.read(f.unit.key)?.phase).toBe('pending');
  });
  it('does not resubmit complete existing server records even when no keys are available', async () => {
    const f = fakeAdapter({ ...data({ ...choice, answer: '' }), answerCount: 2,
      questionAnswerItemVOList: [{ questionId: 101, userAnswer: 'b' }] });
    const c = new Controller(f.adapter, new Store(), lock); await c.start(f.unit, settings);
    expect(c.progress.status).toBe('done'); expect(f.adapter.submit).not.toHaveBeenCalled();
  });
  it('pauses after filling if the question or server attempt count changes', async () => {
    const f = fakeAdapter(data(choice));
    vi.mocked(f.adapter.fill).mockImplementation(async () => {
      f.server.questionVOList[0].stem = 'A different question'; return 'b';
    });
    const c = new Controller(f.adapter, new Store(), lock); await c.start(f.unit, settings);
    expect(c.logs.at(-1)?.code).toBe('DATA_CHANGED'); expect(f.adapter.submit).not.toHaveBeenCalled();
  });
  it('stops during an in-flight mutation and requires reconciliation before retry', async () => {
    const f = fakeAdapter(data(choice)), store = new Store();
    let release!: () => void;
    vi.mocked(f.adapter.submit).mockImplementation(() => new Promise<void>(r => { release = r; }));
    const c = new Controller(f.adapter, store, lock), running = c.start(f.unit, settings);
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledOnce());
    c.pause(true); release(); await running;
    expect(c.progress.status).toBe('stopped'); expect(store.read(f.unit.key)?.phase).toBe('pending');
    await c.start(f.unit, settings); expect(f.adapter.submit).toHaveBeenCalledOnce();
  });
  it('pauses between questions without advancing to submit', async () => {
    const f = fakeAdapter(data(choice, fill)), c = new Controller(f.adapter, new Store(), lock);
    vi.mocked(f.adapter.fill).mockImplementation(async () => { c.pause(); return 'b'; });
    await c.start(f.unit, settings);
    expect(c.progress.status).toBe('paused'); expect(f.adapter.fill).toHaveBeenCalledOnce(); expect(f.adapter.submit).not.toHaveBeenCalled();
  });
  it('never clicks submit when local progress cannot be persisted', async () => {
    const f = fakeAdapter(data(choice));
    const storage = { getItem: () => null, setItem: () => { throw Error('quota'); } } as unknown as Storage;
    const c = new Controller(f.adapter, new Store(storage), lock); await c.start(f.unit, settings);
    expect(c.logs.at(-1)?.code).toBe('STORAGE_WRITE'); expect(f.adapter.submit).not.toHaveBeenCalled();
  });
  it('does not trust a previously verified checkpoint when the server record disappears', async () => {
    const f = fakeAdapter(data(choice)), store = new Store(); const c = new Controller(f.adapter, store, lock);
    await c.start(f.unit, settings); f.server = data(choice); await c.start(f.unit, settings);
    expect(c.logs.at(-1)?.code).toBe('RECORD_CHANGED'); expect(f.adapter.submit).toHaveBeenCalledOnce();
  });
  it('restricts batch execution to the frozen list from the selected chapter', async () => {
    const f = fakeAdapter(data(choice)), second = { ...f.unit, key: '/course_center/reader/student_course/12:99:31', catalogId: '99', contentId: '31' };
    vi.mocked(f.adapter.discover).mockReturnValue([f.unit, second]);
    const c = new Controller(f.adapter, new Store(), lock); await c.start(f.unit, { ...settings, allLoaded: true });
    expect(c.progress.unitsTotal).toBe(1); expect(f.adapter.submit).toHaveBeenCalledOnce();
  });
});

describe('browser multi-tab lock', () => {
  it('refuses a second tab when the course lock is occupied', async () => {
    vi.stubGlobal('navigator', { locks: { request: async (_name: unknown, _options: unknown, callback: (lock: unknown) => Promise<void>) => callback(null) } });
    const job = vi.fn(); await expect(browserLock('course', job)).rejects.toThrow(/另一个标签页/); expect(job).not.toHaveBeenCalled();
  });
  it('fails visibly if the browser has no Web Locks support', async () => {
    vi.stubGlobal('navigator', {});
    await expect(browserLock('course', async () => {})).rejects.toThrow(/互斥锁/);
  });
});

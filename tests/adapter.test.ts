import { afterEach, describe, expect, it, vi } from 'vitest';
import { TsinghuaAdapter } from '../src/adapter';
import { taskFor, object } from '../src/answers';
import { components } from '../src/vue';
import { choice, data, fill, mountPage, oral, settings, writing } from './fixtures';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; history.replaceState({}, '', '/'); });
const signal = () => new AbortController().signal;
describe('current production Vue page adapter', () => {
  it('discovers production VNodes without any devtools or __vueParentComponent property', () => {
    mountPage(data(choice));
    const adapter = new TsinghuaAdapter();
    expect(components()).toHaveLength(3);
    expect(adapter.discover()).toHaveLength(1);
    adapter.assertContext(adapter.discover()[0]);
  });
  it('fills a choice through its real input change event', async () => {
    const page = mountPage(data(choice)), a = new TsinghuaAdapter(), u = a.discover()[0];
    expect(await a.fill(u, taskFor(choice), signal())).toBe('b');
    expect(page.root.querySelector<HTMLInputElement>('input[value="b"]')?.checked).toBe(true);
    expect(page.submit).not.toHaveBeenCalled();
  });
  it('writes every fill blank then blurs so the page receives the answer', async () => {
    mountPage(data(fill)); const a = new TsinghuaAdapter();
    expect(await a.fill(a.discover()[0], taskFor(fill), signal())).toEqual(taskFor(fill).value);
  });
  it('finds an essay textarea inside a fragment-rendered child component', async () => {
    mountPage(data(writing)); const a = new TsinghuaAdapter();
    expect(await a.fill(a.discover()[0], taskFor(writing), signal())).toEqual(taskFor(writing).value);
  });
  it('waits for fill listeners installed after page rendering', async () => {
    const page = mountPage(data(fill)), a = new TsinghuaAdapter();
    const stem = page.root.querySelector<HTMLElement>('#do_102')!; delete stem.dataset.teFillBlankContainerInited;
    setTimeout(() => { stem.dataset.teFillBlankContainerInited = '1'; }, 25);
    expect(await a.fill(a.discover()[0], taskFor(fill), signal())).toEqual(taskFor(fill).value);
  });
  it('loads through the page callback and submits only the local practice button', async () => {
    const page = mountPage(data(choice)), a = new TsinghuaAdapter(), u = a.discover()[0];
    await a.load(u, signal()); expect(page.load).toHaveBeenCalledWith(30);
    await a.submit(u, signal()); expect(page.submit).toHaveBeenCalledTimes(1);
  });
  it('rejects exam routes, teacher preview, and stale components', () => {
    const page = mountPage(data(choice)), a = new TsinghuaAdapter(), u = a.discover()[0];
    page.component.props.userType = 7; expect(() => a.assertContext(u)).toThrow(/日常练习/);
    page.component.props.userType = 6;
    history.replaceState({}, '', '/exam/123'); expect(() => a.assertContext(u)).toThrow(/改变/);
    expect(a.discover()).toEqual([]);
    history.replaceState({}, '', '/course_center/reader/student_course/12');
    page.root.remove(); expect(() => a.assertContext(u)).toThrow(/改变/);
  });
  it('supports hash routing and rejects different current catalogs', () => {
    const page = mountPage(data(choice)); history.replaceState({}, '', '/#/course_center/reader/student_course/12');
    const a = new TsinghuaAdapter(), u = a.discover()[0]; expect(u).toBeDefined();
    page.component.props.currentCatalogId = 99; expect(() => a.assertContext(u)).toThrow(/章节/);
  });
  it('blocks conflicts even when the old panel is hidden', () => {
    mountPage(data(choice)); const a = new TsinghuaAdapter(), u = a.discover()[0];
    const old = document.createElement('div'); old.className = 'yunPanel'; old.hidden = true; document.body.append(old);
    expect(() => a.assertContext(u)).toThrow(/停用旧脚本/);
  });
  it('rejects malformed server payloads and maps authentication errors', async () => {
    const page = mountPage(data(choice)), a = new TsinghuaAdapter(), u = a.discover()[0];
    page.component.props.onLoadExercise = async () => ({ questionVOList: null });
    await expect(a.load(u, signal())).rejects.toThrow(/格式/);
    page.component.props.onLoadExercise = async () => { throw { status: 401 }; };
    await expect(a.load(u, signal())).rejects.toThrow(/登录/);
  });
  it('aborts recording and releases the permission-probe microphone', async () => {
    const page = mountPage(data(oral)), a = new TsinghuaAdapter(), u = a.discover()[0];
    const stop = vi.fn(), getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const abort = new AbortController();
    const job = a.record(u, taskFor(oral), settings, abort.signal);
    await vi.waitFor(() => expect(page.root.querySelector('img')?.src).toContain('recording.gif'));
    abort.abort(); await expect(job).rejects.toThrow(/暂停|停止/);
    expect(stop).toHaveBeenCalled();
    expect(page.root.querySelector('img')?.src).toContain('record.png');
    expect(object(page.findQuestion(104).props.exercise).doRecord).toBeTruthy();
  });
  it('reports microphone rejection without clicking record or submit', async () => {
    const page = mountPage(data(oral)), a = new TsinghuaAdapter();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw Error('denied'); } } });
    await expect(a.record(a.discover()[0], taskFor(oral), settings, signal())).rejects.toThrow(/授权失败/);
    expect(page.root.querySelector('img')?.src).toContain('record.png'); expect(page.submit).not.toHaveBeenCalled();
  });
});

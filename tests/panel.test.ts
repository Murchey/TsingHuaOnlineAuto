import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TsinghuaAdapter } from '../src/adapter';
import { Controller } from '../src/controller';
import { Panel } from '../src/panel';
import { Store } from '../src/storage';
import { choice, data, mountPage } from './fixtures';

let panel: Panel | undefined;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); document.body.innerHTML = ''; });
afterEach(() => { panel?.dispose(); panel = undefined; vi.restoreAllMocks(); });
const make = () => {
  const a = new TsinghuaAdapter(), s = new Store(), c = new Controller(a, s);
  panel = new Panel(c, a, s); panel.mount(); return { panel, controller: c, shadow: panel.host.shadowRoot! };
};

describe('independent panel lifecycle', () => {
  it('mounts even if window.load has already fired and the route is unsupported', () => {
    window.dispatchEvent(new Event('load')); history.replaceState({}, '', '/login');
    const { panel, shadow } = make();
    expect(panel.host.isConnected).toBe(true);
    expect(shadow.getElementById('message')?.textContent).toContain('助手已运行');
    expect((shadow.getElementById('rolePlayMode') as HTMLSelectElement).value).toBe('original');
    expect((shadow.getElementById('continuous') as HTMLInputElement).checked).toBe(true);
    expect((shadow.getElementById('autoRechallenge') as HTMLInputElement).checked).toBe(true);
    expect((shadow.getElementById('ttsProvider') as HTMLSelectElement).value).toBe('mimo');
    expect(shadow.getElementById('aiApiBase')).not.toBeNull();
    expect(shadow.getElementById('asrApiBase')).not.toBeNull();
    expect((shadow.getElementById('start') as HTMLButtonElement).disabled).toBe(true);
  });
  it('waits for body at document-start and recovers if the SPA removes the host', async () => {
    document.body.remove(); const { panel } = make();
    expect(panel.host.isConnected).toBe(false);
    document.documentElement.append(document.createElement('body'));
    await vi.waitFor(() => expect(panel.host.isConnected).toBe(true));
    panel.host.remove(); await vi.waitFor(() => expect(panel.host.isConnected).toBe(true));
  });
  it('minimizes and restores using the button or keyboard', () => {
    const { shadow } = make();
    shadow.getElementById('collapse')!.click(); expect(shadow.getElementById('panel')?.classList.contains('hidden')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', altKey: true, shiftKey: true }));
    expect(shadow.getElementById('panel')?.classList.contains('hidden')).toBe(false);
  });
  it('discovers exercises and exports a diagnostic with no answer, token or URL query', () => {
    mountPage(data(choice)); history.replaceState({}, '', '/course_center/reader/student_course/12?token=private-token');
    const { panel, shadow } = make();
    expect((shadow.getElementById('start') as HTMLButtonElement).disabled).toBe(false);
    const json = JSON.stringify(panel.diagnostics());
    expect(json).toContain('componentCount'); expect(json).not.toContain('private-token'); expect(json).not.toContain('Blue');
    expect(json).not.toContain('extension'); expect(json).not.toContain('userAnswer');
  });
  it('puts errors in text nodes so a message cannot inject markup', () => {
    const { controller, shadow } = make(); controller.report('ERROR', '<img src=x onerror=alert(1)>', true);
    expect(shadow.querySelector('img')).toBeNull(); expect(shadow.getElementById('message')?.textContent).toContain('<img');
  });
  it('continues automatically after the controller requests a page reload', async () => {
    mountPage(data(choice));
    const adapter = new TsinghuaAdapter(), store = new Store();
    store.requestResume();
    const controller = new Controller(adapter, store, async (_key, job) => job());
    const start = vi.spyOn(controller, 'start').mockResolvedValue(undefined);
    panel = new Panel(controller, adapter, store); panel.mount();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0][0].key).toContain('student_course');
    expect(store.takeResume()).toBe(false);
  });
  it('does not create a second controller or panel on repeated script injection', async () => {
    vi.resetModules(); await import('../src/main');
    const key = Symbol.for('tsinghua-online-auto.instance');
    const global = window as unknown as Record<symbol, Panel>;
    const first = global[key];
    try {
      vi.resetModules(); await import('../src/main');
      expect(global[key]).toBe(first); expect(document.querySelectorAll('tsinghua-exercise-helper')).toHaveLength(1);
    } finally { first.dispose(); delete global[key]; }
  });
});

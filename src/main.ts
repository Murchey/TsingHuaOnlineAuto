import { AdaptiveAdapter } from './adaptive-adapter';
import { Controller } from './controller';
import { Panel } from './panel';
import { Store } from './storage';

const key = Symbol.for('tsinghua-online-auto.instance');
const hostWindow = ((globalThis as any).unsafeWindow ?? (window as any).unsafeWindow ?? window) as Window;
const page = hostWindow as unknown as Record<symbol, Panel | undefined>;
function boot(): void {
  if (hostWindow.top !== hostWindow.self) return;
  if (page[key]) { page[key]!.reveal(); return; }
  const adapter = new AdaptiveAdapter(), store = new Store();
  const panel = new Panel(new Controller(adapter, store), adapter, store);
  page[key] = panel;
  panel.mount();
  hostWindow.addEventListener('pagehide', () => { panel.dispose(); delete page[key]; }, { once: true });
}

hostWindow.addEventListener('pageshow', event => { if (event.persisted) boot(); });

// Works both at document-start and when a manager injects after window.load has fired.
if (document.documentElement) boot();
else {
  const observer = new MutationObserver(() => {
    if (document.documentElement) { observer.disconnect(); boot(); }
  });
  observer.observe(document, { childList: true });
}

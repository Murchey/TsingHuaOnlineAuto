import { AdaptiveAdapter } from './adaptive-adapter';
import { Controller } from './controller';
import { Panel } from './panel';
import { Store } from './storage';

const key = Symbol.for('tsinghua-online-auto.instance');
const page = window as unknown as Record<symbol, Panel | undefined>;
function boot(): void {
  if (window.top !== window.self) return;
  if (page[key]) { page[key]!.reveal(); return; }
  const adapter = new AdaptiveAdapter(), store = new Store();
  const panel = new Panel(new Controller(adapter, store), adapter, store);
  page[key] = panel;
  panel.mount();
  window.addEventListener('pagehide', () => { panel.dispose(); delete page[key]; }, { once: true });
}

window.addEventListener('pageshow', event => { if (event.persisted) boot(); });

// Works both at document-start and when a manager injects after window.load has fired.
if (document.documentElement) boot();
else {
  const observer = new MutationObserver(() => {
    if (document.documentElement) { observer.disconnect(); boot(); }
  });
  observer.observe(document, { childList: true });
}

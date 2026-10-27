// ViewEngine bridge for the first-party Angular 7.2.16 legacy application.
// Only the already bootstrapped platform is used. No application is bootstrapped here.
export interface LegacyComponent {
  [key: string]: any;
}
interface View {
  component?: LegacyComponent;
  nodes?: { renderElement?: HTMLElement; componentView?: View;
    viewContainer?: { _embeddedViews?: View[] } }[];
}
type Require = ((id: string) => any) & { c: Record<string, { exports: any }> };
let runtime: Require | undefined;
let application: any;

export function runInLegacyZone(job: () => void): void {
  if (application?._zone?.run) application._zone.run(job);
  else job();
}

export function legacyComponents(): { component: LegacyComponent; root: HTMLElement }[] {
  const w = window as any;
  if (document.querySelector('app-root')?.getAttribute('ng-version') !== '7.2.16' ||
      !document.querySelector('app-course-study-student') || !w.ng?.coreTokens?.ApplicationRef) return [];
  try {
    if (!runtime) {
      // Pin the bridge to the inspected build; unknown builds must fail closed.
      if (!Array.from(document.scripts).some(s => /\/main\.4c93dc9c6da8077cd693\.js(?:\?|$)/.test(s.src)) ||
          !Array.isArray(w.webpackJsonp)) return [];
      const key = 'thoa-read-runtime-' + Math.random().toString(36).slice(2);
      w.webpackJsonp.push([[], { [key]: (_m: unknown, _e: unknown, r: Require) => { runtime = r; } }, [[key]]]);
    }
    if (!runtime?.c.ZYjt || typeof runtime.c.ZYjt.exports.i !== 'function') return [];
    const platform = runtime.c.ZYjt.exports.i();
    const apps = (platform._modules || []).map((m: any) => m.injector.get(w.ng.coreTokens.ApplicationRef, null)).filter(Boolean);
    application = apps[0];
    const result: { component: LegacyComponent; root: HTMLElement }[] = [], seen = new Set<View>();
    function walk(view: View | undefined): void {
      if (!view || seen.has(view) || seen.size > 30_000) return;
      seen.add(view);
      for (const node of view.nodes || []) {
        if (node?.componentView) {
          if (node.renderElement instanceof HTMLElement && node.componentView.component) {
            result.push({ component: node.componentView.component, root: node.renderElement });
          }
          walk(node.componentView);
        }
        for (const child of node?.viewContainer?._embeddedViews || []) walk(child);
      }
    }
    for (const app of apps) for (const v of app._views || []) walk(v._view);
    return result;
  } catch { return []; }
}

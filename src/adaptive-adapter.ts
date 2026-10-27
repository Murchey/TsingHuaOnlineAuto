import { TsinghuaAdapter } from './adapter';
import { LegacyAdapter, legacyRoute } from './legacy-adapter';
import type { Adapter, Settings, Task, Unit } from './model';

export class AdaptiveAdapter implements Adapter {
  private modern = new TsinghuaAdapter();
  private legacy = new LegacyAdapter();
  private get active(): Adapter { return legacyRoute() ? this.legacy : this.modern; }
  discover() { return this.active.discover(); }
  assertContext(unit: Unit) { return this.active.assertContext(unit); }
  load(unit: Unit, signal: AbortSignal) { return this.active.load(unit, signal); }
  fill(unit: Unit, task: Task, settings: Settings, signal: AbortSignal) { return this.active.fill(unit, task, settings, signal); }
  record(unit: Unit, task: Task, settings: Settings, signal: AbortSignal) { return this.active.record(unit, task, settings, signal); }
  submit(unit: Unit, signal: AbortSignal) { return this.active.submit(unit, signal); }
  next(unit: Unit, signal: AbortSignal, settings?: Settings, beforeRechallenge?: () => void) { return this.active.next?.(unit, signal, settings, beforeRechallenge) || Promise.resolve(undefined); }
  conflict() { return this.active.conflict(); }
}

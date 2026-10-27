import { Halt } from './model';

export function check(signal: AbortSignal): void {
  if (signal.aborted) throw new Halt('CANCELLED', '操作已暂停或停止');
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  check(signal);
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(new Halt('CANCELLED', '操作已暂停或停止')); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// A timeout does not cancel a website request. Callers must never retry mutations automatically.
export function bounded<T>(job: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(new Halt('CANCELLED', '操作已暂停或停止')); };
    const timer = setTimeout(() => { done(); reject(new Halt('TIMEOUT', '等待页面响应超时，请核查网络和登录状态')); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    job.then(v => { done(); resolve(v); }, e => { done(); reject(e); });
  });
}

export async function until<T>(read: () => T | undefined, timeout: number, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    check(signal);
    const value = read();
    if (value !== undefined) return value;
    await sleep(100, signal);
  } while (Date.now() < deadline);
  throw new Halt('PAGE_TIMEOUT', '页面控件未就绪或录音未完成，请检查页面提示');
}

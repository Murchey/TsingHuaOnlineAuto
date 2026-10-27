import { bounded } from './async';
import { Halt } from './model';

export interface MimoConfig {
  apiKey: string;
  apiBase?: string;
  ttsModel?: string;
  ttsVoice?: string;
  aiModel?: string;
  timeoutMs?: number;
}

interface GmResponse { status: number; responseText: string; }
type GmRequest = (details: Record<string, unknown>) => { abort?: () => void };

function endpoint(base: string | undefined): string {
  const value = (base || 'https://api.xiaomimimo.com/v1').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(value) ? value : value + '/chat/completions';
}

function headers(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'api-key': key, Authorization: `Bearer ${key}` };
}

function failure(status: number, text: string): Halt {
  let message = '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    message = typeof parsed.error?.message === 'string' ? parsed.error.message :
      (typeof parsed.message === 'string' ? parsed.message : '');
  } catch { /* non-JSON error body */ }
  return new Halt('API_ERROR', `MiMo API 请求失败（HTTP ${status}）${message ? `：${message.slice(0, 180)}` : ''}`);
}

async function post(body: unknown, config: MimoConfig, signal: AbortSignal): Promise<string> {
  if (!config.apiKey.trim()) throw new Halt('API_CONFIG', '请先在面板中填写 MiMo API Key');
  const url = endpoint(config.apiBase), data = JSON.stringify(body);
  const timeout = Math.min(120_000, Math.max(15_000, config.timeoutMs ?? 30_000));
  const gm = (globalThis as unknown as { GM_xmlhttpRequest?: GmRequest }).GM_xmlhttpRequest;
  if (typeof gm === 'function') {
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) { reject(new Halt('CANCELLED', '操作已暂停或停止')); return; }
      let settled = false;
      const cleanup = () => { signal.removeEventListener('abort', abort); };
      const done = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn(); };
      const abort = () => { try { request?.abort?.(); } catch { /* ignore */ } done(() => reject(new Halt('CANCELLED', '操作已暂停或停止'))); };
      const request = gm({
        method: 'POST', url, headers: headers(config.apiKey), data, timeout,
        onload: (response: GmResponse) => done(() => response.status >= 200 && response.status < 300 ?
          resolve(response.responseText) : reject(failure(response.status, response.responseText))),
        onerror: () => done(() => reject(new Halt('API_NETWORK', 'MiMo API 网络请求失败，请检查网络或脚本管理器授权'))),
        ontimeout: () => done(() => reject(new Halt('API_TIMEOUT', 'MiMo API 请求超时'))),
      });
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  try {
    const response = await bounded(fetch(url, { method: 'POST', headers: headers(config.apiKey), body: data, signal }), timeout, signal);
    const text = await response.text();
    if (!response.ok) throw failure(response.status, text);
    return text;
  } catch (error) {
    if (error instanceof Halt) throw error;
    throw new Halt('API_CORS', '浏览器直接访问 MiMo API 失败；请使用支持 GM_xmlhttpRequest 的脚本管理器，或在设置中检查 API Base');
  }
}

function decodeAudio(value: string): ArrayBuffer {
  const clean = value.replace(/^data:[^,]*,/i, '').replace(/\s+/g, '');
  if (!clean) throw new Halt('TTS_RESPONSE', 'MiMo TTS 返回了空音频');
  let binary: string;
  try { binary = atob(clean); } catch { throw new Halt('TTS_RESPONSE', 'MiMo TTS 返回的音频不是有效 Base64'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export async function mimoTts(text: string, config: MimoConfig, signal: AbortSignal): Promise<ArrayBuffer> {
  const value = text.trim();
  if (!value) throw new Halt('TTS_TEXT', '当前句子没有可合成的文本');
  const body = {
    model: (config.ttsModel || 'mimo-v2.5-tts').trim(),
    messages: [{ role: 'assistant', content: value }],
    audio: { format: 'mp3', voice: (config.ttsVoice || 'mimo_default').trim() },
    stream: false,
  };
  let parsed: any;
  try { parsed = JSON.parse(await post(body, config, signal)); }
  catch (error) { if (error instanceof Halt) throw error; throw new Halt('TTS_RESPONSE', 'MiMo TTS 返回内容不是有效 JSON'); }
  const audio = parsed?.choices?.[0]?.message?.audio;
  const data = typeof audio?.data === 'string' ? audio.data : (typeof audio?.audio === 'string' ? audio.audio : '');
  if (!data) throw new Halt('TTS_RESPONSE', 'MiMo TTS 响应中缺少 message.audio.data');
  return decodeAudio(data);
}

const SYSTEM = '你是英语课程作答助手。只返回一个 JSON 对象，不要 Markdown、解释或额外文字。严格使用题目提供的选项 ID 和空位 ID。';

export async function mimoAnswer(prompt: string, config: MimoConfig, signal: AbortSignal): Promise<unknown> {
  const body = {
    model: (config.aiModel || 'mimo-v2.6-pro').trim(),
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    temperature: 0.2, stream: false,
  };
  let parsed: any;
  try { parsed = JSON.parse(await post(body, config, signal)); }
  catch (error) { if (error instanceof Halt) throw error; throw new Halt('AI_RESPONSE', 'AI API 返回内容不是有效 JSON'); }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Halt('AI_RESPONSE', 'AI API 没有返回 message.content');
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Halt('AI_RESPONSE', 'AI 返回内容中没有 JSON 对象');
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { throw new Halt('AI_RESPONSE', 'AI 返回的 JSON 无法解析'); }
}

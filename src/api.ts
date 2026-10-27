import { bounded } from './async';
import { Halt, type Settings } from './model';

interface GmResponse { status: number; responseText?: string; response?: unknown; }
type GmRequest = (details: Record<string, unknown>) => { abort?: () => void };
interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: string | FormData;
  responseType?: 'text' | 'arraybuffer';
}

function baseUrl(value: string): string { return value.trim().replace(/\/+$/, ''); }
function endpoint(base: string, path: string): string {
  const value = baseUrl(base);
  return value.endsWith(path) ? value : value + path;
}
function timeoutOf(settings: Settings): number { return Math.min(180_000, Math.max(60_000, settings.timeoutMs)); }
function authHeaders(key: string, json = true): Record<string, string> {
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'api-key': key, Authorization: `Bearer ${key}` };
}
function failure(status: number, text: string): Halt {
  let message = '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    message = typeof parsed.error?.message === 'string' ? parsed.error.message :
      (typeof parsed.message === 'string' ? parsed.message : '');
  } catch { /* non-JSON */ }
  return new Halt('API_ERROR', `API 请求失败（HTTP ${status}）${message ? `：${message.slice(0, 180)}` : ''}`);
}

function gmRequest(options: RequestOptions, timeout: number, signal: AbortSignal): Promise<GmResponse> {
  const gm = (globalThis as unknown as { GM_xmlhttpRequest?: GmRequest }).GM_xmlhttpRequest;
  if (typeof gm !== 'function') return Promise.reject(new Halt('API_GM', '当前脚本管理器没有提供 GM_xmlhttpRequest'));
  return new Promise<GmResponse>((resolve, reject) => {
    if (signal.aborted) { reject(new Halt('CANCELLED', '操作已暂停或停止')); return; }
    let settled = false, request: { abort?: () => void } | undefined;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const done = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn(); };
    const abort = () => { try { request?.abort?.(); } catch { /* ignore */ } done(() => reject(new Halt('CANCELLED', '操作已暂停或停止'))); };
    request = gm({
      method: options.method || 'POST', url: options.url, headers: options.headers, data: options.data,
      responseType: options.responseType || 'text', timeout,
      onload: (response: GmResponse) => done(() => response.status >= 200 && response.status < 300 ?
        resolve(response) : reject(failure(response.status, response.responseText || ''))),
      onerror: () => done(() => reject(new Halt('API_NETWORK', 'API 网络请求失败，请检查网络或脚本管理器授权'))),
      ontimeout: () => done(() => reject(new Halt('API_TIMEOUT', 'API 请求超时'))),
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function request(options: RequestOptions, settings: Settings, signal: AbortSignal): Promise<GmResponse> {
  const timeout = timeoutOf(settings);
  try { return await gmRequest(options, timeout, signal); }
  catch (error) {
    if (signal.aborted || (error instanceof Halt && error.code !== 'API_GM')) throw error;
  }
  try {
    const init: RequestInit = { method: options.method || 'POST', headers: options.headers, body: options.data, signal };
    const response = await bounded(fetch(options.url, init), timeout, signal);
    if (!response.ok) throw failure(response.status, await response.text());
    if (options.responseType === 'arraybuffer') return { status: response.status, response: await response.arrayBuffer() };
    return { status: response.status, responseText: await response.text() };
  } catch (error) {
    if (error instanceof Halt) throw error;
    throw new Halt('API_CORS', '浏览器直接访问 API 失败；请使用支持 GM_xmlhttpRequest 的脚本管理器，或检查 API Base');
  }
}

function contentObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonObject(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Halt('AI_RESPONSE', 'AI 返回内容中没有 JSON 对象');
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { throw new Halt('AI_RESPONSE', 'AI 返回的 JSON 无法解析'); }
}

function decodeBase64(value: string): ArrayBuffer {
  const clean = value.replace(/^data:[^,]*,/i, '').replace(/\s+/g, '');
  if (!clean) throw new Halt('TTS_RESPONSE', 'TTS 返回了空音频');
  let binary: string;
  try { binary = atob(clean); } catch { throw new Halt('TTS_RESPONSE', 'TTS 返回的音频不是有效 Base64'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export async function synthesizeSpeech(text: string, settings: Settings, signal: AbortSignal): Promise<ArrayBuffer> {
  const value = text.trim();
  if (!value) throw new Halt('TTS_TEXT', '当前句子没有可合成的文本');
  if (!settings.ttsApiKey.trim()) throw new Halt('TTS_CONFIG', '请在面板填写 TTS API Key');
  if (settings.ttsProvider === 'openai') {
    const response = await request({
      url: endpoint(settings.ttsApiBase, '/audio/speech'), headers: authHeaders(settings.ttsApiKey), responseType: 'arraybuffer',
      data: JSON.stringify({ model: settings.ttsModel || 'tts-1', input: value,
        voice: settings.ttsVoice || 'alloy', response_format: 'mp3' }),
    }, settings, signal);
    if (!(response.response instanceof ArrayBuffer) || !response.response.byteLength) throw new Halt('TTS_RESPONSE', 'OpenAI TTS 没有返回音频');
    return response.response;
  }
  const response = await request({
    url: endpoint(settings.ttsApiBase, '/chat/completions'), headers: authHeaders(settings.ttsApiKey),
    data: JSON.stringify({ model: settings.ttsModel || 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: value }],
      audio: { format: 'mp3', voice: settings.ttsVoice || 'mimo_default' }, stream: false }),
  }, settings, signal);
  const parsed = JSON.parse(response.responseText || '{}') as any;
  const audio = parsed?.choices?.[0]?.message?.audio;
  const data = typeof audio?.data === 'string' ? audio.data : (typeof audio?.audio === 'string' ? audio.audio : '');
  if (!data) throw new Halt('TTS_RESPONSE', 'MiMo TTS 响应中缺少 message.audio.data');
  return decodeBase64(data);
}

const SYSTEM = '你是英语课程作答助手。只返回一个 JSON 对象，不要 Markdown、解释或额外文字。严格使用题目提供的选项 ID 和空位 ID。';

export async function answerWithAi(prompt: string, settings: Settings, signal: AbortSignal): Promise<unknown> {
  if (!settings.aiApiKey.trim()) throw new Halt('AI_CONFIG', '请在面板填写 AI API Key');
  const response = await request({
    url: endpoint(settings.aiApiBase, '/chat/completions'), headers: authHeaders(settings.aiApiKey),
    data: JSON.stringify({ model: settings.aiModel, messages: [{ role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }], temperature: 0.2, stream: false }),
  }, settings, signal);
  const parsed = JSON.parse(response.responseText || '{}') as any;
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Halt('AI_RESPONSE', 'AI API 没有返回 message.content');
  return parseJsonObject(content);
}

export async function transcribeAudio(audio: ArrayBuffer, filename: string, settings: Settings, signal: AbortSignal): Promise<string> {
  if (!settings.asrApiKey.trim()) throw new Halt('ASR_CONFIG', '听力题需要 ASR：请在面板填写 ASR API Key');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), filename);
  form.append('model', settings.asrModel);
  const response = await request({ url: endpoint(settings.asrApiBase, '/audio/transcriptions'),
    headers: authHeaders(settings.asrApiKey, false), data: form }, settings, signal);
  const parsed = contentObject(JSON.parse(response.responseText || '{}'));
  const text = typeof parsed.text === 'string' ? parsed.text :
    (Array.isArray(parsed.results) ? contentObject(parsed.results[0]).text : contentObject(parsed.result).text);
  if (typeof text !== 'string' || !text.trim()) throw new Halt('ASR_RESPONSE', 'ASR 没有返回转写文本');
  return text.trim();
}

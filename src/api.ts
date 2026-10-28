import { bounded, check } from './async';
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
  // Throw synchronously: creating a rejected promise outside the Angular zone would be
  // reported as an unhandled rejection even though request() falls back to fetch.
  if (typeof gm !== 'function') throw new Halt('API_GM', '当前脚本管理器没有提供 GM_xmlhttpRequest');
  return new Promise<GmResponse>((resolve, reject) => {
    if (signal.aborted) { reject(new Halt('CANCELLED', '操作已暂停或停止')); return; }
    let settled = false, request: { abort?: () => void } | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const done = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn(); };
    const abort = () => { try { request?.abort?.(); } catch { /* ignore */ } done(() => reject(new Halt('CANCELLED', '操作已暂停或停止'))); };
    // A manager-provided timeout is advisory; enforce it here so a hung request can never
    // freeze a run indefinitely.
    timer = setTimeout(() => {
      try { request?.abort?.(); } catch { /* ignore */ }
      done(() => reject(new Halt('API_TIMEOUT', 'API 请求超时（脚本管理器未在规定时间内返回）')));
    }, timeout);
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

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
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

export interface ImagePart { mime: string; data: string }
export const MAX_AI_IMAGE_BYTES = 8_000_000;

function imageMime(buffer: ArrayBuffer, url: string): string {
  const b = new Uint8Array(buffer);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (/\.png(?:\?|$)/i.test(url)) return 'image/png';
  if (/\.webp(?:\?|$)/i.test(url)) return 'image/webp';
  if (/\.gif(?:\?|$)/i.test(url)) return 'image/gif';
  return 'image/jpeg';
}

/** Download an exercise image and return base64 for a multimodal chat request. */
export async function fetchImage(url: string, settings: Settings, signal: AbortSignal): Promise<ImagePart | undefined> {
  const inline = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(url);
  if (inline) return inline[2].length * 3 / 4 > MAX_AI_IMAGE_BYTES ? undefined :
    { mime: inline[1].toLowerCase(), data: inline[2].replace(/\s+/g, '') };
  try {
    const response = await request({ url, method: 'GET', responseType: 'arraybuffer' }, settings, signal);
    const buffer = response.response;
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > MAX_AI_IMAGE_BYTES) return undefined;
    return { mime: imageMime(buffer, url), data: encodeBase64(buffer) };
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

export async function answerWithAi(prompt: string, settings: Settings, signal: AbortSignal,
  images: ImagePart[] = []): Promise<unknown> {
  if (!settings.aiApiKey.trim()) throw new Halt('AI_CONFIG', '请在面板填写 AI API Key');
  const response = await request({
    url: endpoint(settings.aiApiBase, '/chat/completions'), headers: authHeaders(settings.aiApiKey),
    data: JSON.stringify({ model: settings.aiModel, messages: [{ role: 'system', content: SYSTEM },
      { role: 'user', content: images.length ? [
        ...images.map(image => ({ type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.data}` } })),
        { type: 'text', text: prompt },
      ] : prompt }], temperature: 0.2, stream: false }),
  }, settings, signal);
  const parsed = JSON.parse(response.responseText || '{}') as any;
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Halt('AI_RESPONSE', 'AI API 没有返回 message.content');
  return parseJsonObject(content);
}

export async function transcribeAudio(audio: ArrayBuffer, filename: string, settings: Settings, signal: AbortSignal): Promise<string> {
  if (!settings.asrApiKey.trim()) throw new Halt('ASR_CONFIG', '听力题需要 ASR：请在面板填写 ASR API Key');
  // MiMo serves ASR through Chat Completions with an input_audio part; OpenAI-compatible
  // providers use the multipart /audio/transcriptions endpoint instead.
  const mimo = /mimo/i.test(settings.asrModel) || /xiaomimimo\.com/i.test(settings.asrApiBase);
  if (mimo) {
    const format = (/\.(mp3|wav|m4a|aac)(?:\?|$)/i.exec(filename)?.[1] || 'mp3').toLowerCase();
    const response = await request({ url: endpoint(settings.asrApiBase, '/chat/completions'),
      headers: authHeaders(settings.asrApiKey),
      data: JSON.stringify({ model: settings.asrModel, stream: false, messages: [{ role: 'user', content: [
        { type: 'input_audio', input_audio: { data: encodeBase64(audio), format } }] }] }) }, settings, signal);
    const parsed = contentObject(JSON.parse(response.responseText || '{}'));
    const choice = contentObject(Array.isArray(parsed.choices) ? parsed.choices[0] : {});
    const content = contentObject(choice.message).content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ?
      content.map(part => typeof contentObject(part).text === 'string' ? String(contentObject(part).text) : '').join('') : '';
    if (!text.trim()) throw new Halt('ASR_RESPONSE', 'MiMo ASR 没有返回转写文本');
    return text.trim();
  }
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

/** Download a large exercise asset through GM_xmlhttpRequest when available. */
export async function fetchMedia(url: string, settings: Settings, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await request({ url, method: 'GET', responseType: 'arraybuffer' }, settings, signal);
  const buffer = response.response;
  if (buffer instanceof Blob) return buffer.arrayBuffer();
  if (ArrayBuffer.isView(buffer)) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) {
    throw new Halt('MEDIA_DOWNLOAD', '媒体文件下载失败或为空');
  }
  return buffer;
}

const ASR_SAMPLE_RATE = 16_000;
const ASR_CHUNK_BYTES = 5_600_000; // ~7.5 MB after base64, below MiMo ASR's 10 MB limit

function audioContext(): any {
  const scope = ((globalThis as any).unsafeWindow ?? globalThis) as any;
  return scope.AudioContext || scope.webkitAudioContext || (globalThis as any).AudioContext;
}

async function decodeVideoAudio(video: ArrayBuffer): Promise<AudioBuffer> {
  const Ctor = audioContext();
  if (typeof Ctor !== 'function') throw new Halt('VIDEO_AUDIO', '浏览器不支持视频音轨解码');
  const context = new Ctor();
  try {
    return await context.decodeAudioData(video.slice(0));
  } catch {
    throw new Halt('VIDEO_AUDIO', '视频音轨解码失败，请确认视频为 MP4/MOV 且包含音频');
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }
}

function videoToPcm(audio: AudioBuffer, sampleRate = ASR_SAMPLE_RATE): Int16Array {
  const channels = audio.numberOfChannels;
  const first = audio.getChannelData(0);
  const second = channels > 1 ? audio.getChannelData(1) : null;
  const duration = Number.isFinite(audio.duration) ? audio.duration : audio.length / audio.sampleRate;
  const length = Math.max(0, Math.ceil(duration * sampleRate));
  const out = new Int16Array(length);
  const step = audio.sampleRate / sampleRate;
  let energy = 0;
  for (let i = 0; i < length; i++) {
    const position = i * step, left = Math.floor(position), right = Math.min(left + 1, first.length - 1);
    const fraction = position - left;
    let sample = first[left] * (1 - fraction) + first[right] * fraction;
    if (second) sample = (sample + second[left] * (1 - fraction) + second[right] * fraction) / 2;
    sample = Math.max(-1, Math.min(1, sample));
    energy += sample * sample;
    out[i] = sample * 0x7fff;
  }
  if (!out.length || Math.sqrt(energy / out.length) < 0.0002) {
    throw new Halt('VIDEO_AUDIO', '视频音轨为空或为静音，无法转写');
  }
  return out;
}

function pcmToWav(pcm: Int16Array, sampleRate = ASR_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2), view = new DataView(buffer);
  const write = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return buffer;
}

/** Convert a video's audio track to 16 kHz mono WAV chunks and transcribe it with the configured ASR. */
export async function transcribeVideo(video: ArrayBuffer, filename: string, settings: Settings,
  signal: AbortSignal): Promise<string> {
  if (!settings.asrApiKey.trim()) throw new Halt('ASR_CONFIG', '视频题需要 ASR：请先在面板填写 ASR API Key');
  const audio = await decodeVideoAudio(video);
  const pcm = videoToPcm(audio);
  const perChunk = Math.max(1, Math.floor(ASR_CHUNK_BYTES / 2));
  const texts: string[] = [];
  const stem = filename.replace(/\.[^.]+$/, '') || 'video';
  for (let start = 0, index = 0; start < pcm.length; start += perChunk, index++) {
    check(signal);
    const chunk = pcm.subarray(start, Math.min(start + perChunk, pcm.length));
    texts.push(await transcribeAudio(pcmToWav(chunk), `${stem}-${index + 1}.wav`, settings, signal));
  }
  return texts.map(text => text.trim()).filter(Boolean).join('\n');
}

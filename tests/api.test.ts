import { afterEach, expect, it, vi } from 'vitest';
import { answerWithAi, fetchImage, fetchMedia, synthesizeSpeech, transcribeAudio, transcribeVideo } from '../src/api';
import { defaults, type Settings } from '../src/model';

const signal = () => new AbortController().signal;
const cfg = (overrides: Partial<Settings> = {}): Settings => ({ ...defaults, ...overrides });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('uses MiMo chat-completions TTS by default and decodes audio', async () => {
  const calls: any[] = [], bytes = new Uint8Array([1, 2, 3]);
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details);
    details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
      audio: { data: Buffer.from(bytes).toString('base64') } } }] }) });
    return { abort: vi.fn() };
  });
  const audio = new Uint8Array(await synthesizeSpeech('Hello', cfg({ ttsApiKey: 'tts-key' }), signal()));
  expect([...audio]).toEqual([1, 2, 3]);
  expect(calls[0].url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  expect(JSON.parse(calls[0].data)).toMatchObject({ model: 'mimo-v2.5-tts', messages: [{ role: 'assistant', content: 'Hello' }] });
});

it('supports an OpenAI-compatible TTS provider without MiMo coupling', async () => {
  const calls: any[] = [], bytes = new Uint8Array([7, 8]).buffer;
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details); details.onload({ status: 200, response: bytes }); return { abort: vi.fn() };
  });
  const audio = await synthesizeSpeech('Hello', cfg({ ttsProvider: 'openai', ttsApiKey: 'k',
    ttsApiBase: 'https://tts.example/v1', ttsModel: 'tts-1', ttsVoice: 'alloy' }), signal());
  expect(new Uint8Array(audio)).toEqual(new Uint8Array([7, 8]));
  expect(calls[0].url).toBe('https://tts.example/v1/audio/speech');
  expect(calls[0].responseType).toBe('arraybuffer');
});

it('parses AI answers and sends ASR multipart audio', async () => {
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    if (details.url.endsWith('/chat/completions')) details.onload({ status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: '```json\n{"answer":"AI text"}\n```' } }] }) });
    else details.onload({ status: 200, responseText: '{"text":"listening transcript"}' });
    return { abort: vi.fn() };
  });
  await expect(answerWithAi('question', cfg({ aiApiKey: 'ai-key' }), signal())).resolves.toEqual({ answer: 'AI text' });
  await expect(transcribeAudio(new ArrayBuffer(8), 'q.mp3', cfg({ asrApiKey: 'asr-key' }), signal()))
    .resolves.toBe('listening transcript');
});

it('uses MiMo chat-completions ASR with an input_audio part', async () => {
  const calls: any[] = [];
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details);
    details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: 'hello world' } }] }) });
    return { abort: vi.fn() };
  });
  const text = await transcribeAudio(new Uint8Array([1, 2, 3]).buffer, 'clip.mp3',
    cfg({ asrApiKey: 'k', asrApiBase: 'https://api.xiaomimimo.com/v1', asrModel: 'mimo-v2.5-asr' }), signal());
  expect(text).toBe('hello world');
  expect(calls[0].url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  const body = JSON.parse(calls[0].data);
  expect(body.model).toBe('mimo-v2.5-asr');
  expect(body.messages[0].content[0]).toMatchObject({ type: 'input_audio', input_audio: { format: 'mp3', data: 'AQID' } });
});
it('disables MiMo deep thinking and reserves tokens for structured answers', async () => {
  const calls: any[] = [];
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details);
    details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"answer":"x"}' } }] }) });
    return { abort: vi.fn() };
  });
  await answerWithAi('q', cfg({ aiApiKey: 'k', aiApiBase: 'https://api.xiaomimimo.com/v1',
    aiModel: 'mimo-v2.6-flash' }), signal());
  const body = JSON.parse(calls[0].data);
  expect(body.thinking).toEqual({ type: 'disabled' });
  expect(body.max_completion_tokens).toBe(4000);
});
it('sends exercise images as OpenAI-compatible multimodal data URIs', async () => {
  const calls: any[] = [];
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details);
    details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"answer":"from image"}' } }] }) });
    return { abort: vi.fn() };
  });
  await expect(answerWithAi('look at the picture', cfg({ aiApiKey: 'k' }), signal(),
    [{ mime: 'image/png', data: 'AAAA' }])).resolves.toEqual({ answer: 'from image' });
  const user = JSON.parse(calls[0].data).messages[1];
  expect(user.content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  expect(user.content[1]).toEqual({ type: 'text', text: 'look at the picture' });
});
it('downloads an exercise image and sniffs its MIME type from the bytes', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer, calls: any[] = [];
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details); details.onload({ status: 200, response: png }); return { abort: vi.fn() };
  });
  const image = await fetchImage('https://cdn.example/picture', cfg(), signal());
  expect(image?.mime).toBe('image/png');
  expect(image?.data).toBe(Buffer.from(new Uint8Array(png)).toString('base64'));
  expect(calls[0]).toMatchObject({ method: 'GET', responseType: 'arraybuffer' });
});
it('encodes large media with 32 KB String.fromCharCode chunks', async () => {
  const bytes = new Uint8Array(100_000);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    details.onload({ status: 200, response: bytes.buffer }); return { abort: vi.fn() };
  });
  const image = await fetchImage('https://cdn.example/large.jpg', cfg(), signal());
  expect(image?.data).toBe(Buffer.from(bytes).toString('base64'));
});
it('maps a media download timeout to a clear manual-answer message', async () => {
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    details.ontimeout(); return { abort: vi.fn() };
  });
  await expect(fetchMedia('https://cdn.example/video.mp4', cfg(), signal()))
    .rejects.toThrow('视频下载超过 10 分钟');
});
it('accepts an inline data URI image without a network request', async () => {
  const gm = vi.fn();
  vi.stubGlobal('GM_xmlhttpRequest', gm);
  await expect(fetchImage('data:image/jpeg;base64,QUJD', cfg(), signal()))
    .resolves.toEqual({ mime: 'image/jpeg', data: 'QUJD' });
  expect(gm).not.toHaveBeenCalled();
});
it('decodes a video audio track with a 16 kHz OfflineAudioContext before MiMo ASR', async () => {
  class FakeAudioBuffer {
    duration = 1; sampleRate = 16000; length = 16000; numberOfChannels = 1;
    getChannelData() { const data = new Float32Array(16000); data.fill(0.1); return data; }
  }
  const contexts: any[] = [];
  class FakeOfflineAudioContext {
    decodeAudioData = vi.fn(async () => new FakeAudioBuffer());
    close = vi.fn(async () => undefined);
    constructor(...args: any[]) { contexts.push(args); }
  }
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  const calls: any[] = [], progress = vi.fn();
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details);
    details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: 'video transcript' } }] }) });
    return { abort: vi.fn() };
  });
  await expect(transcribeVideo(new ArrayBuffer(8), 'q.mp4',
    cfg({ asrApiKey: 'k', asrApiBase: 'https://api.xiaomimimo.com/v1', asrModel: 'mimo-v2.5-asr' }), signal(), progress))
    .resolves.toBe('video transcript');
  expect(contexts[0]).toEqual([1, 1, 16000]);
  expect(progress).toHaveBeenCalledWith('正在转写视频音频第 1/1 段…');
  const part = JSON.parse(calls[0].data).messages[0].content[0];
  expect(part.type).toBe('input_audio');
  expect(part.input_audio.format).toBe('wav');
  expect(part.input_audio.data.startsWith('UklGR')).toBe(true);
});
it('falls back to fetch when the userscript manager lacks GM_xmlhttpRequest', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '{"answer":"x"}' } }] }) }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(answerWithAi('q', cfg({ aiApiKey: 'k' }), signal())).resolves.toEqual({ answer: 'x' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('times out a hung userscript-manager request instead of freezing', async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  vi.stubGlobal('GM_xmlhttpRequest', () => ({ abort }));
  const pending = answerWithAi('q', cfg({ aiApiKey: 'k' }), signal());
  const assertion = expect(pending).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(61_000);
  await assertion;
  expect(abort).toHaveBeenCalled();
});
it('requires independent AI, ASR and TTS keys', async () => {
  await expect(answerWithAi('q', cfg({ aiApiKey: '' }), signal())).rejects.toThrow('AI API Key');
  await expect(transcribeAudio(new ArrayBuffer(1), 'q.mp3', cfg({ asrApiKey: '' }), signal())).rejects.toThrow('ASR');
  await expect(synthesizeSpeech('q', cfg({ ttsApiKey: '' }), signal())).rejects.toThrow('TTS API Key');
});

import { afterEach, expect, it, vi } from 'vitest';
import { answerWithAi, synthesizeSpeech, transcribeAudio } from '../src/api';
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

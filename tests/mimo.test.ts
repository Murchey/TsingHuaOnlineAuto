import { afterEach, expect, it, vi } from 'vitest';
import { mimoAnswer, mimoTts, type MimoConfig } from '../src/mimo';

const signal = () => new AbortController().signal;
const config = (overrides: Partial<MimoConfig> = {}): MimoConfig => ({ apiKey: 'secret', ...overrides });

afterEach(() => vi.unstubAllGlobals());

it('sends a MiMo TTS request and decodes message.audio.data', async () => {
  const calls: any[] = [], bytes = new Uint8Array([1, 2, 3]);
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    calls.push(details);
    details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
      audio: { data: Buffer.from(bytes).toString('base64') } } }] }) });
    return { abort: vi.fn() };
  });
  const audio = new Uint8Array(await mimoTts('Hello', config({ ttsModel: 'tts-x', ttsVoice: 'voice-x' }), signal()));
  expect([...audio]).toEqual([1, 2, 3]);
  expect(calls[0].url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  expect(calls[0].headers.Authorization).toBe('Bearer secret');
  expect(JSON.parse(calls[0].data)).toMatchObject({ model: 'tts-x', messages: [{ role: 'assistant', content: 'Hello' }],
    audio: { format: 'mp3', voice: 'voice-x' } });
});

it('parses a fenced JSON answer from MiMo chat', async () => {
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {
      content: '```json\n{"answer":"AI text"}\n```' } }] }) });
    return { abort: vi.fn() };
  });
  await expect(mimoAnswer('question', config(), signal())).resolves.toEqual({ answer: 'AI text' });
});

it('rejects without a key and surfaces API errors', async () => {
  await expect(mimoTts('Hello', config({ apiKey: '' }), signal())).rejects.toThrow('API Key');
  vi.stubGlobal('GM_xmlhttpRequest', (details: any) => {
    details.onload({ status: 401, responseText: '{"error":{"message":"bad key"}}' });
    return { abort: vi.fn() };
  });
  await expect(mimoAnswer('question', config(), signal())).rejects.toThrow('HTTP 401');
});

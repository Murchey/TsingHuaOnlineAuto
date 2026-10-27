import { beforeEach, expect, it } from 'vitest';
import { Store } from '../src/storage';
import { defaults } from '../src/model';

it('requests a page reload resume with a bounded retry budget', () => {
  const store = new Store();
  expect(store.takeResume()).toBe(false);
  expect(store.requestResume(1_000)).toBe(true);
  expect(store.requestResume(1_000)).toBe(true);
  expect(store.requestResume(1_000)).toBe(true);
  expect(store.requestResume(1_000)).toBe(false);
  expect(store.takeResume()).toBe(true);
  expect(store.takeResume()).toBe(false);
  store.resetResume();
  expect(store.requestResume(1_000)).toBe(true);
  expect(store.requestResume(1_000 + 11 * 60_000)).toBe(true);
});
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
it('restores defaults for damaged settings and clamps duration', () => {
  localStorage.setItem('thoa:v1:settings', '{bad'); expect(new Store().settings()).toEqual(defaults);
  localStorage.setItem('thoa:v1:settings', '{"recordingSeconds":999,"allLoaded":true}');
  expect(new Store().settings().recordingSeconds).toBe(180); expect(new Store().settings().allLoaded).toBe(true);
  expect(new Store().settings().rolePlayAudioMode).toBe('original');
  expect(new Store().settings().continuous).toBe(true);
  expect(new Store().settings().ttsProvider).toBe('mimo');
  new Store().saveSettings({ ...defaults, aiApiKey: 'ai', asrApiKey: 'asr', ttsApiKey: 'tts' });
  expect(new Store().settings()).toMatchObject({ aiApiKey: 'ai', asrApiKey: 'asr', ttsApiKey: 'tts' });
  localStorage.setItem('thoa:v1:settings', '{"rolePlayAudioMode":"microphone"}');
  expect(new Store().settings().rolePlayAudioMode).toBe('microphone');
  localStorage.setItem('thoa:v1:settings', '{"rolePlayExampleAudio":false}');
  expect(new Store().settings().rolePlayAudioMode).toBe('microphone');
  localStorage.setItem('thoa:v1:settings', '{"rolePlayAudioMode":"bad"}');
  expect(new Store().settings().rolePlayAudioMode).toBe('original');
});
it('blocks damaged checkpoint recovery instead of treating it as a fresh exercise', () => {
  localStorage.setItem('thoa:v1:unit', '{"version":1,"phase":"pending"}');
  expect(() => new Store().read('unit')).toThrow(/核查/);
});
it('resets only the explicitly selected exercise', () => {
  localStorage.setItem('thoa:v1:one', 'one'); localStorage.setItem('thoa:v1:two', 'two');
  new Store().clear('one'); expect(localStorage.getItem('thoa:v1:one')).toBeNull(); expect(localStorage.getItem('thoa:v1:two')).toBe('two');
});
it('clears checkpoints for a rechallenged course without touching other courses', () => {
  localStorage.setItem('thoa:v1:/legacy/course:20:page-a', 'a');
  localStorage.setItem('thoa:v1:/legacy/course:20:page-b', 'b');
  localStorage.setItem('thoa:v1:/legacy/course:21:page-c', 'c');
  new Store().clearCourse('/legacy/course:20:page-a');
  expect(localStorage.getItem('thoa:v1:/legacy/course:20:page-a')).toBeNull();
  expect(localStorage.getItem('thoa:v1:/legacy/course:20:page-b')).toBeNull();
  expect(localStorage.getItem('thoa:v1:/legacy/course:21:page-c')).toBe('c');
});

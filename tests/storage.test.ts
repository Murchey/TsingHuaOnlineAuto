import { beforeEach, expect, it } from 'vitest';
import { Store } from '../src/storage';
import { defaults } from '../src/model';

beforeEach(() => localStorage.clear());
it('restores defaults for damaged settings and clamps duration', () => {
  localStorage.setItem('thoa:v1:settings', '{bad'); expect(new Store().settings()).toEqual(defaults);
  localStorage.setItem('thoa:v1:settings', '{"recordingSeconds":999,"allLoaded":true}');
  expect(new Store().settings().recordingSeconds).toBe(180); expect(new Store().settings().allLoaded).toBe(true);
});
it('blocks damaged checkpoint recovery instead of treating it as a fresh exercise', () => {
  localStorage.setItem('thoa:v1:unit', '{"version":1,"phase":"pending"}');
  expect(() => new Store().read('unit')).toThrow(/核查/);
});
it('resets only the explicitly selected exercise', () => {
  localStorage.setItem('thoa:v1:one', 'one'); localStorage.setItem('thoa:v1:two', 'two');
  new Store().clear('one'); expect(localStorage.getItem('thoa:v1:one')).toBeNull(); expect(localStorage.getItem('thoa:v1:two')).toBe('two');
});

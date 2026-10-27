import { beforeEach, describe, expect, it } from 'vitest';
import { answerHashes, canonical, fingerprint, hasCompleteResponse, isSaved, planTasks, taskFor, text } from '../src/answers';
import { choice, data, fill, oral, writing } from './fixtures';

beforeEach(() => { document.body.innerHTML = ''; });
describe('answer parsing', () => {
  it('matches choice by stable option idx rather than display position or text', () => {
    expect(taskFor(choice).value).toBe('b');
    const changed = { ...choice, extension: JSON.stringify([{ idx: 'b', val: 'Blue' }, { idx: 'a', val: 'Red' }]) };
    expect(taskFor(changed).value).toBe('b');
  });
  it('rejects answer-less and duplicate/unknown choices', () => {
    expect(() => taskFor({ ...choice, answer: '' })).toThrow(/缺失/);
    expect(() => taskFor({ ...choice, answer: 'Blue' })).toThrow(/不匹配/);
    expect(() => taskFor({ ...choice, extension: [{ idx: 'b' }, { idx: 'b' }] })).toThrow();
  });
  it('supports multiple choices and preserves the literal judge value zero', () => {
    expect(taskFor({ ...choice, type: 'choice_multiple', answer: '["b","a"]' }).value).toEqual(['b', 'a']);
    expect(taskFor({ id: 10, type: 'judge_basic', answer: '0' }).value).toBe('0');
    expect(() => taskFor({ ...choice, type: 'choice_multiple', answer: '[]' })).toThrow();
  });
  it('orders fill blanks by DOM idx and uses standardAnswer or a listed alternative', () => {
    expect(taskFor(fill).value).toEqual([{ idx: 'blank-2', answer: 'Hello' }, { idx: 'blank-1', answer: 'world' }]);
  });
  it('rejects mismatched or duplicate blanks instead of guessing', () => {
    expect(() => taskFor({ ...fill, answer: [{ idx: 'blank-1', val: 'x' }] })).toThrow(/数量/);
    expect(() => taskFor({ ...fill, answer: [{ idx: 'blank-1', val: 'x' }, { idx: 'blank-1', val: 'y' }] })).toThrow(/唯一/);
  });
  it('keeps essay paragraph boundaries and never treats HTML as live DOM', () => {
    expect(taskFor(writing).value).toEqual({ answer: 'Hello.\nNice to meet you.', annex: [] });
    expect(text('A<br>B &amp; C')).toBe('A\nB & C');
    expect(document.querySelector('p')).toBeNull();
  });
  it('uses only a question-id-matched answer record, not a user response', () => {
    expect(taskFor({ ...choice, answer: '' }, { questionId: 101, userAnswer: 'a', answer: 'b' }).value).toBe('b');
    expect(() => planTasks({ ...data({ ...choice, answer: '' }), questionAnswerItemVOList: [{ questionId: 999, answer: 'b' }] })).toThrow();
    expect(() => taskFor({ ...choice, answer: '' }, { questionId: 101, userAnswer: 'b' })).toThrow();
  });
  it('allows answer scaffolds for AI generation only when explicitly enabled', () => {
    const missingChoice = data({ ...choice, answer: '' }), missingWriting = data({ ...writing, answer: '' });
    expect(() => planTasks(missingChoice)).toThrow();
    expect(planTasks(missingChoice, { allowMissing: true })[0]).toMatchObject({ kind: 'choice', value: '' });
    expect(planTasks(missingWriting, { allowMissing: true })[0].value).toEqual({ answer: '', annex: [] });
  });
  it('preflights combined questions and rejects duplicate ids and unsupported types', () => {
    expect(planTasks(data({ id: 1, type: 'combined_basic', children: [choice, fill] }))).toHaveLength(2);
    expect(() => planTasks(data(choice, choice))).toThrow(/重复/);
    expect(() => taskFor({ id: 1, type: 'oral_roleplay' })).toThrow(/不支持/);
    expect(taskFor(oral).kind).toBe('recording');
  });
});

describe('server verification', () => {
  it('does not call partial fill or recording responses complete', () => {
    expect(hasCompleteResponse(fill, '[{"idx":"blank-1","answer":"world"}]')).toBe(false);
    expect(hasCompleteResponse(fill, taskFor(fill).value)).toBe(true);
    expect(hasCompleteResponse(choice, 'unknown')).toBe(false);
    const follow = { id: 105, type: 'oral_follow_along', extension: { sentItems: [{ idx: 'one' }, { idx: 'two' }] } };
    expect(hasCompleteResponse(follow, [{ idx: 'one', answer: { audio: 'a' } }])).toBe(false);
    expect(hasCompleteResponse(follow, [{ idx: 'one', answer: { audio: 'a' } }, { idx: 'two', answer: {} }])).toBe(false);
  });
  it('requires count advancement AND exact per-question saved values', () => {
    const initial = data(choice, fill, writing);
    const tasks = planTasks(initial);
    const expected = answerHashes(initial, new Map(tasks.map(t => [String(t.question.id), t.value])));
    const saved = { ...structuredClone(initial), answerCount: 1,
      questionAnswerItemVOList: tasks.map(t => ({ questionId: t.question.id, userAnswer: typeof t.value === 'string' ? t.value : JSON.stringify(t.value) })) };
    expect(isSaved(saved, 0, expected, fingerprint(initial))).toBe(true);
    expect(isSaved({ ...saved, answerCount: 0 }, 0, expected, fingerprint(initial))).toBe(false);
    saved.questionAnswerItemVOList[0].userAnswer = 'a';
    expect(isSaved(saved, 0, expected, fingerprint(initial))).toBe(false);
  });
  it('rejects a changed question, missing record, or duplicate record', () => {
    const d = data(choice), mark = fingerprint(d), expected = answerHashes(d, new Map([['101', 'b']]));
    const saved = { ...d, answerCount: 1, questionAnswerItemVOList: [{ questionId: 101, userAnswer: 'b' }] };
    expect(isSaved({ ...saved, questionVOList: [{ ...choice, stem: 'Changed' }] }, 0, expected, mark)).toBe(false);
    expect(isSaved({ ...saved, questionAnswerItemVOList: [] }, 0, expected, mark)).toBe(false);
    expect(isSaved({ ...saved, questionAnswerItemVOList: [...saved.questionAnswerItemVOList, ...saved.questionAnswerItemVOList] }, 0, expected, mark)).toBe(false);
  });
  it('compares audio identity while ignoring expiring signatures and grading metadata', () => {
    const a = canonical(oral, { audio: 'https://example.invalid/record.mp3?token=one', score: 0 });
    expect(a).toEqual(canonical(oral, { audio: 'https://example.invalid/record.mp3?token=two', score: 40 }));
  });
});

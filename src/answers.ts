import { Halt, type AnswerRecord, type ExerciseData, type Question, type Task } from './model';

export function parse(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[\[{]/.test(value.trim())) return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function object(value: unknown): Record<string, unknown> {
  const v = parse(value);
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export function leaves(questions: Question[]): Question[] {
  return questions.flatMap(q => q.children?.length ? leaves(q.children) : [q]);
}

export function text(html: unknown): string {
  if (typeof html !== 'string') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  doc.querySelectorAll('p,div,li').forEach(el => el.append('\n'));
  return (doc.body.textContent || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim();
}

function required(value: unknown, id: string | number): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Halt('NO_ANSWER', `题目 ${id} 没有可解析的答案`);
}

export function taskFor(q: Question, record?: AnswerRecord, allowMissing = false): Task {
  const raw = q.answer !== '' && q.answer != null ? q.answer : record?.answer;
  const answer = parse(raw);
  const extension = parse(q.extension);
  if (['oral_simple_speak', 'oral_follow_along', 'oral_vocabulary_learning', 'legacy_8', 'legacy_9', 'legacy_18'].includes(q.type)) {
    return { question: q, kind: 'recording' };
  }
  if (['choice_single', 'choice_multiple', 'judge_basic'].includes(q.type)) {
    // A single-choice idx may look like JSON; it must retain its string identity.
    const selected = q.type === 'choice_multiple' ? answer : raw;
    const values = Array.isArray(selected) ? selected : [selected];
    const options = q.type === 'judge_basic' ? ['1', '0'] :
      Array.isArray(extension) ? extension.map(o => String(object(o).idx)) : [];
    if (!options.length || new Set(options).size !== options.length) {
      throw new Halt('NO_ANSWER', `题目 ${q.id} 的选项缺失或重复`);
    }
    if (allowMissing && (raw == null || raw === '')) {
      return { question: q, kind: 'choice', value: q.type === 'choice_multiple' ? [] : '' };
    }
    if (!values.length || (q.type !== 'choice_multiple' && values.length !== 1) ||
        values.some(v => typeof v !== 'string' || !options.includes(v)) || new Set(values).size !== values.length) {
      throw new Halt('NO_ANSWER', `题目 ${q.id} 的答案缺失或与选项不匹配`);
    }
    return { question: q, kind: 'choice', value: q.type === 'choice_multiple' ? values : values[0] };
  }
  if (q.type === 'fill_base') {
    const doc = new DOMParser().parseFromString(q.stem || '', 'text/html');
    const ids = [...doc.querySelectorAll('span.zty-exercise-item-fill-blank[id]')].map(el => el.id);
    const answers = Array.isArray(answer) ? answer : [];
    if (!ids.length || new Set(ids).size !== ids.length || (!allowMissing && answers.length !== ids.length)) {
      throw new Halt('AMBIGUOUS', `填空题 ${q.id} 的空位与答案数量不一致`);
    }
    const value = ids.map(idx => {
      const matches = answers.map(object).filter(a => a.idx === idx);
      if (matches.length !== 1) {
        if (allowMissing) return { idx, answer: '' };
        throw new Halt('AMBIGUOUS', `填空题 ${q.id} 的空位标识无法唯一匹配`);
      }
      const a = matches[0];
      const val = typeof a.standardAnswer === 'string' && a.standardAnswer.trim() ? a.standardAnswer : a.val;
      if (allowMissing && (typeof val !== 'string' || !val.trim())) return { idx, answer: '' };
      required(val, q.id);
      // The site documents semicolon-separated accepted variants; choose the first explicitly listed variant.
      const selected = text(val.split(/[;；]/)[0]);
      required(selected, q.id);
      return { idx, answer: selected };
    });
    return { question: q, kind: 'fill', value };
  }
  if (['essay_writing', 'essay_translate', 'essay_questions_answers'].includes(q.type)) {
    const value = text(typeof answer === 'string' ? answer : object(answer).answer);
    if (!allowMissing) required(value, q.id);
    return { question: q, kind: 'writing', value: { answer: value, annex: [] } };
  }
  throw new Halt('UNSUPPORTED', `暂不支持题型 ${q.type}（题目 ${q.id}），已暂停`);
}

export function planTasks(data: ExerciseData, options: { allowMissing?: boolean } = {}): Task[] {
  const qs = leaves(data.questionVOList);
  if (!qs.length) throw new Halt('EMPTY', '当前练习没有题目，或题目尚未加载');
  const ids = qs.map(q => String(q.id));
  if (ids.some(id => !/^[\w-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Halt('AMBIGUOUS', '题目标识缺失或重复，无法安全匹配');
  }
  const records = data.questionAnswerItemVOList || [];
  if (new Set(records.map(r => String(r.questionId))).size !== records.length) {
    throw new Halt('AMBIGUOUS', '作答记录中出现重复题目标识');
  }
  return qs.map(q => taskFor(q, records.find(r => String(r.questionId) === String(q.id)), options.allowMissing === true));
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

// Local consistency fingerprint, not a cryptographic identity or an authorization check.
export function hash(value: unknown): string {
  let n = 14695981039346656037n;
  for (const c of stable(value)) n = BigInt.asUintN(64, (n ^ BigInt(c.codePointAt(0)!)) * 1099511628211n);
  return n.toString(16);
}

export function fingerprint(data: ExerciseData): string {
  return hash(leaves(data.questionVOList).map(q => [String(q.id), q.type, q.stem, q.instruction, parse(q.extension)]));
}

function audioId(value: unknown): string {
  if (typeof value !== 'string') return '';
  try { const u = new URL(value); return u.origin + u.pathname; } catch { return value; }
}

export function canonical(q: Question, value: unknown): unknown {
  const v = q.type === 'choice_single' || q.type === 'judge_basic' ? value : parse(value);
  if (q.type === 'choice_multiple') return Array.isArray(v) ? [...v].sort() : v;
  if (q.type === 'fill_base') return Array.isArray(v) ? v.map(object)
    .map(a => ({ idx: a.idx, answer: a.answer })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
  if (q.type.startsWith('essay_')) return { answer: String(object(v).answer ?? '').replace(/\r\n/g, '\n').trim() };
  if (q.type === 'oral_simple_speak' || q.type === 'legacy_8') return { audio: audioId(object(v).audio) };
  if (q.type === 'legacy_9') return Array.isArray(v) ? v.map(object).map(a => ({ idx: a.idx, audio: audioId(String(a.audio || '')) }))
    .sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
  if (q.type === 'legacy_18') {
    const r = object(v);
    return { roleId: String(r.roleId || ''), answers: Array.isArray(r.answers) ? r.answers.map(object)
      .map(a => ({ idx: a.idx, audio: audioId(String(a.audio || '')) }))
      .sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : [] };
  }
  if (q.type === 'oral_follow_along' || q.type === 'oral_vocabulary_learning') return Array.isArray(v) ?
    v.map(object).map(a => ({ idx: a.idx, audio: audioId(object(a.answer).audio) }))
      .sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
  return v;
}

export function hasCompleteResponse(q: Question, value: unknown): boolean {
  const v = q.type === 'choice_single' || q.type === 'judge_basic' ? value : parse(value);
  if (q.type === 'choice_single' || q.type === 'choice_multiple' || q.type === 'judge_basic') {
    const options = q.type === 'judge_basic' ? ['0', '1'] :
      Array.isArray(parse(q.extension)) ? (parse(q.extension) as unknown[]).map(o => object(o).idx) : [];
    const selected = q.type === 'choice_multiple' ? v : [v];
    return Array.isArray(selected) && selected.length > 0 && new Set(selected).size === selected.length &&
      selected.every(s => typeof s === 'string' && options.includes(s));
  }
  if (q.type.startsWith('essay_')) return typeof object(v).answer === 'string' && !!String(object(v).answer).trim();
  if (q.type === 'oral_simple_speak' || q.type === 'legacy_8') return typeof object(v).audio === 'string' && !!object(v).audio;
  if (q.type === 'legacy_9') {
    const items = object(q.extension).sentItems;
    if (!Array.isArray(items) || !items.length || !Array.isArray(v) || !v.length) return false;
    const answers = v.map(object);
    if (answers.some(a => typeof a.audio !== 'string' || !a.audio)) return false;
    const itemById = new Map(items.map(item => [String(object(item).idx), object(item)]));
    if (itemById.size !== items.length) return false;
    const answeredIds = new Set(answers.map(a => String(a.idx)));
    if (answeredIds.size !== answers.length || [...answeredIds].some(idx => !itemById.has(idx))) return false;
    // The website only asks the student to record the selected role's lines. Saved
    // records may omit roleId, so infer the role from the answered sentence IDs.
    if (items.every(item => answeredIds.has(String(object(item).idx)))) return true;
    const roleIds = new Set([...answeredIds].map(idx => String(itemById.get(idx)?.roleId ?? '')));
    if (roleIds.size !== 1) return false;
    const roleId = [...roleIds][0];
    const expected = items.filter(item => String(object(item).roleId ?? '') === roleId);
    return expected.length > 0 && expected.every(item => answeredIds.has(String(object(item).idx)));
  }
  if (q.type === 'legacy_18') {
    const items = object(q.extension).sentItems;
    const record = object(v), answers = Array.isArray(record.answers) ? record.answers.map(object) : [];
    const roleId = String(record.roleId || '');
    if (!roleId || !Array.isArray(items) || !items.length || !answers.length) return false;
    if (answers.some(a => typeof a.audio !== 'string' || !a.audio)) return false;
    const itemById = new Map(items.map(item => [String(object(item).idx), object(item)]));
    if (itemById.size !== items.length) return false;
    const answeredIds = new Set(answers.map(a => String(a.idx)));
    if (answeredIds.size !== answers.length || [...answeredIds].some(idx => !itemById.has(idx))) return false;
    const expected = items.filter(item => String(object(item).roleId ?? '') === roleId);
    return expected.length > 0 && expected.every(item => answeredIds.has(String(object(item).idx)));
  }
  if (q.type === 'fill_base' || q.type === 'oral_follow_along' || q.type === 'oral_vocabulary_learning') {
    const ext = parse(q.extension);
    const ids = q.type === 'fill_base' ? [...new DOMParser().parseFromString(q.stem || '', 'text/html')
      .querySelectorAll('span.zty-exercise-item-fill-blank[id]')].map(el => el.id) :
      (q.type === 'oral_follow_along' ? object(ext).sentItems : ext);
    const expected = Array.isArray(ids) ? ids.map(i => typeof i === 'string' ? i : object(i).idx) : [];
    if (!expected.length || new Set(expected).size !== expected.length || !Array.isArray(v) || v.length !== expected.length) return false;
    return expected.every(idx => {
      const matches = v.map(object).filter(a => a.idx === idx);
      if (matches.length !== 1) return false;
      const a = matches[0];
      return q.type === 'fill_base' ? typeof a.answer === 'string' && !!a.answer.trim() :
        typeof object(a.answer).audio === 'string' && !!object(a.answer).audio;
    });
  }
  return false;
}

export function answerHashes(data: ExerciseData, values: Map<string, unknown>): Record<string, string> {
  return Object.fromEntries(leaves(data.questionVOList).map(q => [String(q.id), hash(canonical(q, values.get(String(q.id))))]));
}

export function isSaved(data: ExerciseData, baseline: number, expected: Record<string, string>, mark: string): boolean {
  if (fingerprint(data) !== mark || (data.answerCount || 0) <= baseline) return false;
  const qs = leaves(data.questionVOList);
  const records = data.questionAnswerItemVOList || [];
  return qs.length === Object.keys(expected).length && qs.every(q => {
    const matches = records.filter(r => String(r.questionId) === String(q.id));
    return matches.length === 1 && matches[0].userAnswer != null &&
      hash(canonical(q, matches[0].userAnswer)) === expected[String(q.id)];
  });
}

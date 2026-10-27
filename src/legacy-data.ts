import { object, text } from './answers';
import { Halt, type AnswerRecord, type ExerciseData, type Question } from './model';

export function legacyQuestion(exercise: unknown): Question {
  const e = object(exercise), type = Number(e.type);
  const q: Question = { id: String(e.id || ''), type: `legacy_${type}`, instruction: String(e.contentString || '') };
  if ([14, 15, 16, 25].includes(type) && Array.isArray(e.exerciseList)) {
    q.children = e.exerciseList.map(legacyQuestion); return q;
  }
  if (type === 1 || type === 2) {
    q.type = type === 1 ? 'choice_single' : 'choice_multiple'; q.answer = e.answer;
    q.extension = Array.isArray(e.choices) ? e.choices.map(c => ({ idx: object(c).id, val: object(c).content })) : [];
  } else if ([3, 5, 17, 24].includes(type)) {
    q.type = 'fill_base';
    const blanks = Array.isArray(e.fillBlanks) ? e.fillBlanks.map(object) : [];
    if (blanks.some(b => typeof b.id !== 'string' || !/^[\w-]+$/.test(b.id))) throw new Halt('DATA_SHAPE', '旧版填空标识格式异常');
    q.stem = blanks.map(b => `<span class="zty-exercise-item-fill-blank" id="${b.id}"></span>`).join('');
    q.answer = blanks.map(b => ({ idx: b.id, val: b.answer }));
    // Keep all option identities in the fingerprint, including drag-and-drop assignments.
    q.extension = { legacyType: type, options: Array.isArray(e.dragged) ? e.dragged.map(d => object(d).id) : [] };
    if (type === 24) {
      const ids = (q.extension as { options: unknown[] }).options;
      if (new Set(ids).size !== ids.length || blanks.some(b => typeof b.answer !== 'string' || !ids.includes(b.answer))) {
        throw new Halt('NO_ANSWER', '拖拽填空的答案缺失或无法唯一匹配选项');
      }
    }
  } else if ([6, 7, 8].includes(type)) {
    q.type = 'essay_questions_answers'; q.answer = text(e.answer);
  } else if (type === 9) {
    q.type = 'legacy_9';
    q.extension = {
      roles: Array.isArray(e.roles) ? e.roles.map(r => ({ id: object(r).id, name: object(r).name })) : [],
      sentItems: Array.isArray(e.sentItems) ? e.sentItems.map(s => ({
        idx: object(s).id, roleId: object(s).roleId, audioTime: object(s).audioTime,
        text: text(object(s).styleText),
      })) : [],
    };
  } else if (type === 20) {
    q.type = 'oral_simple_speak';
  }
  return q;
}

export function legacyValue(q: Question, record: unknown): unknown {
  const a = object(record).answer;
  if (q.type === 'fill_base') return Object.entries(object(a)).map(([idx, v]) => ({ idx,
    answer: object(q.extension).legacyType === 24 ? object(v).choiceId : object(v).content }));
  if (q.type.startsWith('essay_')) return { answer: a, annex: [] };
  if (q.type === 'oral_simple_speak') return { audio: typeof a === 'string' ? a : '' };
  if (q.type === 'legacy_9') {
    const answers = object(a);
    return Object.entries(answers).map(([idx, value]) => ({ idx, audio: object(value).recordAudio || '' }));
  }
  return a;
}

export function legacyData(payload: unknown): ExerciseData {
  const p = object(payload);
  if (!object(p.exercise).id || !Number.isInteger(p.submitNum) || Number(p.submitNum) < 0) {
    throw new Halt('DATA_SHAPE', '旧版练习数据尚未加载或格式已变化');
  }
  const q = legacyQuestion(p.exercise), records: AnswerRecord[] = [];
  function visit(question: Question, record: unknown): void {
    if (question.children) for (const child of question.children) visit(child, object(object(record).answer)[String(child.id)]);
    else if (record) records.push({ questionId: question.id, userAnswer: legacyValue(question, record) });
  }
  visit(q, p.doRecord);
  return { questionVOList: [q], answerCount: Number(p.submitNum), questionAnswerItemVOList: records };
}

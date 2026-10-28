import { object, text } from './answers';
import { Halt, type AnswerRecord, type ExerciseData, type Question } from './model';

export function legacyQuestion(exercise: unknown): Question {
  const e = normalizeExercise(exercise), type = Number(e.type);
  const q: Question = { id: String(e.id || ''), type: `legacy_${type}`, instruction: String(e.contentString || '') };
  const audio = collectAudioIds(e);
  if (audio.length) q.audio = audio;
  const images = collectImageIds(e);
  if (images.length) q.images = images;
  if ([14, 15, 16, 25].includes(type) && Array.isArray(e.exerciseList)) {
    // Composite listening blocks keep the script on the parent; children need it too so
    // the AI can answer without a slow or failing ASR round-trip.
    const parentScript = text(typeof e.audioScript === 'string' ? e.audioScript : '');
    q.children = e.exerciseList.map(child => {
      const question = legacyQuestion(child);
      const ext = object(question.extension);
      if (parentScript && question.extension && !Array.isArray(question.extension)) {
        question.extension = { ...ext, audioScript: parentScript };
      }
      // Composite pages render one shared audio/picture above all child exercises.
      if (q.audio?.length) question.audio = [...new Set([...(question.audio || []), ...q.audio])];
      if (q.images?.length) question.images = [...new Set([...(question.images || []), ...q.images])];
      return question;
    });
    return q;
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
  } else if ([6, 7].includes(type)) {
    q.type = 'essay_questions_answers'; q.answer = text(e.answer);
  } else if (type === 8) {
    q.type = 'legacy_8'; q.answer = text(e.answer);
  } else if (type === 9 || type === 18) {
    q.type = type === 9 ? 'legacy_9' : 'legacy_18';
    const roles = arrayField(e, 'roles', 'roleList');
    const sentItems = arrayField(e, 'sentItems', 'sentenceItems', 'items');
    q.extension = {
      roles: roles.map(r => ({ id: object(r).id, name: object(r).name })),
      sentItems: sentItems.map(s => ({
        idx: object(s).id, roleId: object(s).roleId, audioTime: object(s).audioTime,
        audio: object(s).audio ?? object(s).audioUrl ?? object(s).resId,
        text: richText(object(s).styleText ?? object(s).text ?? object(s).content),
      })),
    };
  } else if (type === 11) {
    // Many-to-many classification: each draggable item belongs to exactly one target zone.
    const targets = arrayField(e, 'drag').map(value => {
      const target = object(value);
      return { id: String(target.id ?? ''), text: richText(target.styleContent) || String(target.content ?? '') };
    });
    const items = arrayField(e, 'dragged').map(value => {
      const item = object(value);
      return { id: String(item.id ?? ''), text: richText(item.styleContent) || richText(item.content) ||
        String(item.content ?? '') };
    });
    if (!targets.length || targets.some(t => !t.id) || !items.length || items.some(i => !i.id)) {
      throw new Halt('DATA_SHAPE', '旧版分类拖拽题的目标或选项缺失');
    }
    q.type = 'legacy_11';
    q.extension = { legacyType: 11, targets, items };
  } else if (type === 10) {
    // One-to-one matching: every target receives exactly one dragged item.
    const targets = arrayField(e, 'drag').map(value => {
      const target = object(value);
      const answer = Array.isArray(target.answer) ? target.answer[0] : (target.answer ?? target.choiceId);
      return { id: String(target.id ?? ''), text: richText(target.styleContent) || richText(target.content) ||
        String(target.content ?? ''), answer: String(answer ?? '') };
    });
    const items = arrayField(e, 'dragged').map(value => {
      const item = object(value);
      return { id: String(item.id ?? ''), text: richText(item.styleContent) || String(item.content ?? '') };
    });
    if (!targets.length || targets.some(target => !target.id) || !items.length || items.some(item => !item.id)) {
      throw new Halt('DATA_SHAPE', '旧版匹配题缺少目标或选项');
    }
    q.type = 'legacy_10';
    q.answer = targets.map(target => ({ idx: target.id, val: target.answer }));
    q.extension = { legacyType: 10, targets, items };
  } else if (type === 22) {
    // Judge (true/false) grid: every statement picks one option column.
    const items = arrayField(e, 'sentItems', 'sentenceItems', 'items').map(value => {
      const item = object(value);
      return { id: String(item.id ?? ''), text: richText(item.styleText ?? item.text ?? item.content),
        answer: String(item.answer ?? item.optionId ?? '') };
    });
    const options = arrayField(e, 'options', 'choices').map(value => {
      const option = object(value);
      return { id: String(option.id ?? ''),
        text: String(option.text ?? '') || richText(option.styleContent ?? option.content) ||
          String(option.content ?? option.name ?? '') };
    });
    if (!items.length || items.some(item => !item.id) || !options.length || options.some(option => !option.id)) {
      throw new Halt('DATA_SHAPE', '旧版判断题缺少句子或判断选项');
    }
    q.type = 'legacy_22';
    q.answer = items.map(item => ({ idx: item.id, val: item.answer }));
    q.extension = { legacyType: 22, items, options };
  } else if (type === 19) {
    q.type = 'fill_base';
    const blanks = Array.isArray(e.fillBlanks) ? e.fillBlanks.map(object) : [];
    if (!blanks.length || blanks.some(b => typeof b.id !== 'string' || !/^[\w-]+$/.test(b.id as string))) {
      throw new Halt('DATA_SHAPE', '旧版对话填空标识格式异常');
    }
    const parsed = dialogueData(e);
    q.stem = blanks.map(b => '<span class="zty-exercise-item-fill-blank" id="' + String(b.id) + '"></span>').join('');
    q.answer = blanks.map(b => {
      const plain = typeof b.answer === 'string' ? b.answer : '';
      const standard = typeof b.standardAnswer === 'string' ? b.standardAnswer : '';
      return { idx: b.id, val: plain || standard };
    });
    q.extension = { legacyType: 19, dialogue: parsed.items, blanks: parsed.blanks,
      audioScript: text(typeof e.audioScript === 'string' ? e.audioScript : '') };
  } else if (type === 20) {
    q.type = 'essay_questions_answers'; q.answer = text(e.answer);
  }
  return q;
}

function normalizeExercise(value: unknown): Record<string, unknown> {
  const root = object(value);
  if (root.type != null && root.id != null) return root;
  for (const key of ['exercise', 'object', 'item', 'data', 'choices']) {
    const nested = object(root[key]);
    if (nested.type != null || nested.id != null) return normalizeExercise(nested);
  }
  return root;
}

function arrayField(e: Record<string, unknown>, ...keys: string[]): unknown[] {
  if (!Object.keys(e).length) return [];
  for (const key of keys) {
    if (Array.isArray(e[key])) return e[key] as unknown[];
    if (e[key] && typeof e[key] === 'object') return Object.values(e[key] as Record<string, unknown>);
  }
  for (const key of ['exercise', 'object', 'item', 'data']) {
    const nested = object(e[key]);
    const found = arrayField(nested, ...keys);
    if (found.length) return found;
  }
  return [];
}

function imageTokens(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(imageTokens);
  if (!value || typeof value !== 'object') return [];
  const entry = object(value), out: string[] = [];
  for (const key of ['id', 'resId', 'resourceID', 'resourceId', 'image', 'imageUrl', 'url', 'previewPath', 'path']) {
    out.push(...imageTokens(entry[key]));
  }
  return out;
}

function collectImageIds(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['image', 'images', 'imageList', 'picture', 'pictures', 'img', 'imgList']) {
    out.push(...imageTokens(e[key]));
  }
  // Image-based choice questions keep the picture on each alternative.
  for (const key of ['alternative', 'alternatives', 'options', 'choices']) {
    const list = Array.isArray(e[key]) ? e[key] as unknown[] : [];
    for (const item of list) {
      const entry = object(item);
      out.push(...imageTokens(entry.image), ...imageTokens(entry.images));
    }
  }
  return [...new Set(out.filter(item => item.length > 0 && item.length <= 400))];
}

function collectAudioIds(value: unknown): string[] {
  const out: string[] = [], seen = new Set<unknown>(), queue: unknown[] = [value];
  const add = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === 'string') { if (v.trim()) out.push(v.trim()); return; }
    if (Array.isArray(v)) { for (const item of v) add(item); return; }
    if (typeof v !== 'object') return;
    const nested = object(v);
    for (const key of ['id', 'resId', 'url', 'audioUrl', 'path']) {
      if (nested[key] !== undefined) add(nested[key]);
    }
  };
  while (queue.length && seen.size < 50) {
    const e = object(queue.shift());
    if (!Object.keys(e).length || seen.has(e)) continue;
    seen.add(e);
    for (const key of ['audio', 'audios', 'audioList', 'audioUrl', 'listenAudio', 'sound', 'soundUrl']) add(e[key]);
    for (const key of ['exercise', 'object', 'item', 'data']) {
      const nested = e[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested && typeof nested === 'object') queue.push(nested);
    }
  }
  return [...new Set(out)];
}

export function richText(value: unknown): string {
  if (typeof value === 'string') return text(value);
  const v = object(value);
  if (typeof v.text === 'string') return text(v.text);
  const paragraphs = Array.isArray(v.paragraphs) ? v.paragraphs : [];
  const chunks: string[] = [];
  for (const p of paragraphs) {
    const items = Array.isArray(object(p).contentItems) ? object(p).contentItems as unknown[] : [];
    for (const item of items) {
      const t = object(item).text;
      if (typeof t === 'string') chunks.push(t);
    }
  }
  return chunks.join(' ').trim();
}

interface DialogueData { items: { role: string; text: string }[]; blanks: { idx: string; before: string; after: string }[] }

// Type 19 interleaves dialogue text with blank placeholders. Keep the nearest text
// neighbours so the official audio script can later restore each missing segment.
function dialogueData(e: Record<string, unknown>): DialogueData {
  const items: DialogueData['items'] = [], blanks: DialogueData['blanks'] = [];
  for (const raw of arrayField(e, 'dialogueContents')) {
    const dialogue = object(raw), parts: string[] = [];
    const paragraphs = Array.isArray(object(dialogue.content).paragraphs) ?
      object(dialogue.content).paragraphs as unknown[] : [];
    for (const paragraph of paragraphs) {
      const contentItems = Array.isArray(object(paragraph).contentItems) ?
        object(paragraph).contentItems as unknown[] : [];
      for (let index = 0; index < contentItems.length; index++) {
        const item = object(contentItems[index]);
        if (Number(item.type) === 2) {
          const idx = typeof item.id === 'string' ? item.id : '';
          if (!idx) continue;
          const before = object(contentItems[index - 1]).text, after = object(contentItems[index + 1]).text;
          blanks.push({ idx, before: typeof before === 'string' ? before : '',
            after: typeof after === 'string' ? after : '' });
          parts.push('[[' + idx + ']]');
        } else if (typeof item.text === 'string') parts.push(item.text);
      }
    }
    items.push({ role: String(dialogue.role ?? ''), text: parts.join('') });
  }
  return { items, blanks };
}

// Normalize only for matching, while retaining a map back to the original offsets.
function normalizeText(value: string): { text: string; map: number[] } {
  let out = ''; const map: number[] = []; let space = false;
  for (let index = 0; index < value.length; index++) {
    let ch = value[index];
    if (/[‘’]/.test(ch)) ch = "'";
    else if (/[“”]/.test(ch)) ch = '\"';
    else if (/[‐-―]/.test(ch)) ch = '-';
    else if (ch === '\u00a0') ch = ' ';
    if (/\s/.test(ch)) { if (space) continue; ch = ' '; space = true; } else space = false;
    for (const piece of ch.toLowerCase()) { out += piece; map.push(index); }
  }
  return { text: out, map };
}

/**
 * Restore type 19 blanks from the exercise's own audio script. This is exact
 * source text, so it is preferred over a generative answer whenever it resolves.
 */
export function scriptFillAnswers(q: Question): { idx: string; answer: string }[] | null {
  const ext = object(q.extension);
  const script = typeof ext.audioScript === 'string' ? ext.audioScript : '';
  const blanks = Array.isArray(ext.blanks) ? ext.blanks.map(object) : [];
  if (!script || !blanks.length) return null;
  const source = normalizeText(script), answers: { idx: string; answer: string }[] = [];
  for (const blank of blanks) {
    const idx = typeof blank.idx === 'string' ? blank.idx : '';
    const before = typeof blank.before === 'string' ? blank.before : '';
    const after = typeof blank.after === 'string' ? blank.after : '';
    const prefix = normalizeText(before), suffix = normalizeText(after);
    if (!idx) return null;
    const from = prefix.text ? source.text.indexOf(prefix.text) : 0;
    if (from < 0) return null;
    const start = from + prefix.text.length;
    const end = suffix.text ? source.text.indexOf(suffix.text, start) : source.text.length;
    if (end < 0 || end <= start) return null;
    const answer = script.slice(source.map[start] ?? script.length, source.map[end] ?? script.length);
    const cleaned = answer.replace(/^[\s:：,，.。;；!！?？]+|[\s:：,，.。;；!！?？]+$/g, '');
    if (!cleaned) return null;
    answers.push({ idx, answer: cleaned });
  }
  return answers.length === blanks.length ? answers : null;
}

export function legacyValue(q: Question, record: unknown): unknown {
  if (q.type === 'legacy_10') {
    return Object.entries(object(object(record).answer)).map(([idx, value]) => ({
      idx, answer: String(object(value).choiceId ?? ''),
    }));
  }
  if (q.type === 'legacy_22') {
    return Object.entries(object(object(record).answer)).map(([idx, value]) => ({
      idx, answer: String(object(value).id ?? ''),
    }));
  }
  if (q.type === 'legacy_11') {
    return Object.entries(object(object(record).answer)).map(([idx, value]) => ({
      idx, answers: Array.isArray(object(value).choiceIds) ? (object(value).choiceIds as unknown[]).map(String) : [],
    }));
  }
  const a = object(record).answer;
  if (q.type === 'fill_base') return Object.entries(object(a)).map(([idx, v]) => ({ idx,
    answer: object(q.extension).legacyType === 24 ? object(v).choiceId : object(v).content }));
  if (q.type.startsWith('essay_')) return { answer: a, annex: [] };
  if (q.type === 'oral_simple_speak' || q.type === 'legacy_8') return { audio: typeof a === 'string' ? a : '' };
  if (q.type === 'legacy_9') {
    const answers = object(a);
    return Object.entries(answers).map(([idx, value]) => ({ idx, audio: object(value).recordAudio || '' }));
  }
  if (q.type === 'legacy_18') {
    const answers = object(a);
    return { roleId: String(object(record).roleId || ''), answers: Object.entries(answers)
      .map(([idx, value]) => ({ idx, audio: object(value).recordAudio || '' })) };
  }
  return a;
}

export function legacyData(payload: unknown): ExerciseData {
  const p = object(payload);
  const exercise = normalizeExercise(p.exercise);
  if (!exercise.id || !Number.isInteger(p.submitNum) || Number(p.submitNum) < 0) {
    throw new Halt('DATA_SHAPE', '旧版练习数据尚未加载或格式已变化');
  }
  const q = legacyQuestion(exercise), records: AnswerRecord[] = [];
  function visit(question: Question, record: unknown): void {
    if (question.children) for (const child of question.children) visit(child, object(object(record).answer)[String(child.id)]);
    else if (record) records.push({ questionId: question.id, userAnswer: legacyValue(question, record) });
  }
  visit(q, p.doRecord);
  return { questionVOList: [q], answerCount: Number(p.submitNum), questionAnswerItemVOList: records };
}

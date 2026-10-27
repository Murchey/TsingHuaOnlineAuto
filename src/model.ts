export interface Question {
  id: string | number;
  type: string;
  stem?: string;
  instruction?: string;
  answer?: unknown;
  extension?: unknown;
  doRecord?: unknown;
  children?: Question[];
}

export interface AnswerRecord {
  questionId: string | number;
  userAnswer?: unknown;
  overWriteUserAnswer?: unknown;
  answer?: unknown;
  answerStatus?: number;
}

export interface ExerciseData {
  questionVOList: Question[];
  questionAnswerItemVOList?: AnswerRecord[];
  answerCount?: number;
}

export interface Unit {
  key: string;
  catalogId: string;
  contentId: string;
  title: string;
  root: HTMLElement;
}

export interface Task {
  question: Question;
  kind: 'choice' | 'fill' | 'writing' | 'recording';
  value?: unknown;
}

export interface Settings {
  allLoaded: boolean;
  recordingSeconds: number;
  timeoutMs: number;
  intervalMs: number;
}

export const defaults: Settings = {
  allLoaded: false, recordingSeconds: 10, timeoutMs: 30_000, intervalMs: 350,
};

export class Halt extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'Halt'; }
}

export interface Adapter {
  discover(): Unit[];
  assertContext(unit: Unit): void;
  load(unit: Unit, signal: AbortSignal): Promise<ExerciseData>;
  fill(unit: Unit, task: Task, signal: AbortSignal): Promise<unknown>;
  record(unit: Unit, task: Task, settings: Settings, signal: AbortSignal): Promise<unknown>;
  submit(unit: Unit, signal: AbortSignal): Promise<void>;
  next?(unit: Unit, signal: AbortSignal): Promise<Unit | undefined>;
  conflict(): string | null;
}

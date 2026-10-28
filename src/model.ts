export interface Question {
  id: string | number;
  type: string;
  stem?: string;
  instruction?: string;
  answer?: unknown;
  extension?: unknown;
  doRecord?: unknown;
  audio?: string[];
  images?: string[];
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

export type RolePlayAudioMode = 'original' | 'sample' | 'microphone';
export type TtsProvider = 'mimo' | 'openai';

export interface Settings {
  allLoaded: boolean;
  continuous: boolean;
  autoRechallenge: boolean;
  recordingSeconds: number;
  rolePlayAudioMode: RolePlayAudioMode;
  aiAnswers: boolean;
  aiApiKey: string;
  aiApiBase: string;
  aiModel: string;
  asrApiKey: string;
  asrApiBase: string;
  asrModel: string;
  ttsProvider: TtsProvider;
  ttsApiKey: string;
  ttsApiBase: string;
  ttsModel: string;
  ttsVoice: string;
  timeoutMs: number;
  intervalMs: number;
}

export const defaults: Settings = {
  allLoaded: false, continuous: true, autoRechallenge: true, recordingSeconds: 10, rolePlayAudioMode: 'original',
  aiAnswers: false, aiApiKey: '', aiApiBase: 'https://api.openai.com/v1', aiModel: 'gpt-4.1-mini',
  asrApiKey: '', asrApiBase: 'https://api.openai.com/v1', asrModel: 'whisper-1',
  ttsProvider: 'mimo', ttsApiKey: '', ttsApiBase: 'https://api.xiaomimimo.com/v1',
  ttsModel: 'mimo-v2.5-tts', ttsVoice: 'mimo_default',
  timeoutMs: 30_000, intervalMs: 350,
};

export class Halt extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'Halt'; }
}

export interface Adapter {
  discover(): Unit[];
  assertContext(unit: Unit): void;
  load(unit: Unit, signal: AbortSignal): Promise<ExerciseData>;
  fill(unit: Unit, task: Task, settings: Settings, signal: AbortSignal): Promise<unknown>;
  record(unit: Unit, task: Task, settings: Settings, signal: AbortSignal): Promise<unknown>;
  submit(unit: Unit, signal: AbortSignal): Promise<void>;
  next?(unit: Unit, signal: AbortSignal, settings?: Settings, beforeRechallenge?: () => void): Promise<Unit | undefined>;
  conflict(): string | null;
}

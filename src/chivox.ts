import { bounded, sleep } from './async';
import type { LegacyComponent } from './legacy-angular';
import { Halt } from './model';

export interface ChivoxScore {
  score: number; accuracy: number; fluency: number; senseGroup: number; speed: number;
  stress: number; integrity: number; rhythm: number; pron: number;
  recordAudio: string; words: unknown[]; ccode: unknown; result: string;
}

const numberValue = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export async function scoreWithChivox(speech: LegacyComponent, text: string, audio: ArrayBuffer,
  timeoutMs: number, signal: AbortSignal): Promise<ChivoxScore> {
  const recorder = speech.chivoxRecorder, service = speech.speechService;
  if (!recorder?.context || !recorder.node || !recorder.inputPoint ||
      typeof service?.startSentence !== 'function' || typeof recorder.record !== 'function') {
    throw new Halt('SPEECH_INIT', '原站 Chivox 录音器尚未初始化，请刷新页面后重试');
  }
  if (service.observer) {
    try { service.stop(); } catch { /* ignore */ }
    await sleep(250, signal);
  }
  if (service.observer) throw new Halt('SPEECH_BUSY', '原站语音评测仍在运行，请稍后重试');
  const context = recorder.context;
  let audioBuffer: AudioBuffer;
  try { audioBuffer = await context.decodeAudioData(audio.slice(0)); }
  catch { throw new Halt('TTS_AUDIO', 'TTS 音频无法由浏览器解码'); }

  const originalRecord = recorder.record.bind(recorder), originalGain = recorder.inputPoint.gain.value;
  let source: AudioBufferSourceNode | undefined, silent: GainNode | undefined;
  let subscription: { unsubscribe(): void } | undefined, finished = false;
  const restore = () => {
    recorder.record = originalRecord;
    try { recorder.inputPoint.gain.value = originalGain; } catch { /* ignore */ }
    try { source?.stop(); } catch { /* ignore */ }
    try { source?.disconnect(); } catch { /* ignore */ }
    try { recorder.node.disconnect(); } catch { /* ignore */ }
    try { silent?.disconnect(); } catch { /* ignore */ }
    try { recorder.node.connect(context.destination); } catch { /* ignore */ }
  };
  recorder.record = function (options: any) {
    const onStart = options?.onStart;
    options = { ...options, onStart: (...args: unknown[]) => {
      try {
        if (!finished && !signal.aborted) {
          recorder.inputPoint.gain.value = 0;
          try { recorder.node.disconnect(); } catch { /* ignore */ }
          const mute = context.createGain();
          silent = mute;
          mute.gain.value = 0;
          mute.connect(context.destination);
          recorder.node.connect(mute);
          const player = context.createBufferSource();
          source = player;
          player.buffer = audioBuffer;
          player.connect(recorder.node);
          player.onended = () => setTimeout(() => {
            if (!finished) { try { service.stop(); } catch { /* ignore */ } }
          }, 800);
          player.start();
        }
      } catch (error) {
        finished = true;
        throw error;
      }
      if (typeof onStart === 'function') onStart(...args);
    } };
    return originalRecord(options);
  };
  try {
    const result: any = await bounded(new Promise<unknown>((resolve, reject) => {
      subscription = service.startSentence(text, Math.max(8_000, Math.round(audioBuffer.duration * 1000) + 5_000))
        .subscribe({ next: resolve, error: reject });
    }), Math.max(30_000, timeoutMs), signal);
    finished = true;
    const recordAudio = typeof result?.recordAudio === 'string' ? result.recordAudio : '';
    if (!recordAudio) throw new Halt('SPEECH_SCORE', 'Chivox 没有返回录音地址');
    return {
      score: numberValue(result.score), accuracy: numberValue(result.accuracy), fluency: numberValue(result.fluency),
      senseGroup: numberValue(result.senseGroup), speed: numberValue(result.speed), stress: numberValue(result.stress),
      integrity: numberValue(result.integrity), rhythm: numberValue(result.rhythm), pron: numberValue(result.pron),
      recordAudio, words: Array.isArray(result.words) ? result.words : [], ccode: result.ccode ?? {}, result: String(result.result ?? ''),
    };
  } catch (error) {
    finished = true;
    try { service.stop(); } catch { /* ignore */ }
    if (error instanceof Halt) throw error;
    const message = typeof error === 'string' ? error : (error as { errMessage?: unknown })?.errMessage;
    throw new Halt('SPEECH_SCORE', `Chivox 评测失败${typeof message === 'string' && message ? `：${message.slice(0, 160)}` : ''}`);
  } finally {
    subscription?.unsubscribe();
    restore();
  }
}

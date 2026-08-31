// Tiny generated sound effects via WebAudio — no audio assets. Each effect is a
// short burst of filtered noise (or a thud) with slight random pitch variation.

import type { SoundKind } from './blocks';

let ctx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

/** Must be called from a user gesture (click) before sounds can play. */
export function initAudio(): void {
  if (!ctx) {
    ctx = new AudioContext();
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  void ctx.resume();
}

function playNoiseBurst(
  duration: number,
  filterFreq: number,
  volume: number,
  freqDrop = 0.5,
): void {
  if (!ctx || !noiseBuffer || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  const jitter = 0.85 + Math.random() * 0.3;
  filter.frequency.setValueAtTime(filterFreq * jitter, now);
  filter.frequency.exponentialRampToValueAtTime(filterFreq * jitter * freqDrop, now + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(now, Math.random() * 0.1);
  src.stop(now + duration);
}

const BREAK_FREQ: Record<SoundKind, number> = {
  soft: 900,
  hard: 2400,
  wood: 1200,
  sand: 700,
  liquid: 500,
};

export function playBreak(kind: SoundKind): void {
  playNoiseBurst(0.14, BREAK_FREQ[kind], 0.35, 0.35);
}

export function playPlace(kind: SoundKind): void {
  playNoiseBurst(0.09, BREAK_FREQ[kind] * 0.8, 0.28, 0.6);
}

export function playStep(): void {
  playNoiseBurst(0.06, 650, 0.12, 0.55);
}

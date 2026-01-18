import type { NoteEvent } from "../notes/segment";

export type SynthType = "sine" | "triangle" | "sawtooth" | "square";

export async function renderNotesToWavBlob(opts: {
  notes: NoteEvent[];
  bpm: number;
  sampleRate?: number;
  synth?: SynthType;
  attack?: number;
  release?: number;
}): Promise<Blob> {
  const {
    notes,
    sampleRate = 44100,
    synth = "triangle",
    attack = 0.01,
    release = 0.05,
  } = opts;

  const duration = Math.max(1, ...notes.map(n => n.end)) + 0.5;
  const offline = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);

  for (const n of notes) {
    const osc = offline.createOscillator();
    osc.type = synth;

    const gain = offline.createGain();
    gain.gain.setValueAtTime(0, n.start);
    gain.gain.linearRampToValueAtTime((n.velocity / 127) * 0.6, n.start + attack);
    gain.gain.setValueAtTime((n.velocity / 127) * 0.6, Math.max(n.start + attack, n.end - release));
    gain.gain.linearRampToValueAtTime(0, n.end);

    osc.frequency.setValueAtTime(midiToHz(n.midi), n.start);

    osc.connect(gain).connect(offline.destination);
    osc.start(n.start);
    osc.stop(n.end + 0.01);
  }

  const rendered = await offline.startRendering();
  const wavArrayBuf = audioBufferToWav(rendered);
  return new Blob([wavArrayBuf], { type: "audio/wav" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;

  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;

  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = buffer.getChannelData(ch)[i];
      const clamped = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return ab;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}


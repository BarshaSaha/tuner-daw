export type PitchFrame = {
  t: number;
  f0: number | null;
  conf: number;
  rms: number;
};

export type NoteEvent = {
  start: number;
  end: number;
  midi: number;
  velocity: number;
};

export function hzToMidi(f: number): number {
  return 69 + 12 * Math.log2(f / 440);
}

export function midiToName(m: number): string {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const mi = Math.round(m);
  const octave = Math.floor(mi / 12) - 1;
  return `${names[(mi % 12 + 12) % 12]}${octave}`;
}

export function framesToNotes(frames: PitchFrame[], opts?: {
  minRms?: number;
  minConf?: number;
  minNoteDur?: number;
  mergeGap?: number;
  pitchTolerance?: number;
}): NoteEvent[] {
  const {
    minRms = 0.01,
    minConf = 0.2,
    minNoteDur = 0.10,
    mergeGap = 0.06,
    pitchTolerance = 0.5,
  } = opts || {};

  const q = frames.map(fr => {
    const usable = fr.f0 && fr.rms >= minRms && fr.conf >= minConf;
    if (!usable || !fr.f0) return { t: fr.t, midi: null as number | null, v: 0 };
    const m = hzToMidi(fr.f0);
    const mi = Math.round(m);
    const vel = Math.max(1, Math.min(127, Math.round(20 + 107 * clamp01((fr.rms - minRms) / 0.2))));
    return { t: fr.t, midi: mi, v: vel };
  });

  const notes: NoteEvent[] = [];
  let curMidi: number | null = null;
  let curStart = 0;
  let curVel = 64;

  for (let i = 0; i < q.length; i++) {
    const { t, midi, v } = q[i];

    if (curMidi === null) {
      if (midi !== null) {
        curMidi = midi;
        curStart = t;
        curVel = v;
      }
      continue;
    }

    if (midi === null) {
      const end = t;
      if (end - curStart >= minNoteDur) notes.push({ start: curStart, end, midi: curMidi, velocity: curVel });
      curMidi = null;
      continue;
    }

    if (Math.abs(midi - curMidi) > pitchTolerance) {
      const end = t;
      if (end - curStart >= minNoteDur) notes.push({ start: curStart, end, midi: curMidi, velocity: curVel });
      curMidi = midi;
      curStart = t;
      curVel = v;
    } else {
      curVel = Math.round(0.8 * curVel + 0.2 * v);
    }
  }

  const lastT = q.length ? q[q.length - 1].t : 0;
  if (curMidi !== null && lastT - curStart >= minNoteDur) {
    notes.push({ start: curStart, end: lastT, midi: curMidi, velocity: curVel });
  }

  const merged: NoteEvent[] = [];
  notes.sort((a,b) => a.start - b.start);
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === n.midi && (n.start - prev.end) <= mergeGap) {
      prev.end = n.end;
      prev.velocity = Math.round((prev.velocity + n.velocity) / 2);
    } else {
      merged.push({ ...n });
    }
  }
  return merged;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}


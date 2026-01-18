import type { NoteEvent } from "../notes/segment";

export function downloadMidi(notes: NoteEvent[], bpm: number, filename = "conversion.mid") {
  const ppq = 480;
  const bytes: number[] = [];

  const usPerQuarter = Math.round(60_000_000 / bpm);

  const push = (...xs: number[]) => xs.forEach(x => bytes.push(x & 0xff));
  const pushStr = (s: string) => [...s].forEach(ch => push(ch.charCodeAt(0)));
  const pushU32 = (n: number) => push((n>>>24)&255, (n>>>16)&255, (n>>>8)&255, n&255);

  const secToTicks = (sec: number) => Math.round(sec * (bpm / 60) * ppq);

  type Ev = { t: number; data: number[] };
  const events: Ev[] = [];

  events.push({
    t: 0,
    data: [0xff, 0x51, 0x03, (usPerQuarter>>>16)&255, (usPerQuarter>>>8)&255, usPerQuarter&255]
  });
  events.push({ t: 0, data: [0xC0, 0x00] });

  for (const n of notes) {
    const onT = secToTicks(n.start);
    const offT = secToTicks(n.end);
    events.push({ t: onT, data: [0x90, n.midi & 127, n.velocity & 127] });
    events.push({ t: offT, data: [0x80, n.midi & 127, 0] });
  }

  events.sort((a,b) => a.t - b.t);

  // Header
  pushStr("MThd");
  pushU32(6);
  push(0x00, 0x01);
  push(0x00, 0x01);
  push((ppq>>>8)&255, ppq&255);

  // Track
  const track: number[] = [];
  const tpush = (...xs: number[]) => xs.forEach(x => track.push(x & 0xff));
  const tvlq = (n: number) => {
    const out: number[] = [];
    let x = n >>> 0;
    out.unshift(x & 0x7f);
    while ((x >>= 7) > 0) out.unshift((x & 0x7f) | 0x80);
    tpush(...out);
  };

  let lastTick = 0;
  for (const ev of events) {
    const dt = Math.max(0, ev.t - lastTick);
    tvlq(dt);
    tpush(...ev.data);
    lastTick = ev.t;
  }

  tvlq(0);
  tpush(0xff, 0x2f, 0x00);

  pushStr("MTrk");
  pushU32(track.length);
  push(...track);

  const blob = new Blob([new Uint8Array(bytes)], { type: "audio/midi" });
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


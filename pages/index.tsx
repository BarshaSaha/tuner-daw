import { useMemo, useRef, useState } from "react";
import { decodeAudioToMono } from "../lib/audio/decode";
import { yinPitch, rms } from "../lib/pitch/yin";
import { framesToNotes, midiToName, type NoteEvent, type PitchFrame } from "../lib/notes/segment";
import { downloadMidi } from "../lib/midi/export";
import { downloadBlob, renderNotesToWavBlob, type SynthType } from "../lib/wav/render";

type Mode = "idle" | "recording" | "analyzed";

export default function Home() {
  const [mode, setMode] = useState<Mode>("idle");
  const [bpm, setBpm] = useState<number>(120);
  const [synth, setSynth] = useState<SynthType>("triangle");
  const [frames, setFrames] = useState<PitchFrame[]>([]);
  const [notes, setNotes] = useState<NoteEvent[]>([]);
  const [status, setStatus] = useState<string>("Ready");

  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<BlobPart[]>([]);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);

  const latest = frames.length ? frames[frames.length - 1] : null;
  const latestMidiName = useMemo(() => {
    if (!latest?.f0) return "--";
    const midi = Math.round(69 + 12 * Math.log2(latest.f0 / 440));
    return midiToName(midi);
  }, [latest]);

  async function startRecording() {
    setStatus("Requesting microphone…");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mr = new MediaRecorder(stream);
    mediaRecRef.current = mr;
    recChunksRef.current = [];

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) recChunksRef.current.push(e.data);
    };

    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunksRef.current, { type: mr.mimeType || "audio/webm" });
      setRecordedBlob(blob);
      setStatus(`Recorded ${(blob.size / 1024).toFixed(1)} KB`);
      setMode("idle");
    };

    mr.start();
    setMode("recording");
    setStatus("Recording… (hum or play a single melody line)");
  }

  function stopRecording() {
    mediaRecRef.current?.stop();
    setStatus("Stopping…");
  }

  async function handleUpload(file: File) {
    setRecordedBlob(null);
    setStatus(`Loaded: ${file.name}`);
    await analyzeBlob(file);
  }

  async function analyzeRecorded() {
    if (!recordedBlob) return;
    await analyzeBlob(recordedBlob);
  }

  async function analyzeBlob(blob: Blob) {
    setStatus("Decoding audio…");
    setFrames([]);
    setNotes([]);
    setMode("idle");

    const { samples, sampleRate, duration } = await decodeAudioToMono(blob, 44100);

    if (duration > 30) {
      setStatus(`Clip is ${duration.toFixed(1)}s. For best results, use <= 30s (monophonic).`);
    }

    setStatus("Analyzing pitch (tuner-style)…");

    const frameSize = 2048;
    const hop = 512;
    const fMin = 65;
    const fMax = 1200;

    const outFrames: PitchFrame[] = [];
    for (let i = 0; i + frameSize < samples.length; i += hop) {
      const frame = samples.subarray(i, i + frameSize);
      const t = i / sampleRate;
      const e = rms(frame);

      if (e < 0.008) {
        outFrames.push({ t, f0: null, conf: 0, rms: e });
        continue;
      }

      const { f0, confidence } = yinPitch(frame, sampleRate, fMin, fMax, 0.12);
      outFrames.push({ t, f0: f0 && isFinite(f0) ? f0 : null, conf: confidence, rms: e });
    }

    setFrames(outFrames);

    setStatus("Converting pitch frames → notes…");
    const outNotes = framesToNotes(outFrames, {
      minRms: 0.01,
      minConf: 0.2,
      minNoteDur: 0.1,
      mergeGap: 0.06,
      pitchTolerance: 0.5
    });

    setNotes(outNotes);
    setMode("analyzed");
    setStatus(`Done: ${outNotes.length} notes detected.`);
  }

  async function playConverted() {
    if (!notes.length) return;

    setStatus("Playing converted sample…");
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

    for (const n of notes) {
      const osc = audioCtx.createOscillator();
      osc.type = synth;

      const gain = audioCtx.createGain();
      const vel = (n.velocity / 127) * 0.6;

      gain.gain.setValueAtTime(0, audioCtx.currentTime + n.start);
      gain.gain.linearRampToValueAtTime(vel, audioCtx.currentTime + n.start + 0.01);
      gain.gain.setValueAtTime(vel, audioCtx.currentTime + Math.max(n.start + 0.01, n.end - 0.05));
      gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + n.end);

      osc.frequency.setValueAtTime(midiToHz(n.midi), audioCtx.currentTime + n.start);

      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + n.start);
      osc.stop(audioCtx.currentTime + n.end + 0.02);
    }

    const total = Math.max(...notes.map((n) => n.end)) + 0.3;
    setTimeout(() => {
      audioCtx.close();
      setStatus("Ready");
    }, total * 1000);
  }

  function exportMidi() {
    if (!notes.length) return;
    downloadMidi(notes, bpm, "conversion.mid");
  }

  async function exportWav() {
    if (!notes.length) return;
    setStatus("Rendering WAV (offline)…");
    const blob = await renderNotesToWavBlob({ notes, bpm, synth });
    downloadBlob(blob, "conversion.wav");
    setStatus("Ready");
  }

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 8 }}>Tuner → Instrument Converter (Browser-only Demo)</h1>
      <p style={{ marginTop: 0, color: "#444" }}>
        Record or upload a <b>single-voice / single-instrument</b> melody. We track pitch like a tuner, segment notes, play a chosen synth, and export MIDI/WAV.
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <button
          onClick={mode === "recording" ? stopRecording : startRecording}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
        >
          {mode === "recording" ? "Stop Recording" : "Record (Mic)"}
        </button>

        <label style={{ padding: "10px 14px", borderRadius: 10, border: "1px dashed #aaa", cursor: "pointer" }}>
          Upload Audio
          <input
            type="file"
            accept="audio/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
        </label>

        {recordedBlob && (
          <button
            onClick={analyzeRecorded}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
          >
            Analyze Recording
          </button>
        )}

        <span style={{ marginLeft: "auto", color: "#666" }}>{status}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section style={{ border: "1px solid #eee", borderRadius: 14, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Tuner View</h3>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ fontSize: 42, fontWeight: 700 }}>{latestMidiName}</div>
            <div style={{ color: "#666" }}>
              <div>f0: {latest?.f0 ? `${latest.f0.toFixed(1)} Hz` : "--"}</div>
              <div>conf: {latest ? latest.conf.toFixed(2) : "--"}</div>
              <div>rms: {latest ? latest.rms.toFixed(3) : "--"}</div>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <h4 style={{ margin: "0 0 8px" }}>Controls</h4>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label>
                BPM&nbsp;
                <input
                  type="number"
                  value={bpm}
                  min={40}
                  max={240}
                  onChange={(e) => setBpm(parseInt(e.target.value || "120", 10))}
                  style={{ width: 80 }}
                />
              </label>

              <label>
                Instrument (demo synth)&nbsp;
                <select value={synth} onChange={(e) => setSynth(e.target.value as SynthType)}>
                  <option value="triangle">Flute-ish (triangle)</option>
                  <option value="sine">Pure (sine)</option>
                  <option value="sawtooth">Synth lead (saw)</option>
                  <option value="square">Chiptune (square)</option>
                </select>
              </label>
            </div>
          </div>
        </section>

        <section style={{ border: "1px solid #eee", borderRadius: 14, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Converted Notes</h3>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <button
              onClick={playConverted}
              disabled={!notes.length}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              Play Converted
            </button>

            <button
              onClick={exportMidi}
              disabled={!notes.length}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              Export MIDI
            </button>

            <button
              onClick={exportWav}
              disabled={!notes.length}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              Export WAV
            </button>
          </div>

          <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #f2f2f2", borderRadius: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Note</th>
                  <th style={th}>Start</th>
                  <th style={th}>End</th>
                  <th style={th}>Vel</th>
                </tr>
              </thead>
              <tbody>
                {notes.slice(0, 200).map((n, i) => (
                  <tr key={i}>
                    <td style={td}>{i + 1}</td>
                    <td style={td}>{midiToName(n.midi)}</td>
                    <td style={td}>{n.start.toFixed(2)}s</td>
                    <td style={td}>{n.end.toFixed(2)}s</td>
                    <td style={td}>{n.velocity}</td>
                  </tr>
                ))}
                {!notes.length && (
                  <tr>
                    <td style={{ ...td, padding: 14 }} colSpan={5}>
                      No notes yet. Record or upload a monophonic melody, then analyze.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid #eee",
  position: "sticky",
  top: 0,
  background: "white"
};

const td: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #f3f3f3",
  fontSize: 14
};


import { useEffect, useMemo, useRef, useState } from "react";
import { decodeAudioToMono } from "../lib/audio/decode";
import { yinPitch, rms } from "../lib/pitch/yin";
import { framesToNotes, midiToName, type NoteEvent, type PitchFrame } from "../lib/notes/segment";
import { downloadMidi } from "../lib/midi/export";
import { downloadBlob, renderNotesToWavBlob, type SynthType } from "../lib/wav/render";

type Mode = "idle" | "recording" | "analyzed";

const MAX_RECORD_SECONDS = 10;

export default function Home() {
  const [mode, setMode] = useState<Mode>("idle");
  const [bpm, setBpm] = useState<number>(120);
  const [synth, setSynth] = useState<SynthType>("triangle");
  const [frames, setFrames] = useState<PitchFrame[]>([]);
  const [notes, setNotes] = useState<NoteEvent[]>([]);
  const [status, setStatus] = useState<string>("Ready");

  // Recording
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recChunksRef = useRef<BlobPart[]>([]);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);

  // Timer
  const [elapsed, setElapsed] = useState<number>(0);
  const timerRef = useRef<number | null>(null);

  // Playback state
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playingNodesRef = useRef<{ osc: OscillatorNode; gain: GainNode }[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const playStartWallRef = useRef<number>(0);     // wall-clock when play started
  const playOffsetRef = useRef<number>(0);        // seconds into the piece (for pause/resume)
  const pieceDuration = useMemo(() => (notes.length ? Math.max(...notes.map(n => n.end)) : 0), [notes]);

  // Tuner display
  const latest = frames.length ? frames[frames.length - 1] : null;
  const latestMidiName = useMemo(() => {
    if (!latest?.f0) return "--";
    const midi = Math.round(69 + 12 * Math.log2(latest.f0 / 440));
    return midiToName(midi);
  }, [latest]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPlayback(true);
      stopRecording(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If user changes instrument while playing: stop (no overlap), do NOT auto-restart
  useEffect(() => {
    if (isPlaying) {
      stopPlayback(false);
      setStatus("Instrument changed. Press Play to listen with the new instrument.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synth]);

  async function startRecording() {
    try {
      // Reset old state
      clearRecording();

      setStatus("Requesting microphone…");

      // Better mic constraints (helps pitch)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      streamRef.current = stream;

      const mr = new MediaRecorder(stream);
      mediaRecRef.current = mr;
      recChunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recChunksRef.current.push(e.data);
      };

      mr.onerror = () => {
        setStatus("Recorder error. Try again.");
        stopRecording(true);
      };

      mr.onstop = () => {
        // Stop mic tracks
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        // Stop timer
        if (timerRef.current) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }

        const blob = new Blob(recChunksRef.current, { type: mr.mimeType || "audio/webm" });

        // If blob is tiny, it likely didn’t record
        if (blob.size < 1500) {
          setStatus("Recording was empty. Please allow mic permission and try again.");
          setMode("idle");
          return;
        }

        setRecordedBlob(blob);
        setStatus(`Recorded ${(blob.size / 1024).toFixed(1)} KB. Click “Analyze Recording”.`);
        setMode("idle");
      };

      // Start recorder with timeslice for reliability (important!)
      mr.start(250);

      setElapsed(0);
      setMode("recording");
      setStatus("Recording… (max 10s)");

      // Start visible timer + auto-stop at MAX_RECORD_SECONDS
      timerRef.current = window.setInterval(() => {
        setElapsed((prev) => {
          const next = prev + 0.1;
          if (next >= MAX_RECORD_SECONDS) {
            stopRecording(false);
            return MAX_RECORD_SECONDS;
          }
          return next;
        });
      }, 100);

    } catch (e) {
      setStatus("Mic permission denied or unavailable. Please allow microphone access and retry.");
      setMode("idle");
    }
  }

  function stopRecording(force: boolean) {
    const mr = mediaRecRef.current;
    if (mr && mr.state !== "inactive") {
      try { mr.stop(); } catch {}
    }
    mediaRecRef.current = null;

    // Stop timer
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // Stop stream if force stop
    if (force && streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setMode("idle");
  }

  function clearRecording() {
    // Stop any playing audio too
    stopPlayback(true);

    setRecordedBlob(null);
    setFrames([]);
    setNotes([]);
    setElapsed(0);
    playOffsetRef.current = 0;
    setStatus("Ready");
  }

  async function handleUpload(file: File) {
    clearRecording();
    setStatus(`Loaded: ${file.name}`);
    await analyzeBlob(file);
  }

  async function analyzeRecorded() {
    if (!recordedBlob) return;
    await analyzeBlob(recordedBlob);
  }

  async function analyzeBlob(blob: Blob) {
    stopPlayback(true);
    setStatus("Decoding audio…");
    setFrames([]);
    setNotes([]);

    const { samples, sampleRate, duration } = await decodeAudioToMono(blob, 44100);

    // For mic recordings, short is better
    if (duration > 30) {
      setStatus(`Clip is ${duration.toFixed(1)}s. For best results, use <= 30s (monophonic).`);
    } else {
      setStatus("Analyzing pitch (tuner-style)…");
    }

    const frameSize = 2048;
    const hop = 512;
    const fMin = 65;
    const fMax = 1200;

    const outFrames: PitchFrame[] = [];

    // A slightly higher silence gate helps mic noise
    const silenceGate = 0.010;

    for (let i = 0; i + frameSize < samples.length; i += hop) {
      const frame = samples.subarray(i, i + frameSize);
      const t = i / sampleRate;
      const e = rms(frame);

      if (e < silenceGate) {
        outFrames.push({ t, f0: null, conf: 0, rms: e });
        continue;
      }

      const { f0, confidence } = yinPitch(frame, sampleRate, fMin, fMax, 0.12);
      outFrames.push({ t, f0: f0 && isFinite(f0) ? f0 : null, conf: confidence, rms: e });
    }

    setFrames(outFrames);

    setStatus("Converting pitch frames → notes…");
    const outNotes = framesToNotes(outFrames, {
      minRms: 0.012,
      minConf: 0.22,
      minNoteDur: 0.10,
      mergeGap: 0.06,
      pitchTolerance: 0.5
    });

    setNotes(outNotes);
    setMode("analyzed");
    playOffsetRef.current = 0;

    if (!outNotes.length) {
      setStatus("No stable notes detected. Try humming louder/steadier and closer to the mic.");
    } else {
      setStatus(`Done: ${outNotes.length} notes detected.`);
    }
  }

  // ---------------- Playback (Play / Pause) ----------------

  function ensureAudioCtx(): AudioContext {
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") return audioCtxRef.current;
    audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return audioCtxRef.current;
  }

  function stopPlayback(resetOffset: boolean) {
    // Stop scheduled nodes
    for (const node of playingNodesRef.current) {
      try { node.osc.stop(); } catch {}
      try { node.osc.disconnect(); } catch {}
      try { node.gain.disconnect(); } catch {}
    }
    playingNodesRef.current = [];
    setIsPlaying(false);

    // Preserve pause offset unless reset
    if (resetOffset) playOffsetRef.current = 0;
  }

  function play() {
    if (!notes.length) return;

    // If already playing, ignore
    if (isPlaying) return;

    const ctx = ensureAudioCtx();
    const offset = Math.max(0, Math.min(playOffsetRef.current, pieceDuration));

    // schedule from offset
    const now = ctx.currentTime + 0.03;
    playStartWallRef.current = performance.now();

    const nodes: { osc: OscillatorNode; gain: GainNode }[] = [];

    for (const n of notes) {
      // Skip notes before offset
      if (n.end <= offset) continue;

      const start = Math.max(0, n.start - offset);
      const end = Math.max(0, n.end - offset);

      const osc = ctx.createOscillator();
      osc.type = synth;

      const gain = ctx.createGain();
      const vel = (n.velocity / 127) * 0.6;

      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(vel, now + start + 0.01);
      gain.gain.setValueAtTime(vel, now + Math.max(start + 0.01, end - 0.05));
      gain.gain.linearRampToValueAtTime(0, now + end);

      osc.frequency.setValueAtTime(midiToHz(n.midi), now + start);

      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + end + 0.02);

      nodes.push({ osc, gain });
    }

    playingNodesRef.current = nodes;
    setIsPlaying(true);
    setStatus("Playing…");

    // Auto-finish: stop and reset when done
    const remaining = Math.max(0, pieceDuration - offset) + 0.25;
    window.setTimeout(() => {
      // If user already paused/stopped, ignore
      if (!isPlaying) return;
      stopPlayback(true);
      setStatus("Ready");
    }, remaining * 1000);
  }

  function pause() {
    if (!isPlaying) return;

    // Update offset based on time since play started
    const elapsedWall = (performance.now() - playStartWallRef.current) / 1000;
    playOffsetRef.current = Math.min(pieceDuration, playOffsetRef.current + elapsedWall);

    stopPlayback(false);
    setStatus("Paused");
  }

  function stop() {
    playOffsetRef.current = 0;
    stopPlayback(true);
    setStatus("Ready");
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
          onClick={mode === "recording" ? () => stopRecording(false) : startRecording}
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
              e.currentTarget.value = ""; // allow re-upload same file
            }}
          />
        </label>

        <button
          onClick={clearRecording}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
        >
          Refresh / Re-record
        </button>

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

      {mode === "recording" && (
        <div style={{ marginBottom: 12, color: "#333" }}>
          Recording: <b>{elapsed.toFixed(1)}s</b> / {MAX_RECORD_SECONDS}s
        </div>
      )}

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
                <select
                  value={synth}
                  onChange={(e) => setSynth(e.target.value as SynthType)}
                >
                  <option value="triangle">Flute-ish (triangle)</option>
                  <option value="sine">Pure (sine)</option>
                  <option value="sawtooth">Synth lead (saw)</option>
                  <option value="square">Chiptune (square)</option>
                </select>
              </label>
            </div>
          </div>

          <small style={{ display: "block", marginTop: 12, color: "#777" }}>
            Tip: hum clearly, steady tone, minimal background noise. Keep clips ≤ 10s for mic demos.
          </small>
        </section>

        <section style={{ border: "1px solid #eee", borderRadius: 14, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Playback & Export</h3>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <button
              onClick={isPlaying ? pause : play}
              disabled={!notes.length}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              {isPlaying ? "Pause" : "Play"}
            </button>

            <button
              onClick={stop}
              disabled={!notes.length}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              Stop
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
                      No notes yet. Record/upload a monophonic melody, then analyze.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <small style={{ display: "block", marginTop: 10, color: "#777" }}>
            Instrument changes won’t auto-play anymore. Press Play to hear the selected instrument.
          </small>
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
  background: "white",
};

const td: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #f3f3f3",
  fontSize: 14,
};

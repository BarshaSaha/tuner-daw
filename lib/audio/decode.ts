export async function decodeAudioToMono(
  fileOrBlob: Blob,
  targetSampleRate = 44100
): Promise<{ samples: Float32Array; sampleRate: number; duration: number }> {
  const arrayBuf = await fileOrBlob.arrayBuffer();

  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
  const sr = decoded.sampleRate;

  const ch0 = decoded.getChannelData(0);
  const mono = new Float32Array(decoded.length);

  if (decoded.numberOfChannels === 1) {
    mono.set(ch0);
  } else {
    const ch1 = decoded.getChannelData(1);
    for (let i = 0; i < decoded.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
  }

  audioCtx.close();

  if (sr === targetSampleRate) {
    return { samples: mono, sampleRate: sr, duration: decoded.duration };
  }

  const resampled = await resampleMono(mono, sr, targetSampleRate);
  const duration = resampled.length / targetSampleRate;
  return { samples: resampled, sampleRate: targetSampleRate, duration };
}

async function resampleMono(
  input: Float32Array,
  inRate: number,
  outRate: number
): Promise<Float32Array> {
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const t = i / ratio;
    const i0 = Math.floor(t);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = t - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}


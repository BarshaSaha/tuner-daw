export type YinResult = { f0: number | null; confidence: number };

export function yinPitch(
  frame: Float32Array,
  sampleRate: number,
  fMin = 65,
  fMax = 1200,
  threshold = 0.12
): YinResult {
  const N = frame.length;
  const maxTau = Math.floor(sampleRate / fMin);
  const minTau = Math.floor(sampleRate / fMax);

  if (maxTau >= N) return { f0: null, confidence: 0 };

  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < N - tau; i++) {
      const diff = frame[i] - frame[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  const cmndf = new Float32Array(maxTau + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    runningSum += d[tau];
    cmndf[tau] = d[tau] * (tau / (runningSum || 1e-9));
  }

  let tauEstimate: number | null = null;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= maxTau && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === null) return { f0: null, confidence: 0 };

  const tau = tauEstimate;
  const x0 = Math.max(1, tau - 1);
  const x2 = Math.min(maxTau, tau + 1);
  const s0 = cmndf[x0], s1 = cmndf[tau], s2 = cmndf[x2];
  const denom = (2 * s1 - s2 - s0);
  const betterTau = denom !== 0 ? (tau + (s2 - s0) / (2 * denom)) : tau;

  const f0 = sampleRate / betterTau;
  const confidence = Math.max(0, Math.min(1, 1 - cmndf[tau]));
  return { f0, confidence };
}

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}


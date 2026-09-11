import { createRealFftPlan } from "./fft.js";

const ENERGY_WORKSPACES = new Map();

function energyWorkspace(length) {
  if (!ENERGY_WORKSPACES.has(length)) {
    const plan = createRealFftPlan(length);
    ENERGY_WORKSPACES.set(length, {
      plan,
      input: new Float64Array(length),
      magnitudes: new Float64Array(plan.binCount),
    });
  }
  return ENERGY_WORKSPACES.get(length);
}

export function hammingWindow(length) {
  const coefficients = new Float64Array(length);
  if (length === 1) {
    coefficients[0] = 1;
    return coefficients;
  }
  const denominator = length - 1;
  for (let index = 0; index < length; index += 1) {
    coefficients[index] = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / denominator);
  }
  return coefficients;
}

export function hanningWindow(length) {
  const coefficients = new Float64Array(length);
  if (length === 1) {
    coefficients[0] = 1;
    return coefficients;
  }
  const denominator = length - 1;
  for (let index = 0; index < length; index += 1) {
    coefficients[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / denominator);
  }
  return coefficients;
}

export function preprocEnergyComponents(window, sampleRateHz, bandHz = [1300, 1600]) {
  if (!window || window.length !== sampleRateHz) {
    throw new RangeError("能量分析需要一个完整的 1 秒采样窗口");
  }
  const { plan, input, magnitudes } = energyWorkspace(window.length);
  let hasFiniteSignal = false;
  for (let index = 0; index < window.length; index += 1) {
    const value = Number.isFinite(window[index]) ? window[index] : 0;
    input[index] = value;
    hasFiniteSignal ||= value !== 0;
  }
  if (!hasFiniteSignal) return { bandMagnitudeSum: 0, maximumMagnitude: 0 };

  plan.magnitudes(input, magnitudes);
  let maximumMagnitude = 0;
  let bandMagnitudeSum = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const magnitude = Number.isFinite(magnitudes[bin]) ? magnitudes[bin] : 0;
    if (magnitude > maximumMagnitude) maximumMagnitude = magnitude;
    const frequency = (bin * sampleRateHz) / window.length;
    if (frequency >= bandHz[0] && frequency <= bandHz[1]) bandMagnitudeSum += magnitude;
  }
  return {
    bandMagnitudeSum: Number.isFinite(bandMagnitudeSum) ? bandMagnitudeSum : 0,
    maximumMagnitude,
  };
}

export function preprocEnergy(window, sampleRateHz, bandHz = [1300, 1600]) {
  const { bandMagnitudeSum, maximumMagnitude } = preprocEnergyComponents(window, sampleRateHz, bandHz);
  if (!(maximumMagnitude > 0)) return 0;
  return bandMagnitudeSum / maximumMagnitude;
}

export function stft(samples, sampleRateHz, options = {}) {
  const {
    windowSeconds = 0.075,
    overlapPercent = 0,
    zeroPadding = 480,
    frequencyBandHz = [1000, 2000],
    window = "hamming",
  } = options;
  const windowLength = Math.round(windowSeconds * sampleRateHz);
  const stepLength = Math.max(1, Math.round(windowLength * (1 - overlapPercent / 100)));
  const fftLength = windowLength + zeroPadding;
  if (windowLength < 2 || fftLength < 2 || samples.length < windowLength) {
    return { matrix: [], frequencyAxisHz: [], timeStartsSeconds: [], timeEndsSeconds: [] };
  }
  if (window !== "hamming" && window !== "rectangle") {
    throw new RangeError(`不支持的 STFT 窗函数: ${window}`);
  }

  const coefficients = window === "hamming" ? hammingWindow(windowLength) : null;
  const input = new Float64Array(fftLength);
  const plan = createRealFftPlan(fftLength);
  const rowCount = Math.floor(fftLength / 2);
  const selectedRows = [];
  const frequencyAxisHz = [];
  for (let row = 0; row < rowCount; row += 1) {
    const frequency = ((row + 1) * sampleRateHz) / fftLength;
    if (frequency >= frequencyBandHz[0] && frequency <= frequencyBandHz[1]) {
      selectedRows.push(row);
      frequencyAxisHz.push(frequency);
    }
  }

  const matrix = [];
  const timeStartsSeconds = [];
  const timeEndsSeconds = [];
  for (let start = 0; start + windowLength <= samples.length; start += stepLength) {
    input.fill(0);
    for (let index = 0; index < windowLength; index += 1) {
      const value = Number.isFinite(samples[start + index]) ? samples[start + index] : 0;
      input[index] = value * (coefficients ? coefficients[index] : 1);
    }
    const spectrum = plan.transform(input);
    const frame = new Float64Array(selectedRows.length);
    for (let index = 0; index < selectedRows.length; index += 1) {
      const row = selectedRows[index];
      frame[index] = (2 * Math.hypot(spectrum.real[row], spectrum.imag[row])) / fftLength;
    }
    matrix.push(frame);
    const time = start / sampleRateHz;
    timeStartsSeconds.push(time);
    timeEndsSeconds.push(time + windowSeconds);
  }

  return { matrix, frequencyAxisHz, timeStartsSeconds, timeEndsSeconds };
}

function ituWeightDb(frequency) {
  const f2 = frequency * frequency;
  const f3 = f2 * frequency;
  const f4 = f2 * f2;
  const f5 = f4 * frequency;
  const f6 = f3 * f3;
  const h1 = -4.73733898137838e-24 * f6 + 2.04382833606125e-15 * f4 - 1.36389479546364e-7 * f2 + 1;
  const h2 = 1.30661225741282e-19 * f5 - 2.11815088751866e-11 * f3 + 5.55948802349864e-4 * frequency;
  const response = (1.24633263753214e-4 * frequency) / Math.sqrt(h1 * h1 + h2 * h2);
  return 18.2 + 20 * Math.log10(response);
}

export function dbItuDynamicRange(matrix, frequencyAxisHz, dynamicRangeDb = 60) {
  if (matrix.length === 0) return { matrix: [], minDb: 0, maxDb: 0 };
  const weighted = matrix.map((frame) => new Float64Array(frame.length));
  let maximum = -Infinity;

  for (let frameIndex = 0; frameIndex < matrix.length; frameIndex += 1) {
    const frame = matrix[frameIndex];
    for (let bin = 0; bin < frame.length; bin += 1) {
      const magnitudeDb = frame[bin] > 0 ? 20 * Math.log10(frame[bin]) : -Infinity;
      const value = magnitudeDb + ituWeightDb(frequencyAxisHz[bin]);
      weighted[frameIndex][bin] = value;
      if (Number.isFinite(value) && value > maximum) maximum = value;
    }
  }

  if (!Number.isFinite(maximum)) {
    return { matrix: weighted.map((frame) => new Float64Array(frame.length)), minDb: 0, maxDb: 0 };
  }
  const floor = maximum - dynamicRangeDb;
  let minimum = Infinity;
  for (const frame of weighted) {
    for (let bin = 0; bin < frame.length; bin += 1) {
      if (!Number.isFinite(frame[bin]) || frame[bin] < floor) frame[bin] = floor;
      if (frame[bin] < minimum) minimum = frame[bin];
    }
  }
  for (const frame of weighted) {
    for (let bin = 0; bin < frame.length; bin += 1) frame[bin] -= minimum;
  }
  return { matrix: weighted, minDb: 0, maxDb: maximum - minimum };
}

export function ribbit(envelope, options = {}) {
  const {
    windowLength = 180,
    overlapPercent = 50,
    callRateBandHz = [0.05, 0.1],
  } = options;
  if (!envelope || envelope.length < windowLength) return 0;
  const step = Math.max(1, Math.round(windowLength * (1 - overlapPercent / 100)));
  const window = hanningWindow(windowLength);
  const input = new Float64Array(windowLength);
  const plan = createRealFftPlan(windowLength);
  const mean = new Float64Array(plan.binCount);
  let frameCount = 0;

  for (let start = 0; start + windowLength <= envelope.length; start += step) {
    for (let index = 0; index < windowLength; index += 1) {
      const value = Number.isFinite(envelope[start + index]) ? envelope[start + index] : 0;
      input[index] = value * window[index];
    }
    const magnitudes = plan.magnitudes(input);
    for (let bin = 0; bin < mean.length; bin += 1) mean[bin] += magnitudes[bin];
    frameCount += 1;
  }
  if (frameCount === 0) return 0;

  let globalMaximum = 0;
  for (let bin = 0; bin < mean.length; bin += 1) {
    mean[bin] /= frameCount;
    if (mean[bin] > globalMaximum) globalMaximum = mean[bin];
  }
  if (!(globalMaximum > 0)) return 0;

  let peak = 0;
  for (let bin = 0; bin < mean.length; bin += 1) {
    const frequency = bin / windowLength;
    if (frequency >= callRateBandHz[0] && frequency <= callRateBandHz[1]) {
      peak = Math.max(peak, mean[bin] / globalMaximum);
    }
  }
  return Number.isFinite(peak) ? peak : 0;
}

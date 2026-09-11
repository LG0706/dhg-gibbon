import { preprocEnergyComponents, stft, dbItuDynamicRange } from "./dsp.js";
import { fitEnergyHmm } from "./hmm.js";
import { postProcessStates } from "./post-process.js";

export const DEFAULT_PARAMETERS = Object.freeze({
  windowSeconds: 1,
  energyBandHz: Object.freeze([1300, 1600]),
  minimumBoutSeconds: 180,
  ribbitBandHz: Object.freeze([0.05, 0.1]),
  candidateScoreThreshold: 0.1,
  previewSeconds: 10,
  spectrogramBandHz: Object.freeze([1000, 2000]),
  spectrogramWindowSeconds: 0.075,
  spectrogramZeroPadding: 480,
  displayDynamicRangeDb: 60,
});

function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function copyParameters(parameters) {
  return {
    ...DEFAULT_PARAMETERS,
    ...parameters,
    energyBandHz: [...(parameters?.energyBandHz ?? DEFAULT_PARAMETERS.energyBandHz)],
    ribbitBandHz: [...(parameters?.ribbitBandHz ?? DEFAULT_PARAMETERS.ribbitBandHz)],
    spectrogramBandHz: [...(parameters?.spectrogramBandHz ?? DEFAULT_PARAMETERS.spectrogramBandHz)],
  };
}

function safeId(value) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "recording";
}

function normalizeTrace(values) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return Array(values.length).fill(0);
  if (!(maximum > minimum)) return Array(values.length).fill(0.5);
  return values.map((value) => Number.isFinite(value) ? (value - minimum) / (maximum - minimum) : 0);
}

export function createAnalyzer(metadata, parameters = DEFAULT_PARAMETERS) {
  if (!metadata?.recording) throw new TypeError("metadata.recording 是必填项");
  const config = copyParameters(parameters);
  const info = { recording: metadata.recording, device: metadata.device ?? "" };
  const energies = [];
  const energyBandSums = [];
  const warnings = [];
  const metrics = {
    decodeMs: 0,
    featureMs: 0,
    hmmMs: 0,
    scoreMs: 0,
    spectrogramMs: 0,
    totalMs: 0,
    audioSeconds: 0,
    realtimeFactor: 0,
  };
  let globalSpectrumMaximum = 0;
  let sampleRateHz = null;
  let windowBuffer = null;
  let windowOffset = 0;
  let totalFrames = 0;
  let phase = "features";
  let partialResult = null;
  let previewBuffers = new Map();

  function setSampleRate(rate) {
    if (!Number.isInteger(rate) || rate < 4000) throw new RangeError("采样率必须是不低于 4000 Hz 的整数");
    if (sampleRateHz !== null && sampleRateHz !== rate) throw new RangeError("同一录音的采样率不能改变");
    if (sampleRateHz === null) {
      sampleRateHz = rate;
      windowBuffer = new Float32Array(Math.round(config.windowSeconds * sampleRateHz));
    }
  }

  function pushSamples(samples, rate) {
    if (phase !== "features") throw new Error("当前分析阶段不接受特征采样");
    setSampleRate(rate);
    let sourceOffset = 0;
    totalFrames += samples.length;
    while (sourceOffset < samples.length) {
      const count = Math.min(windowBuffer.length - windowOffset, samples.length - sourceOffset);
      windowBuffer.set(samples.subarray(sourceOffset, sourceOffset + count), windowOffset);
      windowOffset += count;
      sourceOffset += count;
      if (windowOffset === windowBuffer.length) {
        const started = clock();
        const feature = preprocEnergyComponents(windowBuffer, sampleRateHz, config.energyBandHz);
        energyBandSums.push(feature.bandMagnitudeSum);
        globalSpectrumMaximum = Math.max(globalSpectrumMaximum, feature.maximumMagnitude);
        metrics.featureMs += clock() - started;
        windowOffset = 0;
      }
    }
  }

  function completeFirstPass() {
    if (phase !== "features") throw new Error("特征分析已经结束");
    if (sampleRateHz === null) throw new Error("录音没有可解码的采样");
    phase = "detections";
    metrics.audioSeconds = totalFrames / sampleRateHz;
    const energyScale = globalSpectrumMaximum > 0 ? globalSpectrumMaximum : 1;
    for (const bandMagnitudeSum of energyBandSums) energies.push(bandMagnitudeSum / energyScale);

    const hmmStarted = clock();
    const hmm = fitEnergyHmm(energies);
    metrics.hmmMs = clock() - hmmStarted;
    if (!hmm.converged) warnings.push(`HMM 未收敛，全部标记为 N (${hmm.reason})`);

    const states = hmm.classes.map((className, index) => {
      const time = (index + 1) * config.windowSeconds;
      return {
        t: time,
        env: hmm.normalized[index],
        start: time - config.windowSeconds / 2,
        end: time + config.windowSeconds / 2,
        class: className,
        threshold: "hmm",
      };
    });

    const scoreStarted = clock();
    const processed = postProcessStates(states, metrics.audioSeconds, config);
    metrics.scoreMs = clock() - scoreStarted;
    const recordingStem = safeId(info.recording.replace(/\.wav$/i, ""));
    const detections = processed.bouts.map((bout) => {
      const candidateId = `${recordingStem}-${bout.selec}-${Math.round(bout.start * 1000)}-${Math.round(bout.end * 1000)}`;
      return {
        label: "P",
        selec: bout.selec,
        start: bout.start,
        end: bout.end,
        dir: info.device,
        recording: info.recording,
        group: info.device,
        threshold: "hmm",
        ribbit: bout.ribbit,
        candidate_id: candidateId,
        is_candidate: bout.is_candidate,
      };
    });

    const candidates = detections.filter((detection) => detection.is_candidate).map((detection) => {
      const midpoint = detection.start + (detection.end - detection.start) / 2;
      const start = Math.max(0, midpoint - config.previewSeconds / 2);
      const end = Math.min(metrics.audioSeconds, start + config.previewSeconds);
      return {
        candidate_id: detection.candidate_id,
        recording: info.recording,
        device: info.device,
        boutStart: detection.start,
        boutEnd: detection.end,
        ribbit: detection.ribbit,
        previewStart: Math.max(0, end - config.previewSeconds),
        previewEnd: end,
        spectrogram: null,
      };
    });

    let peakEnergyIndex = 0;
    for (let index = 1; index < energies.length; index += 1) {
      if (energies[index] > energies[peakEnergyIndex]) peakEnergyIndex = index;
    }
    const overviewMidpoint = Math.min(
      metrics.audioSeconds,
      (peakEnergyIndex + 0.5) * config.windowSeconds,
    );
    const overviewEnd = Math.min(
      metrics.audioSeconds,
      Math.max(config.previewSeconds, overviewMidpoint + config.previewSeconds / 2),
    );
    const overviewStart = Math.max(0, overviewEnd - config.previewSeconds);

    partialResult = {
      metadata: info,
      parameters: config,
      detections,
      candidates,
      overview: {
        energy: normalizeTrace(energies),
        rawEnergy: energies.slice(),
        classes: hmm.classes,
        states,
        intervals: processed.intervals,
        preview: {
          preview_id: "__overview__",
          previewStart: overviewStart,
          previewEnd: overviewEnd,
          spectrogram: null,
        },
      },
      warnings,
      metrics,
      sampleRateHz,
    };
    return partialResult;
  }

  function beginPreviewPass() {
    if (phase !== "detections") throw new Error("必须先完成检测阶段");
    phase = "previews";
    const previews = [partialResult.overview.preview, ...partialResult.candidates];
    previewBuffers = new Map(previews.map((preview) => {
      const startFrame = Math.round(preview.previewStart * sampleRateHz);
      const endFrame = Math.round(preview.previewEnd * sampleRateHz);
      const previewId = preview.preview_id ?? preview.candidate_id;
      return [previewId, {
        startFrame,
        endFrame,
        samples: new Float32Array(Math.max(0, endFrame - startFrame)),
      }];
    }));
  }

  function pushPreviewSamples(samples, sourceStartFrame) {
    if (phase !== "previews") throw new Error("当前分析阶段不接受预览采样");
    const sourceEndFrame = sourceStartFrame + samples.length;
    for (const preview of previewBuffers.values()) {
      const overlapStart = Math.max(sourceStartFrame, preview.startFrame);
      const overlapEnd = Math.min(sourceEndFrame, preview.endFrame);
      if (overlapEnd <= overlapStart) continue;
      const sourceOffset = overlapStart - sourceStartFrame;
      const destinationOffset = overlapStart - preview.startFrame;
      preview.samples.set(samples.subarray(sourceOffset, sourceOffset + overlapEnd - overlapStart), destinationOffset);
    }
  }

  function completePreviewPass() {
    if (phase !== "previews") throw new Error("预览分析尚未开始");
    const started = clock();
    const createSpectrogram = (preview) => {
      const spectrum = stft(preview.samples, sampleRateHz, {
        windowSeconds: config.spectrogramWindowSeconds,
        overlapPercent: 0,
        zeroPadding: config.spectrogramZeroPadding,
        frequencyBandHz: config.spectrogramBandHz,
        window: "hamming",
      });
      const display = dbItuDynamicRange(spectrum.matrix, spectrum.frequencyAxisHz, config.displayDynamicRangeDb);
      return {
        matrix: display.matrix,
        frequencyAxisHz: spectrum.frequencyAxisHz,
        timeStartsSeconds: spectrum.timeStartsSeconds,
        timeEndsSeconds: spectrum.timeEndsSeconds,
        minDb: display.minDb,
        maxDb: display.maxDb,
      };
    };
    for (const candidate of partialResult.candidates) {
      candidate.spectrogram = createSpectrogram(previewBuffers.get(candidate.candidate_id));
    }
    partialResult.overview.preview.spectrogram = createSpectrogram(previewBuffers.get("__overview__"));
    metrics.spectrogramMs = clock() - started;
    previewBuffers.clear();
    phase = "complete";
    return partialResult;
  }

  function setExternalMetrics(values) {
    Object.assign(metrics, values);
    metrics.realtimeFactor = metrics.audioSeconds > 0 ? metrics.totalMs / (metrics.audioSeconds * 1000) : 0;
  }

  return {
    pushSamples,
    completeFirstPass,
    beginPreviewPass,
    pushPreviewSamples,
    completePreviewPass,
    setExternalMetrics,
    get phase() { return phase; },
    get metrics() { return metrics; },
  };
}

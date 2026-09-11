import { describe, expect, it } from "vitest";
import { createRealFftPlan } from "../src/analysis/fft.js";
import { dbItuDynamicRange, hammingWindow, preprocEnergy, ribbit, stft } from "../src/analysis/dsp.js";
import { fitEnergyHmm } from "../src/analysis/hmm.js";
import { postProcessStates } from "../src/analysis/post-process.js";
import { AnalysisError, WavStreamDecoder } from "../src/analysis/wav.js";
import { CHUNK_BYTES } from "../src/analysis-client.js";
import { createPcm16Wav } from "./fixtures/synthetic.js";

function naiveDft(input, bin) {
  let real = 0;
  let imag = 0;
  for (let index = 0; index < input.length; index += 1) {
    const angle = (-2 * Math.PI * bin * index) / input.length;
    real += input[index] * Math.cos(angle);
    imag += input[index] * Math.sin(angle);
  }
  return { real, imag };
}

describe("exact-length FFT", () => {
  for (const length of [8, 7]) {
    it(`matches a direct DFT for length ${length}`, () => {
      const input = Float64Array.from({ length }, (_, index) => Math.sin(index * 0.71) + index / 10);
      const plan = createRealFftPlan(length);
      const spectrum = plan.transform(input);
      for (let bin = 0; bin < plan.binCount; bin += 1) {
        const expected = naiveDft(input, bin);
        expect(spectrum.real[bin]).toBeCloseTo(expected.real, 9);
        expect(spectrum.imag[bin]).toBeCloseTo(expected.imag, 9);
      }
      expect(plan.algorithm).toBe(length === 8 ? "radix-4" : "bluestein");
      expect(createRealFftPlan(length)).toBe(plan);
    });
  }
});

describe("detector DSP", () => {
  it("uses the R Hamming coefficients", () => {
    expect(Array.from(hammingWindow(5))).toEqual(expect.arrayContaining([
      expect.closeTo(0.08, 12),
      expect.closeTo(0.54, 12),
      expect.closeTo(1, 12),
      expect.closeTo(0.54, 12),
      expect.closeTo(0.08, 12),
    ]));
  });

  it("extracts a one-second rectangle-window band tone", () => {
    const sampleRate = 4000;
    const samples = Float64Array.from({ length: sampleRate }, (_, index) => Math.sin(2 * Math.PI * 1450 * index / sampleRate));
    expect(preprocEnergy(samples, sampleRate)).toBeCloseTo(1, 9);
    expect(preprocEnergy(new Float64Array(sampleRate), sampleRate)).toBe(0);
  });

  it("builds the R-shaped Hamming STFT axes", () => {
    const sampleRate = 4000;
    const samples = Float64Array.from({ length: 600 }, (_, index) => Math.sin(2 * Math.PI * 1400 * index / sampleRate));
    const spectrum = stft(samples, sampleRate, { windowSeconds: 0.075, zeroPadding: 0 });
    expect(spectrum.matrix).toHaveLength(2);
    expect(spectrum.timeStartsSeconds).toEqual([0, 0.075]);
    expect(spectrum.frequencyAxisHz[0]).toBeGreaterThanOrEqual(1000);
    expect(spectrum.frequencyAxisHz.at(-1)).toBeLessThanOrEqual(2000);
  });

  it("maps ITU-weighted magnitudes into a clipped 60 dB display", () => {
    const output = dbItuDynamicRange([
      Float64Array.from([1, 0.001]),
      Float64Array.from([0, 0.5]),
    ], [1000, 2000], 60);
    expect(output.minDb).toBe(0);
    expect(output.maxDb).toBeCloseTo(60, 8);
    expect(Math.min(...output.matrix.flatMap((frame) => Array.from(frame)))).toBe(0);
  });

  it("finds a pulse-rate peak without calling it a probability", () => {
    const envelope = Float64Array.from({ length: 360 }, (_, index) => 1 + Math.sin(2 * Math.PI * 0.075 * index));
    expect(ribbit(envelope)).toBeGreaterThan(0.4);
  });
});

describe("HMM and post-processing", () => {
  it("converges on two states and falls back on a flat sequence", () => {
    const result = fitEnergyHmm([...Array(80).fill(0.1), ...Array(240).fill(0.9), ...Array(80).fill(0.1)]);
    expect(result.converged).toBe(true);
    expect(result.classes.filter((value) => value === "P")).toHaveLength(240);
    expect(fitEnergyHmm([2, 2, 2]).classes).toEqual(["N", "N", "N"]);
  });

  it("extends, merges, shrinks, clips, and retains a long P bout", () => {
    const states = Array.from({ length: 400 }, (_, index) => ({
      class: index < 100 || (index >= 150 && index < 260) ? "P" : "N",
      start: index + 0.5,
      end: index + 1.5,
      env: 1 + Math.sin(2 * Math.PI * 0.075 * index),
    }));
    const output = postProcessStates(states, 400);
    expect(output.bouts).toHaveLength(1);
    expect(output.bouts[0].start).toBe(0.5);
    expect(output.bouts[0].end).toBe(260.5);
    expect(output.bouts[0].is_candidate).toBe(true);
  });
});

describe("incremental WAV decoding", () => {
  it("rejects malformed data with an AnalysisError", () => {
    const decoder = new WavStreamDecoder();
    expect(() => decoder.pushBytes(new Uint8Array(12))).toThrowError(AnalysisError);
  });

  it("decodes a one-second window split at the 4 MiB boundary", () => {
    const samples = Float32Array.from({ length: 4000 }, (_, index) => Math.sin(2 * Math.PI * 500 * index / 4000));
    const wav = createPcm16Wav(samples, 4000, { junkBytes: CHUNK_BYTES - 60, channels: 2 });
    const decoder = new WavStreamDecoder();
    const first = decoder.pushBytes(wav.subarray(0, CHUNK_BYTES));
    const second = decoder.pushBytes(wav.subarray(CHUNK_BYTES));
    const final = decoder.finish();
    expect(first.samples.length + second.samples.length + final.samples.length).toBe(4000);
    expect(decoder.metadata.channels).toBe(2);
    expect(decoder.metadata.durationSeconds).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import reference from "./fixtures/r_reference.json";
import { createSyntheticSamples, createPcm16Wav } from "./fixtures/synthetic.js";
import { WavStreamDecoder } from "../src/analysis/wav.js";
import { createAnalyzer } from "../src/analysis/engine.js";

function feed(decoder, bytes, chunkSizes, consume) {
  let offset = 0;
  let chunkIndex = 0;
  while (offset < bytes.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length];
    const decoded = decoder.pushBytes(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
    if (decoded.samples.length) consume(decoded.samples, decoded.metadata);
    offset += size;
    chunkIndex += 1;
  }
  const final = decoder.finish();
  if (final.samples.length) consume(final.samples, final.metadata);
}

describe("synthetic R-workflow parity", () => {
  it("matches energy, retained P interval, and RIBBIT reference", () => {
    const wav = createPcm16Wav(createSyntheticSamples());
    const analyzer = createAnalyzer({ recording: "synthetic.wav", device: "fixture" });
    const decoder = new WavStreamDecoder();
    feed(decoder, wav, [17, 65537, 1048583], (samples, metadata) => {
      analyzer.pushSamples(samples, metadata.sampleRateHz);
    });

    const firstPass = analyzer.completeFirstPass();
    const expectedEnergy = Array.from({ length: reference.durationSeconds }, (_, index) => {
      if (index < 60 || index >= 300) return reference.backgroundEnergy;
      return reference.activeEnergyCycle[(index - 60) % reference.activeEnergyCycle.length];
    });
    expect(firstPass.overview.rawEnergy).toHaveLength(expectedEnergy.length);
    firstPass.overview.rawEnergy.forEach((value, index) => {
      expect(Math.abs(value - expectedEnergy[index])).toBeLessThanOrEqual(1e-6);
    });

    const counts = firstPass.overview.classes.reduce((output, value) => {
      output[value] = (output[value] ?? 0) + 1;
      return output;
    }, {});
    expect(counts).toEqual(reference.hmmCounts);
    expect(firstPass.detections).toHaveLength(1);
    expect(Math.abs(firstPass.detections[0].start - reference.detections[0].start)).toBeLessThanOrEqual(1);
    expect(Math.abs(firstPass.detections[0].end - reference.detections[0].end)).toBeLessThanOrEqual(1);
    expect(Math.abs(firstPass.detections[0].ribbit - reference.detections[0].ribbit)).toBeLessThanOrEqual(1e-3);

    analyzer.beginPreviewPass();
    const previewDecoder = new WavStreamDecoder();
    let frameOffset = 0;
    feed(previewDecoder, wav, [4 * 1024 * 1024], (samples) => {
      analyzer.pushPreviewSamples(samples, frameOffset);
      frameOffset += samples.length;
    });
    const result = analyzer.completePreviewPass();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].spectrogram.matrix.length).toBeGreaterThan(100);
    expect(result.candidates[0].spectrogram.frequencyAxisHz[0]).toBeGreaterThanOrEqual(1000);
    expect(result.candidates[0].spectrogram.frequencyAxisHz.at(-1)).toBeLessThanOrEqual(2000);
  }, 30000);

  it("creates a real overview spectrum when no bout is retained", () => {
    const sampleRateHz = 4000;
    const samples = Float32Array.from({ length: sampleRateHz * 30 }, (_, index) => {
      const second = index / sampleRateHz;
      const bandAmplitude = 0.04 + 0.03 * Math.sin(2 * Math.PI * 0.2 * second);
      return 0.4 * Math.sin(2 * Math.PI * 500 * second)
        + bandAmplitude * Math.sin(2 * Math.PI * 1450 * second);
    });
    const wav = createPcm16Wav(samples, sampleRateHz);
    const analyzer = createAnalyzer({ recording: "no-bout.wav", device: "fixture" });
    const decoder = new WavStreamDecoder();
    feed(decoder, wav, [8191, 32768], (decoded, metadata) => {
      analyzer.pushSamples(decoded, metadata.sampleRateHz);
    });
    const firstPass = analyzer.completeFirstPass();
    expect(firstPass.detections).toHaveLength(0);
    expect(Math.max(...firstPass.overview.energy) - Math.min(...firstPass.overview.energy)).toBeGreaterThan(0.9);

    analyzer.beginPreviewPass();
    const previewDecoder = new WavStreamDecoder();
    let frameOffset = 0;
    feed(previewDecoder, wav, [65537], (decoded) => {
      analyzer.pushPreviewSamples(decoded, frameOffset);
      frameOffset += decoded.length;
    });
    const result = analyzer.completePreviewPass();
    expect(result.overview.preview.spectrogram.matrix.length).toBeGreaterThan(100);
    expect(result.overview.preview.spectrogram.maxDb).toBeGreaterThan(0);
  }, 30000);
});

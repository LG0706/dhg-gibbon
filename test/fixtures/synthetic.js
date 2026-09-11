export const SYNTHETIC_SAMPLE_RATE = 4000;
export const SYNTHETIC_DURATION_SECONDS = 360;

export function createSyntheticSamples() {
  const samples = new Float32Array(SYNTHETIC_SAMPLE_RATE * SYNTHETIC_DURATION_SECONDS);
  for (let index = 0; index < samples.length; index += 1) {
    const second = Math.floor(index / SYNTHETIC_SAMPLE_RATE);
    const active = second >= 60 && second < 300;
    const bandAmplitude = active
      ? 0.12 + 0.1 * Math.sin(2 * Math.PI * 0.075 * second)
      : 0.002;
    samples[index] = 0.4 * Math.sin(2 * Math.PI * 500 * index / SYNTHETIC_SAMPLE_RATE)
      + bandAmplitude * Math.sin(2 * Math.PI * 1450 * index / SYNTHETIC_SAMPLE_RATE);
  }
  return samples;
}

function writeFourCC(view, offset, text) {
  for (let index = 0; index < 4; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

export function createPcm16Wav(samples, sampleRateHz = SYNTHETIC_SAMPLE_RATE, { junkBytes = 0, channels = 1 } = {}) {
  const formatSize = 16;
  const junkPadding = junkBytes & 1;
  const junkChunkBytes = junkBytes > 0 ? 8 + junkBytes + junkPadding : 0;
  const blockAlign = channels * 2;
  const dataBytes = samples.length * blockAlign;
  const totalBytes = 12 + 8 + formatSize + junkChunkBytes + 8 + dataBytes;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  writeFourCC(view, 0, "RIFF");
  view.setUint32(4, totalBytes - 8, true);
  writeFourCC(view, 8, "WAVE");
  writeFourCC(view, 12, "fmt ");
  view.setUint32(16, formatSize, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  let offset = 36;
  if (junkBytes > 0) {
    writeFourCC(view, offset, "JUNK");
    view.setUint32(offset + 4, junkBytes, true);
    offset += 8 + junkBytes + junkPadding;
  }
  writeFourCC(view, offset, "data");
  view.setUint32(offset + 4, dataBytes, true);
  offset += 8;
  for (let frame = 0; frame < samples.length; frame += 1) {
    const integer = Math.max(-32768, Math.min(32767, Math.round(samples[frame] * 32767)));
    for (let channel = 0; channel < channels; channel += 1) view.setInt16(offset + (frame * channels + channel) * 2, integer, true);
  }
  return new Uint8Array(buffer);
}

export class AnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
  }
}

const EMPTY_BYTES = new Uint8Array(0);

function fourCC(bytes, offset = 0) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function joinBytes(left, right) {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function joinSamples(parts) {
  if (parts.length === 0) return new Float32Array(0);
  if (parts.length === 1) return parts[0];
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

export class WavStreamDecoder {
  constructor() {
    this.pending = EMPTY_BYTES;
    this.mode = "riff";
    this.currentChunk = null;
    this.skipRemaining = 0;
    this.dataRemaining = 0;
    this.dataPadding = 0;
    this.bytesReceived = 0;
    this.expectedRiffBytes = null;
    this.format = null;
    this.foundData = false;
    this.framesDecoded = 0;
    this.finished = false;
  }

  get metadata() {
    if (!this.format) return null;
    return {
      sampleRateHz: this.format.sampleRateHz,
      channels: this.format.channels,
      bitsPerSample: this.format.bitsPerSample,
      codec: this.format.audioFormat === 1 ? "PCM" : "IEEE_FLOAT",
      framesDecoded: this.framesDecoded,
      durationSeconds: this.framesDecoded / this.format.sampleRateHz,
    };
  }

  pushBytes(uint8Array) {
    if (this.finished) throw new AnalysisError("decoder_finished", "WAV 解码器已经结束");
    if (!(uint8Array instanceof Uint8Array)) {
      throw new AnalysisError("invalid_chunk", "WAV 数据块必须是 Uint8Array");
    }

    this.bytesReceived += uint8Array.length;
    this.pending = joinBytes(this.pending, uint8Array);
    const decodedParts = [];

    while (true) {
      if (this.mode === "riff") {
        if (this.pending.length < 12) break;
        if (fourCC(this.pending, 0) !== "RIFF" || fourCC(this.pending, 8) !== "WAVE") {
          throw new AnalysisError("invalid_wave", "文件不是有效的 RIFF/WAVE 录音");
        }
        const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
        this.expectedRiffBytes = view.getUint32(4, true) + 8;
        if (this.expectedRiffBytes < 12) {
          throw new AnalysisError("corrupt_header", "WAV 的 RIFF 长度无效");
        }
        this._consume(12);
        this.mode = "chunk-header";
        continue;
      }

      if (this.mode === "chunk-header") {
        if (this.pending.length < 8) break;
        const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
        const id = fourCC(this.pending, 0);
        const size = view.getUint32(4, true);
        this._consume(8);
        if (id === "fmt ") {
          if (this.format) throw new AnalysisError("corrupt_header", "WAV 包含重复的 fmt 块");
          this.currentChunk = { id, size, padding: size & 1 };
          this.mode = "format";
        } else if (id === "data") {
          if (!this.format) throw new AnalysisError("corrupt_header", "WAV 的 data 块出现在 fmt 块之前");
          if (this.foundData) throw new AnalysisError("corrupt_header", "WAV 包含重复的 data 块");
          this.foundData = true;
          this.dataRemaining = size;
          this.dataPadding = size & 1;
          this.mode = "audio";
        } else {
          this.skipRemaining = size;
          this.dataPadding = size & 1;
          this.mode = "skip";
        }
        continue;
      }

      if (this.mode === "format") {
        const { size, padding } = this.currentChunk;
        if (size < 16) throw new AnalysisError("corrupt_header", "WAV 的 fmt 块长度不足 16 字节");
        if (this.pending.length < size + padding) break;
        this._parseFormat(this.pending.subarray(0, size));
        this._consume(size + padding);
        this.currentChunk = null;
        this.mode = "chunk-header";
        continue;
      }

      if (this.mode === "skip") {
        if (this.skipRemaining > 0) {
          const count = Math.min(this.skipRemaining, this.pending.length);
          this._consume(count);
          this.skipRemaining -= count;
          if (this.skipRemaining > 0) break;
        }
        if (this.dataPadding) {
          if (this.pending.length < 1) break;
          this._consume(1);
          this.dataPadding = 0;
        }
        this.mode = "chunk-header";
        continue;
      }

      if (this.mode === "audio") {
        if (this.dataRemaining === 0) {
          if (this.dataPadding) {
            if (this.pending.length < 1) break;
            this._consume(1);
            this.dataPadding = 0;
          }
          this.mode = "chunk-header";
          continue;
        }
        const available = Math.min(this.pending.length, this.dataRemaining);
        const completeBytes = available - (available % this.format.blockAlign);
        if (completeBytes === 0) break;
        decodedParts.push(this._decodeFrames(this.pending.subarray(0, completeBytes)));
        this._consume(completeBytes);
        this.dataRemaining -= completeBytes;
        continue;
      }

      break;
    }

    return {
      samples: joinSamples(decodedParts),
      metadata: this.metadata,
    };
  }

  finish() {
    if (this.finished) throw new AnalysisError("decoder_finished", "WAV 解码器已经结束");
    const finalChunk = this.pushBytes(EMPTY_BYTES);
    this.finished = true;

    if (this.mode === "riff") throw new AnalysisError("incomplete_file", "WAV 文件头不完整");
    if (!this.format) throw new AnalysisError("missing_format", "WAV 缺少 fmt 格式块");
    if (!this.foundData) throw new AnalysisError("missing_audio", "WAV 缺少 data 音频块");
    if (this.dataRemaining !== 0 || this.mode === "format" || this.mode === "skip" || this.pending.length > 0) {
      throw new AnalysisError("incomplete_file", "WAV 文件数据不完整或块长度损坏");
    }
    if (this.expectedRiffBytes !== null && this.bytesReceived < this.expectedRiffBytes) {
      throw new AnalysisError("incomplete_file", "WAV 文件短于 RIFF 文件头声明的长度");
    }

    return {
      ...finalChunk,
      metadata: this.metadata,
    };
  }

  _consume(count) {
    this.pending = count === this.pending.length ? EMPTY_BYTES : this.pending.subarray(count);
  }

  _parseFormat(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const audioFormat = view.getUint16(0, true);
    const channels = view.getUint16(2, true);
    const sampleRateHz = view.getUint32(4, true);
    const byteRate = view.getUint32(8, true);
    const blockAlign = view.getUint16(12, true);
    const bitsPerSample = view.getUint16(14, true);

    if (audioFormat !== 1 && audioFormat !== 3) {
      throw new AnalysisError("unsupported_codec", `不支持 WAV 编码格式 ${audioFormat}，请转换为 PCM WAV`);
    }
    if (channels !== 1 && channels !== 2) {
      throw new AnalysisError("unsupported_channels", `仅支持单声道或双声道 WAV，当前为 ${channels} 声道`);
    }
    if (sampleRateHz < 4000) {
      throw new AnalysisError("sample_rate_too_low", `采样率 ${sampleRateHz} Hz 低于 4000 Hz`);
    }
    const validPcmDepth = audioFormat === 1 && [16, 24, 32].includes(bitsPerSample);
    const validFloatDepth = audioFormat === 3 && bitsPerSample === 32;
    if (!validPcmDepth && !validFloatDepth) {
      throw new AnalysisError("unsupported_bit_depth", `不支持 ${bitsPerSample} 位 ${audioFormat === 3 ? "浮点" : "PCM"} WAV`);
    }
    const bytesPerSample = bitsPerSample / 8;
    if (blockAlign !== channels * bytesPerSample || byteRate !== sampleRateHz * blockAlign) {
      throw new AnalysisError("corrupt_format", "WAV 的块对齐或字节率与格式不一致");
    }

    this.format = { audioFormat, channels, sampleRateHz, blockAlign, bitsPerSample, bytesPerSample };
  }

  _decodeFrames(bytes) {
    const { audioFormat, blockAlign, bitsPerSample, bytesPerSample } = this.format;
    const frameCount = bytes.length / blockAlign;
    const samples = new Float32Array(frameCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let frame = 0; frame < frameCount; frame += 1) {
      const offset = frame * blockAlign;
      let value;
      if (audioFormat === 3) {
        value = view.getFloat32(offset, true);
      } else if (bitsPerSample === 16) {
        value = view.getInt16(offset, true) / 32768;
      } else if (bitsPerSample === 24) {
        let integer = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
        if (integer & 0x800000) integer |= 0xff000000;
        value = integer / 8388608;
      } else {
        value = view.getInt32(offset, true) / 2147483648;
      }
      samples[frame] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      if (bytesPerSample > blockAlign) break;
    }
    this.framesDecoded += frameCount;
    return samples;
  }
}

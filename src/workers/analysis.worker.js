import { WavStreamDecoder, AnalysisError } from "../analysis/wav.js";
import { createAnalyzer } from "../analysis/engine.js";

let active = null;

function now() {
  return self.performance?.now?.() ?? Date.now();
}

function send(type, detail = {}) {
  self.postMessage({ type, ...detail });
}

function errorDetail(error) {
  const allocationFailure = error instanceof RangeError && /Array buffer allocation failed|Invalid array length|out of memory/i.test(error.message);
  return {
    code: allocationFailure ? "out_of_memory" : (error.code ?? "analysis_failed"),
    message: allocationFailure ? "此浏览器内存不足，建议关闭其他标签页后重试" : (error.message ?? String(error)),
  };
}

function decodeIntoAnalyzer(bytes, preview = false) {
  const started = now();
  const decoded = active.decoder.pushBytes(bytes);
  active.decodeMs += now() - started;
  if (decoded.samples.length === 0) return;
  if (preview) {
    active.analyzer.pushPreviewSamples(decoded.samples, active.previewFrameOffset);
    active.previewFrameOffset += decoded.samples.length;
  } else {
    active.analyzer.pushSamples(decoded.samples, decoded.metadata.sampleRateHz);
  }
}

function finishDecoder(preview = false) {
  const started = now();
  const decoded = active.decoder.finish();
  active.decodeMs += now() - started;
  if (decoded.samples.length > 0) {
    if (preview) {
      active.analyzer.pushPreviewSamples(decoded.samples, active.previewFrameOffset);
      active.previewFrameOffset += decoded.samples.length;
    } else {
      active.analyzer.pushSamples(decoded.samples, decoded.metadata.sampleRateHz);
    }
  }
}

function completeFile(result, requestId) {
  const totalMs = now() - active.startedAt;
  active.analyzer.setExternalMetrics({ decodeMs: active.decodeMs, totalMs });
  const payload = {
    fileId: active.fileId,
    filename: active.filename,
    result,
    metrics: { ...active.analyzer.metrics },
    requestId,
  };
  send("file-complete", payload);
  active = null;
}

self.addEventListener("message", (event) => {
  const message = event.data;
  try {
    if (message.type === "start-file") {
      if (active) throw new AnalysisError("worker_busy", "分析器正在处理另一条录音");
      active = {
        fileId: message.fileId,
        filename: message.metadata.recording,
        totalBytes: message.totalBytes,
        decoder: new WavStreamDecoder(),
        analyzer: createAnalyzer(message.metadata, message.parameters),
        decodeMs: 0,
        startedAt: now(),
        previewFrameOffset: 0,
      };
      send("chunk-ack", { fileId: active.fileId, requestId: message.requestId });
      return;
    }

    if (message.type === "finish-batch") {
      send("batch-complete", { requestId: message.requestId });
      return;
    }

    if (!active || message.fileId !== active.fileId) {
      throw new AnalysisError("unknown_file", "工作线程没有找到对应的活动录音");
    }

    if (message.type === "file-chunk") {
      decodeIntoAnalyzer(new Uint8Array(message.buffer), message.phase === "previews");
      send("file-progress", {
        fileId: active.fileId,
        filename: active.filename,
        phase: message.phase,
        bytesRead: message.bytesRead,
        totalBytes: active.totalBytes,
      });
      send("chunk-ack", { fileId: active.fileId, requestId: message.requestId });
      return;
    }

    if (message.type === "end-file") {
      finishDecoder(false);
      const result = active.analyzer.completeFirstPass();
      active.analyzer.beginPreviewPass();
      active.decoder = new WavStreamDecoder();
      active.previewFrameOffset = 0;
      send("preview-request", {
        fileId: active.fileId,
        requestId: message.requestId,
        ranges: [
          {
            preview_id: result.overview.preview.preview_id,
            previewStart: result.overview.preview.previewStart,
            previewEnd: result.overview.preview.previewEnd,
          },
          ...result.candidates.map(({ candidate_id, previewStart, previewEnd }) => ({ candidate_id, previewStart, previewEnd })),
        ],
      });
      return;
    }

    if (message.type === "end-previews") {
      finishDecoder(true);
      completeFile(active.analyzer.completePreviewPass(), message.requestId);
      return;
    }

    throw new AnalysisError("unknown_message", `未知工作线程消息: ${message.type}`);
  } catch (error) {
    const detail = errorDetail(error);
    const fileId = active?.fileId ?? message.fileId;
    const filename = active?.filename ?? message.filename ?? "";
    active = null;
    send(fileId ? "file-error" : "worker-error", {
      fileId,
      filename,
      requestId: message.requestId,
      error: { ...detail, filename },
    });
  }
});

self.addEventListener("error", (event) => {
  send("worker-error", {
    error: { code: "worker_crash", message: event.message || "分析工作线程意外终止", filename: active?.filename ?? "" },
  });
  active = null;
});

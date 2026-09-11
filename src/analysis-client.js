const CHUNK_BYTES = 4 * 1024 * 1024;

export class AnalysisClientError extends Error {
  constructor(detail) {
    super(detail.message);
    this.name = "AnalysisClientError";
    this.code = detail.code;
    this.filename = detail.filename;
  }
}

export class AnalysisClient extends EventTarget {
  constructor(worker = new Worker(new URL("./workers/analysis.worker.js", import.meta.url), { type: "module" })) {
    super();
    this.worker = worker;
    this.sequence = 0;
    this.pending = new Map();
    this.worker.addEventListener("message", (event) => this._handleMessage(event.data));
    this.worker.addEventListener("error", (event) => {
      const detail = { code: "worker_crash", message: event.message || "分析工作线程意外终止", filename: "" };
      this._rejectAll(new AnalysisClientError(detail));
      this._emit("worker-error", { error: detail });
    });
  }

  async analyzeFile(fileId, file, metadata, parameters, onProgress) {
    await this._request({
      type: "start-file",
      fileId,
      metadata,
      parameters,
      totalBytes: file.size,
    }, [], ["chunk-ack"]);

    await this._streamFile(fileId, file, "features", onProgress);
    const firstPass = await this._request({ type: "end-file", fileId }, [], ["preview-request", "file-complete", "file-error"]);
    if (firstPass.type === "file-complete") return firstPass;

    await this._streamFile(fileId, file, "previews", onProgress);
    return this._request({ type: "end-previews", fileId }, [], ["file-complete", "file-error"]);
  }

  async finishBatch() {
    return this._request({ type: "finish-batch" }, [], ["batch-complete"]);
  }

  terminate() {
    this._rejectAll(new AnalysisClientError({ code: "terminated", message: "分析工作线程已关闭", filename: "" }));
    this.worker.terminate();
  }

  async _streamFile(fileId, file, phase, onProgress) {
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const end = Math.min(file.size, offset + CHUNK_BYTES);
      const buffer = await file.slice(offset, end).arrayBuffer();
      await this._request({
        type: "file-chunk",
        fileId,
        phase,
        buffer,
        bytesRead: end,
      }, [buffer], ["chunk-ack"]);
      onProgress?.({ phase, bytesRead: end, totalBytes: file.size });
    }
  }

  _request(message, transfer, expectedTypes) {
    const requestId = `request-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, expectedTypes });
      this.worker.postMessage({ ...message, requestId }, transfer);
    });
  }

  _handleMessage(message) {
    this._emit(message.type, message);
    if (!message.requestId) return;
    const request = this.pending.get(message.requestId);
    if (!request || !request.expectedTypes.includes(message.type)) return;
    this.pending.delete(message.requestId);
    if (message.type === "file-error" || message.type === "worker-error") {
      request.reject(new AnalysisClientError(message.error));
    } else {
      request.resolve(message);
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _rejectAll(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export { CHUNK_BYTES };

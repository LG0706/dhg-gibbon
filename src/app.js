import { AnalysisClient } from "./analysis-client.js";
import { DEFAULT_PARAMETERS } from "./analysis/engine.js";
import { createImportPanel } from "./components/import-panel.js";
import { AnalysisQueue } from "./components/analysis-queue.js";
import { ReviewWorkspace } from "./components/review-workspace.js";
import { createStorage } from "./storage.js";
import { createAnalysisImageBlob, IMAGE_RENDERER_VERSION } from "./render.js";
import { downloadExport } from "./export.js";

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `recording-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const RECENT_DEVICES_KEY = "gibbon-recent-devices";
const LAST_DEVICE_KEY = "gibbon-last-device";

function loadDevicePreferences(records) {
  const recordDevices = records.map((record) => record.device?.trim()).filter(Boolean);
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(RECENT_DEVICES_KEY) ?? "[]");
    const recent = Array.isArray(stored) ? stored.filter((device) => typeof device === "string" && device.trim()) : [];
    const current = globalThis.localStorage?.getItem(LAST_DEVICE_KEY)?.trim() || recordDevices.at(-1) || "";
    return { current, devices: Array.from(new Set([current, ...recent, ...recordDevices].filter(Boolean))) };
  } catch {
    const current = recordDevices.at(-1) || "";
    return { current, devices: Array.from(new Set(recordDevices)) };
  }
}

function saveDevicePreferences(current, devices) {
  if (!current) return;
  try {
    globalThis.localStorage?.setItem(LAST_DEVICE_KEY, current);
    globalThis.localStorage?.setItem(RECENT_DEVICES_KEY, JSON.stringify(Array.from(devices).slice(-20)));
  } catch {
    // Analysis remains available when browser preference storage is unavailable.
  }
}

function serializableRecord(record) {
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    size: record.size,
    lastModified: record.lastModified,
    device: record.device,
    status: record.status,
    metrics: record.metrics ?? null,
    error: record.error ?? null,
  };
}

export async function mountApp(root) {
  if (!root) throw new Error("找不到应用挂载节点");
  root.innerHTML = `
    <main id="main-content" class="app-shell">
      <header class="app-header">
        <h1>长臂猿录音筛查</h1>
        <p>选择 PCM WAV 录音，完成检测、复核与导出。</p>
      </header>
      <div class="warning-banner">
        <strong>漏检提示</strong>
        <span>本程序无法避免丢掉假阴性数据，即算法漏掉但其实有长臂猿声音的数据（大概率质量差），望知晓！</span>
      </div>
      <div class="privacy-banner">
        <strong>本地处理</strong>
        <span>音频字节仅进入当前浏览器的分析工作线程，不会发送到网络，也不会保存到 IndexedDB。</span>
      </div>
      <p class="warning-banner" data-role="storage-warning" hidden></p>
      <div class="workspace" data-role="workspace" aria-busy="true">
        <p class="loading-state">正在打开本地结果存储…</p>
      </div>
    </main>`;

  const workspace = root.querySelector('[data-role="workspace"]');
  const warningBanner = root.querySelector('[data-role="storage-warning"]');
  const storage = await createStorage();
  if (storage.warning) {
    warningBanner.hidden = false;
    warningBanner.textContent = storage.warning;
  }

  const batches = await storage.getAll("batches");
  const latestBatch = batches.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  const batchId = latestBatch?.batchId ?? createId();
  const records = (latestBatch?.records ?? []).map((record) => ({ ...record, file: null }));
  const persistedResults = await storage.getAll("results");
  const storedResults = new Map(persistedResults.map((entry) => [entry.recordingKey, entry]));
  const persistedReviews = await storage.getAll("reviews");
  const reviews = new Map(persistedReviews.map((review) => [review.candidate_id, review]));
  const errors = records.filter((record) => record.error).map((record) => ({ filename: record.name, ...record.error }));
  const existingKeys = new Set(records.map((record) => record.key));
  let analysisClient = new AnalysisClient();
  let parameters = { ...DEFAULT_PARAMETERS, energyBandHz: [...DEFAULT_PARAMETERS.energyBandHz] };
  const devicePreferences = loadDevicePreferences(records);
  let currentDevice = devicePreferences.current;
  const knownDevices = new Set(devicePreferences.devices);

  workspace.replaceChildren();
  workspace.setAttribute("aria-busy", "false");
  const importPanel = createImportPanel({
    existingKeys,
    onFilesAdded: (items) => {
      for (const item of items) {
        records.push({
          id: createId(),
          key: item.key,
          name: item.file.name,
          size: item.file.size,
          lastModified: item.file.lastModified,
          device: currentDevice,
          status: "待分析",
          metrics: null,
          error: null,
          file: item.file,
        });
      }
      refresh();
      persistBatch();
    },
    onDuplicate: (file, key) => {
      const historical = records.find((record) => record.key === key && !record.file);
      if (!historical) return;
      historical.file = file;
      if (!historical.device) historical.device = currentDevice;
      historical.status = "待分析";
      historical.error = null;
      refresh();
      persistBatch();
    },
  });

  const queue = new AnalysisQueue({
    onStart: startPendingWithDevice,
    onRemove: removeRecord,
    initialDevice: currentDevice,
    devices: knownDevices,
    onDeviceChange: updateCurrentDevice,
  });

  const parameterSection = document.createElement("section");
  parameterSection.className = "parameter-panel";
  parameterSection.setAttribute("aria-labelledby", "parameter-heading");
  parameterSection.innerHTML = `
    <div class="section-heading">
      <div>
        <div class="parameter-title-row">
          <h2 id="parameter-heading">分析参数</h2>
          <button class="parameter-toggle" data-role="parameter-toggle" type="button" aria-expanded="false" aria-controls="parameter-body" aria-label="展开分析参数">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </button>
        </div>
        <p>可按需修改 RIBBIT 分数门槛与检测频率范围；不修改则直接使用默认推荐值。</p>
      </div>
    </div>
    <div id="parameter-body" data-role="parameter-body" hidden>
      <div class="parameter-grid">
        <label class="field">
          <span>RIBBIT 分数门槛（0–1）</span>
          <input type="number" data-role="threshold" min="0" max="1" step="0.01" value="0.1" inputmode="decimal" />
          <small>评分高于该值的片段才进入人工复核。调低→进入复核的片段更多；调高→更少。推荐值 0.1。</small>
        </label>
        <div class="field">
          <span>检测频率范围（Hz）</span>
          <div class="dual-range">
            <div class="dual-range-track"></div>
            <div class="dual-range-fill" data-role="band-fill"></div>
            <input type="range" data-role="band-low" min="1000" max="2000" step="10" value="1300" aria-label="检测频率下限（Hz）" />
            <input type="range" data-role="band-high" min="1000" max="2000" step="10" value="1600" aria-label="检测频率上限（Hz）" />
          </div>
          <small data-role="band-readout"></small>
        </div>
      </div>
      <div class="parameter-actions">
        <button class="primary-button" data-role="apply" type="button">应用并重新分析</button>
        <button class="secondary-button" data-role="reset" type="button">恢复推荐值</button>
        <p class="inline-notice" data-role="parameter-status" aria-live="polite"></p>
      </div>
      <p class="parameter-hint">参数需点击“应用并重新分析”后生效，且只对当前会话中仍可用的录音文件重新分析；已保存的复核结论不受影响。</p>
    </div>`;
  const thresholdInput = parameterSection.querySelector('[data-role="threshold"]');
  const bandLowInput = parameterSection.querySelector('[data-role="band-low"]');
  const bandHighInput = parameterSection.querySelector('[data-role="band-high"]');
  const bandFill = parameterSection.querySelector('[data-role="band-fill"]');
  const bandReadout = parameterSection.querySelector('[data-role="band-readout"]');
  const applyButton = parameterSection.querySelector('[data-role="apply"]');
  const resetButton = parameterSection.querySelector('[data-role="reset"]');
  const parameterStatus = parameterSection.querySelector('[data-role="parameter-status"]');
  const BAND_MIN = 1000;
  const BAND_MAX = 2000;
  const BAND_MIN_GAP = 10;

  function updateBandUi() {
    const low = Number(bandLowInput.value);
    const high = Number(bandHighInput.value);
    bandFill.style.left = `${((low - BAND_MIN) / (BAND_MAX - BAND_MIN)) * 100}%`;
    bandFill.style.width = `${((high - low) / (BAND_MAX - BAND_MIN)) * 100}%`;
    bandReadout.textContent = `当前 ${low}–${high} Hz（推荐 ${DEFAULT_PARAMETERS.energyBandHz[0]}–${DEFAULT_PARAMETERS.energyBandHz[1]} Hz）`;
  }

  bandLowInput.addEventListener("input", () => {
    const high = Number(bandHighInput.value);
    if (Number(bandLowInput.value) > high - BAND_MIN_GAP) bandLowInput.value = String(high - BAND_MIN_GAP);
    updateBandUi();
  });
  bandHighInput.addEventListener("input", () => {
    const low = Number(bandLowInput.value);
    if (Number(bandHighInput.value) < low + BAND_MIN_GAP) bandHighInput.value = String(low + BAND_MIN_GAP);
    updateBandUi();
  });
  updateBandUi();

  function updateParameterControls() {
    applyButton.disabled = queue.busy;
  }

  async function applyParameters() {
    const raw = thresholdInput.value.trim();
    const threshold = Number(raw);
    if (raw === "" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      parameterStatus.textContent = "RIBBIT 分数门槛必须是 0 到 1 之间的数字。";
      return;
    }
    const low = Number(bandLowInput.value);
    const high = Number(bandHighInput.value);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low + BAND_MIN_GAP > high) {
      parameterStatus.textContent = "检测频率范围无效：下限必须至少比上限低 10 Hz。";
      return;
    }
    parameters.candidateScoreThreshold = Math.round(threshold * 100) / 100;
    parameters.energyBandHz = [low, high];
    const targets = records.filter((record) => record.file && storedResults.has(record.key));
    if (targets.length === 0) {
      parameterStatus.textContent = `参数已更新（门槛 ${parameters.candidateScoreThreshold}，${low}–${high} Hz）；当前会话没有可重新分析的录音文件，新参数将用于之后新分析的录音。`;
      return;
    }
    parameterStatus.textContent = `正在按新参数重新分析 ${targets.length} 个录音…`;
    await processSequentially(targets);
    const done = targets.filter((record) => storedResults.has(record.key)).length;
    parameterStatus.textContent = `已按新参数重新分析：成功 ${done} 个，失败 ${targets.length - done} 个（门槛 ${parameters.candidateScoreThreshold}，${low}–${high} Hz）。`;
  }

  applyButton.addEventListener("click", () => {
    void applyParameters();
  });
  resetButton.addEventListener("click", () => {
    thresholdInput.value = String(DEFAULT_PARAMETERS.candidateScoreThreshold);
    bandLowInput.value = String(DEFAULT_PARAMETERS.energyBandHz[0]);
    bandHighInput.value = String(DEFAULT_PARAMETERS.energyBandHz[1]);
    updateBandUi();
    parameterStatus.textContent = "已恢复推荐值，点击“应用并重新分析”后生效。";
  });
  const parameterBody = parameterSection.querySelector('[data-role="parameter-body"]');
  const parameterToggle = parameterSection.querySelector('[data-role="parameter-toggle"]');
  parameterToggle.addEventListener("click", () => {
    const expanded = parameterBody.hidden;
    parameterBody.hidden = !expanded;
    parameterToggle.setAttribute("aria-expanded", String(expanded));
    parameterToggle.setAttribute("aria-label", expanded ? "收起分析参数" : "展开分析参数");
  });
  const review = new ReviewWorkspace({
    onSave: async (savedReview) => {
      reviews.set(savedReview.candidate_id, savedReview);
      await storage.put("reviews", savedReview);
      renderSavedReviews();
    },
  });
  const exportSection = document.createElement("section");
  exportSection.className = "export-panel";
  exportSection.innerHTML = `
    <div>
      <h2>导出结果</h2>
      <p>ZIP 顶层是复核所需表格，错误、参数、性能记录和分析图收纳在“研究资料”文件夹。</p>
    </div>
    <button class="primary-button" data-role="export" type="button">导出 ZIP</button>
    <p class="inline-notice" data-role="export-status" aria-live="polite"></p>
    <div class="saved-reviews">
      <div class="saved-reviews-heading">
        <h3>已保存复核结果</h3>
        <span data-role="saved-review-count">0 条</span>
      </div>
      <div class="table-scroll">
        <table class="saved-review-table">
          <thead><tr>
            <th scope="col">文件名</th>
            <th scope="col">候选区间</th>
            <th scope="col">RIBBIT 评分</th>
            <th scope="col">复核结论</th>
            <th scope="col">备注</th>
            <th scope="col">更新时间</th>
            <th scope="col">操作</th>
          </tr></thead>
          <tbody data-role="saved-review-rows"></tbody>
        </table>
      </div>
    </div>`;
  const exportButton = exportSection.querySelector('[data-role="export"]');
  const exportStatus = exportSection.querySelector('[data-role="export-status"]');
  const savedReviewCount = exportSection.querySelector('[data-role="saved-review-count"]');
  const savedReviewRows = exportSection.querySelector('[data-role="saved-review-rows"]');
  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    exportStatus.textContent = "正在生成导出文件…";
    try {
      const archive = await downloadExport({ records, storedResults, reviews, errors });
      exportStatus.textContent = `已生成 ${archive.filename}`;
    } catch (error) {
      exportStatus.textContent = `导出失败：${error.message}`;
    } finally {
      exportButton.disabled = storedResults.size === 0;
    }
  });

  workspace.append(importPanel.element, parameterSection, queue.element, review.element, exportSection);
  refresh();

  async function persistBatch() {
    await storage.put("batches", {
      batchId,
      updatedAt: new Date().toISOString(),
      records: records.map(serializableRecord),
    });
  }
  function savedReviewDetail(savedReview) {
    const stored = storedResults.get(savedReview.recordingKey);
    const result = stored?.result;
    if (!result) {
      return { recording: savedReview.recording, interval: "-", score: "-" };
    }
    if (savedReview.candidate_id === `recording:${savedReview.recordingKey}`) {
      return {
        recording: result.metadata.recording,
        interval: `0.0-${result.metrics.audioSeconds.toFixed(1)} 秒（整段）`,
        score: "-",
      };
    }
    const segment = result.candidates.find((item) => item.candidate_id === savedReview.candidate_id)
      ?? result.detections.find((item) => item.candidate_id === savedReview.candidate_id);
    const start = segment?.boutStart ?? segment?.start;
    const end = segment?.boutEnd ?? segment?.end;
    return {
      recording: result.metadata.recording,
      interval: Number.isFinite(start) && Number.isFinite(end) ? `${start.toFixed(1)}-${end.toFixed(1)} 秒` : "-",
      score: Number.isFinite(segment?.ribbit) ? segment.ribbit.toFixed(4) : "-",
    };
  }

  function renderSavedReviews() {
    const saved = Array.from(reviews.values()).sort((left, right) => (
      String(right.updatedAt).localeCompare(String(left.updatedAt))
    ));
    savedReviewCount.textContent = `${saved.length} 条`;
    savedReviewRows.replaceChildren();
    if (saved.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "empty-cell";
      cell.textContent = "尚未保存复核结果。";
      row.append(cell);
      savedReviewRows.append(row);
      return;
    }
    for (const savedReview of saved) {
      const detail = savedReviewDetail(savedReview);
      const row = document.createElement("tr");
      const updated = new Date(savedReview.updatedAt);
      const values = [
        detail.recording,
        detail.interval,
        detail.score,
        savedReview.decision,
        savedReview.note || "-",
        Number.isNaN(updated.getTime()) ? "-" : updated.toLocaleString("zh-CN", { hour12: false }),
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      const actionCell = document.createElement("td");
      const correctButton = document.createElement("button");
      correctButton.type = "button";
      correctButton.className = "secondary-button table-action";
      correctButton.textContent = "校对";
      correctButton.disabled = !review.entries.some((entry) => entry.reviewId === savedReview.candidate_id);
      correctButton.addEventListener("click", () => review.selectReview(savedReview.candidate_id));
      actionCell.append(correctButton);
      row.append(actionCell);
      savedReviewRows.append(row);
    }
  }

  async function removeRecord(recordId) {
    const index = records.findIndex((record) => record.id === recordId);
    if (index < 0) return;
    const record = records[index];
    if (record.status === "分析中") {
      analysisClient.terminate();
      analysisClient = new AnalysisClient();
    }
    records.splice(index, 1);
    record.file = null;
    existingKeys.delete(record.key);
    const hadStoredResult = storedResults.delete(record.key);
    const reviewIds = Array.from(reviews.values())
      .filter((savedReview) => savedReview.recordingKey === record.key)
      .map((savedReview) => savedReview.candidate_id);
    for (const reviewId of reviewIds) reviews.delete(reviewId);
    for (let errorIndex = errors.length - 1; errorIndex >= 0; errorIndex -= 1) {
      if (errors[errorIndex].filename === record.name) errors.splice(errorIndex, 1);
    }
    refresh();
    if (hadStoredResult) await storage.delete("results", record.key);
    for (const reviewId of reviewIds) await storage.delete("reviews", reviewId);
    await persistBatch();
  }

  function refresh() {
    queue.setRecords(records);
    const results = new Map(Array.from(storedResults, ([key, entry]) => [key, entry.result]));
    const availableFiles = new Map(records.filter((record) => record.file).map((record) => [record.key, record.file]));
    review.setData(results, Array.from(reviews.values()), availableFiles);
    exportButton.disabled = storedResults.size === 0;
    updateParameterControls();
    renderSavedReviews();
  }

  function updateCurrentDevice(device, remember = false) {
    currentDevice = device.trim();
    for (const record of records) {
      if (record.status === "待分析" && record.file) record.device = currentDevice;
    }
    queue.setRecords(records);
    if (!remember || !currentDevice) return;
    knownDevices.add(currentDevice);
    saveDevicePreferences(currentDevice, knownDevices);
    queue.setDeviceOptions(knownDevices, currentDevice);
    void persistBatch();
  }

  async function startPendingWithDevice(pending, device) {
    updateCurrentDevice(device, true);
    for (const record of pending) record.device = currentDevice;
    refresh();
    await persistBatch();
    await processSequentially(pending);
  }

  async function processSequentially(pending) {
    queue.setBusy(true);
    updateParameterControls();
    try {
      for (const record of pending) {
        if (!records.includes(record)) continue;
        queue.updateRecord(record.id, { status: "分析中", progress: 0, error: null });
        try {
          const completed = await analysisClient.analyzeFile(
            record.id,
            record.file,
            { recording: record.name, device: record.device },
            parameters,
            ({ phase, bytesRead, totalBytes }) => {
              const fraction = totalBytes > 0 ? bytesRead / totalBytes : 0;
              queue.updateRecord(record.id, { progress: phase === "features" ? fraction * 0.5 : 0.5 + fraction * 0.5 });
            },
          );
          if (!records.includes(record)) continue;
          const imageBlob = await createAnalysisImageBlob(completed.result);
          if (!records.includes(record)) continue;
          const entry = { recordingKey: record.key, result: completed.result, imageBlob, imageRendererVersion: IMAGE_RENDERER_VERSION };
          storedResults.set(record.key, entry);
          record.status = "已完成";
          record.metrics = completed.metrics;
          record.error = null;
          await storage.put("results", entry);
        } catch (error) {
          if (!records.includes(record)) continue;
          record.status = "失败";
          record.error = { code: error.code ?? "analysis_failed", message: error.message };
          errors.push({ filename: record.name, ...record.error });
        }
        delete record.progress;
        await persistBatch();
        refresh();
      }
      await analysisClient.finishBatch();
    } finally {
      queue.setBusy(false);
      updateParameterControls();
      refresh();
    }
  }

  window.addEventListener("beforeunload", () => analysisClient.terminate(), { once: true });
}

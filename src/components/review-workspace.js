import { renderAnalysisCanvas } from "../render.js";

const DECISIONS = ["待确认", "确认有长臂猿", "疑似", "没有长臂猿", "其他动物", "噪声"];

function formatTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export class ReviewWorkspace {
  constructor({ onSave }) {
    this.onSave = onSave;
    this.entries = [];
    this.reviews = new Map();
    this.files = new Map();
    this.audioUrl = null;
    this.audioKey = null;
    this.audioDuration = 0;
    this.tickId = null;
    this.seeking = false;
    this.element = document.createElement("section");
    this.element.className = "review-section";
    this.element.setAttribute("aria-labelledby", "review-heading");
    this.element.innerHTML = `
      <div class="section-heading">
        <div>
          <h2 id="review-heading">人工复核</h2>
          <p>RIBBIT 评分用于排序，不代表概率。请结合整段状态与频谱确认。</p>
        </div>
      </div>
      <div class="audio-bar" data-role="audio-bar" hidden>
        <audio data-role="audio" preload="metadata"></audio>
        <div class="audio-bar-controls">
          <button class="secondary-button" data-role="play" type="button">播放</button>
          <span class="audio-time numeric" data-role="time">0:00 / 0:00</span>
        </div>
        <div class="timeline-wrap">
          <div class="timeline" data-role="timeline" tabindex="0" role="slider" aria-label="录音时间轴：点击定位，左右方向键前后 1 秒，加 Shift 为 5 秒，空格播放或暂停" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0:00 / 0:00">
            <div class="timeline-progress" data-role="progress"></div>
            <div class="timeline-segments" data-role="segments"></div>
            <div class="timeline-playhead" data-role="playhead"></div>
          </div>
          <div class="timeline-legend" aria-hidden="true">
            <span class="legend-item"><i class="legend-swatch legend-candidate"></i>候选片段</span>
            <span class="legend-item"><i class="legend-swatch legend-detection"></i>检测片段</span>
            <span class="legend-item"><i class="legend-swatch legend-progress"></i>已播放</span>
            <span class="legend-item"><i class="legend-swatch legend-playhead"></i>播放位置</span>
          </div>
        </div>
        <div class="audio-bar-actions">
          <button class="secondary-button" data-role="seek-back" type="button">−5 秒</button>
          <button class="secondary-button" data-role="seek-forward" type="button">+5 秒</button>
          <button class="secondary-button" data-role="jump-candidate" type="button">跳到片段</button>
        </div>
      </div>
      <div class="review-grid">
        <form class="review-panel" data-role="form">
          <label class="field">
            <span>分析结果</span>
            <div class="result-navigator">
              <button class="secondary-button navigator-button" data-role="previous" type="button" aria-label="上一个分析结果">←</button>
              <select data-role="candidate"></select>
              <button class="secondary-button navigator-button" data-role="next" type="button" aria-label="下一个分析结果">→</button>
            </div>
            <small class="result-position" data-role="position"></small>
          </label>
          <dl class="candidate-details">
            <div><dt>文件名</dt><dd data-role="filename">-</dd></div>
            <div><dt>设备或地点</dt><dd data-role="device">-</dd></div>
            <div><dt>起止时间</dt><dd data-role="times">-</dd></div>
            <div><dt>RIBBIT 评分</dt><dd data-role="score">-</dd></div>
          </dl>
          <label class="field">
            <span>复核结论</span>
            <select data-role="decision">${DECISIONS.map((decision) => `<option value="${decision}">${decision}</option>`).join("")}</select>
          </label>
          <label class="field note-field">
            <span>备注</span>
            <textarea data-role="note" rows="3" placeholder="记录物种、噪声或复核依据"></textarea>
          </label>
          <button class="primary-button" type="submit">保存复核</button>
          <p class="inline-notice" data-role="saved" aria-live="polite"></p>
        </form>
        <div class="preview-panel">
          <canvas data-role="canvas" tabindex="0" role="button" aria-label="整段能量、HMM 状态与候选频谱。点击放大"></canvas>
        </div>
      </div>
      <dialog class="chart-dialog" data-role="chart-dialog" aria-labelledby="chart-dialog-heading">
        <div class="chart-dialog-header">
          <h3 id="chart-dialog-heading">分析图</h3>
          <button class="secondary-button" data-role="close-chart" type="button">关闭</button>
        </div>
        <div class="chart-zoom">
          <img data-role="large-chart" alt="" />
        </div>
      </dialog>`;

    this.selector = this.element.querySelector('[data-role="candidate"]');
    this.previousButton = this.element.querySelector('[data-role="previous"]');
    this.nextButton = this.element.querySelector('[data-role="next"]');
    this.position = this.element.querySelector('[data-role="position"]');
    this.decision = this.element.querySelector('[data-role="decision"]');
    this.note = this.element.querySelector('[data-role="note"]');
    this.canvas = this.element.querySelector('[data-role="canvas"]');
    this.chartDialog = this.element.querySelector('[data-role="chart-dialog"]');
    this.largeChart = this.element.querySelector('[data-role="large-chart"]');
    this.audioBar = this.element.querySelector('[data-role="audio-bar"]');
    this.audio = this.element.querySelector('[data-role="audio"]');
    this.playButton = this.element.querySelector('[data-role="play"]');
    this.timeDisplay = this.element.querySelector('[data-role="time"]');
    this.timeline = this.element.querySelector('[data-role="timeline"]');
    this.progressEl = this.element.querySelector('[data-role="progress"]');
    this.segmentsEl = this.element.querySelector('[data-role="segments"]');
    this.playheadEl = this.element.querySelector('[data-role="playhead"]');
    this.playButton.addEventListener("click", () => this.togglePlay());
    this.element.querySelector('[data-role="seek-back"]').addEventListener("click", () => this.seekBy(-5));
    this.element.querySelector('[data-role="seek-forward"]').addEventListener("click", () => this.seekBy(5));
    this.element.querySelector('[data-role="jump-candidate"]').addEventListener("click", () => this.jumpToCandidate());
    this.timeline.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.seeking = true;
      this.timeline.setPointerCapture(event.pointerId);
      this.seekFromPointer(event);
    });
    this.timeline.addEventListener("pointermove", (event) => {
      if (this.seeking) this.seekFromPointer(event);
    });
    for (const eventName of ["pointerup", "pointercancel"]) {
      this.timeline.addEventListener(eventName, () => { this.seeking = false; });
    }
    this.timeline.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 5 : 1;
      if (event.key === "ArrowLeft") { event.preventDefault(); this.seekBy(-step); }
      else if (event.key === "ArrowRight") { event.preventDefault(); this.seekBy(step); }
      else if (event.key === "Home") { event.preventDefault(); this.seekTo(0); }
      else if (event.key === "End") { event.preventDefault(); this.seekTo(this.audioDuration); }
      else if (event.key === " " || event.key === "Enter") { event.preventDefault(); this.togglePlay(); }
    });
    this.audio.addEventListener("play", () => { this.updatePlayButton(); this.startTicking(); });
    this.audio.addEventListener("pause", () => { this.updatePlayButton(); this.stopTicking(); this.updatePlayhead(); });
    this.audio.addEventListener("ended", () => { this.updatePlayButton(); this.stopTicking(); this.updatePlayhead(); });
    this.audio.addEventListener("timeupdate", () => this.updatePlayhead());
    this.audio.addEventListener("loadedmetadata", () => {
      this.audioDuration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
      this.updatePlayhead();
    });
    this.audio.addEventListener("durationchange", () => {
      this.audioDuration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
      this.updatePlayhead();
    });
    this.selector.addEventListener("change", () => this.renderSelected());
    this.previousButton.addEventListener("click", () => this.moveSelection(-1));
    this.nextButton.addEventListener("click", () => this.moveSelection(1));
    this.canvas.addEventListener("click", () => this.openChart());
    this.canvas.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openChart();
    });
    this.element.querySelector('[data-role="close-chart"]').addEventListener("click", () => this.chartDialog.close());
    this.chartDialog.addEventListener("click", (event) => {
      if (event.target === this.chartDialog) this.chartDialog.close();
    });
    this.element.querySelector('[data-role="form"]').addEventListener("submit", async (event) => {
      event.preventDefault();
      const entry = this.selectedEntry();
      if (!entry) return;
      const review = {
        candidate_id: entry.reviewId,
        recordingKey: entry.recordingKey,
        recording: entry.result.metadata.recording,
        decision: this.decision.value,
        note: this.note.value.trim(),
        updatedAt: new Date().toISOString(),
      };
      this.reviews.set(review.candidate_id, review);
      await this.onSave(review);
      this.element.querySelector('[data-role="saved"]').textContent = "复核结果已保存。";
    });
    this.renderEmpty();
  }

  setData(results, reviews, files) {
    this.entries = [];
    for (const [recordingKey, result] of results) {
      if (result.candidates.length === 0) {
        this.entries.push({
          entryId: `overview:${recordingKey}`,
          reviewId: `recording:${recordingKey}`,
          recordingKey,
          result,
          candidate: null,
        });
        continue;
      }
      for (const candidate of result.candidates) {
        this.entries.push({
          entryId: candidate.candidate_id,
          reviewId: candidate.candidate_id,
          recordingKey,
          result,
          candidate,
        });
      }
    }
    this.reviews = new Map(reviews.map((review) => [review.candidate_id, review]));
    this.files = files;
    const previous = this.selector.value;
    this.selector.replaceChildren();
    for (const entry of this.entries) {
      const option = document.createElement("option");
      option.value = entry.entryId;
      option.textContent = entry.candidate
        ? `${entry.result.metadata.recording} | ${entry.candidate.boutStart.toFixed(1)}-${entry.candidate.boutEnd.toFixed(1)} 秒`
        : `${entry.result.metadata.recording} | 整段录音复核（未发现候选片段）`;
      this.selector.append(option);
    }
    if (this.entries.some((entry) => entry.entryId === previous)) this.selector.value = previous;
    this.entries.length > 0 ? this.renderSelected() : this.renderEmpty();
  }

  selectedEntry() {
    return this.entries.find((entry) => entry.entryId === this.selector.value) ?? this.entries[0];
  }
  selectReview(reviewId) {
    const entry = this.entries.find((item) => item.reviewId === reviewId);
    if (!entry) return false;
    this.selector.value = entry.entryId;
    this.renderSelected();
    this.element.scrollIntoView({ block: "start" });
    return true;
  }

  moveSelection(offset) {
    if (this.entries.length === 0) return;
    const current = Math.max(0, this.selector.selectedIndex);
    const target = Math.min(this.entries.length - 1, Math.max(0, current + offset));
    if (target === current) return;
    this.selector.selectedIndex = target;
    this.renderSelected();
  }

  updateNavigation() {
    const index = this.entries.length > 0 ? Math.max(0, this.selector.selectedIndex) : -1;
    this.previousButton.disabled = index <= 0;
    this.nextButton.disabled = index < 0 || index >= this.entries.length - 1;
    this.position.textContent = index < 0 ? "0 / 0" : `${index + 1} / ${this.entries.length}`;
  }

  openChart() {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.largeChart.src = this.canvas.toDataURL("image/png");
    this.largeChart.alt = `${entry.result.metadata.recording} 分析图`;
    this.chartDialog.showModal();
  }

  renderEmpty() {
    this.selector.replaceChildren(new Option("暂无候选片段", ""));
    this.selector.disabled = true;
    this.element.querySelector('[data-role="filename"]').textContent = "-";
    this.updateNavigation();
    this.element.querySelector('[data-role="device"]').textContent = "-";
    this.element.querySelector('[data-role="times"]').textContent = "-";
    this.element.querySelector('[data-role="score"]').textContent = "-";
    this.decision.disabled = true;
    this.note.disabled = true;
    this.element.querySelector('button[type="submit"]').disabled = true;
    const context = this.canvas.getContext("2d");
    this.canvas.width = 960;
    this.canvas.height = 560;
    context.fillStyle = "#eef2ef";
    context.fillRect(0, 0, 960, 560);
    context.fillStyle = "#526159";
    context.font = "22px system-ui";
    context.textAlign = "center";
    context.fillText("分析完成后，候选片段会显示在这里。", 480, 280);
    this.updateAudioForEntry(null);
  }

  renderSelected() {
    const entry = this.selectedEntry();
    if (!entry) return this.renderEmpty();
    const isBout = Boolean(entry.candidate);
    this.selector.disabled = false;
    this.updateNavigation();
    this.decision.disabled = false;
    this.note.disabled = false;
    this.element.querySelector('button[type="submit"]').disabled = false;
    this.element.querySelector('[data-role="filename"]').textContent = entry.result.metadata.recording;
    this.element.querySelector('[data-role="device"]').textContent = entry.result.metadata.device || "未填写";
    this.element.querySelector('[data-role="times"]').textContent = isBout
      ? `${entry.candidate.boutStart.toFixed(1)}-${entry.candidate.boutEnd.toFixed(1)} 秒`
      : `0.0-${entry.result.metrics.audioSeconds.toFixed(1)} 秒（整段）`;
    this.element.querySelector('[data-role="score"]').textContent = isBout ? entry.candidate.ribbit.toFixed(4) : "无候选评分";
    const review = this.reviews.get(entry.reviewId);
    this.decision.value = review?.decision ?? "待确认";
    this.note.value = review?.note ?? "";
    this.element.querySelector('[data-role="saved"]').textContent = isBout
      ? ""
      : "未发现候选片段，可对整段录音保存复核结论。";
    renderAnalysisCanvas(this.canvas, entry.result, entry.candidate?.candidate_id);
    this.updateAudioForEntry(entry);
  }

  updateAudioForEntry(entry) {
    const file = entry ? (this.files.get(entry.recordingKey) ?? null) : null;
    const justLoaded = this.ensureAudio(file, entry ? entry.recordingKey : null);
    this.audioBar.hidden = !file;
    this.renderTimelineMarkers(entry);
    if (!file) {
      this.audioDuration = 0;
      this.updatePlayhead();
      return;
    }
    if (entry.candidate) {
      this.seekTo(entry.candidate.boutStart);
    } else if (justLoaded) {
      this.seekTo(0);
    }
  }

  ensureAudio(file, key) {
    if (key === this.audioKey && this.audioUrl) return false;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
    this.audioKey = key;
    this.audioDuration = 0;
    this.stopTicking();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (file) {
      this.audioUrl = URL.createObjectURL(file);
      this.audio.src = this.audioUrl;
    }
    return true;
  }

  renderTimelineMarkers(entry) {
    this.segmentsEl.replaceChildren();
    const result = entry?.result;
    const duration = result?.metrics?.audioSeconds;
    if (!result || !Number.isFinite(duration) || duration <= 0) return;
    const toPercent = (value) => `${(Math.min(duration, Math.max(0, value)) / duration) * 100}%`;
    for (const detection of result.detections ?? []) {
      const tick = document.createElement("span");
      tick.className = "timeline-detection";
      tick.style.left = toPercent(detection.start);
      tick.style.width = `max(${toPercent(detection.end - detection.start)}, 2px)`;
      tick.title = `检测片段 ${detection.start.toFixed(1)}–${detection.end.toFixed(1)} 秒 · RIBBIT ${detection.ribbit.toFixed(4)}`;
      this.segmentsEl.append(tick);
    }
    for (const candidate of result.candidates ?? []) {
      const marker = document.createElement("span");
      marker.className = candidate.candidate_id === entry.candidate?.candidate_id
        ? "timeline-candidate is-selected"
        : "timeline-candidate";
      marker.style.left = toPercent(candidate.boutStart);
      marker.style.width = `max(${toPercent(candidate.boutEnd - candidate.boutStart)}, 3px)`;
      marker.title = `候选片段 ${candidate.boutStart.toFixed(1)}–${candidate.boutEnd.toFixed(1)} 秒 · RIBBIT ${candidate.ribbit.toFixed(4)}`;
      this.segmentsEl.append(marker);
    }
  }

  seekTo(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (this.audioDuration > 0) seconds = Math.min(seconds, this.audioDuration);
    this.audio.currentTime = seconds;
    this.updatePlayhead();
  }

  seekBy(delta) {
    this.seekTo((this.audio.currentTime || 0) + delta);
  }

  jumpToCandidate() {
    const entry = this.selectedEntry();
    const target = entry?.candidate ? entry.candidate.boutStart : 0;
    this.seekTo(target);
  }

  togglePlay() {
    if (this.audioBar.hidden) return;
    if (this.audio.paused) {
      this.audio.play().catch(() => { /* 浏览器策略或解码失败时保持暂停 */ });
    } else {
      this.audio.pause();
    }
  }

  seekFromPointer(event) {
    if (this.audioDuration <= 0) return;
    const rect = this.timeline.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    this.seekTo(fraction * this.audioDuration);
  }

  updatePlayButton() {
    this.playButton.textContent = this.audio.paused ? "播放" : "暂停";
  }

  updatePlayhead() {
    const current = this.audio.currentTime || 0;
    const fraction = this.audioDuration > 0 ? Math.min(1, current / this.audioDuration) : 0;
    const percent = `${(fraction * 100).toFixed(4)}%`;
    this.playheadEl.style.left = percent;
    this.progressEl.style.width = percent;
    const label = `${formatTime(current)} / ${formatTime(this.audioDuration)}`;
    if (this.timeDisplay.textContent !== label) this.timeDisplay.textContent = label;
    this.timeline.setAttribute("aria-valuenow", String(Math.round(current)));
    this.timeline.setAttribute("aria-valuemax", String(Math.round(this.audioDuration)));
    this.timeline.setAttribute("aria-valuetext", label);
  }

  startTicking() {
    if (this.tickId !== null) return;
    const tick = () => {
      this.updatePlayhead();
      this.tickId = globalThis.requestAnimationFrame(tick);
    };
    this.tickId = globalThis.requestAnimationFrame(tick);
  }

  stopTicking() {
    if (this.tickId !== null) {
      globalThis.cancelAnimationFrame(this.tickId);
      this.tickId = null;
    }
  }
}

export { DECISIONS };

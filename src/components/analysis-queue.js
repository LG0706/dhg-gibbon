const STATUS_VALUES = new Set(["待分析", "分析中", "已完成", "失败"]);

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "-";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function formatFactor(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)}×` : "-";
}

export class AnalysisQueue {
  constructor({ onStart, onRemove, initialDevice = "", devices = [], onDeviceChange }) {
    this.records = [];
    this.onStart = onStart;
    this.onRemove = onRemove;
    this.onDeviceChange = onDeviceChange;
    this.busy = false;
    this.rowElements = new Map();
    this.emptyRow = null;
    this.element = document.createElement("section");
    this.element.className = "queue-panel";
    this.element.setAttribute("aria-labelledby", "queue-heading");
    this.element.innerHTML = `
      <div class="section-heading queue-heading-row">
        <div>
          <h2 id="queue-heading">分析队列</h2>
          <p data-role="summary">尚未添加录音。</p>
        </div>
        <div class="queue-actions">
          <label class="field queue-device-field">
            <span>当前设备或地点</span>
            <input data-role="device" type="text" list="known-devices" autocomplete="off" placeholder="例如：S4A" />
            <small>可先导入录音，再在分析前确认或修改；等待分析的录音会同步更新。</small>
          </label>
          <datalist id="known-devices" data-role="device-options"></datalist>
          <button class="primary-button" data-role="start" type="button">开始分析</button>
        </div>
      </div>
      <p class="inline-notice queue-device-notice" data-role="device-notice" aria-live="polite"></p>
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th scope="col">文件名</th>
            <th scope="col">设备或地点</th>
            <th scope="col">大小（MB）</th>
            <th scope="col">状态</th>
            <th scope="col">分析耗时</th>
            <th scope="col">实时倍数</th>
            <th scope="col">操作</th>
          </tr></thead>
          <tbody data-role="rows"></tbody>
        </table>
      </div>`;
    this.rows = this.element.querySelector('[data-role="rows"]');
    this.summary = this.element.querySelector('[data-role="summary"]');
    this.startButton = this.element.querySelector('[data-role="start"]');
    this.deviceInput = this.element.querySelector('[data-role="device"]');
    this.deviceOptions = this.element.querySelector('[data-role="device-options"]');
    this.deviceNotice = this.element.querySelector('[data-role="device-notice"]');
    this.setDeviceOptions(devices, initialDevice);
    this.deviceInput.addEventListener("input", () => {
      this.deviceNotice.textContent = "";
      this.onDeviceChange?.(this.deviceInput.value.trim(), false);
    });
    this.deviceInput.addEventListener("change", () => {
      const device = this.deviceInput.value.trim();
      this.deviceInput.value = device;
      this.onDeviceChange?.(device, true);
    });
    this.startButton.addEventListener("click", () => {
      if (this.busy) return;
      const pending = this.records.filter((record) => record.status === "待分析" && record.file);
      const device = this.deviceInput.value.trim();
      if (pending.length > 0 && !device) {
        this.deviceNotice.textContent = "请先填写设备或地点，再开始分析。";
        this.deviceInput.focus();
        return;
      }
      this.deviceNotice.textContent = "";
      this.onStart(pending, device);
    });
    this.render();
  }

  setDeviceOptions(devices, currentDevice = this.deviceInput.value) {
    this.deviceOptions.replaceChildren();
    for (const device of devices) {
      if (!device) continue;
      const option = document.createElement("option");
      option.value = device;
      this.deviceOptions.append(option);
    }
    this.deviceInput.value = currentDevice;
  }

  setRecords(records) {
    this.records = records;
    this.render();
  }

  updateRecord(id, updates) {
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    if (updates.status && !STATUS_VALUES.has(updates.status)) throw new RangeError(`未知队列状态: ${updates.status}`);
    Object.assign(record, updates);
    this.render();
  }
  setBusy(busy) {
    this.busy = Boolean(busy);
    this.render();
  }

  createRow(record) {
    const row = document.createElement("tr");
    const cells = {};
    for (const name of ["name", "device", "size", "status", "duration", "factor", "action"]) {
      const cell = document.createElement("td");
      cells[name] = cell;
      row.append(cell);
    }
    cells.duration.className = "numeric";
    cells.factor.className = "numeric";

    const status = document.createElement("span");
    const detail = document.createElement("small");
    detail.hidden = true;
    cells.status.append(status, detail);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger-button queue-remove";
    removeButton.addEventListener("click", () => this.onRemove(record.id));
    cells.action.append(removeButton);

    return { row, cells, status, detail, removeButton };
  }

  updateRow(elements, record) {
    elements.cells.name.textContent = record.name;
    elements.cells.device.textContent = record.device || "-";
    elements.cells.size.textContent = (record.size / (1024 * 1024)).toFixed(1);
    elements.status.className = `status status-${record.status}`;
    elements.status.textContent = record.status;
    elements.detail.hidden = true;
    elements.detail.className = "";
    elements.detail.textContent = "";
    if (Number.isFinite(record.progress) && record.status === "分析中") {
      elements.detail.hidden = false;
      elements.detail.textContent = ` ${Math.round(record.progress * 100)}%`;
    } else if (record.error) {
      elements.detail.hidden = false;
      elements.detail.className = "row-error";
      elements.detail.textContent = record.error.message;
    } else if (!record.file && record.status === "已完成") {
      elements.detail.hidden = false;
      elements.detail.textContent = "需要重新选择原始文件才能再次分析";
    }
    elements.cells.duration.textContent = formatDuration(record.metrics?.totalMs);
    elements.cells.factor.textContent = formatFactor(record.metrics?.realtimeFactor);
    elements.removeButton.textContent = record.status === "分析中" ? "停止并删除" : "删除";
    elements.removeButton.setAttribute("aria-label", `${elements.removeButton.textContent} ${record.name}`);
  }

  render() {
    const recordIds = new Set(this.records.map((record) => record.id));
    for (const [id, elements] of this.rowElements) {
      if (recordIds.has(id)) continue;
      elements.row.remove();
      this.rowElements.delete(id);
    }

    if (this.records.length === 0) {
      if (!this.emptyRow) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 7;
        cell.className = "empty-cell";
        cell.textContent = "导入 WAV 录音后，文件会显示在这里。";
        row.append(cell);
        this.emptyRow = row;
      }
      if (!this.emptyRow.isConnected) this.rows.append(this.emptyRow);
    } else {
      this.emptyRow?.remove();
      this.records.forEach((record, index) => {
        let elements = this.rowElements.get(record.id);
        if (!elements) {
          elements = this.createRow(record);
          this.rowElements.set(record.id, elements);
        }
        this.updateRow(elements, record);
        if (this.rows.children[index] !== elements.row) {
          this.rows.insertBefore(elements.row, this.rows.children[index] ?? null);
        }
      });
    }

    const pending = this.records.filter((record) => record.status === "待分析" && record.file).length;
    const active = this.records.some((record) => record.status === "分析中");
    this.startButton.disabled = pending === 0 || this.busy || active;
    this.summary.textContent = this.records.length === 0
      ? "尚未添加录音。"
      : `共 ${this.records.length} 个录音，${pending} 个等待分析。`;
  }
}

export { formatDuration, formatFactor };

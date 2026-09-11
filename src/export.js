import { strToU8, zipSync } from "fflate";
import { createAnalysisImageBlob, IMAGE_RENDERER_VERSION } from "./render.js";

const DETECTION_COLUMNS = ["检测类别", "序号", "开始时间（秒）", "结束时间（秒）", "来源目录", "文件名", "设备或地点", "检测方法", "RIBBIT 评分", "候选编号", "是否进入人工复核"];
const REVIEW_COLUMNS = ["候选编号", "文件名", "复核结论", "备注", "更新时间"];
const MANIFEST_COLUMNS = ["文件名", "设备或地点", "文件大小（字节）", "文件最后修改时间", "状态", "分析耗时（毫秒）", "实时倍数"];
const ERROR_COLUMNS = ["文件名", "错误类型", "错误说明"];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return strToU8(`\ufeff${lines.join("\r\n")}\r\n`);
}

function timestamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function imageFilename(recording) {
  const stem = recording.replace(/\.wav$/i, "").normalize("NFKC").replace(/[\\/:*?"<>|]+/g, "-") || "录音";
  return `${stem}.png`;
}
function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const part = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}
function rounded(value, digits) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

const ERROR_NAMES = {
  decoder_finished: "解码器已结束",
  invalid_chunk: "数据块无效",
  invalid_wave: "不是有效录音",
  corrupt_header: "文件头损坏",
  incomplete_file: "文件不完整",
  missing_format: "缺少格式信息",
  missing_audio: "缺少音频数据",
  unsupported_codec: "编码格式不支持",
  unsupported_channels: "声道数量不支持",
  sample_rate_too_low: "采样率过低",
  unsupported_bit_depth: "位深不支持",
  corrupt_format: "音频格式损坏",
  worker_busy: "分析器正忙",
  unknown_file: "未找到活动录音",
  unknown_message: "分析指令无法识别",
  worker_crash: "分析工作线程异常",
  out_of_memory: "浏览器内存不足",
  terminated: "分析已停止",
  analysis_failed: "分析失败",
};

function localizedMetrics(metrics = {}) {
  return {
    "解码耗时（毫秒）": rounded(metrics.decodeMs, 3),
    "能量特征计算耗时（毫秒）": rounded(metrics.featureMs, 3),
    "HMM 耗时（毫秒）": rounded(metrics.hmmMs, 3),
    "RIBBIT 评分耗时（毫秒）": rounded(metrics.scoreMs, 3),
    "频谱图计算耗时（毫秒）": rounded(metrics.spectrogramMs, 3),
    "总分析耗时（毫秒）": rounded(metrics.totalMs, 3),
    "录音时长（秒）": rounded(metrics.audioSeconds, 3),
    "实时倍数": rounded(metrics.realtimeFactor, 6),
  };
}

function localizedParameters(parameters) {
  if (!parameters) return null;
  return {
    "能量窗口长度（秒）": parameters.windowSeconds,
    "能量频率范围（赫兹）": parameters.energyBandHz,
    "最短候选时长（秒）": parameters.minimumBoutSeconds,
    "RIBBIT 评分频率范围（赫兹）": parameters.ribbitBandHz,
    "RIBBIT 人工复核阈值": parameters.candidateScoreThreshold,
    "频谱预览长度（秒）": parameters.previewSeconds,
    "频谱频率范围（赫兹）": parameters.spectrogramBandHz,
    "频谱窗口长度（秒）": parameters.spectrogramWindowSeconds,
    "频谱补零点数": parameters.spectrogramZeroPadding,
    "显示动态范围（分贝）": parameters.displayDynamicRangeDb,
  };
}

function usageGuide() {
  return `# 长臂猿录音分析结果使用说明

## 结果文件

- **检测结果.csv**：HMM 检测到的所有长时间候选片段。开始和结束时间均以录音开头为零点，单位为秒。“RIBBIT 评分”用于候选排序，不是出现长臂猿的概率。“是否进入人工复核”为“是”的片段超过设定评分阈值。
- **复核结果.csv**：工作人员在页面中保存的复核结论和备注。可通过“候选编号”与检测结果对应。
- **录音清单.csv**：本次队列中的录音、设备或地点、文件大小、分析状态和耗时。

## 研究资料

“研究资料”文件夹供研究人员排查和复现实验使用，日常复核通常不需要打开。

- **研究资料/错误记录.csv**：无法完成分析的录音及错误原因。没有错误时仅保留表头。
- **研究资料/运行记录.txt**：每段录音在浏览器中的各阶段耗时，用于检查分析性能。
- **研究资料/分析参数.json**：本次分析采用的固定参数及各录音的运行数据。
- **研究资料/分析图/**：每段已完成录音的能量曲线、HMM 状态、候选区间和候选频谱图。

## 分析图怎么看

- **env** 表示归一化能量，数值越高表示目标频率范围内的声音能量越强。
- **t** 表示从录音开头开始计算的时间，单位为秒。
- **class** 表示 HMM 分类；**P** 表示可能存在目标声纹，**N** 表示未检测到目标声纹。
- 图中标出的白色小数是 RIBBIT 评分，该评分不是概率。

## 使用方法

1. 先打开“复核结果.csv”，查看工作人员已经确认的结论和备注。
2. 需要核对时间或 RIBBIT 评分时，用“候选编号”在“检测结果.csv”中找到同一片段。
3. 需要查看声音分布时，打开“研究资料/分析图”文件夹中同名的图片。
4. 将整个压缩包作为一次完整结果保存，不要只单独保留某一个表格。

## 注意事项

- 原始录音不会包含在导出包中，请另外妥善保存。
- 表格采用适合 Excel 和 WPS 的中文 UTF-8 编码。
- 模型结果只能帮助筛查，最终结论应以人工复核为准。
`;
}

export async function buildExportArchive({ records, storedResults, reviews, errors = [], date = new Date() }) {
  const completed = records.filter((record) => storedResults.has(record.key));
  const detections = completed.flatMap((record) => (
    storedResults.get(record.key).result.detections.map((detection) => ({
      "检测类别": detection.label === "P" ? "候选片段" : "非候选片段",
      "序号": detection.selec,
      "开始时间（秒）": detection.start,
      "结束时间（秒）": detection.end,
      "来源目录": detection.dir,
      "文件名": detection.recording,
      "设备或地点": detection.group,
      "检测方法": detection.threshold === "hmm" ? "HMM" : detection.threshold,
      "RIBBIT 评分": detection.ribbit,
      "候选编号": detection.candidate_id,
      "是否进入人工复核": detection.is_candidate ? "是" : "否",
    }))
  ));
  const manifest = records.map((record) => ({
    "文件名": record.name,
    "设备或地点": record.device,
    "文件大小（字节）": record.size,
    "文件最后修改时间": formatDate(record.lastModified),
    "状态": record.status,
    "分析耗时（毫秒）": rounded(record.metrics?.totalMs, 3),
    "实时倍数": rounded(record.metrics?.realtimeFactor, 6),
  }));
  const reviewRows = Array.from(reviews.values()).map((review) => ({
    "候选编号": review.candidate_id,
    "文件名": review.recording,
    "复核结论": review.decision,
    "备注": review.note,
    "更新时间": formatDate(review.updatedAt),
  }));
  const errorRows = errors.map((item) => ({
    "文件名": item.filename ?? item.recording ?? "",
    "错误类型": ERROR_NAMES[item.code] ?? "分析失败",
    "错误说明": item.message ?? "",
  }));

  const runLog = completed.map((record) => {
    const metrics = storedResults.get(record.key).result.metrics;
    return [
      `录音文件：${record.name}`,
      `解码耗时（毫秒）：${metrics.decodeMs.toFixed(3)}`,
      `能量特征计算耗时（毫秒）：${metrics.featureMs.toFixed(3)}`,
      `HMM 耗时（毫秒）：${metrics.hmmMs.toFixed(3)}`,
      `RIBBIT 评分耗时（毫秒）：${metrics.scoreMs.toFixed(3)}`,
      `频谱图计算耗时（毫秒）：${metrics.spectrogramMs.toFixed(3)}`,
      `总分析耗时（毫秒）：${metrics.totalMs.toFixed(3)}`,
      `录音时长（秒）：${metrics.audioSeconds.toFixed(3)}`,
      `实时倍数：${metrics.realtimeFactor.toFixed(6)}`,
    ].join("\n");
  }).join("\n\n");

  const parameterRuns = completed.map((record) => {
    const result = storedResults.get(record.key).result;
    return {
      "文件名": record.name,
      "设备或地点": record.device,
      "运行数据": localizedMetrics(result.metrics),
    };
  });
  const parameters = {
    "说明": "本文件记录本次导出使用的固定分析参数和每段录音的运行性能。",
    "生成时间": formatDate(date),
    "固定分析参数": completed[0] ? localizedParameters(storedResults.get(completed[0].key).result.parameters) : null,
    "各录音运行情况": parameterRuns,
  };

  const entries = {
    "检测结果.csv": csv(DETECTION_COLUMNS, detections),
    "复核结果.csv": csv(REVIEW_COLUMNS, reviewRows),
    "录音清单.csv": csv(MANIFEST_COLUMNS, manifest),
    "研究资料/错误记录.csv": csv(ERROR_COLUMNS, errorRows),
    "研究资料/运行记录.txt": strToU8(`\ufeff${runLog}${runLog ? "\n" : ""}`),
    "研究资料/分析参数.json": strToU8(`${JSON.stringify(parameters, null, 2)}\n`),
    "使用说明.md": strToU8(`\ufeff${usageGuide()}`),
  };

  for (const record of completed) {
    const stored = storedResults.get(record.key);
    const blob = stored.imageBlob && stored.imageRendererVersion === IMAGE_RENDERER_VERSION
      ? stored.imageBlob
      : await createAnalysisImageBlob(stored.result);
    entries[`研究资料/分析图/${imageFilename(record.name)}`] = new Uint8Array(await blob.arrayBuffer());
  }

  return {
    bytes: zipSync(entries, { level: 6 }),
    filename: `长臂猿录音分析-${timestamp(date)}.zip`,
    entryNames: Object.keys(entries),
  };
}

export async function downloadExport(input) {
  const archive = await buildExportArchive(input);
  const url = URL.createObjectURL(new Blob([archive.bytes], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = archive.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return archive;
}

export { DETECTION_COLUMNS, timestamp };

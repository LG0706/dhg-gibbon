import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildExportArchive } from "../src/export.js";
import { IMAGE_RENDERER_VERSION } from "../src/render.js";

const metrics = {
  decodeMs: 1,
  featureMs: 2,
  hmmMs: 3,
  scoreMs: 4,
  spectrogramMs: 5,
  totalMs: 15,
  audioSeconds: 60,
  realtimeFactor: 0.00025,
};

describe("analysis ZIP export", () => {
  it("separates staff results from research files and preserves model names", async () => {
    const record = {
      key: "recording-key",
      name: "S4 test.wav",
      device: "S4A",
      size: 1234,
      lastModified: 0,
      status: "已完成",
      metrics,
    };
    const result = {
      metadata: { recording: record.name, device: record.device },
      parameters: { windowSeconds: 1 },
      metrics,
      detections: [{
        label: "P", selec: 1, start: 1, end: 200, dir: "S4A", recording: record.name,
        group: "S4A", threshold: "hmm", ribbit: 0.2, candidate_id: "candidate-1", is_candidate: true,
      }],
    };
    const storedResults = new Map([[record.key, {
      recordingKey: record.key,
      result,
      imageBlob: new Blob([Uint8Array.from([137, 80, 78, 71])], { type: "image/png" }),
      imageRendererVersion: IMAGE_RENDERER_VERSION,
    }]]);
    const archive = await buildExportArchive({
      records: [record],
      storedResults,
      reviews: new Map([["candidate-1", {
        candidate_id: "candidate-1", recording: record.name, decision: "疑似", note: "复核", updatedAt: "2026-09-04T00:00:00.000Z",
      }]]),
      date: new Date("2026-09-04T01:02:03"),
    });
    const files = unzipSync(archive.bytes);
    expect(Object.keys(files).sort()).toEqual([
      "检测结果.csv", "复核结果.csv", "录音清单.csv", "使用说明.md",
      "研究资料/错误记录.csv", "研究资料/运行记录.txt", "研究资料/分析参数.json", "研究资料/分析图/S4 test.png",
    ].sort());
    for (const filename of ["检测结果.csv", "复核结果.csv", "录音清单.csv", "研究资料/错误记录.csv"]) {
      expect(files[filename].slice(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
    }
    expect(strFromU8(files["检测结果.csv"])).toContain("检测类别,序号,开始时间（秒）,结束时间（秒）,来源目录,文件名,设备或地点,检测方法,RIBBIT 评分,候选编号,是否进入人工复核");
    expect(strFromU8(files["检测结果.csv"])).toContain("候选片段");
    expect(strFromU8(files["检测结果.csv"])).toContain(",HMM,0.2,");
    expect(strFromU8(files["复核结果.csv"])).toContain("复核结论");
    expect(strFromU8(files["录音清单.csv"])).toContain("S4A");
    expect(strFromU8(files["研究资料/运行记录.txt"])).toContain("HMM 耗时（毫秒）：3.000");
    expect(strFromU8(files["研究资料/运行记录.txt"])).toContain("RIBBIT 评分耗时（毫秒）：4.000");
    expect(strFromU8(files["研究资料/运行记录.txt"])).toContain("实时倍数：0.000250");
    const parameters = JSON.parse(strFromU8(files["研究资料/分析参数.json"]));
    expect(parameters["各录音运行情况"][0]["运行数据"]["总分析耗时（毫秒）"]).toBe(15);
    expect(parameters["各录音运行情况"][0]["运行数据"]["HMM 耗时（毫秒）"]).toBe(3);
    expect(strFromU8(files["使用说明.md"])).toContain("“研究资料”文件夹供研究人员");
    expect(strFromU8(files["使用说明.md"])).toContain("RIBBIT 评分”用于候选排序，不是出现长臂猿的概率");
    expect(archive.filename).toBe("长臂猿录音分析-20260904-010203.zip");
  });
});

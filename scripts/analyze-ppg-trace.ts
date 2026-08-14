import fs from "node:fs";
import path from "node:path";
import type {
  PpgBeat,
  PpgDecision,
  PpgDiagnostics,
  PpgFrameSample,
} from "../packages/ppg-core/src/index.ts";

/**
 * iPhone 앱의 'PPG 로그 공유'로 저장한 JSON을 요약합니다.
 * 영상/사진은 읽지 않으며 RGB 평균, 품질 점수, 판정과 박동 시각만 다룹니다.
 *
 * 사용법:
 *   npm run analyze:ppg:trace -- /absolute/path/to/trace.json
 */

interface TraceFrameRecord {
  kind?: "frame";
  timestamp: number;
  sample: PpgFrameSample;
  result: {
    fingerDetected: boolean;
    signalQuality: number;
    bpm: number | null;
    beat: PpgBeat | null;
    diagnostics: PpgDiagnostics;
  };
}

interface TraceBridgedRecord {
  kind: "bridged";
  timestamp: number;
  beat: PpgBeat;
}

interface TraceFile {
  format: "heartrace-ppg-trace-v1" | "heartrace-ppg-trace-v2";
  records: Array<TraceFrameRecord | TraceBridgedRecord>;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error(
    "PPG trace JSON 경로가 필요합니다. 예: npm run analyze:ppg:trace -- /path/to/trace.json",
  );
  process.exitCode = 1;
} else {
  analyze(path.resolve(inputPath));
}

function analyze(file: string): void {
  const trace = JSON.parse(fs.readFileSync(file, "utf8")) as TraceFile;
  if (!Array.isArray(trace.records))
    throw new Error("올바른 PPG trace가 아닙니다.");
  const frames = trace.records.filter(isFrame);
  const bridged = trace.records.filter(isBridged);
  const observed = frames.flatMap((record) =>
    record.result.beat ? [record.result.beat] : [],
  );
  const allBeats = [...observed, ...bridged.map((record) => record.beat)].sort(
    (left, right) => left.detectedAt - right.detectedAt,
  );
  const startedAt = trace.records.at(0)?.timestamp ?? 0;
  const finishedAt = trace.records.at(-1)?.timestamp ?? startedAt;
  const qualities = frames.map((record) => record.result.signalQuality);
  const contactFrames = frames.filter((record) => record.result.fingerDetected);

  console.table([
    {
      format: trace.format,
      durationSeconds: round((finishedAt - startedAt) / 1_000, 1),
      numericFrames: frames.length,
      contactRate: ratio(contactFrames.length, frames.length),
      observedBeats: observed.length,
      bridgedBeats: bridged.length,
      beatsPerMinute:
        finishedAt === startedAt
          ? 0
          : round((allBeats.length * 60_000) / (finishedAt - startedAt), 1),
      medianSignalQuality: round(median(qualities), 3),
      firstObservedLatencyMs:
        observed.length === 0
          ? null
          : Math.round((observed[0]?.detectedAt ?? startedAt) - startedAt),
      longestBeatGapMs: longestGap(allBeats.map((beat) => beat.detectedAt)),
    },
  ]);

  const decisions = countBy(
    frames.map((record) => record.result.diagnostics.decision),
  );
  console.table(
    Object.entries(decisions)
      .map(([decision, count]) => ({
        decision,
        count,
        ratio: ratio(count, frames.length),
      }))
      .sort((left, right) => right.count - left.count),
  );

  console.table([
    componentSummary("contact", contactFrames, (item) => item.contactQuality),
    componentSummary("optical", contactFrames, (item) => item.opticalQuality),
    componentSummary("motion", contactFrames, (item) => item.motionQuality),
    componentSummary("rhythm", contactFrames, (item) => item.rhythmConfidence),
  ]);

  const bottleneck = inferBottleneck(decisions, frames.length, bridged.length);
  console.log(`\n판정 힌트: ${bottleneck}`);
}

function isFrame(
  record: TraceFrameRecord | TraceBridgedRecord,
): record is TraceFrameRecord {
  return record.kind !== "bridged" && "result" in record;
}

function isBridged(
  record: TraceFrameRecord | TraceBridgedRecord,
): record is TraceBridgedRecord {
  return record.kind === "bridged";
}

function componentSummary(
  component: string,
  records: TraceFrameRecord[],
  pick: (diagnostics: PpgDiagnostics) => number,
) {
  const values = records.map((record) => pick(record.result.diagnostics));
  return {
    component,
    median: round(median(values), 3),
    p10: round(quantile(values, 0.1), 3),
    p90: round(quantile(values, 0.9), 3),
  };
}

function inferBottleneck(
  decisions: Partial<Record<PpgDecision, number>>,
  totalFrames: number,
  bridgedBeats: number,
): string {
  const fraction = (decision: PpgDecision) =>
    (decisions[decision] ?? 0) / Math.max(1, totalFrames);
  if (fraction("no_contact") + fraction("contact_grace") > 0.25) {
    return "접촉 판정 손실이 큽니다. ROI 색 분포와 접촉 hysteresis부터 확인하세요.";
  }
  if (fraction("motion_rejected") > 0.08) {
    return "움직임 판정이 주 병목입니다. 프레임 RGB 변화와 실제 손가락 움직임을 대조하세요.";
  }
  if (fraction("warming_up") > 0.18) {
    return "카메라/노출 재시작이 잦습니다. 렌즈 전환과 화면 전환 시 필터 reset을 확인하세요.";
  }
  if (fraction("extra_peak_rejected") > 0.08) {
    return "이중 peak 또는 실제 급격한 cadence 전환 후보가 많습니다. 후보 강도와 IBI 교대 패턴을 확인하세요.";
  }
  if (bridgedBeats > 0 || fraction("below_threshold") > 0.85) {
    return "접촉은 유지되지만 slope threshold를 넘는 박동이 적습니다. 채널 진폭과 임계값 분포를 비교하세요.";
  }
  return "한 가지 품질 gate보다 개별 박동 판정과 서버 승인 흐름을 함께 확인하는 편이 좋습니다.";
}

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function longestGap(timestamps: number[]): number | null {
  if (timestamps.length < 2) return null;
  let longest = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    longest = Math.max(
      longest,
      (timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0),
    );
  }
  return Math.round(longest);
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[
      Math.max(
        0,
        Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)),
      )
    ] ?? 0
  );
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

function ratio(numerator: number, denominator: number): number {
  return round(numerator / Math.max(1, denominator), 3);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

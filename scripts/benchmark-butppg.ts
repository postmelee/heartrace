import fs from "node:fs";
import path from "node:path";
import {
  PpgBeatHoldover,
  PpgProcessor,
} from "../packages/ppg-core/src/index.ts";

/**
 * PhysioNet BUT PPG 1.0.0 전체를 재생하는 오프라인 회귀 도구입니다.
 * Dataset: https://physionet.org/content/butppg/1.0.0/ (CC BY 4.0)
 *
 * 사용법:
 *   npm run benchmark:ppg:but -- /absolute/path/to/but-ppg-1.0.0
 */

interface Annotation {
  id: string;
  quality: number;
  referenceBpm: number;
}

interface Result extends Annotation {
  estimateBpm: number | null;
  maxBpm: number | null;
  absoluteError: number | null;
  beats: number;
  expectedBeats: number;
  detectionRate: number;
  firstBeatLatencyMs: number | null;
  longestObservedGapMs: number | null;
  bridgedBeats: number;
  movementEvents: number;
  movementDetectionRate: number;
  longestMovementGapMs: number | null;
}

interface WfdbPpg {
  samples: number[];
  samplingFrequency: number;
}

const datasetRoot = process.argv[2];
const inspectedRecord = process.argv[3];
if (!datasetRoot) {
  console.error(
    "BUT PPG 데이터셋 경로가 필요합니다. 예: npm run benchmark:ppg:but -- /path/to/but-ppg-1.0.0",
  );
  process.exitCode = 1;
} else {
  runBenchmark(path.resolve(datasetRoot));
}

function runBenchmark(root: string): void {
  const annotations = readAnnotations(root);
  const results = annotations.map((annotation) =>
    replayRecord(root, annotation),
  );

  console.table([1, 0].map((quality) => summarize(results, quality)));
  console.table(
    results
      .filter((result) => result.absoluteError !== null)
      .sort(
        (left, right) => (right.absoluteError ?? 0) - (left.absoluteError ?? 0),
      )
      .slice(0, 10),
  );
}

function readAnnotations(root: string): Annotation[] {
  const file = path.join(root, "quality-hr-ann.csv");
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [id = "", quality = "", referenceBpm = ""] = line.split(",");
      return {
        id,
        quality: Number(quality),
        referenceBpm: Number(referenceBpm),
      };
    });
}

function replayRecord(root: string, annotation: Annotation): Result {
  const { samples: normalized, samplingFrequency } = readNormalizedPpg(
    root,
    annotation.id,
  );
  const processor = new PpgProcessor();
  const holdover = new PpgBeatHoldover();
  const bpms: number[] = [];
  const beatTimes: number[] = [];
  const movementTimes: number[] = [];
  let bridgedBeats = 0;
  const startedAt = 1_000;

  normalized.forEach((value, index) => {
    // BUT PPG는 red intensity 한 채널만 제공하므로 실제 앱의 RGB 평균값
    // 범위에 맞춰 재구성합니다. 공간 편차·노출 품질은 이 벤치마크 범위가
    // 아니며 peak/IBI 로직만 비교합니다.
    const result = processor.process({
      timestamp: startedAt + index * (1_000 / samplingFrequency),
      // BUT PPG는 카메라 red 평균을 반전한 생리학적 파형입니다. 실제
      // 카메라 밝기로 되돌린 뒤 처리기의 내부 극성 보정을 검증합니다.
      red: 220 - value * 4,
      green: 75 + value * 0.8,
      blue: 50,
    });
    if (
      inspectedRecord === annotation.id &&
      result.diagnostics.decision !== "below_threshold" &&
      result.diagnostics.decision !== "warming_up"
    ) {
      console.log({
        atMs: Math.round(index * (1_000 / samplingFrequency)),
        decision: result.diagnostics.decision,
        strength: round(result.diagnostics.slopeSum, 6),
        threshold: round(result.diagnostics.slopeThreshold, 6),
        ibi: result.beat?.ibiMs ?? null,
        bpm: result.beat?.bpm ?? result.bpm,
      });
    }
    if (result.beat) {
      bpms.push(result.beat.bpm);
      beatTimes.push(result.beat.detectedAt);
      if (holdover.observeReal(result.beat)) {
        movementTimes.push(result.beat.detectedAt);
      }
    }
    const bridged = holdover.poll(
      startedAt + index * (1_000 / samplingFrequency),
    );
    if (bridged) {
      bridgedBeats += 1;
      movementTimes.push(bridged.detectedAt);
    }
  });

  const estimateBpm = bpms.at(-1) ?? null;
  const durationMs = (normalized.length / samplingFrequency) * 1_000;
  const expectedBeats =
    (durationMs / 60_000) * Math.max(1, annotation.referenceBpm);
  return {
    ...annotation,
    estimateBpm,
    maxBpm: bpms.length > 0 ? Math.max(...bpms) : null,
    absoluteError:
      estimateBpm === null
        ? null
        : Math.abs(estimateBpm - annotation.referenceBpm),
    beats: bpms.length,
    expectedBeats: round(expectedBeats, 1),
    detectionRate: round(bpms.length / Math.max(1, expectedBeats), 3),
    firstBeatLatencyMs:
      beatTimes.length === 0
        ? null
        : Math.round((beatTimes[0] ?? 0) - startedAt),
    longestObservedGapMs: longestGap(beatTimes),
    bridgedBeats,
    movementEvents: movementTimes.length,
    movementDetectionRate: round(
      movementTimes.length / Math.max(1, expectedBeats),
      3,
    ),
    longestMovementGapMs: longestGap(movementTimes.sort((a, b) => a - b)),
  };
}

function readNormalizedPpg(root: string, id: string): WfdbPpg {
  const recordDirectory = fs.existsSync(path.join(root, id))
    ? path.join(root, id)
    : root;
  const headerPath = path.join(recordDirectory, `${id}_PPG.hea`);
  const lines = fs.readFileSync(headerPath, "utf8").trim().split(/\r?\n/);
  const recordFields = (lines[0] ?? "").trim().split(/\s+/);
  const signalCount = Number(recordFields[1]);
  const samplingFrequency = Number(recordFields[2]);
  const frameCount = Number(recordFields[3]);
  const signalLines = lines
    .slice(1, 1 + signalCount)
    .filter((line) => line.includes("_PPG.dat"));
  const signalLine = signalLines[0];
  if (
    !signalLine ||
    !Number.isFinite(signalCount) ||
    !Number.isFinite(samplingFrequency) ||
    !Number.isFinite(frameCount)
  ) {
    throw new Error(`WFDB header parse failed: ${headerPath}`);
  }
  const fields = signalLine.trim().split(/\s+/);
  const dataFile = fields[0];
  const format = fields[1]?.split(/[x:+]/)[0];
  if (!dataFile || format !== "16") {
    throw new Error(
      `지원하지 않는 WFDB 형식(${format ?? "unknown"}): ${signalLine}`,
    );
  }
  const bytes = fs.readFileSync(path.join(recordDirectory, dataFile));
  let raw: number[];
  if (frameCount === 1 && signalLines.length === signalCount) {
    // BUT PPG 1.0.0은 10초 파형을 1신호×300샘플이 아니라
    // 300신호×1프레임으로 기록했습니다. 각 신호 명세의 gain/baseline을
    // 적용해야 실제 시간축 파형이 복원됩니다.
    raw = signalLines.map((line, index) => {
      const calibration = line.match(
        /\s16\s+(-?[0-9.]+)\((-?[0-9]+)\)\/[^\s]+/,
      );
      if (!calibration) throw new Error(`gain parse failed: ${line}`);
      const gain = Number(calibration[1]);
      const baseline = Number(calibration[2]);
      const digital = bytes.readInt16LE(index * 2);
      return (digital - baseline) / gain;
    });
  } else if (signalCount === 1) {
    const calibration = signalLine.match(
      /\s16\s+(-?[0-9.]+)(?:\((-?[0-9]+)\))?\/[^\s]+/,
    );
    const gain = Number(calibration?.[1] ?? 1);
    const baseline = Number(calibration?.[2] ?? 0);
    raw = Array.from(
      { length: Math.floor(bytes.length / 2) },
      (_, index) => (bytes.readInt16LE(index * 2) - baseline) / gain,
    );
  } else {
    throw new Error(
      `지원하지 않는 WFDB 배열: signals=${signalCount}, frames=${frameCount}`,
    );
  }
  const mean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
  const stdDev = Math.sqrt(
    raw.reduce((sum, value) => sum + (value - mean) ** 2, 0) / raw.length,
  );
  return {
    samples: raw.map((value) => (value - mean) / Math.max(stdDev, 1e-9)),
    samplingFrequency,
  };
}

function summarize(results: Result[], quality: number) {
  const group = results.filter((result) => result.quality === quality);
  const detected = group.filter((result) => result.estimateBpm !== null);
  return {
    quality,
    records: group.length,
    detected: detected.length,
    meanAbsoluteError: Number(
      (
        detected.reduce((sum, result) => sum + (result.absoluteError ?? 0), 0) /
        Math.max(1, detected.length)
      ).toFixed(1),
    ),
    errorsOver10Bpm: detected.filter(
      (result) => (result.absoluteError ?? 0) > 10,
    ).length,
    spikesAtLeast180Bpm: detected.filter(
      (result) => (result.maxBpm ?? 0) >= 180,
    ).length,
    meanDetectionRate: round(
      group.reduce((sum, result) => sum + result.detectionRate, 0) /
        Math.max(1, group.length),
      3,
    ),
    meanMovementDetectionRate: round(
      group.reduce((sum, result) => sum + result.movementDetectionRate, 0) /
        Math.max(1, group.length),
      3,
    ),
    firstBeatOver3Seconds: group.filter(
      (result) => (result.firstBeatLatencyMs ?? Infinity) > 3_000,
    ).length,
    movementGapOver2Point5Seconds: group.filter(
      (result) => (result.longestMovementGapMs ?? Infinity) > 2_500,
    ).length,
  };
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

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

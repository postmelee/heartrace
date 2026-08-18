import { describe, expect, it } from "vitest";
import { PpgBeatHoldover, PpgProcessor, scoreFinger } from "../src/index";
import {
  BUTPPG_105001,
  BUTPPG_105001_REFERENCE_BPM,
} from "./fixtures/butppg-105001";

function longestGap(timestamps: number[]): number {
  return timestamps
    .slice(1)
    .reduce(
      (longest, timestamp, index) =>
        Math.max(longest, timestamp - (timestamps[index] ?? timestamp)),
      0,
    );
}

describe("카메라 PPG 처리", () => {
  it("카메라 전환 중 마지막 cadence를 한 박동씩만 이어간다", () => {
    const holdover = new PpgBeatHoldover();
    const realBeat = {
      detectedAt: 1_000,
      ibiMs: 600,
      bpm: 100,
      confidence: 0.96,
      signalQuality: 0.94,
    };
    expect(holdover.observeReal(realBeat)).toBe(true);
    holdover.prepareCameraTransition(1_200);

    expect(holdover.poll(1_700)).toBeNull();
    const predicted = holdover.poll(1_800);
    expect(predicted?.detectedAt).toBe(1_600);
    expect(predicted?.bpm).toBe(100);
    expect(holdover.poll(1_810)).toBeNull();
  });

  it("보간 박동과 겹친 실제 박동은 중복 전달하지 않고 새 기준으로 삼는다", () => {
    const holdover = new PpgBeatHoldover();
    holdover.observeReal({
      detectedAt: 1_000,
      ibiMs: 600,
      bpm: 100,
      confidence: 0.96,
      signalQuality: 0.94,
    });
    holdover.prepareCameraTransition(1_200);
    expect(holdover.poll(1_800)).not.toBeNull();

    expect(
      holdover.observeReal({
        detectedAt: 1_650,
        ibiMs: 610,
        bpm: 98,
        confidence: 0.94,
        signalQuality: 0.92,
      }),
    ).toBe(false);
    expect(holdover.poll(2_100)).toBeNull();
  });

  it("일반 신호 유실은 한 박동만 이어가고 연속 보간하지 않는다", () => {
    const holdover = new PpgBeatHoldover();
    holdover.observeReal({
      detectedAt: 1_000,
      ibiMs: 600,
      bpm: 100,
      confidence: 0.96,
      signalQuality: 0.94,
    });

    expect(holdover.canHold(1_700)).toBe(true);
    expect(holdover.poll(1_800)).not.toBeNull();
    expect(holdover.canHold(1_900)).toBe(false);
    expect(holdover.poll(2_400)).toBeNull();
  });

  it("붉게 덮인 렌즈와 열린 렌즈를 구분한다", () => {
    expect(scoreFinger(225, 78, 52)).toBeGreaterThan(0.7);
    expect(scoreFinger(110, 108, 112)).toBeLessThan(0.3);
  });

  it("75 BPM 합성 파형에서 반복 박동과 BPM을 검출한다", () => {
    const processor = new PpgProcessor();
    const beats = [];
    const fps = 30;
    const durationSeconds = 14;

    for (let frame = 0; frame < fps * durationSeconds; frame += 1) {
      const seconds = frame / fps;
      const phase = seconds * 2 * Math.PI * 1.25;
      const pulse = Math.sin(phase) * 5 + Math.sin(phase * 2) * 1.2;
      const result = processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 222 + pulse,
        green: 72 - pulse * 0.18,
        blue: 48,
      });
      if (result.beat) beats.push(result.beat);
    }

    expect(beats.length).toBeGreaterThanOrEqual(12);
    expect(beats.at(-1)?.bpm).toBeGreaterThanOrEqual(73);
    expect(beats.at(-1)?.bpm).toBeLessThanOrEqual(77);
    expect(beats.at(-1)?.confidence).toBeGreaterThan(0.58);
  });

  it("RGB 채널이 같은 비율로 변하는 접촉 신호에서도 박동을 보존한다", () => {
    const processor = new PpgProcessor();
    const beats = [];
    const fps = 30;

    for (let frame = 0; frame < fps * 14; frame += 1) {
      const seconds = frame / fps;
      const pulse = Math.sin(seconds * 2 * Math.PI * 1.25) * 0.009;
      const slowExposure = Math.sin(seconds * 2 * Math.PI * 0.12) * 3;
      const result = processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: (220 + slowExposure) * (1 + pulse),
        green: (76 + slowExposure * 0.25) * (1 + pulse),
        blue: 48 * (1 + pulse),
      });
      if (result.beat) beats.push(result.beat);
    }

    expect(beats.length).toBeGreaterThanOrEqual(12);
    expect(beats.at(-1)?.bpm).toBeGreaterThanOrEqual(73);
    expect(beats.at(-1)?.bpm).toBeLessThanOrEqual(77);
  });

  it("빨강 채널이 포화되면 초록 채널로 전환한다", () => {
    const processor = new PpgProcessor();
    const beats = [];
    let lastResult = null;
    const fps = 30;

    for (let frame = 0; frame < fps * 14; frame += 1) {
      const seconds = frame / fps;
      const pulse = Math.sin(seconds * 2 * Math.PI * 1.5) * 2.4;
      lastResult = processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 253,
        green: 92 + pulse,
        blue: 50,
      });
      if (lastResult.beat) beats.push(lastResult.beat);
    }

    expect(lastResult?.diagnostics.channel).toBe("green");
    expect(beats.length).toBeGreaterThanOrEqual(15);
    expect(beats.at(-1)?.bpm).toBeGreaterThanOrEqual(88);
    expect(beats.at(-1)?.bpm).toBeLessThanOrEqual(92);
    expect(beats.at(-1)?.confidence).toBeGreaterThan(0.58);
  });

  it("경기 시작 기준을 보존하면서 80 BPM에서 130 BPM 전환을 연속 확인한다", () => {
    const processor = new PpgProcessor();
    const fps = 30;

    for (let frame = 0; frame < fps * 8; frame += 1) {
      const seconds = frame / fps;
      const pulse = Math.sin(seconds * 2 * Math.PI * (80 / 60)) * 4;
      processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 220 + pulse,
        green: 74 - pulse * 0.2,
        blue: 48,
      });
    }

    processor.resetCadence();
    const acceleratedBeats = [];
    for (let frame = 0; frame < fps * 8; frame += 1) {
      const seconds = 8 + frame / fps;
      const pulse = Math.sin(seconds * 2 * Math.PI * (130 / 60)) * 4;
      const result = processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 220 + pulse,
        green: 74 - pulse * 0.2,
        blue: 48,
      });
      if (result.beat) acceleratedBeats.push(result.beat);
    }

    expect(acceleratedBeats.length).toBeGreaterThanOrEqual(14);
    expect(acceleratedBeats.at(-1)?.bpm).toBeGreaterThanOrEqual(126);
    expect(acceleratedBeats.at(-1)?.bpm).toBeLessThanOrEqual(134);
    expect(acceleratedBeats.at(1)?.confidence).toBeGreaterThan(0.52);
  });

  it("카메라 교체 뒤 기존 cadence를 이용해 두 박동 안에 다시 이벤트를 낸다", () => {
    const processor = new PpgProcessor();
    const fps = 30;

    for (let frame = 0; frame < fps * 8; frame += 1) {
      const seconds = frame / fps;
      const pulse = Math.sin(seconds * 2 * Math.PI * 1.5) * 4;
      processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 220 + pulse,
        green: 74 - pulse * 0.2,
        blue: 48,
      });
    }

    processor.resetCadence();
    const restartAt = 12_000;
    let firstBeatAt: number | null = null;
    for (let frame = 0; frame < fps * 4; frame += 1) {
      const seconds = frame / fps;
      const pulse = Math.sin(seconds * 2 * Math.PI * 1.5) * 4;
      const result = processor.process({
        timestamp: restartAt + seconds * 1_000,
        red: 220 + pulse,
        green: 74 - pulse * 0.2,
        blue: 48,
      });
      if (result.beat && firstBeatAt === null)
        firstBeatAt = result.beat.detectedAt;
    }

    expect(firstBeatAt).not.toBeNull();
    expect((firstBeatAt ?? Infinity) - restartAt).toBeLessThanOrEqual(2_000);
  });

  it("안정된 파형 사이의 단발성 광량 spike를 고심박 박동으로 보내지 않는다", () => {
    const processor = new PpgProcessor();
    const beats = [];
    const fps = 30;

    for (let frame = 0; frame < fps * 15; frame += 1) {
      const seconds = frame / fps;
      const phase = seconds * 2 * Math.PI * 1.25;
      const artifact =
        Math.exp(-((seconds - 7.22) ** 2) / (2 * 0.035 ** 2)) * 18;
      const result = processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 222 + Math.sin(phase) * 5 + artifact,
        green: 72 - Math.sin(phase) - artifact * 0.08,
        blue: 48,
      });
      if (result.beat) beats.push(result.beat);
    }

    expect(beats.length).toBeGreaterThanOrEqual(12);
    expect(Math.min(...beats.map((beat) => beat.ibiMs))).toBeGreaterThan(600);
    expect(Math.max(...beats.map((beat) => beat.bpm))).toBeLessThan(100);
  });

  it("손가락 압력으로 광량 기준선이 변한 뒤 두 박동 안에 검출을 재개한다", () => {
    const processor = new PpgProcessor();
    const beats = [];
    const fps = 30;
    const bpm = 82;

    for (let frame = 0; frame < fps * 18; frame += 1) {
      const seconds = frame / fps;
      const phase = seconds * 2 * Math.PI * (bpm / 60);
      const pulse = Math.sin(phase) * 2.4 + Math.sin(phase * 2) * 0.45;
      // 두 번째 iPhone trace에서 관측한 191 -> 218 -> 200의 압력/노출
      // 변화를 재현합니다. DC 변화 자체를 박동으로 세면 안 되지만, 변화가
      // 안정된 뒤 실제 맥동 검출도 여러 초 동안 멈추면 안 됩니다.
      const pressureOffset =
        seconds < 8
          ? 0
          : seconds < 8.7
            ? ((seconds - 8) / 0.7) * 27
            : seconds < 9.8
              ? 27 - ((seconds - 8.7) / 1.1) * 22
              : 5;
      const result = processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 191 + pressureOffset + pulse,
        green: 0.4,
        blue: 24 + pressureOffset * 0.12,
      });
      if (result.beat) beats.push(result.beat);
    }

    const afterPressure = beats.filter((beat) => beat.detectedAt >= 10_800);
    expect(afterPressure.length).toBeGreaterThanOrEqual(9);
    expect(
      (afterPressure.at(0)?.detectedAt ?? Infinity) - 10_800,
    ).toBeLessThanOrEqual((60_000 / bpm) * 2.1);
    expect(
      longestGap(afterPressure.map((beat) => beat.detectedAt)),
    ).toBeLessThanOrEqual((60_000 / bpm) * 2.1);
    expect(Math.max(...beats.map((beat) => beat.bpm))).toBeLessThan(110);
  });

  it("움직임 중 누락 간격 복구값으로 표시 BPM 전환을 준비하지 않는다", () => {
    const processor = new PpgProcessor();
    // 네 번째 iPhone trace의 55~60초 구간을 cadence 상태 수준에서 재현합니다.
    // 725ms 기준에서 2009ms와 1163ms 공백이 각각 정규화된 뒤 597ms
    // artifact가 들어와도 102 BPM으로 기준선이 바뀌면 안 됩니다.
    const harness = processor as unknown as {
      ibiWindow: number[];
      lastObservedAt: number | null;
      currentBpm: number | null;
      registerCandidate: (
        timestamp: number,
        signalQuality: number,
      ) => { decision: string };
    };
    harness.ibiWindow = [690, 725, 725, 759, 725, 690, 725];
    harness.lastObservedAt = 1_000;
    harness.currentBpm = 83;

    expect(harness.registerCandidate(3_009, 0.96).decision).toBe(
      "missed_interval_observed",
    );
    expect(harness.registerCandidate(4_172, 0.96).decision).toBe(
      "missed_interval_observed",
    );
    harness.registerCandidate(4_769, 0.96);

    expect(harness.currentBpm).toBe(83);
  });

  it("큰 공간 편차와 포화 픽셀이 있는 프레임의 품질을 감점한다", () => {
    const clean = new PpgProcessor();
    const noisy = new PpgProcessor();
    let cleanQuality = 0;
    let noisyQuality = 0;

    for (let frame = 0; frame < 120; frame += 1) {
      const seconds = frame / 30;
      const pulse = Math.sin(seconds * 2 * Math.PI * 1.2) * 4;
      cleanQuality = clean.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 220 + pulse,
        green: 74 - pulse * 0.2,
        blue: 48,
        redSpatialStdDev: 12,
        greenSpatialStdDev: 7,
        saturationRatio: 0.02,
      }).signalQuality;
      noisyQuality = noisy.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 220 + pulse,
        green: 74 - pulse * 0.2,
        blue: 48,
        redSpatialStdDev: 105,
        greenSpatialStdDev: 55,
        saturationRatio: 0.82,
      }).signalQuality;
    }

    expect(cleanQuality).toBeGreaterThan(noisyQuality + 0.03);
  });

  it("BUT PPG 공개 스마트폰 파형을 연속 검출하면서 초기 고심박 오검출을 억제한다", () => {
    const processor = new PpgProcessor();
    const beats = BUTPPG_105001.flatMap((normalized, index) => {
      const result = processor.process({
        timestamp: 1_000 + index * (1_000 / 30),
        red: 220 - normalized * 4,
        green: 75 + normalized * 0.8,
        blue: 50,
      });
      return result.beat ? [result.beat] : [];
    });

    const expectedBeats =
      (BUTPPG_105001.length / 30) * (BUTPPG_105001_REFERENCE_BPM / 60);
    expect(beats.length).toBeGreaterThanOrEqual(
      Math.floor(expectedBeats * 0.4),
    );
    expect((beats[0]?.detectedAt ?? Infinity) - 1_000).toBeLessThanOrEqual(
      3_000,
    );
    expect(Math.max(...beats.map((beat) => beat.bpm))).toBeLessThan(150);
    expect(beats.at(-1)?.bpm).toBeGreaterThanOrEqual(
      BUTPPG_105001_REFERENCE_BPM - 12,
    );
    expect(beats.at(-1)?.bpm).toBeLessThanOrEqual(
      BUTPPG_105001_REFERENCE_BPM + 12,
    );
  });

  it("실제로 지속되는 190 BPM은 충분히 확인한 뒤 차단하지 않는다", () => {
    const processor = new PpgProcessor();
    const beats = [];
    let firstBpmFrame = -1;
    let firstBeatFrame = -1;
    const fps = 30;

    for (let frame = 0; frame < fps * 10; frame += 1) {
      const seconds = frame / fps;
      const pulse = Math.sin(seconds * 2 * Math.PI * (190 / 60)) * 4;
      const result = processor.process({
        timestamp: 1_000 + seconds * 1_000,
        red: 220 + pulse,
        green: 74 - pulse * 0.2,
        blue: 48,
      });
      if (result.bpm !== null && firstBpmFrame === -1) firstBpmFrame = frame;
      if (result.beat) {
        beats.push(result.beat);
        if (firstBeatFrame === -1) firstBeatFrame = frame;
      }
    }

    expect(beats.length).toBeGreaterThanOrEqual(20);
    expect(firstBpmFrame).toBe(firstBeatFrame);
    // 30 Hz 입력은 한 프레임이 33.3ms라 190 BPM(315.8ms)이 180 BPM
    // 간격으로 양자화될 수 있습니다. 중요한 것은 고심박을 차단하지 않는지입니다.
    expect(beats.at(-1)?.bpm).toBeGreaterThanOrEqual(175);
    expect(beats.at(-1)?.bpm).toBeLessThanOrEqual(200);
  });

  it("짧은 접촉 흔들림은 견디고 지속 이탈에서 신호를 초기화한다", () => {
    const processor = new PpgProcessor();
    for (let frame = 0; frame < 90; frame += 1) {
      processor.process({
        timestamp: frame * 33,
        red: 220 + Math.sin(frame / 4) * 4,
        green: 72,
        blue: 46,
      });
    }

    const absent = Array.from({ length: 28 }, (_, index) =>
      processor.process({
        timestamp: 3_000 + index * 33,
        red: 100,
        green: 103,
        blue: 105,
      }),
    );
    expect(absent.slice(0, 8).every((result) => result.beat === null)).toBe(
      true,
    );
    expect(absent.slice(-4).every((result) => !result.fingerDetected)).toBe(
      true,
    );
  });
});

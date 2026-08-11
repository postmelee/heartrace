import { describe, expect, it } from "vitest";
import { PpgProcessor, scoreFinger } from "../src/index";

describe("카메라 PPG 처리", () => {
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

  it("경기 시작 후 80 BPM에서 130 BPM으로 빨라진 박동에 즉시 적응한다", () => {
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

  it("손가락이 떨어지면 신호를 초기화하고 박동을 만들지 않는다", () => {
    const processor = new PpgProcessor();
    for (let frame = 0; frame < 90; frame += 1) {
      processor.process({
        timestamp: frame * 33,
        red: 220 + Math.sin(frame / 4) * 4,
        green: 72,
        blue: 46,
      });
    }

    const absent = Array.from({ length: 8 }, (_, index) =>
      processor.process({
        timestamp: 3_000 + index * 33,
        red: 100,
        green: 103,
        blue: 105,
      }),
    );
    expect(
      absent.every((result) => !result.fingerDetected && result.beat === null),
    ).toBe(true);
  });
});

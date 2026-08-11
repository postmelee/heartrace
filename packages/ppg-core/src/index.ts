const TWO_PI = Math.PI * 2;
const MIN_IBI_MS = 270;
const MAX_IBI_MS = 2_000;

export interface PpgFrameSample {
  /** Unix epoch 또는 같은 시계 기준의 단조 증가 millisecond */
  timestamp: number;
  /** 중앙 ROI의 평균 8-bit 채널값 */
  red: number;
  green: number;
  blue: number;
}

export interface PpgBeat {
  detectedAt: number;
  ibiMs: number;
  bpm: number;
  confidence: number;
  signalQuality: number;
}

export type PpgSignalChannel = "red" | "green";
export type PpgExposure = "uncovered" | "dark" | "good" | "saturated";

export interface PpgDiagnostics {
  channel: PpgSignalChannel;
  red: number;
  green: number;
  blue: number;
  /** 선택된 채널에서 DC 성분을 제거한 파형의 표준편차 */
  amplitude: number;
  exposure: PpgExposure;
}

export interface PpgResult {
  fingerDetected: boolean;
  signalQuality: number;
  waveform: number;
  bpm: number | null;
  beat: PpgBeat | null;
  diagnostics: PpgDiagnostics;
}

interface FilterPoint {
  timestamp: number;
  value: number;
}

interface ChannelFilter {
  dc: number;
  lowPass: number;
  points: FilterPoint[];
}

const SIGNAL_CHANNELS: PpgSignalChannel[] = ["red", "green"];

/**
 * 플래시가 켜진 접촉식 카메라 PPG용 신호 처리기입니다.
 *
 * 프레임에서 픽셀을 읽는 일은 카메라 Worklet이 담당하고, 이 클래스는
 * 정규화 → 대역 통과 필터 → 적응형 peak 검출 → IBI 중앙값 계산만 수행합니다.
 * 의료 진단용이 아니라 게임 입력의 일관성을 위한 알고리즘입니다.
 */
export class PpgProcessor {
  private channels = createChannelFilters();
  private selectedChannel: PpgSignalChannel = "red";
  private lastChannelEvaluationAt = 0;
  private lastTimestamp: number | null = null;
  private previous2: FilterPoint | null = null;
  private previous1: FilterPoint | null = null;
  private ibiWindow: number[] = [];
  private lastPeakAt: number | null = null;
  private missingFingerFrames = 0;
  private currentBpm: number | null = null;

  process(sample: PpgFrameSample): PpgResult {
    const fingerScore = scoreFinger(sample.red, sample.green, sample.blue);
    // 완전히 포화된 접촉 화면도 손가락으로 안내할 수 있도록 검출과
    // 실제 신호 품질 판정을 분리합니다.
    const fingerDetected = fingerScore >= 0.34;

    if (!fingerDetected) {
      this.missingFingerFrames += 1;
      if (this.missingFingerFrames >= 6) this.resetSignal();
      return {
        fingerDetected: false,
        signalQuality: 0,
        waveform: 0,
        bpm: this.currentBpm,
        beat: null,
        diagnostics: makeDiagnostics(
          sample,
          this.selectedChannel,
          0,
          "uncovered",
        ),
      };
    }

    this.missingFingerFrames = 0;
    const dtMs =
      this.lastTimestamp === null
        ? 33.3
        : Math.max(10, Math.min(100, sample.timestamp - this.lastTimestamp));
    this.lastTimestamp = sample.timestamp;
    const dt = dtMs / 1_000;

    // 각 채널을 자신의 평균 밝기로 정규화합니다. R/(R+G+B) 색상 비율은
    // 모든 채널이 함께 변하는 실제 접촉 PPG에서 박동 성분을 상쇄할 수 있습니다.
    const dcRc = 1 / (TWO_PI * 0.45);
    const dcAlpha = dt / (dcRc + dt);
    const lpRc = 1 / (TWO_PI * 4);
    const lpAlpha = dt / (lpRc + dt);
    const cutoff = sample.timestamp - 4_000;

    for (const channel of SIGNAL_CHANNELS) {
      const filter = this.channels[channel];
      const raw = sample[channel];
      if (filter.points.length === 0) filter.dc = raw;
      filter.dc += dcAlpha * (raw - filter.dc);
      const highPassed = (raw - filter.dc) / Math.max(1, filter.dc);
      filter.lowPass += lpAlpha * (highPassed - filter.lowPass);
      filter.points.push({
        timestamp: sample.timestamp,
        value: filter.lowPass,
      });
      while ((filter.points[0]?.timestamp ?? Infinity) < cutoff) {
        filter.points.shift();
      }
    }

    if (
      this.channels.red.points.length >= 24 &&
      sample.timestamp - this.lastChannelEvaluationAt >= 900
    ) {
      this.lastChannelEvaluationAt = sample.timestamp;
      const nextChannel = chooseSignalChannel(
        sample,
        this.channels,
        this.selectedChannel,
      );
      if (nextChannel !== this.selectedChannel) {
        this.selectedChannel = nextChannel;
        // 서로 다른 채널 사이의 기준선 차이를 박동으로 세지 않습니다.
        this.previous2 = null;
        this.previous1 = null;
        this.lastPeakAt = null;
        this.ibiWindow = [];
      }
    }

    const selectedFilter = this.channels[this.selectedChannel];
    const point = selectedFilter.points.at(-1) ?? {
      timestamp: sample.timestamp,
      value: 0,
    };
    const stats = windowStats(selectedFilter.points);
    const selectedRaw = sample[this.selectedChannel];
    const exposureScore = usableExposure(selectedRaw);
    const amplitudeScore = clamp01(stats.stdDev / 0.0025);
    const cadenceScore = intervalConsistency(this.ibiWindow);
    const warmupScore = clamp01(selectedFilter.points.length / 75);
    const signalQuality = clamp01(
      fingerScore * 0.34 +
        amplitudeScore * 0.36 +
        cadenceScore * 0.08 +
        warmupScore * 0.1 +
        exposureScore * 0.12,
    );

    let beat: PpgBeat | null = null;
    if (
      this.previous2 &&
      this.previous1 &&
      selectedFilter.points.length >= 24
    ) {
      const candidate = this.previous1;
      const isLocalPeak =
        candidate.value > this.previous2.value &&
        candidate.value >= point.value;
      const threshold = stats.mean + Math.max(stats.stdDev * 0.3, 0.00008);
      const interval =
        this.lastPeakAt === null
          ? Infinity
          : candidate.timestamp - this.lastPeakAt;

      if (
        isLocalPeak &&
        candidate.value > threshold &&
        interval >= MIN_IBI_MS
      ) {
        if (this.lastPeakAt !== null && interval <= MAX_IBI_MS) {
          this.ibiWindow.push(interval);
          // 전시에서는 관람자가 의도적으로 심박수를 변화시키므로 오래된
          // 박동을 길게 유지하지 않고 최근 5회에 빠르게 적응합니다.
          if (this.ibiWindow.length > 5) this.ibiWindow.shift();
          const stableIbi = median(this.ibiWindow);
          this.currentBpm = Math.round(60_000 / stableIbi);
          const confidence = clamp01(
            signalQuality * 0.88 + intervalConsistency(this.ibiWindow) * 0.12,
          );
          beat = {
            detectedAt: candidate.timestamp,
            ibiMs: Math.round(interval),
            bpm: this.currentBpm,
            confidence,
            signalQuality,
          };
        }
        this.lastPeakAt = candidate.timestamp;
      }
    }

    this.previous2 = this.previous1;
    this.previous1 = point;

    return {
      fingerDetected: true,
      signalQuality,
      waveform: clamp(
        -1,
        1,
        selectedFilter.lowPass / Math.max(0.0002, stats.stdDev * 2.5),
      ),
      bpm: this.currentBpm,
      beat,
      diagnostics: makeDiagnostics(
        sample,
        this.selectedChannel,
        stats.stdDev,
        exposureFor(selectedRaw),
      ),
    };
  }

  reset(): void {
    this.currentBpm = null;
    this.lastPeakAt = null;
    this.ibiWindow = [];
    this.resetSignal();
  }

  /** 경기 시작 시 대기실의 느린 박동 이력을 버리고 새 속도에 빠르게 적응합니다. */
  resetCadence(): void {
    this.ibiWindow = [];
  }

  private resetSignal(): void {
    this.channels = createChannelFilters();
    this.selectedChannel = "red";
    this.lastChannelEvaluationAt = 0;
    this.lastTimestamp = null;
    this.previous2 = null;
    this.previous1 = null;
  }
}

function createChannelFilters(): Record<PpgSignalChannel, ChannelFilter> {
  return {
    red: { dc: 0, lowPass: 0, points: [] },
    green: { dc: 0, lowPass: 0, points: [] },
  };
}

function chooseSignalChannel(
  sample: PpgFrameSample,
  channels: Record<PpgSignalChannel, ChannelFilter>,
  current: PpgSignalChannel,
): PpgSignalChannel {
  const score = (channel: PpgSignalChannel) =>
    windowStats(channels[channel].points).stdDev *
    usableExposure(sample[channel]);
  const other = current === "red" ? "green" : "red";
  return score(other) > score(current) * 1.25 ? other : current;
}

function makeDiagnostics(
  sample: PpgFrameSample,
  channel: PpgSignalChannel,
  amplitude: number,
  exposure: PpgExposure,
): PpgDiagnostics {
  return {
    channel,
    red: Math.round(sample.red),
    green: Math.round(sample.green),
    blue: Math.round(sample.blue),
    amplitude,
    exposure,
  };
}

function exposureFor(value: number): PpgExposure {
  if (value >= 248) return "saturated";
  if (value <= 35) return "dark";
  return "good";
}

function usableExposure(value: number): number {
  const brightEnough = smoothstep(18, 58, value);
  const headroom = 1 - smoothstep(238, 254, value);
  return clamp01(brightEnough * headroom);
}

export function scoreFinger(red: number, green: number, blue: number): number {
  const brightness = (red + green + blue) / 3;
  const dominance = (red - Math.max(green, blue)) / Math.max(1, red);
  const redLevel = smoothstep(65, 185, red);
  const warmLevel = smoothstep(0.05, 0.42, dominance);
  const exposurePenalty =
    brightness > 250 ? clamp01((270 - brightness) / 20) : 1;
  return clamp01((redLevel * 0.55 + warmLevel * 0.45) * exposurePenalty);
}

function windowStats(points: FilterPoint[]): { mean: number; stdDev: number } {
  if (points.length === 0) return { mean: 0, stdDev: 0 };
  const mean =
    points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const variance =
    points.reduce((sum, point) => sum + (point.value - mean) ** 2, 0) /
    points.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

function intervalConsistency(intervals: number[]): number {
  if (intervals.length < 2) return 0.5;
  const center = median(intervals);
  const deviations = intervals.map((interval) => Math.abs(interval - center));
  return clamp01(1 - median(deviations) / Math.max(1, center * 0.18));
}

function median(values: number[]): number {
  if (values.length === 0) return 1_000;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 1_000;
  return ((sorted[middle - 1] ?? 1_000) + (sorted[middle] ?? 1_000)) / 2;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  return clamp(0, 1, value);
}

function clamp(minimum: number, maximum: number, value: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

const TWO_PI = Math.PI * 2;
const MIN_IBI_MS = 270;
const MAX_IBI_MS = 2_000;
const IBI_HISTORY_SIZE = 7;
const CONTACT_ENTER_FRAMES = 5;
const CONTACT_EXIT_FRAMES = 24;
const CHANNEL_DWELL_MS = 4_000;
const SLOPE_SUM_WINDOW_MS = 170;
const SLOPE_HISTORY_MS = 1_500;
const SIGNAL_LOSS_HOLD_MS = 2_200;
const MAX_CADENCE_RECOVERY_MS = 6_000;

export interface PpgFrameSample {
  timestamp: number;
  red: number;
  green: number;
  blue: number;
  redSpatialStdDev?: number;
  greenSpatialStdDev?: number;
  saturationRatio?: number;
  /** 0은 정지, 1은 강한 움직임입니다. 카메라만 사용할 때는 생략합니다. */
  motionMagnitude?: number;
}

export type PpgBeatSource = "observed" | "bridged";

export interface PpgBeat {
  detectedAt: number;
  ibiMs: number;
  bpm: number;
  confidence: number;
  signalQuality: number;
  source?: PpgBeatSource;
}

/**
 * 정상 검출이 한 박동 늦을 때만 마지막 cadence를 한 번 이어 줍니다.
 * 실제 박동이 다시 들어오기 전에는 두 번째 보간을 만들지 않습니다.
 */
export class PpgBeatHoldover {
  private lastRealBeat: PpgBeat | null = null;
  private nextExpectedAt: number | null = null;
  private lastPredictedAt: number | null = null;
  private predictionUsed = false;
  private holdUntil = 0;

  reset(): void {
    this.lastRealBeat = null;
    this.nextExpectedAt = null;
    this.lastPredictedAt = null;
    this.predictionUsed = false;
    this.holdUntil = 0;
  }

  prepareCameraTransition(now: number): void {
    if (!this.lastRealBeat) return;
    this.holdUntil = Math.max(
      this.holdUntil,
      now + Math.min(3_000, this.lastRealBeat.ibiMs * 3),
    );
    if (
      this.nextExpectedAt === null ||
      this.nextExpectedAt < now - this.lastRealBeat.ibiMs * 1.5
    ) {
      this.nextExpectedAt = now + this.lastRealBeat.ibiMs;
    }
  }

  observeReal(beat: PpgBeat): boolean {
    const duplicateWindow = Math.max(180, Math.min(360, beat.ibiMs * 0.45));
    const shouldDeliver =
      this.lastPredictedAt === null ||
      Math.abs(beat.detectedAt - this.lastPredictedAt) > duplicateWindow;
    this.lastRealBeat = { ...beat, source: "observed" };
    this.nextExpectedAt = beat.detectedAt + beat.ibiMs;
    this.lastPredictedAt = null;
    this.predictionUsed = false;
    this.holdUntil = beat.detectedAt + SIGNAL_LOSS_HOLD_MS;
    return shouldDeliver;
  }

  canHold(now: number): boolean {
    return (
      this.lastRealBeat !== null &&
      !this.predictionUsed &&
      now <= this.holdUntil
    );
  }

  poll(now: number): PpgBeat | null {
    const beat = this.lastRealBeat;
    const expectedAt = this.nextExpectedAt;
    if (!beat || expectedAt === null || !this.canHold(now)) return null;
    const allowance = Math.max(150, Math.min(240, beat.ibiMs * 0.28));
    if (now < expectedAt + allowance) return null;

    const predictedAt = now - expectedAt > beat.ibiMs * 1.5 ? now : expectedAt;
    this.predictionUsed = true;
    this.lastPredictedAt = predictedAt;
    this.nextExpectedAt = predictedAt + beat.ibiMs;
    return {
      ...beat,
      detectedAt: predictedAt,
      confidence: Math.min(beat.confidence, 0.72),
      signalQuality: Math.min(beat.signalQuality, 0.78),
      source: "bridged",
    };
  }
}

export type PpgSignalChannel = "red" | "green";
export type PpgExposure = "uncovered" | "dark" | "good" | "saturated";
export type PpgDecision =
  | "no_contact"
  | "contact_grace"
  | "warming_up"
  | "below_threshold"
  | "motion_rejected"
  | "refractory_rejected"
  | "extra_peak_rejected"
  | "baseline_peak"
  | "observed"
  | "missed_interval_observed";

export interface PpgDiagnostics {
  channel: PpgSignalChannel;
  red: number;
  green: number;
  blue: number;
  amplitude: number;
  exposure: PpgExposure;
  contactQuality: number;
  opticalQuality: number;
  motionQuality: number;
  rhythmConfidence: number;
  slopeSum: number;
  slopeThreshold: number;
  decision: PpgDecision;
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
  lastValue: number | null;
  points: FilterPoint[];
  positiveSlopes: FilterPoint[];
  slopeSums: FilterPoint[];
}

interface PendingRhythm {
  intervals: number[];
}

interface PendingRapidCadence {
  lastCandidateAt: number;
  intervals: number[];
}

interface CandidateResult {
  beat: PpgBeat | null;
  decision: PpgDecision;
}

const SIGNAL_CHANNELS: PpgSignalChannel[] = ["red", "green"];

/**
 * 30 Hz 접촉식 카메라 PPG 처리기입니다.
 *
 * qPPG와 같은 slope-sum 방식으로 수축기 상승 구간을 먼저 찾고, 관측 박동과
 * BPM 안정화를 분리합니다. IBI 변화는 BPM 기준선만 보류하며 실제로 관측한
 * 강한 상승 구간은 경기 이벤트에서 제거하지 않습니다.
 */
export class PpgProcessor {
  private channels = createChannelFilters();
  private selectedChannel: PpgSignalChannel = "red";
  private lastChannelEvaluationAt = 0;
  private lastChannelSwitchAt = -Infinity;
  private lastTimestamp: number | null = null;
  private ibiWindow: number[] = [];
  private pendingRhythm: PendingRhythm | null = null;
  private pendingRapidCadence: PendingRapidCadence | null = null;
  private lastObservedAt: number | null = null;
  private currentBpm: number | null = null;
  private contactDetected = false;
  private contactEnterFrames = 0;
  private contactExitFrames = 0;
  private candidateArmed = true;
  private previousRaw: Pick<PpgFrameSample, "red" | "green" | "blue"> | null =
    null;

  process(sample: PpgFrameSample): PpgResult {
    const contactQuality = scoreFinger(sample.red, sample.green, sample.blue);
    const contact = this.updateContact(contactQuality);
    if (!contact.processFrame) {
      return this.emptyResult(sample, contact.fingerDetected, contact.decision);
    }

    const dtMs =
      this.lastTimestamp === null
        ? 33.3
        : Math.max(10, Math.min(120, sample.timestamp - this.lastTimestamp));
    this.lastTimestamp = sample.timestamp;
    const dt = dtMs / 1_000;
    const dcRc = 1 / (TWO_PI * 0.5);
    const dcAlpha = dt / (dcRc + dt);
    const lpRc = 1 / (TWO_PI * 5);
    const lpAlpha = dt / (lpRc + dt);
    const signalCutoff = sample.timestamp - 4_000;
    const slopeCutoff = sample.timestamp - SLOPE_HISTORY_MS;

    for (const channel of SIGNAL_CHANNELS) {
      const filter = this.channels[channel];
      const raw = sample[channel];
      if (filter.points.length === 0) filter.dc = raw;
      filter.dc += dcAlpha * (raw - filter.dc);
      // 스마트폰 접촉 PPG는 혈액량이 늘어날 때 카메라에 도달하는 빛이
      // 줄어듭니다. qPPG의 수축기 상승 방향과 맞추기 위해 카메라 밝기를
      // 반전한 뒤 slope-sum을 계산합니다. BUT PPG도 원본 red 평균을 같은
      // 이유로 반전해 배포합니다.
      const highPassed = -(raw - filter.dc) / Math.max(1, filter.dc);
      filter.lowPass += lpAlpha * (highPassed - filter.lowPass);
      const point = { timestamp: sample.timestamp, value: filter.lowPass };
      filter.points.push(point);

      if (filter.lastValue !== null) {
        filter.positiveSlopes.push({
          timestamp: sample.timestamp,
          value: Math.max(0, filter.lowPass - filter.lastValue),
        });
      }
      filter.lastValue = filter.lowPass;
      trimBefore(filter.points, signalCutoff);
      trimBefore(filter.positiveSlopes, sample.timestamp - 500);

      const slopeSum = filter.positiveSlopes
        .filter(
          (candidate) =>
            candidate.timestamp >= sample.timestamp - SLOPE_SUM_WINDOW_MS,
        )
        .reduce((sum, candidate) => sum + candidate.value, 0);
      filter.slopeSums.push({ timestamp: sample.timestamp, value: slopeSum });
      trimBefore(filter.slopeSums, slopeCutoff);
    }

    this.maybeSwitchChannel(sample);
    const filter = this.channels[this.selectedChannel];
    const stats = windowStats(filter.points);
    const selectedRaw = sample[this.selectedChannel];
    const amplitudeScore = amplitudeQuality(stats.stdDev);
    const exposureScore = usableExposure(selectedRaw);
    const spatialScore = spatialQuality(sample, this.selectedChannel);
    const motionQuality = this.measureMotionQuality(sample);
    const opticalQuality = clamp01(
      amplitudeScore * 0.5 + exposureScore * 0.25 + spatialScore * 0.25,
    );
    const rhythmConfidence = intervalConsistency(this.ibiWindow);
    const signalQuality = clamp01(
      contactQuality * 0.28 +
        opticalQuality * 0.38 +
        motionQuality * 0.18 +
        rhythmConfidence * 0.16,
    );
    const slopeSum = filter.slopeSums.at(-1)?.value ?? 0;
    const slopeThreshold = adaptiveSlopeThreshold(filter.slopeSums);

    let decision: PpgDecision =
      filter.points.length < 18 ? "warming_up" : "below_threshold";
    let beat: PpgBeat | null = null;
    if (slopeSum <= slopeThreshold * 0.48) this.candidateArmed = true;

    if (
      filter.points.length >= 18 &&
      this.candidateArmed &&
      slopeSum >= slopeThreshold &&
      slopeSum >= 0.00004
    ) {
      this.candidateArmed = false;
      if (motionQuality < 0.2) {
        decision = "motion_rejected";
      } else {
        const candidate = this.registerCandidate(
          sample.timestamp,
          signalQuality,
        );
        beat = candidate.beat;
        decision = candidate.decision;
      }
    }

    return {
      fingerDetected: true,
      signalQuality,
      waveform: clamp(
        -1,
        1,
        filter.lowPass / Math.max(0.0002, stats.stdDev * 2.5),
      ),
      bpm: this.currentBpm,
      beat,
      diagnostics: makeDiagnostics({
        sample,
        channel: this.selectedChannel,
        amplitude: stats.stdDev,
        contactQuality,
        opticalQuality,
        motionQuality,
        rhythmConfidence,
        slopeSum,
        slopeThreshold,
        decision,
      }),
    };
  }

  reset(): void {
    this.contactDetected = false;
    this.contactEnterFrames = 0;
    this.contactExitFrames = 0;
    this.resetCadenceState();
    this.resetSignal();
  }

  /** 카메라 화면 전환 시 BPM 기준선은 보존하고 영상 필터만 다시 준비합니다. */
  resetCadence(): void {
    this.contactEnterFrames = 0;
    this.contactExitFrames = 0;
    this.resetSignal();
  }

  private updateContact(contactQuality: number): {
    fingerDetected: boolean;
    processFrame: boolean;
    decision: PpgDecision;
  } {
    if (!this.contactDetected) {
      this.contactEnterFrames =
        contactQuality >= 0.34 ? this.contactEnterFrames + 1 : 0;
      if (this.contactEnterFrames < CONTACT_ENTER_FRAMES) {
        return {
          fingerDetected: false,
          processFrame: false,
          decision: "no_contact",
        };
      }
      this.contactDetected = true;
      this.contactExitFrames = 0;
      this.resetSignal();
      return {
        fingerDetected: true,
        processFrame: true,
        decision: "warming_up",
      };
    }

    if (contactQuality < 0.18) {
      this.contactExitFrames += 1;
      if (this.contactExitFrames >= CONTACT_EXIT_FRAMES) {
        this.contactDetected = false;
        this.contactEnterFrames = 0;
        this.resetCadenceState();
        this.resetSignal();
        return {
          fingerDetected: false,
          processFrame: false,
          decision: "no_contact",
        };
      }
      return {
        fingerDetected: true,
        processFrame: false,
        decision: "contact_grace",
      };
    }

    this.contactExitFrames = 0;
    return {
      fingerDetected: true,
      processFrame: true,
      decision: "below_threshold",
    };
  }

  private maybeSwitchChannel(sample: PpgFrameSample): void {
    if (
      this.channels.red.points.length < 24 ||
      sample.timestamp - this.lastChannelEvaluationAt < 900 ||
      sample.timestamp - this.lastChannelSwitchAt < CHANNEL_DWELL_MS
    ) {
      return;
    }
    this.lastChannelEvaluationAt = sample.timestamp;
    const current = this.selectedChannel;
    const other: PpgSignalChannel = current === "red" ? "green" : "red";
    const currentScore = channelQuality(
      sample,
      this.channels[current],
      current,
    );
    const otherScore = channelQuality(sample, this.channels[other], other);
    const currentUnusable = usableExposure(sample[current]) < 0.18;
    if (
      (currentUnusable && otherScore > 0.28) ||
      (currentScore < 0.24 && otherScore > currentScore * 1.8)
    ) {
      this.selectedChannel = other;
      this.lastChannelSwitchAt = sample.timestamp;
      this.candidateArmed = true;
    }
  }

  private registerCandidate(
    timestamp: number,
    signalQuality: number,
  ): CandidateResult {
    if (this.lastObservedAt === null) {
      this.lastObservedAt = timestamp;
      return { beat: null, decision: "baseline_peak" };
    }

    const interval = timestamp - this.lastObservedAt;
    if (interval < MIN_IBI_MS) {
      return { beat: null, decision: "refractory_rejected" };
    }

    const historyCenter =
      this.ibiWindow.length === 0 ? null : median(this.ibiWindow);

    // 직전 승인 시각과의 간격이 MAX_IBI를 넘었더라도, 그 사이에 보류한
    // 빠른 cadence 후보들이 일관되게 이어졌다면 먼저 전환을 확정합니다.
    // 이 순서가 뒤집히면 낮은 BPM으로 잘못 잠긴 뒤 정상 peak를 계속
    // 보류하다 매번 baseline으로 초기화하는 연쇄 누락이 발생합니다.
    if (historyCenter !== null && this.pendingRapidCadence) {
      const pendingInterval =
        timestamp - this.pendingRapidCadence.lastCandidateAt;
      if (
        pendingInterval >= MIN_IBI_MS &&
        intervalsAgree(
          pendingInterval,
          median(this.pendingRapidCadence.intervals),
          // 60 BPM 아래로 잠긴 상태는 실제 peak를 건너뛴 결과일 가능성이
          // 크며, 서로 다른 파형 지점을 잡으면 후보 IBI가 30 Hz에서 크게
          // 교대할 수 있습니다. 세 후보 확인은 유지하되 이 구간만 허용
          // 폭을 넓혀 half-rate lock에서 빠져나옵니다.
          historyCenter > 1_000 ? 0.45 : 0.22,
        )
      ) {
        this.pendingRapidCadence.intervals.push(pendingInterval);
        this.pendingRapidCadence.lastCandidateAt = timestamp;
        const rapidCenter = median(this.pendingRapidCadence.intervals);
        // 거의 두 배로 보이는 cadence는 dicrotic notch가 연속 검출된 경우와
        // 구분하기 위해 세 간격, 그보다 완만한 변화는 두 간격을 확인합니다.
        const required = rapidCenter < historyCenter * 0.6 ? 3 : 2;
        if (this.pendingRapidCadence.intervals.length < required) {
          return { beat: null, decision: "extra_peak_rejected" };
        }

        this.ibiWindow =
          this.pendingRapidCadence.intervals.slice(-IBI_HISTORY_SIZE);
        this.pendingRapidCadence = null;
        this.pendingRhythm = null;
        this.currentBpm = Math.round(60_000 / median(this.ibiWindow));
        this.lastObservedAt = timestamp;
        return this.makeObservedBeat(
          timestamp,
          rapidCenter,
          signalQuality,
          "observed",
        );
      }
      this.pendingRapidCadence = null;
    }

    if (interval > MAX_IBI_MS) {
      // 압력/노출 변화로 threshold가 잠시 높아진 뒤 처음 돌아온 후보를
      // baseline으로만 소비하면, 사용자는 정상 파형이 돌아온 뒤에도 한
      // 박동을 더 기다려야 합니다. 접촉이 계속 유지되고 충분한 cadence
      // 이력이 있을 때는 현재 후보 자체는 관측한 박동으로 전달하되, 긴
      // 공백을 IBI/BPM으로 사용하지 않고 직전 중앙 cadence를 보존합니다.
      if (
        historyCenter !== null &&
        this.ibiWindow.length >= 3 &&
        interval <= MAX_CADENCE_RECOVERY_MS
      ) {
        this.lastObservedAt = timestamp;
        this.pendingRhythm = null;
        this.pendingRapidCadence = null;
        return this.makeObservedBeat(
          timestamp,
          historyCenter,
          signalQuality,
          "missed_interval_observed",
        );
      }
      this.lastObservedAt = timestamp;
      this.pendingRhythm = null;
      return { beat: null, decision: "baseline_peak" };
    }

    if (historyCenter !== null && interval < historyCenter * 0.72) {
      this.pendingRapidCadence = {
        lastCandidateAt: timestamp,
        intervals: [interval],
      };
      return { beat: null, decision: "extra_peak_rejected" };
    }

    let effectiveIbi = interval;
    let decision: PpgDecision = "observed";
    if (historyCenter !== null) {
      const estimatedMultiple = Math.max(
        2,
        Math.min(3, Math.round(interval / historyCenter)),
      );
      if (
        interval > historyCenter * 1.55 &&
        Math.abs(interval / historyCenter - estimatedMultiple) <= 0.48
      ) {
        effectiveIbi = interval / estimatedMultiple;
        decision = "missed_interval_observed";
      }
    }

    this.lastObservedAt = timestamp;
    this.updateRhythm(effectiveIbi, decision === "observed");
    return this.makeObservedBeat(
      timestamp,
      effectiveIbi,
      signalQuality,
      decision,
    );
  }

  private makeObservedBeat(
    timestamp: number,
    ibiMs: number,
    signalQuality: number,
    decision: PpgDecision,
  ): CandidateResult {
    const confidence = clamp01(
      signalQuality * 0.82 + intervalConsistency(this.ibiWindow) * 0.18,
    );
    return {
      beat: {
        detectedAt: timestamp,
        ibiMs: Math.round(ibiMs),
        bpm: this.currentBpm ?? Math.round(60_000 / ibiMs),
        confidence,
        signalQuality,
        source: "observed",
      },
      decision,
    };
  }

  private updateRhythm(interval: number, allowCadenceTransition = true): void {
    if (this.ibiWindow.length === 0) {
      this.ibiWindow = [interval];
      this.currentBpm = Math.round(60_000 / interval);
      return;
    }

    if (intervalMatchesHistory(interval, this.ibiWindow)) {
      this.ibiWindow.push(interval);
      if (this.ibiWindow.length > IBI_HISTORY_SIZE) this.ibiWindow.shift();
      this.pendingRhythm = null;
      this.currentBpm = Math.round(60_000 / median(this.ibiWindow));
      return;
    }

    // 2~3박동 길이의 공백을 나눈 값은 누락 이벤트 복구에는 유용하지만,
    // 움직임 artifact가 섞이면 실제보다 짧은 IBI가 될 수 있습니다. 기존
    // cadence와 맞으면 이력에 포함하되, 맞지 않는 복구값 하나만으로 새로운
    // BPM 전환 후보를 준비하지 않습니다.
    if (!allowCadenceTransition) {
      this.pendingRhythm = null;
      return;
    }

    if (
      this.pendingRhythm &&
      intervalsAgree(interval, median(this.pendingRhythm.intervals))
    ) {
      this.pendingRhythm.intervals.push(interval);
      this.ibiWindow = this.pendingRhythm.intervals.slice(-IBI_HISTORY_SIZE);
      this.pendingRhythm = null;
      this.currentBpm = Math.round(60_000 / median(this.ibiWindow));
      return;
    }

    this.pendingRhythm = { intervals: [interval] };
  }

  private measureMotionQuality(sample: PpgFrameSample): number {
    const previous = this.previousRaw;
    this.previousRaw = {
      red: sample.red,
      green: sample.green,
      blue: sample.blue,
    };
    if (!previous) return 1;
    const frameDelta =
      (Math.abs(sample.red - previous.red) +
        Math.abs(sample.green - previous.green) +
        Math.abs(sample.blue - previous.blue)) /
      (255 * 3);
    const cameraMotion = 1 - smoothstep(0.012, 0.065, frameDelta);
    const sensorMotion =
      sample.motionMagnitude === undefined
        ? 1
        : 1 - smoothstep(0.08, 0.65, sample.motionMagnitude);
    return clamp01(cameraMotion * 0.7 + sensorMotion * 0.3);
  }

  private emptyResult(
    sample: PpgFrameSample,
    fingerDetected: boolean,
    decision: PpgDecision,
  ): PpgResult {
    return {
      fingerDetected,
      signalQuality: 0,
      waveform: 0,
      bpm: this.currentBpm,
      beat: null,
      diagnostics: makeDiagnostics({
        sample,
        channel: this.selectedChannel,
        amplitude: 0,
        contactQuality: scoreFinger(sample.red, sample.green, sample.blue),
        opticalQuality: 0,
        motionQuality: 0,
        rhythmConfidence: intervalConsistency(this.ibiWindow),
        slopeSum: 0,
        slopeThreshold: 0,
        decision,
      }),
    };
  }

  private resetCadenceState(): void {
    this.ibiWindow = [];
    this.pendingRhythm = null;
    this.pendingRapidCadence = null;
    this.lastObservedAt = null;
    this.currentBpm = null;
  }

  private resetSignal(): void {
    this.channels = createChannelFilters();
    this.selectedChannel = "red";
    this.lastChannelEvaluationAt = 0;
    this.lastChannelSwitchAt = -Infinity;
    this.lastTimestamp = null;
    this.candidateArmed = true;
    this.previousRaw = null;
  }
}

function createChannelFilters(): Record<PpgSignalChannel, ChannelFilter> {
  const create = (): ChannelFilter => ({
    dc: 0,
    lowPass: 0,
    lastValue: null,
    points: [],
    positiveSlopes: [],
    slopeSums: [],
  });
  return { red: create(), green: create() };
}

function channelQuality(
  sample: PpgFrameSample,
  filter: ChannelFilter,
  channel: PpgSignalChannel,
): number {
  return (
    amplitudeQuality(windowStats(filter.points).stdDev) *
    usableExposure(sample[channel])
  );
}

function adaptiveSlopeThreshold(points: FilterPoint[]): number {
  if (points.length < 12) return Infinity;
  const values = points.map((point) => point.value);
  const baseline = quantile(values, 0.55);
  const upper = quantile(values, 0.9);
  return Math.max(0.00004, baseline + (upper - baseline) * 0.42);
}

function makeDiagnostics(input: {
  sample: PpgFrameSample;
  channel: PpgSignalChannel;
  amplitude: number;
  contactQuality: number;
  opticalQuality: number;
  motionQuality: number;
  rhythmConfidence: number;
  slopeSum: number;
  slopeThreshold: number;
  decision: PpgDecision;
}): PpgDiagnostics {
  return {
    channel: input.channel,
    red: Math.round(input.sample.red),
    green: Math.round(input.sample.green),
    blue: Math.round(input.sample.blue),
    amplitude: input.amplitude,
    exposure: exposureFor(input.sample[input.channel]),
    contactQuality: input.contactQuality,
    opticalQuality: input.opticalQuality,
    motionQuality: input.motionQuality,
    rhythmConfidence: input.rhythmConfidence,
    slopeSum: input.slopeSum,
    slopeThreshold: input.slopeThreshold,
    decision: input.decision,
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
  if (intervals.length < 2) return 0.55;
  const center = median(intervals);
  const deviations = intervals.map((interval) => Math.abs(interval - center));
  return clamp01(1 - median(deviations) / Math.max(1, center * 0.2));
}

function amplitudeQuality(stdDev: number): number {
  const enoughPulse = smoothstep(0.00018, 0.0018, stdDev);
  const motionHeadroom = 1 - smoothstep(0.04, 0.11, stdDev);
  return clamp01(enoughPulse * motionHeadroom);
}

function spatialQuality(
  sample: PpgFrameSample,
  channel: PpgSignalChannel,
): number {
  const spatialStdDev =
    channel === "red" ? sample.redSpatialStdDev : sample.greenSpatialStdDev;
  const raw = sample[channel];
  const uniformity =
    spatialStdDev === undefined
      ? 1
      : 1 - smoothstep(0.16, 0.48, spatialStdDev / Math.max(1, raw));
  const saturationHeadroom =
    sample.saturationRatio === undefined
      ? 1
      : 1 - smoothstep(0.25, 0.85, sample.saturationRatio);
  return clamp01(uniformity * saturationHeadroom);
}

function intervalMatchesHistory(interval: number, history: number[]): boolean {
  if (history.length === 0) return true;
  const center = median(history);
  const deviations = history.map((value) => Math.abs(value - center));
  const robustSigma = median(deviations) * 1.4826;
  const tolerance = Math.max(110, center * 0.16, robustSigma * 3);
  return Math.abs(interval - center) <= tolerance;
}

function intervalsAgree(
  left: number,
  right: number,
  toleranceRatio = 0.22,
): boolean {
  const center = (left + right) / 2;
  return Math.abs(left - right) <= Math.max(110, center * toleranceRatio);
}

function trimBefore(points: FilterPoint[], cutoff: number): void {
  while ((points[0]?.timestamp ?? Infinity) < cutoff) points.shift();
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index] ?? 0;
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

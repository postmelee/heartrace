import { useCallback, useEffect, useRef, useState } from "react";
import {
  PpgBeatHoldover,
  PpgProcessor,
  type PpgBeat,
  type PpgDiagnostics,
  type PpgFrameSample,
} from "@heartrace/ppg-core";

export type HeartRateSource = "camera" | "simulator";

export interface HeartRateState {
  fingerDetected: boolean;
  signalQuality: number;
  waveform: number;
  bpm: number | null;
  validBeats: number;
  stableMs: number;
  ready: boolean;
  beatSerial: number;
  lastBeat: PpgBeat | null;
  lastBeatAt: number | null;
  beatAgeMs: number | null;
  holdingSignal: boolean;
  diagnostics: PpgDiagnostics | null;
}

interface PpgTraceFrameRecord {
  kind: "frame";
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

interface PpgTraceBridgedRecord {
  kind: "bridged";
  timestamp: number;
  beat: PpgBeat;
}

type PpgTraceRecord = PpgTraceFrameRecord | PpgTraceBridgedRecord;

const INITIAL_STATE: HeartRateState = {
  fingerDetected: false,
  signalQuality: 0,
  waveform: 0,
  bpm: null,
  validBeats: 0,
  stableMs: 0,
  ready: false,
  beatSerial: 0,
  lastBeat: null,
  lastBeatAt: null,
  beatAgeMs: null,
  holdingSignal: false,
  diagnostics: null,
};

export function useHeartRate({
  source,
  enabled,
  simulatorBpm,
  onBeat,
}: {
  source: HeartRateSource;
  enabled: boolean;
  simulatorBpm: number;
  onBeat: (beat: PpgBeat) => void;
}) {
  const processorRef = useRef(new PpgProcessor());
  const holdoverRef = useRef(new PpgBeatHoldover());
  const onBeatRef = useRef(onBeat);
  const stableStartedAtRef = useRef<number | null>(null);
  const validBeatsRef = useRef(0);
  const beatSerialRef = useRef(0);
  const lastBeatRef = useRef<PpgBeat | null>(null);
  const lastBeatAtRef = useRef<number | null>(null);
  const lastRenderAtRef = useRef(0);
  const holdingSignalRef = useRef(false);
  const traceRef = useRef<PpgTraceRecord[]>([]);
  const lastTraceAtRef = useRef(0);
  const [state, setState] = useState<HeartRateState>(INITIAL_STATE);

  onBeatRef.current = onBeat;

  const resetProcessing = useCallback((clearTrace: boolean) => {
    processorRef.current.reset();
    stableStartedAtRef.current = null;
    validBeatsRef.current = 0;
    beatSerialRef.current = 0;
    lastBeatRef.current = null;
    lastBeatAtRef.current = null;
    holdingSignalRef.current = false;
    if (clearTrace) {
      traceRef.current = [];
      lastTraceAtRef.current = 0;
    }
    holdoverRef.current.reset();
    setState(INITIAL_STATE);
  }, []);

  const reset = useCallback(() => {
    resetProcessing(true);
  }, [resetProcessing]);

  const resetCadence = useCallback(() => {
    processorRef.current.resetCadence();
    holdoverRef.current.prepareCameraTransition(Date.now());
  }, []);

  useEffect(() => {
    // 경기 종료 뒤에도 숫자형 진단 로그를 공유할 수 있도록 명시적인 새
    // 측정 reset 전까지 trace는 보존합니다.
    if (!enabled) resetProcessing(false);
  }, [enabled, resetProcessing]);

  const handleResult = useCallback(
    (result: ReturnType<PpgProcessor["process"]>, now: number) => {
      const stableSignal =
        result.fingerDetected && result.signalQuality >= 0.44;
      if (stableSignal && stableStartedAtRef.current === null) {
        stableStartedAtRef.current = now;
      }
      if (!stableSignal) {
        stableStartedAtRef.current = null;
        validBeatsRef.current = 0;
      }
      if (result.beat) {
        const shouldDeliver = holdoverRef.current.observeReal(result.beat);
        holdingSignalRef.current = false;
        validBeatsRef.current += 1;
        beatSerialRef.current += 1;
        lastBeatRef.current = result.beat;
        lastBeatAtRef.current = result.beat.detectedAt;
        if (shouldDeliver) onBeatRef.current(result.beat);
      }

      const beatAgeMs =
        lastBeatAtRef.current === null ? null : now - lastBeatAtRef.current;
      const freshnessLimitMs =
        result.bpm === null
          ? 0
          : Math.max(1_800, Math.min(3_500, (60_000 / result.bpm) * 3));
      const freshBpm =
        result.fingerDetected &&
        beatAgeMs !== null &&
        beatAgeMs <= freshnessLimitMs
          ? result.bpm
          : null;
      const stableMs =
        stableStartedAtRef.current === null
          ? 0
          : now - stableStartedAtRef.current;
      const ready =
        stableMs >= 5_000 && validBeatsRef.current >= 4 && freshBpm !== null;
      const shouldRender =
        result.beat !== null || now - lastRenderAtRef.current >= 90;
      if (!shouldRender) return;
      lastRenderAtRef.current = now;
      setState({
        fingerDetected: result.fingerDetected,
        signalQuality: result.signalQuality,
        waveform: result.waveform,
        bpm: freshBpm,
        validBeats: validBeatsRef.current,
        stableMs,
        ready,
        beatSerial: beatSerialRef.current,
        lastBeat: lastBeatRef.current,
        lastBeatAt: lastBeatAtRef.current,
        beatAgeMs,
        holdingSignal: holdingSignalRef.current,
        diagnostics: result.diagnostics,
      });
    },
    [],
  );

  const onFrameSample = useCallback(
    (sample: PpgFrameSample) => {
      if (!enabled || source !== "camera") return;
      const result = processorRef.current.process(sample);
      if (
        result.beat !== null ||
        sample.timestamp - lastTraceAtRef.current >= 200
      ) {
        lastTraceAtRef.current = sample.timestamp;
        traceRef.current.push({
          kind: "frame",
          timestamp: sample.timestamp,
          sample,
          result: {
            fingerDetected: result.fingerDetected,
            signalQuality: result.signalQuality,
            bpm: result.bpm,
            beat: result.beat,
            diagnostics: result.diagnostics,
          },
        });
        // 약 3분의 숫자형 진단만 보관하며 카메라 영상은 저장하지 않습니다.
        if (traceRef.current.length > 900) traceRef.current.shift();
      }
      handleResult(result, sample.timestamp);
    },
    [enabled, handleResult, source],
  );

  const exportTrace = useCallback(
    () =>
      JSON.stringify(
        {
          format: "heartrace-ppg-trace-v2",
          exportedAt: Date.now(),
          source,
          records: traceRef.current,
        },
        null,
        2,
      ),
    [source],
  );

  useEffect(() => {
    if (!enabled || source !== "camera") return;
    const timer = setInterval(() => {
      const now = Date.now();
      const predicted = holdoverRef.current.poll(now);
      if (predicted) {
        traceRef.current.push({
          kind: "bridged",
          timestamp: now,
          beat: predicted,
        });
        if (traceRef.current.length > 900) traceRef.current.shift();
        holdingSignalRef.current = true;
        onBeatRef.current(predicted);
        setState((current) => ({
          ...current,
          bpm: predicted.bpm,
          beatAgeMs:
            lastBeatAtRef.current === null ? null : now - lastBeatAtRef.current,
          holdingSignal: true,
        }));
        return;
      }
      if (holdingSignalRef.current && !holdoverRef.current.canHold(now)) {
        holdingSignalRef.current = false;
        setState((current) => ({
          ...current,
          bpm: null,
          holdingSignal: false,
        }));
      }
    }, 50);
    return () => clearInterval(timer);
  }, [enabled, source]);

  useEffect(() => {
    if (!enabled || source !== "simulator") return;
    stableStartedAtRef.current = Date.now();
    const intervalMs = 60_000 / simulatorBpm;
    const timer = setInterval(() => {
      const now = Date.now();
      const beat: PpgBeat = {
        detectedAt: now,
        ibiMs: Math.round(intervalMs),
        bpm: simulatorBpm,
        confidence: 0.96,
        signalQuality: 0.94,
        source: "observed",
      };
      validBeatsRef.current += 1;
      beatSerialRef.current += 1;
      onBeatRef.current(beat);
      const stableMs = now - (stableStartedAtRef.current ?? now);
      setState({
        fingerDetected: true,
        signalQuality: 0.94,
        waveform: 1,
        bpm: simulatorBpm,
        validBeats: validBeatsRef.current,
        stableMs,
        ready: stableMs >= 5_000 && validBeatsRef.current >= 4,
        beatSerial: beatSerialRef.current,
        lastBeat: beat,
        lastBeatAt: now,
        beatAgeMs: 0,
        holdingSignal: false,
        diagnostics: null,
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, simulatorBpm, source]);

  return { state, onFrameSample, reset, resetCadence, exportTrace };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
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
  diagnostics: PpgDiagnostics | null;
}

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
  const onBeatRef = useRef(onBeat);
  const stableStartedAtRef = useRef<number | null>(null);
  const validBeatsRef = useRef(0);
  const beatSerialRef = useRef(0);
  const lastBeatRef = useRef<PpgBeat | null>(null);
  const lastBeatAtRef = useRef<number | null>(null);
  const lastRenderAtRef = useRef(0);
  const [state, setState] = useState<HeartRateState>(INITIAL_STATE);

  onBeatRef.current = onBeat;

  const reset = useCallback(() => {
    processorRef.current.reset();
    stableStartedAtRef.current = null;
    validBeatsRef.current = 0;
    beatSerialRef.current = 0;
    lastBeatRef.current = null;
    lastBeatAtRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  const resetCadence = useCallback(() => {
    processorRef.current.resetCadence();
  }, []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

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
        validBeatsRef.current += 1;
        beatSerialRef.current += 1;
        lastBeatRef.current = result.beat;
        lastBeatAtRef.current = result.beat.detectedAt;
        onBeatRef.current(result.beat);
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
        diagnostics: result.diagnostics,
      });
    },
    [],
  );

  const onFrameSample = useCallback(
    (sample: PpgFrameSample) => {
      if (!enabled || source !== "camera") return;
      handleResult(processorRef.current.process(sample), sample.timestamp);
    },
    [enabled, handleResult, source],
  );

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
        diagnostics: null,
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, simulatorBpm, source]);

  return { state, onFrameSample, reset, resetCadence };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraDevices,
  useCameraPermission,
  useFrameOutput,
  type CameraDevice,
  type CameraRef,
} from "react-native-vision-camera";
import { scheduleOnRN } from "react-native-worklets";
import type { PpgFrameSample } from "@heartrace/ppg-core";

export type PpgCameraLens = "ultra-wide-angle" | "wide-angle" | "telephoto";

const PPG_CAMERA_LENS_ORDER: readonly PpgCameraLens[] = [
  "ultra-wide-angle",
  "wide-angle",
  "telephoto",
];

export interface PpgCameraLensInfo {
  lens: PpgCameraLens;
  localizedName: string;
  hasTorch: boolean;
}

export interface PpgCameraDeviceInfo {
  requestedLens: PpgCameraLens;
  activeLens: PpgCameraLens | null;
  localizedName: string | null;
  hasTorch: boolean;
  usingFallback: boolean;
  availableLenses: PpgCameraLensInfo[];
  exposureBias: number;
  calibration: "waiting" | "adjusting" | "locked";
}

export function PpgCamera({
  active,
  visible = false,
  onSample,
  onPermission,
  onRunningChange,
  onTorchChange,
  onTorchError,
  preferredLens = "ultra-wide-angle",
  onDeviceInfo,
}: {
  active: boolean;
  visible?: boolean;
  onSample: (sample: PpgFrameSample) => void;
  onPermission: (granted: boolean) => void;
  onRunningChange?: (running: boolean) => void;
  onTorchChange?: (enabled: boolean) => void;
  onTorchError?: (message: string | null) => void;
  preferredLens?: PpgCameraLens;
  onDeviceInfo?: (info: PpgCameraDeviceInfo) => void;
}) {
  const cameraRef = useRef<CameraRef>(null);
  const lastExposureAdjustmentAtRef = useRef(0);
  const stableExposureChecksRef = useRef(0);
  const exposureLockingRef = useRef(false);
  const whiteBalanceLockedRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const calibrationRef = useRef<PpgCameraDeviceInfo["calibration"]>("waiting");
  const { hasPermission, requestPermission } = useCameraPermission();
  const allDevices = useCameraDevices();
  const defaultBackCamera = useCameraDevice("back");
  const filteredBackCamera = useCameraDevice("back", {
    physicalDevices: [preferredLens],
  });
  const physicalBackCameras = useMemo(
    () => collectPhysicalBackCameras(allDevices),
    [allDevices],
  );
  const exactPreferredCamera = physicalBackCameras.find(
    (device) => device.type === preferredLens,
  );
  const requestedCamera = exactPreferredCamera ?? filteredBackCamera;
  // 접촉식 PPG에는 조명이 필수이므로 요청한 렌즈가 torch를 제공하지 않으면
  // 기본 후면 렌즈로 안전하게 돌아갑니다.
  const backCamera = requestedCamera?.hasTorch
    ? requestedCamera
    : defaultBackCamera?.hasTorch
      ? defaultBackCamera
      : (requestedCamera ?? defaultBackCamera);
  const requestedCameraIsActive =
    requestedCamera?.hasTorch === true && requestedCamera.id === backCamera?.id;
  const activeLens =
    cameraLens(backCamera) ??
    (requestedCameraIsActive
      ? preferredLens
      : backCamera
        ? "wide-angle"
        : null);
  const initialExposureBias = clamp(
    backCamera?.minExposureBias ?? -0.7,
    backCamera?.maxExposureBias ?? -0.7,
    -0.7,
  );
  const [exposureBias, setExposureBias] = useState(initialExposureBias);
  const [calibration, setCalibration] =
    useState<PpgCameraDeviceInfo["calibration"]>("waiting");

  useEffect(() => {
    setExposureBias(initialExposureBias);
    setCalibration("waiting");
    calibrationRef.current = "waiting";
    lastExposureAdjustmentAtRef.current = 0;
    stableExposureChecksRef.current = 0;
    exposureLockingRef.current = false;
    whiteBalanceLockedRef.current = false;
  }, [backCamera?.id, initialExposureBias]);

  useEffect(() => {
    sessionGenerationRef.current += 1;
  }, [active, backCamera?.id]);

  const deviceInfo = useMemo<PpgCameraDeviceInfo>(
    () => ({
      requestedLens: preferredLens,
      activeLens,
      localizedName: backCamera?.localizedName ?? null,
      hasTorch: backCamera?.hasTorch ?? false,
      usingFallback: activeLens !== preferredLens,
      exposureBias,
      calibration,
      availableLenses: PPG_CAMERA_LENS_ORDER.flatMap((lens) => {
        const device = physicalBackCameras.find(
          (candidate) => candidate.type === lens,
        );
        return device && isPpgLens(device)
          ? [
              {
                lens: device.type,
                localizedName: device.localizedName,
                hasTorch: device.hasTorch,
              },
            ]
          : [];
      }),
    }),
    [
      activeLens,
      backCamera?.hasTorch,
      backCamera?.localizedName,
      calibration,
      exposureBias,
      physicalBackCameras,
      preferredLens,
    ],
  );

  useEffect(() => {
    onDeviceInfo?.(deviceInfo);
  }, [deviceInfo, onDeviceInfo]);

  useEffect(() => {
    onPermission(hasPermission);
  }, [hasPermission, onPermission]);

  useEffect(() => {
    if (active && !hasPermission) {
      void requestPermission().then(onPermission);
    }
  }, [active, hasPermission, onPermission, requestPermission]);

  const deliverSample = useCallback(
    (
      red: number,
      green: number,
      blue: number,
      redSpatialStdDev: number,
      greenSpatialStdDev: number,
      saturationRatio: number,
      timestamp: number,
    ) => {
      // 손가락을 올린 직후 자동 노출/화이트밸런스가 크게 움직이는 구간은
      // 실제 심박보다 훨씬 빠른 가짜 peak를 만듭니다. 카메라 보정이 잠긴
      // 다음 프레임부터만 PPG 처리기에 전달합니다.
      if (calibrationRef.current === "locked") {
        onSample({
          red,
          green,
          blue,
          redSpatialStdDev,
          greenSpatialStdDev,
          saturationRatio,
          timestamp,
        });
      }

      const controller = cameraRef.current?.controller;
      if (
        !controller ||
        !controller.device.supportsExposureBias ||
        calibrationRef.current === "locked" ||
        timestamp - lastExposureAdjustmentAtRef.current < 650
      ) {
        return;
      }

      const redDominance = (red - Math.max(green, blue)) / Math.max(1, red);
      const fingerPresent = red >= 90 && redDominance >= 0.08;
      if (!fingerPresent) {
        stableExposureChecksRef.current = 0;
        calibrationRef.current = "waiting";
        setCalibration("waiting");
        return;
      }

      lastExposureAdjustmentAtRef.current = timestamp;
      calibrationRef.current = "adjusting";
      setCalibration("adjusting");

      // 손가락이 올라온 뒤의 색온도를 고정해야 자동 화이트밸런스가
      // 붉은 PPG 변화를 회색으로 중화하지 않습니다.
      if (
        Platform.OS === "ios" &&
        !whiteBalanceLockedRef.current &&
        controller.device.supportsWhiteBalanceLocking
      ) {
        whiteBalanceLockedRef.current = true;
        void controller.lockCurrentWhiteBalance().catch(() => {
          whiteBalanceLockedRef.current = false;
        });
      }

      const nextDelta =
        red >= 244
          ? -0.32
          : red >= 236
            ? -0.18
            : red < 175
              ? 0.28
              : red < 192
                ? 0.14
                : 0;

      if (nextDelta !== 0) {
        stableExposureChecksRef.current = 0;
        setExposureBias((current) =>
          clamp(
            controller.device.minExposureBias,
            controller.device.maxExposureBias,
            current + nextDelta,
          ),
        );
        return;
      }

      stableExposureChecksRef.current += 1;
      if (stableExposureChecksRef.current >= 3 && !exposureLockingRef.current) {
        if (
          Platform.OS === "ios" &&
          controller.device.supportsExposureLocking
        ) {
          exposureLockingRef.current = true;
          void controller
            .lockCurrentExposure()
            .then(() => {
              calibrationRef.current = "locked";
              setCalibration("locked");
            })
            .catch(() => {
              exposureLockingRef.current = false;
            });
        } else {
          exposureLockingRef.current = true;
          calibrationRef.current = "locked";
          setCalibration("locked");
        }
      }
    },
    [onSample],
  );

  const frameOutput = useFrameOutput({
    pixelFormat: "rgb",
    targetResolution: CommonResolutions.VGA_16_9,
    onFrame(frame) {
      "worklet";
      try {
        if (frame.pixelFormat !== "rgb-bgra-8-bit") return;
        const pixels = new Uint8Array(frame.getPixelBuffer());
        const width = frame.width;
        const height = frame.height;
        const rowStride = Math.floor(pixels.length / Math.max(1, height));
        // 렌즈 중앙의 작은 영역만 읽어 손가락 가장자리와 외부광 혼입을 줄입니다.
        const startX = Math.floor(width * 0.34);
        const endX = Math.floor(width * 0.66);
        const startY = Math.floor(height * 0.34);
        const endY = Math.floor(height * 0.66);
        const step = 8;
        let red = 0;
        let green = 0;
        let blue = 0;
        let redSquares = 0;
        let greenSquares = 0;
        let saturated = 0;
        let count = 0;

        for (let y = startY; y < endY; y += step) {
          const row = y * rowStride;
          for (let x = startX; x < endX; x += step) {
            const offset = row + x * 4;
            const pixelBlue = pixels[offset] ?? 0;
            const pixelGreen = pixels[offset + 1] ?? 0;
            const pixelRed = pixels[offset + 2] ?? 0;
            blue += pixelBlue;
            green += pixelGreen;
            red += pixelRed;
            redSquares += pixelRed * pixelRed;
            greenSquares += pixelGreen * pixelGreen;
            if (pixelRed >= 250 || pixelGreen >= 250 || pixelBlue >= 250) {
              saturated += 1;
            }
            count += 1;
          }
        }
        if (count > 0) {
          const meanRed = red / count;
          const meanGreen = green / count;
          scheduleOnRN(
            deliverSample,
            meanRed,
            meanGreen,
            blue / count,
            Math.sqrt(Math.max(0, redSquares / count - meanRed * meanRed)),
            Math.sqrt(
              Math.max(0, greenSquares / count - meanGreen * meanGreen),
            ),
            saturated / count,
            Date.now(),
          );
        }
      } finally {
        frame.dispose();
      }
    },
  });

  const handleCameraStarted = useCallback(() => {
    onRunningChange?.(true);
    const generation = sessionGenerationRef.current;
    const expectedDeviceId = backCamera?.id;
    const currentController = () => {
      if (sessionGenerationRef.current !== generation) return null;
      const controller = cameraRef.current?.controller;
      if (!controller || controller.device.id !== expectedDeviceId) return null;
      return controller;
    };
    const configure = async () => {
      // CameraRef.controller는 onStarted 이후에 준비됩니다. 약간 뒤에 다시
      // 읽습니다. 이전 화면에서 고정한 노출/화이트밸런스가 물리 카메라에
      // 남을 수 있으므로 먼저 3A를 연속 자동 모드로 되돌린 뒤 새 접촉
      // 상태에서 다시 보정합니다.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      let controller = currentController();
      if (!controller) return;
      await controller.resetFocus().catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      controller = currentController();
      if (!controller) return;

      // declarative torchMode와 별개로 플래시를 확실히 켭니다.
      if (controller.device.hasTorch) {
        await controller.setTorchMode("on");
        onTorchChange?.(true);
        onTorchError?.(null);
      } else {
        onTorchChange?.(false);
        onTorchError?.("선택된 카메라는 플래시를 지원하지 않습니다.");
      }
      if (controller.device.supportsTorchStrength) {
        const range =
          controller.device.maxTorchStrength -
          controller.device.minTorchStrength;
        await controller
          .enableTorchWithStrength(
            controller.device.minTorchStrength + range * 0.62,
          )
          .catch(() => undefined);
      }
    };
    void configure().catch(() => {
      onTorchChange?.(false);
      onTorchError?.(
        "플래시를 켜지 못했습니다. 렌즈를 바꿔 다시 시도해 주세요.",
      );
    });
  }, [backCamera?.id, onRunningChange, onTorchChange, onTorchError]);

  const handleCameraStopped = useCallback(() => {
    onRunningChange?.(false);
    onTorchChange?.(false);
  }, [onRunningChange, onTorchChange]);

  useEffect(() => {
    return () => {
      sessionGenerationRef.current += 1;
      void cameraRef.current?.controller
        ?.setTorchMode("off")
        .catch(() => undefined);
      onRunningChange?.(false);
      onTorchChange?.(false);
    };
  }, [onRunningChange, onTorchChange]);

  if (!hasPermission || !backCamera) return null;

  return (
    <View
      pointerEvents="none"
      style={visible ? styles.visibleCamera : styles.hiddenCamera}
    >
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={backCamera}
        isActive={active}
        outputs={[frameOutput]}
        constraints={[{ fps: 30 }, { resolutionBias: frameOutput }]}
        {...(backCamera.supportsExposureBias ? { exposure: exposureBias } : {})}
        torchMode={backCamera.hasTorch && active ? "on" : "off"}
        onStarted={handleCameraStarted}
        onStopped={handleCameraStopped}
      />
    </View>
  );
}

function collectPhysicalBackCameras(devices: CameraDevice[]): CameraDevice[] {
  const found = new Map<string, CameraDevice>();
  for (const device of devices) {
    if (device.position !== "back") continue;
    if (!device.isVirtualDevice) found.set(device.id, device);
    for (const physical of device.physicalDevices) {
      if (physical.position === "back") found.set(physical.id, physical);
    }
  }
  return [...found.values()];
}

function isPpgLens(
  device: CameraDevice,
): device is CameraDevice & { type: PpgCameraLens } {
  return (
    device.type === "ultra-wide-angle" ||
    device.type === "wide-angle" ||
    device.type === "telephoto"
  );
}

function cameraLens(device: CameraDevice | undefined): PpgCameraLens | null {
  if (!device) return null;
  if (
    device.type === "ultra-wide-angle" ||
    device.type === "wide-angle" ||
    device.type === "telephoto"
  ) {
    return device.type;
  }
  return null;
}

function clamp(minimum: number, maximum: number, value: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

const styles = StyleSheet.create({
  visibleCamera: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
  },
  hiddenCamera: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    opacity: 0.01,
  },
});

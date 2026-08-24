import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  AppState,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useFonts } from "expo-font";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
  RELAY_RUNNER_COLORS,
  RELAY_TEAM_COLORS,
  type BeatEvent,
  type PlayerSnapshot,
  type RoomSnapshot,
} from "@heartrace/protocol";
import type { PpgBeat } from "@heartrace/ppg-core";
import {
  useGameConnection,
  type BeatDeliveryReason,
  type BeatDeliveryState,
} from "./src/game/useGameConnection";
import {
  PpgCamera,
  type PpgCameraDeviceInfo,
  type PpgCameraLens,
} from "./src/measurement/PpgCamera";
import {
  useHeartRate,
  type HeartRateSource,
  type HeartRateState,
} from "./src/measurement/useHeartRate";
import { colors, fonts } from "./src/theme";

const DEV_SIMULATOR =
  __DEV__ || process.env.EXPO_PUBLIC_ENABLE_SIMULATOR === "true";
const ENABLE_RACE_PREVIEW =
  __DEV__ || process.env.EXPO_PUBLIC_ENABLE_RACE_PREVIEW === "true";
const PUBLIC_URL =
  process.env.EXPO_PUBLIC_PUBLIC_URL ??
  "https://heartrace-postmelee.onrender.com";
const RACE_CAMERA_SIZE = 154;
const RACE_INK = "#050505";
const RACE_PAPER = "#FFFFFF";

interface CameraPreviewTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RacePalette {
  foreground: string;
  muted: string;
  surface: string;
  line: string;
  statusBarStyle: "dark" | "light";
}

interface RacePreviewModel {
  beatCount: number;
  runnerIndex: number;
  status: "running" | "handoff";
  handoffEndsAt: number | null;
}

export default function App() {
  const [fontsLoaded] = useFonts({
    "Pretendard-Regular": require("./assets/fonts/Pretendard-Regular.ttf"),
    "Pretendard-Medium": require("./assets/fonts/Pretendard-Medium.ttf"),
    "Pretendard-SemiBold": require("./assets/fonts/Pretendard-SemiBold.ttf"),
    "Pretendard-Bold": require("./assets/fonts/Pretendard-Bold.ttf"),
  });

  if (!fontsLoaded) return <View style={styles.loadingBackground} />;

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <HeartRunApp />
    </SafeAreaProvider>
  );
}

function HeartRunApp() {
  const game = useGameConnection();
  const { width: viewportWidth, height: viewportHeight } =
    useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const reduceMotion = useReducedMotionEnabled();
  const roomRef = useRef<RoomSnapshot | null>(null);
  const heartRateStateRef = useRef<HeartRateState | null>(null);
  const sequenceRef = useRef(0);
  const activePhaseStackRef = useRef<View>(null);
  const relayTransition = useRef(new Animated.Value(0)).current;
  const [source, setSource] = useState<HeartRateSource>("camera");
  const [simulatorBpm, setSimulatorBpm] = useState(76);
  const [cameraPermission, setCameraPermission] = useState(true);
  const [measurementStarted, setMeasurementStarted] = useState(false);
  const [cameraRunning, setCameraRunning] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [torchError, setTorchError] = useState<string | null>(null);
  const [cameraLens, setCameraLens] =
    useState<PpgCameraLens>("ultra-wide-angle");
  const [cameraSwitchPhase, setCameraSwitchPhase] = useState<
    "idle" | "stopping" | "settling"
  >("idle");
  const pendingCameraLensRef = useRef<PpgCameraLens | null>(null);
  const [cameraDeviceInfo, setCameraDeviceInfo] =
    useState<PpgCameraDeviceInfo | null>(null);
  const [measurementCameraTarget, setMeasurementCameraTarget] =
    useState<CameraPreviewTarget | null>(null);
  const [raceCameraTarget, setRaceCameraTarget] =
    useState<CameraPreviewTarget | null>(null);
  const [cameraLayoutEpoch, setCameraLayoutEpoch] = useState(0);
  const [racePreviewOpen, setRacePreviewOpen] = useState(false);

  roomRef.current = game.room;
  const ownPlayer =
    game.room && game.session
      ? findPlayer(game.room, game.session.playerId)
      : undefined;
  const relayHandoff =
    game.room?.phase === "racing" && ownPlayer?.relay?.status === "handoff";
  const relayCameraHandoffOffset = Math.min(
    220,
    Math.max(168, viewportHeight * 0.24),
  );

  useEffect(() => {
    relayTransition.stopAnimation();
    const nextValue = relayHandoff ? 1 : 0;
    if (reduceMotion) {
      relayTransition.setValue(nextValue);
      return;
    }
    const animation = Animated.timing(relayTransition, {
      toValue: nextValue,
      duration: 520,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, relayHandoff, relayTransition]);

  const onMeasurementCameraTarget = useCallback(
    (target: CameraPreviewTarget | null) => {
      setMeasurementCameraTarget((current) => {
        if (!target) return null;
        return sameCameraTarget(current, target) ? current : target;
      });
    },
    [],
  );

  const onRaceCameraTarget = useCallback(
    (target: CameraPreviewTarget | null) => {
      setRaceCameraTarget((current) => {
        if (!target) return null;
        return sameCameraTarget(current, target) ? current : target;
      });
    },
    [],
  );

  const invalidateCameraTargets = useCallback(() => {
    setMeasurementCameraTarget(null);
    setRaceCameraTarget(null);
    setCameraLayoutEpoch((current) => current + 1);
  }, []);

  useEffect(() => {
    invalidateCameraTargets();
  }, [
    invalidateCameraTargets,
    safeAreaInsets.bottom,
    safeAreaInsets.left,
    safeAreaInsets.right,
    safeAreaInsets.top,
    game.room?.phase,
    viewportHeight,
    viewportWidth,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") invalidateCameraTargets();
    });
    return () => subscription.remove();
  }, [invalidateCameraTargets]);

  const onBeat = useCallback(
    (beat: PpgBeat) => {
      if (roomRef.current?.phase !== "racing") return;
      // 바톤 시간의 최종 판정은 서버가 담당합니다. 전환 중 박동도 서버로
      // 보내야 단발성 타이머나 스냅샷이 누락됐을 때 만료 상태를 복구할 수 있습니다.
      sequenceRef.current += 1;
      const event: BeatEvent = {
        id: `${Date.now().toString(36)}-${sequenceRef.current.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sequence: sequenceRef.current,
        detectedAt: beat.detectedAt,
        ibiMs: beat.ibiMs,
        bpm: beat.bpm,
        confidence: beat.confidence,
        signalQuality: beat.signalQuality,
        source: beat.source ?? "observed",
      };
      game.sendBeat(event);
    },
    [game.sendBeat],
  );

  useEffect(() => {
    sequenceRef.current = Math.max(sequenceRef.current, game.lastBeatSequence);
  }, [game.lastBeatSequence, game.session?.playerId]);

  useEffect(() => {
    if (game.room?.phase !== "lobby") return;
    setMeasurementStarted(false);
    setCameraRunning(false);
    setTorchEnabled(false);
    setTorchError(null);
    pendingCameraLensRef.current = null;
    setCameraSwitchPhase("idle");
  }, [game.room?.code, game.room?.phase]);

  const measurementEnabled =
    game.session !== null &&
    game.room !== null &&
    game.room.phase !== "finished" &&
    (game.room.phase !== "lobby" || measurementStarted);
  const heartRate = useHeartRate({
    source,
    enabled: measurementEnabled,
    simulatorBpm,
    onBeat,
  });
  heartRateStateRef.current = heartRate.state;

  const handoffEndsAt = ownPlayer?.relay?.handoffEndsAt ?? null;
  useEffect(() => {
    if (handoffEndsAt === null) return;
    // 사람 사이에는 카메라 세션을 유지해 플래시 재점등 지연을 피하되,
    // 이전 주자의 cadence와 보간 상태를 완전히 버립니다.
    heartRate.reset();
    game.resetBeatDelivery();
  }, [game.resetBeatDelivery, handoffEndsAt, heartRate.reset]);

  useEffect(() => {
    if (game.room?.phase === "countdown") {
      sequenceRef.current = 0;
      game.resetBeatDelivery();
    }
  }, [game.resetBeatDelivery, game.room?.phase]);

  useEffect(() => {
    if (!game.session || !game.room || game.room.phase === "finished") return;
    const phase = game.room.phase;
    const send = () => {
      const state = heartRateStateRef.current;
      if (!state) return;
      game.sendMeasurement({
        state:
          phase === "lobby" && !measurementStarted
            ? "joined"
            : state.ready
              ? "ready"
              : state.fingerDetected
                ? "measuring"
                : state.validBeats > 0
                  ? "signal_lost"
                  : "measuring",
        bpm: state.bpm,
        signalQuality: state.signalQuality,
      });
    };
    send();
    const timer = setInterval(send, 700);
    return () => clearInterval(timer);
  }, [
    game.room?.phase,
    game.session,
    game.sendMeasurement,
    measurementStarted,
  ]);

  const cameraMounted = measurementEnabled && source === "camera";
  const cameraActive = cameraMounted && cameraSwitchPhase === "idle";
  useEffect(() => {
    if (cameraSwitchPhase !== "stopping" || cameraRunning) return;
    const nextLens = pendingCameraLensRef.current;
    if (!nextLens) {
      setCameraSwitchPhase("idle");
      return;
    }
    setCameraLens(nextLens);
    setCameraSwitchPhase("settling");
  }, [cameraRunning, cameraSwitchPhase]);

  useEffect(() => {
    if (cameraSwitchPhase !== "stopping") return;
    const fallback = setTimeout(() => setCameraRunning(false), 1_500);
    return () => clearTimeout(fallback);
  }, [cameraSwitchPhase]);

  useEffect(() => {
    if (cameraSwitchPhase !== "settling") return;
    const restart = setTimeout(() => {
      pendingCameraLensRef.current = null;
      setCameraSwitchPhase("idle");
    }, 180);
    return () => clearTimeout(restart);
  }, [cameraSwitchPhase]);
  return (
    <View style={styles.root}>
      {racePreviewOpen ? (
        <RacePreviewExperience onExit={() => setRacePreviewOpen(false)} />
      ) : (
        <View style={styles.opaqueContent}>
          {game.restoring ? (
            <RestoringScreen />
          ) : !game.session || !game.room ? (
            <JoinScreen
              connected={game.connected}
              notice={game.notice}
              onJoin={game.join}
              onOpenRacePreview={
                ENABLE_RACE_PREVIEW
                  ? () => {
                      void Haptics.impactAsync(
                        Haptics.ImpactFeedbackStyle.Medium,
                      );
                      setRacePreviewOpen(true);
                      Alert.alert(
                        "경기 화면 미리보기",
                        "‘경기 중’을 누르면 박동이 늘어납니다. 길게 누르면 바톤 터치 화면으로 전환됩니다.",
                      );
                    }
                  : undefined
              }
            />
          ) : game.room.phase === "finished" ? (
            <FinishScreen
              room={game.room}
              playerId={game.session.playerId}
              onLeave={game.leave}
            />
          ) : (
            <View
              ref={activePhaseStackRef}
              collapsable={false}
              onLayout={invalidateCameraTargets}
              style={styles.activePhaseStack}
            >
              <MeasurementScreen
                room={game.room}
                player={findPlayer(game.room, game.session.playerId)}
                nickname={game.session.nickname}
                connected={game.connected}
                measurement={heartRate.state}
                measurementStarted={measurementStarted}
                source={source}
                cameraPermission={cameraPermission}
                cameraRunning={cameraRunning}
                torchEnabled={torchEnabled}
                torchError={torchError}
                cameraLens={cameraLens}
                cameraDeviceInfo={cameraDeviceInfo}
                cameraSwitching={cameraSwitchPhase !== "idle"}
                cameraCoordinateRootRef={activePhaseStackRef}
                cameraLayoutEpoch={cameraLayoutEpoch}
                onCameraPreviewTarget={onMeasurementCameraTarget}
                onStartMeasurement={() => {
                  heartRate.reset();
                  setCameraRunning(false);
                  setTorchEnabled(false);
                  setTorchError(null);
                  setMeasurementStarted(true);
                }}
                onToggleCameraLens={() => {
                  if (cameraSwitchPhase !== "idle") return;
                  const selectable = cameraDeviceInfo?.availableLenses.filter(
                    (lens) => lens.hasTorch,
                  );
                  if (!selectable || selectable.length < 2) return;
                  const currentLens =
                    cameraDeviceInfo?.activeLens ?? cameraLens;
                  const activeIndex = selectable.findIndex(
                    (lens) => lens.lens === currentLens,
                  );
                  const next =
                    selectable[(activeIndex + 1) % selectable.length];
                  if (!next) return;
                  heartRate.reset();
                  setTorchEnabled(false);
                  setTorchError(null);
                  pendingCameraLensRef.current = next.lens;
                  setCameraSwitchPhase("stopping");
                }}
                onLeave={game.leave}
              />
              {game.room.phase === "countdown" && (
                <View style={styles.activePhaseOverlay}>
                  <CountdownScreen room={game.room} />
                </View>
              )}
              {game.room.phase === "racing" && (
                <View style={styles.activePhaseOverlay}>
                  <RaceScreen
                    room={game.room}
                    player={ownPlayer}
                    connected={game.connected}
                    measurement={heartRate.state}
                    beatCount={game.lastOwnBeat?.beatCount ?? 0}
                    accent={game.lastOwnBeat?.accent ?? false}
                    beatDelivery={game.beatDelivery}
                    source={source}
                    simulatorBpm={simulatorBpm}
                    handoffProgress={relayTransition}
                    handoffCameraOffset={relayCameraHandoffOffset}
                    cameraCoordinateRootRef={activePhaseStackRef}
                    cameraLayoutEpoch={cameraLayoutEpoch}
                    onCameraPreviewTarget={onRaceCameraTarget}
                    onSimulatorBpm={setSimulatorBpm}
                    onLeave={() => {
                      Alert.alert(
                        "경기에서 나갈까요?",
                        "현재 경기의 진행 기록은 사라집니다.",
                        [
                          { text: "계속 경기하기", style: "cancel" },
                          {
                            text: "경기 나가기",
                            style: "destructive",
                            onPress: () => {
                              heartRate.reset();
                              game.leave();
                            },
                          },
                        ],
                      );
                    }}
                  />
                </View>
              )}
              <SharedCameraPreview
                room={game.room}
                player={ownPlayer}
                target={
                  game.room.phase === "racing"
                    ? raceCameraTarget
                    : measurementCameraTarget
                }
                visible={
                  cameraActive &&
                  (game.room.phase === "lobby" || game.room.phase === "racing")
                }
                measurementMode={game.room.phase === "lobby"}
                handoffProgress={relayTransition}
                handoffCameraOffset={relayCameraHandoffOffset}
                reduceMotion={reduceMotion}
              >
                {cameraMounted ? (
                  <PpgCamera
                    active={cameraActive}
                    visible
                    onSample={heartRate.onFrameSample}
                    onPermission={setCameraPermission}
                    onRunningChange={setCameraRunning}
                    onTorchChange={setTorchEnabled}
                    onTorchError={setTorchError}
                    preferredLens={cameraLens}
                    onDeviceInfo={setCameraDeviceInfo}
                  />
                ) : null}
              </SharedCameraPreview>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function JoinScreen({
  connected,
  notice,
  onJoin,
  onOpenRacePreview,
}: {
  connected: boolean;
  notice: string | null;
  onJoin: (roomCode: string, nickname: string) => Promise<void>;
  onOpenRacePreview?: (() => void) | undefined;
}) {
  const [roomCode, setRoomCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyboardSpacer, setKeyboardSpacer] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const nicknameRef = useRef<TextInput>(null);
  const joinButtonRef = useRef<View>(null);
  const keyboardVisibleRef = useRef(false);

  const revealFormAboveKeyboard = useCallback(() => {
    const button = joinButtonRef.current;
    if (!button) return;
    scrollRef.current?.scrollResponderScrollNativeHandleToKeyboard(
      button,
      16,
      true,
    );
  }, []);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      keyboardVisibleRef.current = true;
      // KAV의 높이 애니메이션이 끝나기 전에도 최종 위치까지 스크롤할 수
      // 있도록 키보드의 최종 높이만큼 콘텐츠 여유 공간을 먼저 확보합니다.
      setKeyboardSpacer(event.endCoordinates.height);
      requestAnimationFrame(revealFormAboveKeyboard);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      keyboardVisibleRef.current = false;
      setKeyboardSpacer(0);
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [revealFormAboveKeyboard]);

  const handleInputFocus = () => {
    if (Keyboard.isVisible()) revealFormAboveKeyboard();
  };

  useEffect(() => {
    const applyUrl = (url: string | null) => {
      if (!url) return;
      try {
        const parsed = new URL(url);
        const code = parsed.searchParams.get("room");
        if (code) setRoomCode(code.slice(0, 4).toUpperCase());
      } catch {
        // 잘못된 외부 URL은 무시하고 직접 입력을 유지합니다.
      }
    };
    void Linking.getInitialURL().then(applyUrl);
    const subscription = Linking.addEventListener("url", ({ url }) =>
      applyUrl(url),
    );
    return () => subscription.remove();
  }, []);

  const submit = async () => {
    if (roomCode.length !== 4)
      return setError("네 자리 방 코드를 입력해 주세요.");
    if (!nickname.trim())
      return setError("개인 이름 또는 팀 이름을 입력해 주세요.");
    setBusy(true);
    setError(null);
    try {
      await onJoin(roomCode, nickname);
    } catch (joinError) {
      setError(
        joinError instanceof Error ? joinError.message : "입장하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitAndDismiss = () => {
    Keyboard.dismiss();
    void submit();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
      style={styles.flex}
    >
      <ScrollView
        ref={scrollRef}
        bounces={false}
        contentContainerStyle={styles.joinScrollContent}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        onLayout={() => {
          if (keyboardVisibleRef.current) revealFormAboveKeyboard();
        }}
        showsVerticalScrollIndicator={false}
      >
        <SafeAreaView edges={["top", "bottom"]} style={styles.joinScreen}>
          <View style={styles.screenHeader}>
            <Pressable
              accessibilityLabel="심장달리기"
              accessibilityHint={
                onOpenRacePreview
                  ? "길게 누르면 경기 화면 미리보기를 엽니다"
                  : undefined
              }
              accessibilityRole="header"
              delayLongPress={700}
              disabled={!onOpenRacePreview}
              onLongPress={onOpenRacePreview}
              style={styles.wordmark}
            >
              <Text aria-hidden style={styles.wordmarkIcon}>
                ♥
              </Text>
              <Text style={styles.wordmarkTitle}>심장달리기</Text>
            </Pressable>
            <ConnectionPill connected={connected} />
          </View>
          <View style={styles.joinCopy}>
            <Text style={styles.eyebrow}>한 박동, 한 걸음</Text>
            <Text maxFontSizeMultiplier={1.1} style={styles.joinTitle}>
              심장으로{`\n`}달릴 준비가 됐나요?
            </Text>
            <Text style={styles.bodyText}>
              몸은 그대로 두고, 손끝에서 뛰는 심장으로 경주합니다.
            </Text>
          </View>
          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>방 코드</Text>
              <TextInput
                accessibilityLabel="방 코드 네 자리"
                autoCapitalize="characters"
                autoCorrect={false}
                keyboardType="ascii-capable"
                maxLength={4}
                placeholder="AB12"
                placeholderTextColor={colors.placeholder}
                returnKeyType="next"
                style={[styles.textInput, styles.codeInput]}
                value={roomCode}
                onFocus={handleInputFocus}
                onChangeText={(value) =>
                  setRoomCode(value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase())
                }
                onSubmitEditing={() => nicknameRef.current?.focus()}
              />
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>참가 이름</Text>
              <TextInput
                ref={nicknameRef}
                accessibilityLabel="개인 이름 또는 팀 이름"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={12}
                placeholder="나의 이름 또는 팀 이름"
                placeholderTextColor={colors.placeholder}
                returnKeyType="go"
                style={styles.textInput}
                value={nickname}
                onFocus={handleInputFocus}
                onChangeText={setNickname}
                onSubmitEditing={submitAndDismiss}
              />
            </View>
            {error && <Text style={styles.errorText}>{error}</Text>}
            {!error && notice && (
              <Text style={styles.noticeText}>{notice}</Text>
            )}
            <View ref={joinButtonRef} collapsable={false}>
              <PrimaryButton
                label={busy ? "입장하는 중…" : "경기장 입장"}
                disabled={busy || !connected}
                onPress={submitAndDismiss}
              />
            </View>
            <View style={styles.privacyArea}>
              <Text style={styles.privacyCopy}>
                카메라 영상은 기기 밖으로 전송하거나 저장하지 않습니다.
              </Text>
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(`${PUBLIC_URL}/privacy`)}
              >
                <Text style={styles.privacyLink}>개인정보 처리방침</Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
        {keyboardSpacer > 0 && (
          <View pointerEvents="none" style={{ height: keyboardSpacer }} />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function MeasurementScreen({
  room,
  player,
  nickname,
  connected,
  measurement,
  measurementStarted,
  source,
  cameraPermission,
  cameraRunning,
  torchEnabled,
  torchError,
  cameraLens,
  cameraDeviceInfo,
  cameraSwitching,
  cameraCoordinateRootRef,
  cameraLayoutEpoch,
  onCameraPreviewTarget,
  onStartMeasurement,
  onToggleCameraLens,
  onLeave,
}: {
  room: RoomSnapshot;
  player: PlayerSnapshot | undefined;
  nickname: string;
  connected: boolean;
  measurement: HeartRateState;
  measurementStarted: boolean;
  source: HeartRateSource;
  cameraPermission: boolean;
  cameraRunning: boolean;
  torchEnabled: boolean;
  torchError: string | null;
  cameraLens: PpgCameraLens;
  cameraDeviceInfo: PpgCameraDeviceInfo | null;
  cameraSwitching: boolean;
  cameraCoordinateRootRef: RefObject<View | null>;
  cameraLayoutEpoch: number;
  onCameraPreviewTarget: (target: CameraPreviewTarget | null) => void;
  onStartMeasurement: () => void;
  onToggleCameraLens: () => void;
  onLeave: () => void;
}) {
  const readyHapticRef = useRef(false);
  const activeRunner = player?.relay?.runners[player.relay.activeRunnerIndex];
  const activeRunnerNumber = player?.relay
    ? player.relay.activeRunnerIndex + 1
    : null;
  const { cameraTargetRef, reportCameraTarget } = useStableCameraTarget({
    coordinateRootRef: cameraCoordinateRootRef,
    layoutEpoch: cameraLayoutEpoch,
    onTarget: onCameraPreviewTarget,
  });
  useEffect(() => {
    if (measurement.ready && !readyHapticRef.current) {
      readyHapticRef.current = true;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    if (!measurement.ready) readyHapticRef.current = false;
  }, [measurement.ready]);

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
      <View style={styles.screenHeader}>
        <Pressable onPress={onLeave} hitSlop={12}>
          <Text style={styles.headerBack}>나가기</Text>
        </Pressable>
        <Text style={styles.headerRoom}>방 {room.code}</Text>
        <ConnectionDot connected={connected} />
      </View>

      <View style={styles.relayRunnerSlot}>
        {activeRunner && (
          <View style={styles.relayRunnerBanner}>
            <Text style={styles.relayRunnerNumber}>{activeRunnerNumber}</Text>
            <Text style={styles.relayRunnerBannerText}>
              {nickname} · {activeRunnerNumber}번 주자
            </Text>
          </View>
        )}
      </View>

      <View style={styles.measurementMain}>
        <View style={styles.cameraStage}>
          <View
            style={[
              styles.fingerTarget,
              measurement.fingerDetected && styles.fingerTargetActive,
            ]}
          >
            <View
              ref={cameraTargetRef}
              collapsable={false}
              onLayout={reportCameraTarget}
              style={[
                styles.cameraLens,
                measurementStarted &&
                  source === "camera" &&
                  styles.cameraLensPreview,
              ]}
            >
              {measurementStarted && source === "camera" ? (
                <Text style={styles.previewHeartGlyph}>♥</Text>
              ) : (
                <Text style={styles.heartGlyph}>♥</Text>
              )}
            </View>
            <View
              style={[
                styles.qualityArc,
                {
                  transform: [
                    {
                      rotate: `${Math.round(measurement.signalQuality * 270 - 135)}deg`,
                    },
                  ],
                },
              ]}
            />
          </View>
        </View>

        <View style={styles.instructionCopy}>
          <Text style={styles.eyebrow}>
            {!measurementStarted
              ? "READY TO MEASURE"
              : !cameraPermission && source === "camera"
                ? "CAMERA ACCESS"
                : measurement.ready
                  ? "READY"
                  : measurement.fingerDetected
                    ? "MEASURING"
                    : "PLACE YOUR FINGER"}
          </Text>
          <View style={styles.measurementTitleSlot}>
            <Text style={styles.measurementTitle}>
              {!measurementStarted
                ? "심박수 측정을\n시작할까요?"
                : !cameraPermission && source === "camera"
                  ? "카메라 접근을\n허용해 주세요"
                  : measurement.ready
                    ? "준비 완료!"
                    : measurement.fingerDetected
                      ? "손가락을 그대로\n유지하세요"
                      : "카메라와 플래시를\n완전히 덮어주세요"}
            </Text>
          </View>
          <View style={styles.measurementBodySlot}>
            <Text style={[styles.bodyText, styles.measurementBodyText]}>
              {measurement.ready && activeRunner ? (
                <>
                  <Text style={styles.measurementBodyStrong}>
                    {activeRunnerNumber}번 주자
                  </Text>
                  {"의 심장이 "}
                  <Text style={styles.measurementBodyStrong}>{nickname}</Text>
                  {" 팀에 연결됐습니다."}
                </>
              ) : measurement.ready ? (
                <>
                  <Text style={styles.measurementBodyStrong}>{nickname}</Text>
                  {"님의 심장이 경기장에 연결됐습니다."}
                </>
              ) : !measurementStarted ? (
                "버튼을 누르면 후면 카메라와 플래시가 켜집니다."
              ) : !cameraPermission && source === "camera" ? (
                "설정에서 카메라 접근을 허용한 뒤 앱으로 돌아와 주세요."
              ) : measurement.fingerDetected ? (
                measurement.diagnostics?.exposure === "saturated" ? (
                  "손가락 힘을 조금 빼고 카메라 위에 가볍게 유지해 주세요."
                ) : measurement.bpm ? (
                  `${measurement.bpm} BPM · 안정적인 신호를 찾고 있어요.`
                ) : (
                  "조금만 기다리면 박동이 보이기 시작합니다."
                )
              ) : (
                "검지 끝을 휴대폰 뒷면 카메라 위에 가볍게 올려주세요."
              )}
            </Text>
          </View>
        </View>

        <View style={styles.measurementProgressSlot}>
          {measurementStarted && (
            <MeasurementProgress measurement={measurement} />
          )}
        </View>
      </View>

      <View style={styles.measurementFooter}>
        {!measurementStarted ? (
          <View style={styles.measurementStartAction}>
            <PrimaryButton label="측정 시작" onPress={onStartMeasurement} />
          </View>
        ) : !cameraPermission ? (
          <View style={styles.measurementStartAction}>
            <PrimaryButton
              label="설정 열기"
              onPress={() => void Linking.openSettings()}
            />
          </View>
        ) : null}
        {measurementStarted && source === "camera" && cameraPermission && (
          <View style={styles.cameraStatePill}>
            <View
              style={[
                styles.cameraStateDot,
                cameraRunning && styles.cameraStateDotActive,
              ]}
            />
            <Text style={styles.cameraStateText}>
              {cameraSwitching
                ? "카메라 전환 중"
                : cameraRunning
                  ? torchError
                    ? "플래시 오류"
                    : torchEnabled
                      ? `${cameraLensLabel(cameraDeviceInfo?.activeLens ?? cameraLens)} · 플래시 켜짐`
                      : cameraDeviceInfo?.hasTorch === false
                        ? `${cameraLensLabel(cameraDeviceInfo.activeLens)} · 플래시 미지원`
                        : "플래시 연결 중"
                  : "카메라 연결 중"}
            </Text>
          </View>
        )}
        {measurementStarted &&
          source === "camera" &&
          (cameraDeviceInfo?.availableLenses.filter((lens) => lens.hasTorch)
            .length ?? 0) > 1 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="카메라 전환"
              disabled={cameraSwitching}
              onPress={onToggleCameraLens}
              style={({ pressed }) => [
                styles.cameraSwitchButton,
                pressed && styles.cameraSwitchButtonPressed,
                cameraSwitching && styles.cameraSwitchButtonDisabled,
              ]}
            >
              <Text style={styles.cameraSwitchIcon}>↻</Text>
              <Text style={styles.cameraSwitchText}>
                {cameraSwitching ? "카메라 전환 중" : "카메라 전환"}
              </Text>
            </Pressable>
          )}
      </View>
    </SafeAreaView>
  );
}

function CountdownScreen({ room }: { room: RoomSnapshot }) {
  const [clockOffset] = useState(() => room.serverNow - Date.now());
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  const scale = useRef(new Animated.Value(0.72)).current;
  const remaining = Math.max(0, (room.countdownEndsAt ?? now) - now);
  const display =
    remaining > 3_000
      ? "준비"
      : String(Math.max(1, Math.ceil(remaining / 1_000)));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + clockOffset), 50);
    return () => clearInterval(timer);
  }, [clockOffset]);

  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(0.72);
    const animation = Animated.sequence([
      Animated.timing(scale, {
        toValue: 1.08,
        duration: 140,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        damping: 15,
        stiffness: 210,
        mass: 0.65,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    if (display !== "준비") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    return () => animation.stop();
  }, [display, scale]);

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.countdownScreen}>
      <Text style={styles.countdownHint}>손가락을 그대로 유지하세요</Text>
      <View style={styles.countdownNumberSlot}>
        <Animated.Text
          style={[
            styles.countdownNumber,
            display === "준비" && styles.countdownReady,
            { transform: [{ scale }] },
          ]}
        >
          {display}
        </Animated.Text>
      </View>
      <Text style={styles.countdownBottom}>심장으로 달릴 시간</Text>
    </SafeAreaView>
  );
}

function SharedCameraPreview({
  room,
  player,
  target,
  visible,
  measurementMode,
  handoffProgress,
  handoffCameraOffset,
  reduceMotion,
  children,
}: {
  room: RoomSnapshot;
  player: PlayerSnapshot | undefined;
  target: CameraPreviewTarget | null;
  visible: boolean;
  measurementMode: boolean;
  handoffProgress: Animated.Value;
  handoffCameraOffset: number;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  const relay = player?.relay;
  const isHandoff = relay?.status === "handoff";
  const [clockOffset] = useState(() => room.serverNow - Date.now());
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  const scale = useRef(new Animated.Value(0.86)).current;
  const handoffEndsAt = relay?.handoffEndsAt ?? now;
  const remaining = Math.max(0, handoffEndsAt - now);
  const display = Math.max(1, Math.ceil(remaining / 1_000));
  const teamColor = player?.relay ? relayTeamColor(player) : RACE_PAPER;
  const palette = racePalette(teamColor);

  useEffect(() => {
    if (!isHandoff) return;
    setNow(Date.now() + clockOffset);
    const timer = setInterval(() => setNow(Date.now() + clockOffset), 50);
    return () => clearInterval(timer);
  }, [clockOffset, isHandoff, relay?.handoffEndsAt]);

  useEffect(() => {
    if (!isHandoff) return;
    scale.stopAnimation();
    if (reduceMotion) {
      scale.setValue(1);
    } else {
      scale.setValue(0.86);
      Animated.spring(scale, {
        toValue: 1,
        damping: 16,
        stiffness: 210,
        mass: 0.68,
        useNativeDriver: true,
      }).start();
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [display, isHandoff, reduceMotion, scale]);

  const translateY = handoffProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, handoffCameraOffset],
  });
  const countdownOpacity = handoffProgress.interpolate({
    inputRange: [0, 0.58, 1],
    outputRange: [0, 0, 1],
  });

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.sharedCameraPreview,
        target
          ? {
              left: target.x,
              top: target.y,
              width: target.width,
              height: target.height,
              borderRadius: target.width / 2,
            }
          : styles.sharedCameraPreviewWaiting,
        {
          opacity: visible && target ? 1 : 0,
          transform: [{ translateY }],
        },
      ]}
    >
      <View
        style={[
          styles.sharedCameraCrop,
          {
            borderColor: measurementMode ? colors.line : palette.foreground,
            borderRadius: target ? target.width / 2 : 1,
          },
        ]}
      >
        {children}
        {measurementMode && <Text style={styles.sharedCameraHeart}>♥</Text>}
      </View>
      <View style={styles.sharedCameraCountdownSlot}>
        <Animated.Text
          style={[
            styles.sharedCameraCountdown,
            {
              color: palette.foreground,
              opacity: countdownOpacity,
              transform: [{ scale }],
            },
          ]}
        >
          {display}
        </Animated.Text>
      </View>
    </Animated.View>
  );
}

function RacePreviewExperience({ onExit }: { onExit: () => void }) {
  const { height: viewportHeight } = useWindowDimensions();
  const coordinateRootRef = useRef<View>(null);
  const handoffProgress = useRef(new Animated.Value(0)).current;
  const [cameraTarget, setCameraTarget] = useState<CameraPreviewTarget | null>(
    null,
  );
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [preview, setPreview] = useState<RacePreviewModel>({
    beatCount: 8,
    runnerIndex: 0,
    status: "running",
    handoffEndsAt: null,
  });
  const handoffCameraOffset = Math.min(
    220,
    Math.max(168, viewportHeight * 0.24),
  );

  useEffect(() => {
    const animation = Animated.timing(handoffProgress, {
      toValue: preview.status === "handoff" ? 1 : 0,
      duration: 520,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [handoffProgress, preview.status]);

  const onCameraPreviewTarget = useCallback(
    (target: CameraPreviewTarget | null) => {
      setCameraTarget((current) => {
        if (!target) return null;
        return sameCameraTarget(current, target) ? current : target;
      });
    },
    [],
  );

  const enterHandoff = useCallback(() => {
    setPreview((current) => ({
      ...current,
      beatCount: (current.runnerIndex + 1) * 30,
      status: "handoff",
      handoffEndsAt: Date.now() + 5_000,
    }));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  const addBeat = useCallback(() => {
    setPreview((current) => {
      if (current.status === "handoff") return current;
      const legFinishBeat = (current.runnerIndex + 1) * 30;
      const beatCount = Math.min(legFinishBeat, current.beatCount + 1);
      if (beatCount === legFinishBeat) {
        return {
          ...current,
          beatCount,
          status: "handoff",
          handoffEndsAt: Date.now() + 5_000,
        };
      }
      return { ...current, beatCount };
    });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const advanceRunner = useCallback(() => {
    setPreview((current) => {
      const runnerIndex = current.runnerIndex + 1;
      if (runnerIndex >= 3) {
        return {
          beatCount: 8,
          runnerIndex: 0,
          status: "running",
          handoffEndsAt: null,
        };
      }
      return {
        ...current,
        runnerIndex,
        status: "running",
        handoffEndsAt: null,
      };
    });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  const toggleHandoff = useCallback(() => {
    if (preview.status === "running") {
      enterHandoff();
      return;
    }
    advanceRunner();
  }, [advanceRunner, enterHandoff, preview.status]);

  useEffect(() => {
    if (preview.status !== "handoff" || preview.handoffEndsAt === null) return;
    const timer = setTimeout(
      advanceRunner,
      Math.max(0, preview.handoffEndsAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [advanceRunner, preview.handoffEndsAt, preview.status]);

  const now = Date.now();
  const legStartBeat = preview.runnerIndex * 30;
  const legBeatCount = Math.max(0, preview.beatCount - legStartBeat);
  const completedRunners =
    preview.runnerIndex + (preview.status === "handoff" ? 1 : 0);
  const runners = ["1번 주자", "2번 주자", "3번 주자"].map((name, index) => ({
    index,
    name,
    color: RELAY_RUNNER_COLORS[index] ?? RELAY_RUNNER_COLORS[0],
  }));
  const player: PlayerSnapshot = {
    id: "mobile-preview-team",
    laneIndex: 0,
    nickname: "우리 팀",
    connected: true,
    measurementState: "ready",
    ready: true,
    bpm: 91,
    maxBpm: 104,
    signalQuality: 0.96,
    beatCount: preview.beatCount,
    distanceRatio: preview.beatCount / 90,
    finishPlace: null,
    relay: {
      runners,
      activeRunnerIndex: preview.runnerIndex,
      status: preview.status,
      handoffEndsAt: preview.handoffEndsAt,
      legStartBeat,
      legFinishBeat: legStartBeat + 30,
      legBeatCount,
      legDistanceRatio: Math.min(1, legBeatCount / 30),
      teamDistanceRatio: Math.min(1, preview.beatCount / 90),
      completedRunners,
      lap: preview.runnerIndex + 1,
    },
  };
  const room: RoomSnapshot = {
    code: "TEST",
    phase: "racing",
    mode: "relay",
    trackMode: "circular",
    demo: true,
    demoHumanSlot: false,
    relaySettings: {
      teamCount: 2,
      runnersPerTeam: 3,
      legBeats: 30,
      handoffDurationMs: 5_000,
    },
    serverNow: now,
    finishBeats: 30,
    hostConnected: true,
    players: [player],
    countdownEndsAt: null,
    startedAt: now - 10_000,
    finishedAt: null,
    finishReason: null,
  };
  const measurement: HeartRateState = {
    fingerDetected: true,
    signalQuality: 0.96,
    waveform: 0.6,
    bpm: 91,
    validBeats: 8,
    stableMs: 8_000,
    ready: true,
    beatSerial: preview.beatCount,
    lastBeat: null,
    lastBeatAt: now,
    beatAgeMs: 0,
    holdingSignal: false,
    diagnostics: null,
  };

  return (
    <View
      ref={coordinateRootRef}
      collapsable={false}
      onLayout={() => {
        setCameraTarget(null);
        setLayoutEpoch((current) => current + 1);
      }}
      style={styles.racePreviewRoot}
    >
      <RaceScreen
        room={room}
        player={player}
        connected
        measurement={measurement}
        beatCount={preview.beatCount}
        accent={preview.beatCount > 0 && preview.beatCount % 3 === 0}
        beatDelivery={{
          attempted: preview.beatCount,
          accepted: preview.beatCount,
          rejected: 0,
          lastReason: null,
        }}
        source="camera"
        simulatorBpm={91}
        handoffProgress={handoffProgress}
        handoffCameraOffset={handoffCameraOffset}
        cameraCoordinateRootRef={coordinateRootRef}
        cameraLayoutEpoch={layoutEpoch}
        onCameraPreviewTarget={onCameraPreviewTarget}
        onSimulatorBpm={() => undefined}
        onPreviewBeat={addBeat}
        onPreviewToggleHandoff={toggleHandoff}
        onLeave={onExit}
      />
      <SharedCameraPreview
        room={room}
        player={player}
        target={cameraTarget}
        visible
        measurementMode={false}
        handoffProgress={handoffProgress}
        handoffCameraOffset={handoffCameraOffset}
        reduceMotion={false}
      >
        <View style={styles.racePreviewCameraFill} />
      </SharedCameraPreview>
    </View>
  );
}

function RaceScreen({
  room,
  player,
  connected,
  measurement,
  beatCount,
  accent,
  beatDelivery,
  source,
  simulatorBpm,
  handoffProgress,
  handoffCameraOffset,
  cameraCoordinateRootRef,
  cameraLayoutEpoch,
  onCameraPreviewTarget,
  onSimulatorBpm,
  onPreviewBeat,
  onPreviewToggleHandoff,
  onLeave,
}: {
  room: RoomSnapshot;
  player: PlayerSnapshot | undefined;
  connected: boolean;
  measurement: HeartRateState;
  beatCount: number;
  accent: boolean;
  beatDelivery: BeatDeliveryState;
  source: HeartRateSource;
  simulatorBpm: number;
  handoffProgress: Animated.Value;
  handoffCameraOffset: number;
  cameraCoordinateRootRef: RefObject<View | null>;
  cameraLayoutEpoch: number;
  onCameraPreviewTarget: (target: CameraPreviewTarget | null) => void;
  onSimulatorBpm: (bpm: number) => void;
  onPreviewBeat?: (() => void) | undefined;
  onPreviewToggleHandoff?: (() => void) | undefined;
  onLeave: () => void;
}) {
  const beatScale = useRef(new Animated.Value(1)).current;
  const ringScale = useRef(new Animated.Value(0.7)).current;
  const ringOpacity = useRef(new Animated.Value(0)).current;
  const { cameraTargetRef, reportCameraTarget } = useStableCameraTarget({
    coordinateRootRef: cameraCoordinateRootRef,
    layoutEpoch: cameraLayoutEpoch,
    onTarget: onCameraPreviewTarget,
  });

  useEffect(() => {
    // 서버가 승인한 박동에만 이동 피드백을 맞춥니다. 카메라 검출 시점에
    // 먼저 애니메이션하면 네트워크 ACK 뒤 accent가 도착해 중복 재생될 수 있습니다.
    if (beatCount === 0) return;
    beatScale.setValue(0.94);
    ringScale.setValue(0.78);
    ringOpacity.setValue(0.42);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(beatScale, {
          toValue: accent ? 1.09 : 1.045,
          duration: 110,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(beatScale, {
          toValue: 1,
          duration: 120,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(ringScale, {
        toValue: accent ? 1.55 : 1.28,
        duration: accent ? 580 : 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(ringOpacity, {
        toValue: 0,
        duration: accent ? 580 : 400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
    void Haptics.impactAsync(
      accent
        ? Haptics.ImpactFeedbackStyle.Medium
        : Haptics.ImpactFeedbackStyle.Light,
    );
  }, [accent, beatCount, beatScale, ringOpacity, ringScale]);

  const displayTeamBeatCount = Math.max(beatCount, player?.beatCount ?? 0);
  const displayBeatCount = player?.relay
    ? Math.max(0, displayTeamBeatCount - player.relay.legStartBeat)
    : displayTeamBeatCount;
  const legTargetBeats = player?.relay
    ? Math.max(1, player.relay.legFinishBeat - player.relay.legStartBeat)
    : Math.max(1, room.finishBeats);
  const currentRunnerBeatCount = Math.min(legTargetBeats, displayBeatCount);
  const remainingRunnerBeats = Math.max(
    0,
    legTargetBeats - currentRunnerBeatCount,
  );
  const progress = currentRunnerBeatCount / legTargetBeats;
  const activeRunnerNumber = player?.relay
    ? player.relay.activeRunnerIndex + 1
    : null;
  const nextRunner = player?.relay?.runners[player.relay.activeRunnerIndex + 1];
  const nextRunnerNumber = player?.relay
    ? player.relay.activeRunnerIndex + 2
    : null;
  const isHandoff = player?.relay?.status === "handoff";
  const teamColor = player?.relay ? relayTeamColor(player) : RACE_PAPER;
  const palette = racePalette(teamColor);
  const runningOpacity = handoffProgress.interpolate({
    inputRange: [0, 0.42, 1],
    outputRange: [1, 0, 0],
  });
  const handoffOpacity = handoffProgress.interpolate({
    inputRange: [0, 0.55, 1],
    outputRange: [0, 0, 1],
  });

  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      style={[styles.raceScreen, { backgroundColor: teamColor }]}
    >
      <StatusBar style={palette.statusBarStyle} />
      <View style={styles.raceTopBar}>
        <Pressable
          accessibilityHint={
            onPreviewBeat
              ? "누르면 박동 추가, 길게 누르면 바톤 화면 전환"
              : undefined
          }
          accessibilityLabel="경기 중"
          accessibilityRole={onPreviewBeat ? "button" : "text"}
          delayLongPress={550}
          disabled={!onPreviewBeat}
          onLongPress={onPreviewToggleHandoff}
          onPress={onPreviewBeat}
          style={styles.liveLabel}
        >
          <View
            style={[
              styles.liveBlackDot,
              { backgroundColor: palette.foreground },
            ]}
          />
          <Text style={[styles.liveText, { color: palette.foreground }]}>
            경기 중
          </Text>
        </Pressable>
        <View style={styles.raceTopActions}>
          <ConnectionPill connected={connected} palette={palette} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="경기 나가기"
            hitSlop={10}
            onPress={onLeave}
            style={({ pressed }) => [
              styles.raceLeaveButton,
              { backgroundColor: palette.surface },
              pressed && styles.raceLeaveButtonPressed,
            ]}
          >
            <Text style={[styles.raceLeaveText, { color: palette.muted }]}>
              나가기
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.raceMotionStage}>
        <View
          ref={cameraTargetRef}
          collapsable={false}
          onLayout={reportCameraTarget}
          style={styles.raceCameraTarget}
        />

        <Animated.View
          pointerEvents={isHandoff ? "none" : "auto"}
          style={[styles.raceRunningPanel, { opacity: runningOpacity }]}
        >
          <Text style={[styles.bpmLabel, { color: palette.muted }]}>
            {activeRunnerNumber ? (
              <>
                <Text
                  style={[
                    styles.bpmRunnerLabelStrong,
                    { color: palette.foreground },
                  ]}
                >
                  {activeRunnerNumber}번 주자
                </Text>
                의 심박수
              </>
            ) : (
              "현재 심박수"
            )}
          </Text>
          <View style={styles.bpmValueStage}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.beatRing,
                {
                  borderColor: palette.foreground,
                  opacity: ringOpacity,
                  transform: [{ scale: ringScale }],
                },
              ]}
            />
            <Animated.Text
              adjustsFontSizeToFit
              numberOfLines={1}
              style={[
                styles.bpmNumber,
                {
                  color: palette.foreground,
                  transform: [{ scale: beatScale }],
                },
              ]}
            >
              {measurement.bpm ?? "—"}
            </Animated.Text>
          </View>
          <Text style={[styles.bpmUnit, { color: palette.foreground }]}>
            BPM
          </Text>
          <Text style={[styles.raceSignalText, { color: palette.muted }]}>
            {measurement.holdingSignal
              ? "마지막 박동 리듬으로 잠시 이어가고 있어요"
              : measurement.fingerDetected && measurement.bpm !== null
                ? "한 번의 박동이 한 걸음이 됩니다"
                : measurement.fingerDetected
                  ? "새 박동을 찾고 있습니다"
                  : "손가락으로 카메라와 플래시를 다시 덮어주세요"}
          </Text>
          {beatDelivery.lastReason && (
            <View style={styles.beatDeliveryStatus}>
              <Text
                style={[styles.beatDeliveryText, { color: palette.foreground }]}
              >
                {beatDeliveryReasonLabel(beatDelivery.lastReason)}
              </Text>
            </View>
          )}
        </Animated.View>

        <Animated.View
          pointerEvents={isHandoff ? "auto" : "none"}
          style={[styles.raceHandoffPanel, { opacity: handoffOpacity }]}
        >
          <View style={styles.raceHandoffHeading}>
            <Text style={[styles.handoffEyebrow, { color: palette.muted }]}>
              BATON TOUCH
            </Text>
            <Text style={[styles.handoffTitle, { color: palette.foreground }]}>
              휴대폰을 다음 주자에게 넘겨주세요
            </Text>
          </View>
          <View
            style={[
              styles.raceHandoffDetails,
              {
                paddingTop: handoffCameraOffset + RACE_CAMERA_SIZE + 54,
              },
            ]}
          >
            <View
              style={[
                styles.handoffRunnerCard,
                {
                  borderColor: palette.line,
                  backgroundColor: palette.surface,
                },
              ]}
            >
              <Text
                style={[
                  styles.handoffRunnerNumber,
                  { color: palette.foreground },
                ]}
              >
                {nextRunnerNumber ?? "—"}
              </Text>
              <View>
                <Text
                  style={[styles.handoffRunnerLabel, { color: palette.muted }]}
                >
                  다음 주자
                </Text>
                <Text
                  style={[
                    styles.handoffRunnerName,
                    { color: palette.foreground },
                  ]}
                >
                  {nextRunnerNumber
                    ? `${nextRunnerNumber}번 주자`
                    : (nextRunner?.name ?? "다음 주자")}
                </Text>
              </View>
            </View>
            <Text style={[styles.handoffHint, { color: palette.muted }]}>
              카메라와 플래시에 새 주자의 손가락을 올려주세요.{"\n"}전환 중의
              박동은 경기 거리에 포함되지 않습니다.
            </Text>
          </View>
        </Animated.View>
      </View>

      <Animated.View
        pointerEvents={isHandoff ? "none" : "auto"}
        style={[styles.raceBottom, { opacity: runningOpacity }]}
      >
        {source === "simulator" && (
          <SimulatorControl
            bpm={simulatorBpm}
            onChange={onSimulatorBpm}
            compact
          />
        )}
        <View style={styles.progressMeta}>
          <View style={styles.progressIdentity}>
            <Text style={[styles.progressName, { color: palette.muted }]}>
              {player?.nickname ?? "나"}
            </Text>
            {activeRunnerNumber && (
              <Text style={[styles.progressRunner, { color: palette.muted }]}>
                {activeRunnerNumber}번 주자
              </Text>
            )}
          </View>
          <Text style={[styles.progressCount, { color: palette.muted }]}>
            <Text
              style={[
                styles.progressCountStrong,
                { color: palette.foreground },
              ]}
            >
              {displayBeatCount}
            </Text>{" "}
            / {legTargetBeats} 박동
          </Text>
        </View>
        {player?.relay && (
          <View style={styles.teamProgressSummary}>
            <Text
              style={[styles.teamProgressSummaryText, { color: palette.muted }]}
            >
              {player.relay.completedRunners} / {player.relay.runners.length}{" "}
              주자 완료
            </Text>
            <Text
              style={[
                styles.teamProgressSummaryRemaining,
                { color: palette.foreground },
              ]}
            >
              {remainingRunnerBeats} 박동 남음
            </Text>
          </View>
        )}
        <View style={styles.raceProgressTrack}>
          <View
            style={[styles.raceProgressRail, { backgroundColor: palette.line }]}
          >
            <View
              style={[
                styles.raceProgressFill,
                {
                  width: `${Math.min(100, progress * 100)}%`,
                  backgroundColor: palette.foreground,
                },
              ]}
            />
            <View
              style={[
                styles.raceProgressHeart,
                {
                  left: `${Math.min(100, progress * 100)}%`,
                  backgroundColor: palette.foreground,
                },
              ]}
            >
              <Text style={[styles.progressHeartGlyph, { color: teamColor }]}>
                ♥
              </Text>
            </View>
          </View>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

function FinishScreen({
  room,
  playerId,
  onLeave,
}: {
  room: RoomSnapshot;
  playerId: string;
  onLeave: () => void;
}) {
  const player = findPlayer(room, playerId);
  const manuallyEnded = room.finishReason === "host_ended";
  const place = manuallyEnded
    ? room.players.filter(
        (item) =>
          item.beatCount > (player?.beatCount ?? Number.NEGATIVE_INFINITY),
      ).length + 1
    : (player?.finishPlace ??
      room.players.findIndex((item) => item.id === playerId) + 1);

  useEffect(() => {
    void Haptics.notificationAsync(
      place === 1
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning,
    );
  }, [place]);

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.finishScreen}>
      <Text style={styles.eyebrow}>FINISH</Text>
      <View style={styles.finishMain}>
        <View style={styles.finishHeartCircle}>
          <Text style={styles.finishHeartGlyph}>♥</Text>
        </View>
        <Text style={styles.finishPlace}>{place}위</Text>
        <Text style={styles.finishTitle}>
          {manuallyEnded
            ? place === 1
              ? room.mode === "relay"
                ? "우리 팀이 선두로\n경기를 마쳤어요"
                : "당신의 심장이 선두로\n경기를 마쳤어요"
              : `${place}위로\n경기를 마쳤어요`
            : room.mode === "relay"
              ? place === 1
                ? "우리 팀의 바톤이\n먼저 도착했어요"
                : "우리 팀이 함께\n완주했어요"
              : place === 1
                ? "당신의 심장이\n먼저 도착했어요"
                : "당신의 심장이\n완주했어요"}
        </Text>
        <Text style={styles.finishBody}>
          최고 심박수 {formatMaxBpm(player?.maxBpm)} BPM
          {manuallyEnded
            ? " · 호스트가 경기를 종료했습니다."
            : "으로 결승선을 통과했습니다."}
        </Text>
      </View>
      <View style={styles.finishRanking}>
        {room.players.map((item, index) => (
          <View key={item.id} style={styles.finishRankingRow}>
            <Text style={styles.finishRankingNumber}>
              {manuallyEnded
                ? room.players.filter(
                    (candidate) => candidate.beatCount > item.beatCount,
                  ).length + 1
                : (item.finishPlace ?? index + 1)}
            </Text>
            <Text
              style={[
                styles.finishRankingName,
                item.id === playerId && styles.finishRankingMe,
              ]}
            >
              {item.nickname}
              {item.id === playerId ? " · 나" : ""}
            </Text>
            <Text style={styles.finishRankingBpm}>
              최고 {formatMaxBpm(item.maxBpm)} BPM
            </Text>
          </View>
        ))}
      </View>
      <PrimaryButton label="처음으로" onPress={onLeave} />
    </SafeAreaView>
  );
}

function PermissionScreen({
  onUseSimulator,
}: {
  onUseSimulator?: (() => void) | undefined;
}) {
  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.permissionScreen}>
      <View>
        <Text style={styles.eyebrow}>CAMERA ACCESS</Text>
        <Text style={styles.permissionTitle}>
          심장을 읽으려면{`\n`}카메라가 필요해요
        </Text>
        <Text style={styles.bodyText}>
          설정에서 카메라 접근을 허용해 주세요. 영상은 저장되거나 서버로
          전송되지 않습니다.
        </Text>
      </View>
      <View style={styles.permissionActions}>
        <PrimaryButton
          label="설정 열기"
          onPress={() => void Linking.openSettings()}
        />
        {onUseSimulator && (
          <Pressable onPress={onUseSimulator}>
            <Text style={styles.devLink}>개발용 시뮬레이터 사용</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

function RestoringScreen() {
  const opacity = useRef(new Animated.Value(0.25)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }, [opacity]);
  return (
    <View style={styles.restoringScreen}>
      <Animated.Text style={[styles.restoringHeart, { opacity }]}>
        ♥
      </Animated.Text>
      <Text style={styles.restoringText}>경기장에 다시 연결하는 중</Text>
    </View>
  );
}

function MeasurementProgress({ measurement }: { measurement: HeartRateState }) {
  const timeProgress = Math.min(1, measurement.stableMs / 5_000);
  const beatProgress = Math.min(1, measurement.validBeats / 4);
  const progress = Math.min(timeProgress, beatProgress);
  return (
    <View style={styles.measurementProgress}>
      <View style={styles.measurementProgressTrack}>
        <View
          style={[
            styles.measurementProgressFill,
            { width: `${progress * 100}%` },
          ]}
        />
      </View>
      <View style={styles.measurementProgressLabels}>
        <Text style={styles.progressSmallLabel}>첫 측정</Text>
        <Text style={styles.progressSmallValue}>
          {Math.round(progress * 100)}%
        </Text>
      </View>
    </View>
  );
}

function SimulatorControl({
  bpm,
  onChange,
  compact = false,
}: {
  bpm: number;
  onChange: (bpm: number) => void;
  compact?: boolean;
}) {
  return (
    <View
      style={[
        styles.simulatorControl,
        compact && styles.simulatorControlCompact,
      ]}
    >
      <Pressable
        accessibilityLabel="시뮬레이터 심박수 낮추기"
        style={styles.simulatorButton}
        onPress={() => onChange(Math.max(45, bpm - 5))}
      >
        <Text style={styles.simulatorButtonText}>−</Text>
      </Pressable>
      <View style={styles.simulatorValue}>
        <Text style={styles.simulatorLabel}>가상 심박수</Text>
        <Text style={styles.simulatorBpm}>{bpm} BPM</Text>
      </View>
      <Pressable
        accessibilityLabel="시뮬레이터 심박수 높이기"
        style={styles.simulatorButton}
        onPress={() => onChange(Math.min(180, bpm + 5))}
      >
        <Text style={styles.simulatorButtonText}>＋</Text>
      </Pressable>
    </View>
  );
}

function PrimaryButton({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        style={[styles.primaryButton, disabled && styles.primaryButtonDisabled]}
        onPress={onPress}
        onPressIn={() =>
          Animated.timing(scale, {
            toValue: 0.975,
            duration: 120,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start()
        }
        onPressOut={() =>
          Animated.timing(scale, {
            toValue: 1,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start()
        }
      >
        <Text style={styles.primaryButtonText}>{label}</Text>
        <Text style={styles.primaryButtonArrow}>→</Text>
      </Pressable>
    </Animated.View>
  );
}

function ConnectionPill({
  connected,
  palette,
}: {
  connected: boolean;
  palette?: RacePalette;
}) {
  return (
    <View
      style={[
        styles.connectionPill,
        palette && { backgroundColor: palette.surface },
      ]}
    >
      <ConnectionDot connected={connected} color={palette?.foreground} />
      <Text
        style={[styles.connectionText, palette && { color: palette.muted }]}
      >
        {connected ? "연결됨" : "재연결 중"}
      </Text>
    </View>
  );
}

function ConnectionDot({
  connected,
  color,
}: {
  connected: boolean;
  color?: string | undefined;
}) {
  return (
    <View
      style={[
        styles.connectionDot,
        color && { backgroundColor: color },
        !connected && styles.connectionDotOffline,
      ]}
    />
  );
}

function formatMaxBpm(bpm: number | null | undefined): string {
  return bpm == null ? "—" : String(bpm);
}

function findPlayer(room: RoomSnapshot, playerId: string) {
  return room.players.find((player) => player.id === playerId);
}

function useReducedMotionEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setEnabled);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setEnabled,
    );
    return () => subscription.remove();
  }, []);
  return enabled;
}

function useStableCameraTarget({
  coordinateRootRef,
  layoutEpoch,
  onTarget,
}: {
  coordinateRootRef: RefObject<View | null>;
  layoutEpoch: number;
  onTarget: (target: CameraPreviewTarget | null) => void;
}) {
  const cameraTargetRef = useRef<View>(null);
  const measurementGenerationRef = useRef(0);

  const reportCameraTarget = useCallback(() => {
    const generation = ++measurementGenerationRef.current;
    onTarget(null);

    const measure = (previous: CameraPreviewTarget | null, attempt: number) => {
      requestAnimationFrame(() => {
        if (measurementGenerationRef.current !== generation) return;
        const target = cameraTargetRef.current;
        const coordinateRoot = coordinateRootRef.current;
        if (!target || !coordinateRoot) {
          if (attempt < 5) measure(previous, attempt + 1);
          return;
        }

        target.measureLayout(
          coordinateRoot,
          (x, y, width, height) => {
            if (measurementGenerationRef.current !== generation) return;
            const next = { x, y, width, height };
            const valid =
              Number.isFinite(x) &&
              Number.isFinite(y) &&
              Number.isFinite(width) &&
              Number.isFinite(height) &&
              width > 0 &&
              height > 0;
            if (!valid) {
              if (attempt < 5) measure(null, attempt + 1);
              return;
            }
            if (previous && sameCameraTarget(previous, next)) {
              onTarget(next);
              return;
            }
            if (attempt < 5) measure(next, attempt + 1);
          },
          () => {
            if (attempt < 5) measure(previous, attempt + 1);
          },
        );
      });
    };

    measure(null, 0);
  }, [coordinateRootRef, onTarget]);

  useEffect(() => {
    reportCameraTarget();
  }, [layoutEpoch, reportCameraTarget]);

  useEffect(
    () => () => {
      measurementGenerationRef.current += 1;
    },
    [],
  );

  return { cameraTargetRef, reportCameraTarget };
}

function sameCameraTarget(
  current: CameraPreviewTarget | null,
  next: CameraPreviewTarget,
): boolean {
  if (!current) return false;
  return (
    Math.abs(current.x - next.x) < 0.5 &&
    Math.abs(current.y - next.y) < 0.5 &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5
  );
}

function relayTeamColor(player: PlayerSnapshot): string {
  return (
    RELAY_TEAM_COLORS[player.laneIndex % RELAY_TEAM_COLORS.length] ??
    RELAY_TEAM_COLORS[0]
  );
}

function racePalette(backgroundColor: string): RacePalette {
  const darkContent = relativeLuminance(backgroundColor) > 0.32;
  return darkContent
    ? {
        foreground: RACE_INK,
        muted: "rgba(5,5,5,0.68)",
        surface: "rgba(5,5,5,0.10)",
        line: "rgba(5,5,5,0.32)",
        statusBarStyle: "dark",
      }
    : {
        foreground: RACE_PAPER,
        muted: "rgba(255,255,255,0.76)",
        surface: "rgba(255,255,255,0.14)",
        line: "rgba(255,255,255,0.38)",
        statusBarStyle: "light",
      };
}

function relativeLuminance(hex: string): number {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return 1;
  const channels = [0, 2, 4].map((offset) => {
    const value =
      Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return (
    (channels[0] ?? 0) * 0.2126 +
    (channels[1] ?? 0) * 0.7152 +
    (channels[2] ?? 0) * 0.0722
  );
}

function cameraLensLabel(lens: PpgCameraLens | null): string {
  if (lens === "ultra-wide-angle") return "초광각";
  if (lens === "wide-angle") return "광각";
  if (lens === "telephoto") return "망원";
  return "후면";
}

function beatDeliveryReasonLabel(reason: BeatDeliveryReason): string {
  switch (reason) {
    case "low_confidence":
      return "손가락을 가볍게 유지해 주세요 · 신호가 흔들렸습니다";
    case "invalid_interval":
      return "박동 간격을 다시 확인하고 있습니다";
    case "not_racing":
      return "경기 시작 신호와 동기화하는 중입니다";
    case "handoff":
      return "다음 주자에게 바톤을 전달하고 있습니다";
    case "offline":
    case "timeout":
    case "server_error":
      return "경기장 연결을 다시 확인하고 있습니다";
    case "out_of_order":
    case "duplicate":
      return "박동 순서를 다시 맞추고 있습니다";
    case "finished":
      return "경기가 종료됐습니다";
    case "unknown_player":
      return "방에 다시 연결해 주세요";
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  opaqueContent: { flex: 1, backgroundColor: colors.paper },
  activePhaseStack: { flex: 1 },
  activePhaseOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.paper,
  },
  loadingBackground: { flex: 1, backgroundColor: colors.paper },
  flex: { flex: 1 },
  screen: { flex: 1, paddingHorizontal: 24, backgroundColor: colors.paper },
  screenHeader: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  relayRunnerSlot: {
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  relayRunnerBanner: {
    alignSelf: "center",
    minHeight: 34,
    paddingHorizontal: 13,
    borderRadius: 17,
    backgroundColor: colors.faint,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  relayRunnerNumber: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: colors.ink,
    color: colors.paper,
    fontFamily: fonts.bold,
    fontSize: 11,
    lineHeight: 20,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  relayRunnerBannerText: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  wordmark: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  wordmarkIcon: {
    color: colors.moss,
    fontFamily: fonts.bold,
    fontSize: 25,
    lineHeight: 27,
  },
  wordmarkTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 15,
    letterSpacing: -0.4,
  },
  eyebrow: {
    color: colors.muted,
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 1.6,
    marginBottom: 14,
  },
  bodyText: {
    color: colors.muted,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: -0.25,
  },
  connectionPill: {
    minHeight: 32,
    paddingHorizontal: 11,
    borderRadius: 16,
    backgroundColor: colors.faint,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.mossDeep,
  },
  connectionDotOffline: { backgroundColor: colors.subtle },
  connectionText: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
  },

  joinScreen: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "space-between",
    backgroundColor: colors.paper,
  },
  joinScrollContent: { flexGrow: 1 },
  joinCopy: { paddingTop: 24 },
  joinTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 38,
    lineHeight: 42,
    letterSpacing: -1.8,
    marginBottom: 24,
  },
  form: { paddingBottom: 12, gap: 14 },
  inputGroup: { gap: 8 },
  inputLabel: { color: colors.muted, fontFamily: fonts.medium, fontSize: 12 },
  textInput: {
    height: 62,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    paddingHorizontal: 18,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontFamily: fonts.semibold,
    fontSize: 18,
  },
  codeInput: { fontFamily: fonts.bold, fontSize: 28, letterSpacing: 8 },
  errorText: {
    color: colors.error,
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  noticeText: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  privacyCopy: {
    color: colors.subtle,
    fontFamily: fonts.regular,
    fontSize: 11,
    lineHeight: 17,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  privacyArea: { alignItems: "center", gap: 6 },
  privacyLink: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
    textDecorationLine: "underline",
  },
  primaryButton: {
    minHeight: 62,
    paddingHorizontal: 22,
    borderRadius: 19,
    backgroundColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  primaryButtonDisabled: { opacity: 0.28 },
  primaryButtonText: {
    color: colors.paper,
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  primaryButtonArrow: {
    color: colors.paper,
    fontFamily: fonts.regular,
    fontSize: 25,
  },

  headerBack: { color: colors.ink, fontFamily: fonts.medium, fontSize: 14 },
  headerRoom: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 14 },
  measurementMain: { flex: 1 },
  cameraStage: {
    height: 282,
    paddingTop: 20,
    alignItems: "center",
    gap: 12,
  },
  fingerTarget: {
    alignSelf: "center",
    width: 154,
    height: 154,
    borderRadius: 77,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  fingerTargetActive: { borderColor: colors.ink },
  cameraLens: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  cameraLensPreview: { backgroundColor: "#222222" },
  previewHeartGlyph: {
    position: "absolute",
    color: colors.paper,
    fontFamily: fonts.regular,
    fontSize: 38,
    textShadowColor: "rgba(0,0,0,0.28)",
    textShadowRadius: 5,
    textShadowOffset: { width: 0, height: 1 },
  },
  heartGlyph: { color: colors.paper, fontFamily: fonts.regular, fontSize: 42 },
  qualityArc: {
    position: "absolute",
    top: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.ink,
  },
  cameraStatePill: {
    minHeight: 28,
    paddingHorizontal: 11,
    borderRadius: 14,
    backgroundColor: colors.faint,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  cameraStateDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.subtle,
  },
  cameraStateDotActive: { backgroundColor: colors.ink },
  cameraStateText: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 10,
  },
  instructionCopy: {
    height: 176,
    alignItems: "center",
    paddingHorizontal: 4,
  },
  measurementTitleSlot: {
    height: 90,
    alignItems: "center",
    justifyContent: "center",
  },
  measurementTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 38,
    lineHeight: 42,
    letterSpacing: -1.8,
    textAlign: "center",
  },
  measurementBodySlot: {
    height: 54,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  measurementBodyText: { textAlign: "center" },
  measurementBodyStrong: {
    color: colors.ink,
    fontFamily: fonts.semibold,
  },
  measurementProgressSlot: { height: 62 },
  measurementProgress: { paddingTop: 8 },
  measurementProgressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.line,
    overflow: "hidden",
  },
  measurementProgressFill: { height: 3, backgroundColor: colors.ink },
  measurementProgressLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  progressSmallLabel: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
  },
  progressSmallValue: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  measurementFooter: {
    height: 104,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingBottom: 8,
  },
  measurementStartAction: { alignSelf: "stretch" },
  cameraSwitchButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.faint,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  cameraSwitchButtonPressed: { opacity: 0.58 },
  cameraSwitchButtonDisabled: { opacity: 0.42 },
  cameraSwitchIcon: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 18,
    lineHeight: 22,
  },
  cameraSwitchText: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  devLink: {
    color: colors.subtle,
    fontFamily: fonts.medium,
    fontSize: 11,
    textDecorationLine: "underline",
  },
  countdownScreen: {
    flex: 1,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
  },
  countdownHint: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 15,
    position: "absolute",
    top: 92,
  },
  countdownNumberSlot: {
    width: "100%",
    minHeight: 244,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
  countdownNumber: {
    width: "100%",
    paddingVertical: 16,
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 192,
    lineHeight: 210,
    letterSpacing: 0,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  countdownReady: {
    fontSize: 76,
    lineHeight: 92,
    letterSpacing: 0,
  },
  countdownBottom: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 17,
    position: "absolute",
    bottom: 52,
  },
  sharedCameraPreview: {
    position: "absolute",
    zIndex: 20,
    elevation: 20,
    overflow: "visible",
  },
  sharedCameraCrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
    borderWidth: 2,
    backgroundColor: "#231919",
    alignItems: "center",
    justifyContent: "center",
  },
  sharedCameraPreviewWaiting: {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    borderRadius: 1,
  },
  sharedCameraHeart: {
    position: "absolute",
    color: colors.paper,
    fontFamily: fonts.regular,
    fontSize: 38,
    textShadowColor: "rgba(0,0,0,0.32)",
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 },
  },
  sharedCameraCountdownSlot: {
    position: "absolute",
    top: -12,
    right: -12,
    bottom: -12,
    left: -12,
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
  sharedCameraCountdown: {
    width: 132,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontFamily: fonts.bold,
    fontSize: 82,
    lineHeight: 96,
    letterSpacing: 0,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
    overflow: "visible",
    textShadowColor: "rgba(0,0,0,0.72)",
    textShadowRadius: 10,
    textShadowOffset: { width: 0, height: 2 },
  },
  racePreviewRoot: { flex: 1 },
  racePreviewCameraFill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#C8002A",
  },
  handoffEyebrow: {
    color: colors.muted,
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 1.8,
    marginBottom: 10,
  },
  handoffTitle: {
    maxWidth: 330,
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 30,
    lineHeight: 38,
    letterSpacing: -1.2,
    textAlign: "center",
  },
  handoffRunnerCard: {
    minWidth: 210,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  handoffRunnerNumber: {
    minWidth: 36,
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 28,
    lineHeight: 32,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  handoffRunnerLabel: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
  },
  handoffRunnerName: {
    marginTop: 2,
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 18,
  },
  handoffHint: {
    marginTop: 20,
    color: colors.muted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },

  raceScreen: { flex: 1, paddingHorizontal: 24, backgroundColor: colors.paper },
  raceTopBar: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  raceTopActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  raceLeaveButton: {
    minHeight: 36,
    paddingHorizontal: 13,
    borderRadius: 18,
    backgroundColor: colors.faint,
    alignItems: "center",
    justifyContent: "center",
  },
  raceLeaveButtonPressed: { opacity: 0.55 },
  raceLeaveText: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 12,
  },
  liveLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveBlackDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.ink,
  },
  liveText: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 13 },
  raceMotionStage: { flex: 1, position: "relative" },
  raceCameraTarget: {
    position: "absolute",
    zIndex: 1,
    top: 18,
    left: "50%",
    width: RACE_CAMERA_SIZE,
    height: RACE_CAMERA_SIZE,
    marginLeft: -RACE_CAMERA_SIZE / 2,
    borderRadius: RACE_CAMERA_SIZE / 2,
  },
  raceRunningPanel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    paddingTop: RACE_CAMERA_SIZE + 42,
    paddingBottom: 132,
    alignItems: "center",
  },
  bpmValueStage: {
    width: 300,
    height: 160,
    alignItems: "center",
    justifyContent: "center",
  },
  raceHandoffPanel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
  },
  raceHandoffHeading: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  raceHandoffDetails: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
  },
  beatRing: {
    position: "absolute",
    width: 244,
    height: 244,
    borderRadius: 122,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  bpmLabel: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 15,
    marginBottom: 10,
  },
  bpmRunnerLabelStrong: {
    color: colors.ink,
    fontFamily: fonts.bold,
  },
  bpmNumber: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 150,
    lineHeight: 160,
    letterSpacing: -10,
    minWidth: 300,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  bpmUnit: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 20,
    letterSpacing: 2,
  },
  raceSignalText: {
    color: colors.muted,
    fontFamily: fonts.regular,
    fontSize: 13,
    textAlign: "center",
    marginTop: 25,
  },
  beatDeliveryStatus: { alignItems: "center", gap: 4, marginTop: 10 },
  beatDeliveryText: {
    color: colors.subtle,
    fontFamily: fonts.medium,
    fontSize: 11,
    textAlign: "center",
  },
  beatDeliveryTextWarning: { color: colors.error },
  raceBottom: {
    position: "absolute",
    right: 0,
    bottom: 56,
    left: 0,
    paddingHorizontal: 36,
    gap: 10,
  },
  progressMeta: {
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  progressIdentity: {
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
  },
  progressName: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 14,
    lineHeight: 19,
    textAlign: "center",
  },
  progressRunner: {
    color: colors.ink,
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
  },
  progressCount: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 38,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  progressCountStrong: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 34,
    lineHeight: 38,
  },
  teamProgressSummary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  teamProgressSummaryText: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
    lineHeight: 16,
    fontVariant: ["tabular-nums"],
  },
  teamProgressSummaryRemaining: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 11,
    lineHeight: 16,
    fontVariant: ["tabular-nums"],
  },
  raceProgressTrack: { height: 38, justifyContent: "center" },
  raceProgressRail: {
    height: 2,
    marginHorizontal: 17,
    position: "relative",
  },
  raceProgressFill: { height: 2, backgroundColor: colors.ink },
  raceProgressHeart: {
    position: "absolute",
    top: -16,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ translateX: -17 }],
  },
  progressHeartGlyph: { color: colors.paper, fontSize: 15 },

  simulatorControl: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    padding: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    alignSelf: "stretch",
  },
  simulatorControlCompact: { minHeight: 48 },
  simulatorButton: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: colors.faint,
    alignItems: "center",
    justifyContent: "center",
  },
  simulatorButtonText: {
    color: colors.ink,
    fontFamily: fonts.medium,
    fontSize: 24,
  },
  simulatorValue: { alignItems: "center" },
  simulatorLabel: {
    color: colors.subtle,
    fontFamily: fonts.medium,
    fontSize: 9,
  },
  simulatorBpm: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 15,
    marginTop: 2,
  },

  finishScreen: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 12,
    backgroundColor: colors.paper,
  },
  finishMain: { paddingTop: 20, paddingBottom: 28 },
  finishHeartCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  finishHeartGlyph: { color: colors.paper, fontSize: 27 },
  finishPlace: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 76,
    lineHeight: 82,
    letterSpacing: -4,
  },
  finishTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 38,
    lineHeight: 42,
    letterSpacing: -1.9,
    marginTop: 10,
  },
  finishBody: {
    color: colors.muted,
    fontFamily: fonts.regular,
    fontSize: 14,
    marginTop: 18,
  },
  finishRanking: { flex: 1, borderTopWidth: 1, borderTopColor: colors.ink },
  finishRankingRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  finishRankingNumber: {
    width: 34,
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  finishRankingName: {
    flex: 1,
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 14,
  },
  finishRankingMe: { color: colors.ink, fontFamily: fonts.bold },
  finishRankingBpm: {
    color: colors.muted,
    fontFamily: fonts.regular,
    fontSize: 12,
  },

  permissionScreen: {
    flex: 1,
    padding: 24,
    paddingTop: 84,
    justifyContent: "space-between",
    backgroundColor: colors.paper,
  },
  permissionTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 45,
    lineHeight: 49,
    letterSpacing: -2.2,
    marginBottom: 24,
  },
  permissionActions: { gap: 20, alignItems: "center", paddingBottom: 12 },
  restoringScreen: {
    flex: 1,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
  },
  restoringHeart: { color: colors.ink, fontSize: 46 },
  restoringText: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 14,
  },
});

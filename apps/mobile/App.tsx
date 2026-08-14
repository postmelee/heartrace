import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFonts } from "expo-font";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type {
  BeatEvent,
  PlayerSnapshot,
  RoomSnapshot,
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
const SHOW_DIAGNOSTICS = process.env.EXPO_PUBLIC_SHOW_DIAGNOSTICS === "true";
const PUBLIC_URL =
  process.env.EXPO_PUBLIC_PUBLIC_URL ??
  "https://heartrace-postmelee.onrender.com";

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
      <HeartRaceApp />
    </SafeAreaProvider>
  );
}

function HeartRaceApp() {
  const game = useGameConnection();
  const roomRef = useRef<RoomSnapshot | null>(null);
  const heartRateStateRef = useRef<HeartRateState | null>(null);
  const sequenceRef = useRef(0);
  const [source, setSource] = useState<HeartRateSource>("camera");
  const [simulatorBpm, setSimulatorBpm] = useState(76);
  const [cameraPermission, setCameraPermission] = useState(true);
  const [measurementStarted, setMeasurementStarted] = useState(false);
  const [cameraRunning, setCameraRunning] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [torchError, setTorchError] = useState<string | null>(null);
  const [cameraLens, setCameraLens] =
    useState<PpgCameraLens>("ultra-wide-angle");
  const [cameraDeviceInfo, setCameraDeviceInfo] =
    useState<PpgCameraDeviceInfo | null>(null);

  roomRef.current = game.room;
  const ownPlayer =
    game.room && game.session
      ? findPlayer(game.room, game.session.playerId)
      : undefined;

  const onBeat = useCallback(
    (beat: PpgBeat) => {
      if (roomRef.current?.phase !== "racing") return;
      const currentPlayer = roomRef.current.players.find(
        (player) => player.id === game.session?.playerId,
      );
      if (currentPlayer?.relay?.status === "handoff") return;
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
    [game.sendBeat, game.session?.playerId],
  );

  useEffect(() => {
    if (game.room?.phase !== "lobby") return;
    setMeasurementStarted(false);
    setCameraRunning(false);
    setTorchEnabled(false);
    setTorchError(null);
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

  const cameraActive = measurementEnabled && source === "camera";
  const sharePpgTrace = useCallback(() => {
    void Share.share({
      title: "심장 달리기 PPG 진단 로그",
      message: heartRate.exportTrace(),
    }).catch(() => {
      Alert.alert("공유할 수 없습니다", "진단 로그 공유를 다시 시도해 주세요.");
    });
  }, [heartRate.exportTrace]);

  return (
    <View style={styles.root}>
      <View style={styles.opaqueContent}>
        {game.restoring ? (
          <RestoringScreen />
        ) : !game.session || !game.room ? (
          <JoinScreen
            connected={game.connected}
            notice={game.notice}
            onJoin={game.join}
          />
        ) : game.room.phase === "finished" ? (
          <FinishScreen
            room={game.room}
            playerId={game.session.playerId}
            onShareDiagnostics={sharePpgTrace}
            onLeave={game.leave}
          />
        ) : (
          <View style={styles.activePhaseStack}>
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
              cameraPreview={
                cameraActive ? (
                  <PpgCamera
                    active
                    visible
                    onSample={heartRate.onFrameSample}
                    onPermission={setCameraPermission}
                    onRunningChange={setCameraRunning}
                    onTorchChange={setTorchEnabled}
                    onTorchError={setTorchError}
                    preferredLens={cameraLens}
                    onDeviceInfo={setCameraDeviceInfo}
                  />
                ) : null
              }
              simulatorBpm={simulatorBpm}
              onSimulatorBpm={setSimulatorBpm}
              onToggleSource={
                DEV_SIMULATOR
                  ? () => {
                      heartRate.reset();
                      setTorchError(null);
                      setSource((value) =>
                        value === "camera" ? "simulator" : "camera",
                      );
                    }
                  : undefined
              }
              onStartMeasurement={() => {
                heartRate.reset();
                setCameraRunning(false);
                setTorchEnabled(false);
                setTorchError(null);
                setMeasurementStarted(true);
              }}
              onToggleCameraLens={() => {
                const selectable = cameraDeviceInfo?.availableLenses.filter(
                  (lens) => lens.hasTorch,
                );
                if (!selectable || selectable.length < 2) return;
                const activeIndex = selectable.findIndex(
                  (lens) => lens.lens === cameraLens,
                );
                const next = selectable[(activeIndex + 1) % selectable.length];
                if (!next) return;
                heartRate.reset();
                setCameraRunning(false);
                setTorchEnabled(false);
                setTorchError(null);
                setCameraLens(next.lens);
              }}
              onShareDiagnostics={sharePpgTrace}
              onLeave={game.leave}
            />
            {game.room.phase === "countdown" && (
              <View style={styles.activePhaseOverlay}>
                <CountdownScreen room={game.room} />
              </View>
            )}
            {game.room.phase === "racing" &&
              ownPlayer?.relay?.status === "handoff" && (
                <View style={styles.activePhaseOverlay}>
                  <HandoffScreen room={game.room} player={ownPlayer} />
                </View>
              )}
            {game.room.phase === "racing" &&
              ownPlayer?.relay?.status !== "handoff" && (
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
                    onSimulatorBpm={setSimulatorBpm}
                    onShareDiagnostics={sharePpgTrace}
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
          </View>
        )}
      </View>
    </View>
  );
}

function JoinScreen({
  connected,
  notice,
  onJoin,
}: {
  connected: boolean;
  notice: string | null;
  onJoin: (roomCode: string, nickname: string) => Promise<void>;
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
            <Text style={styles.wordmark}>심장 달리기</Text>
            <ConnectionPill connected={connected} />
          </View>
          <View style={styles.joinCopy}>
            <Text style={styles.eyebrow}>HEART RACE</Text>
            <Text
              adjustsFontSizeToFit
              minimumFontScale={0.88}
              numberOfLines={2}
              style={styles.joinTitle}
            >
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
                placeholderTextColor="#B6B6B3"
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
                placeholderTextColor="#B6B6B3"
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
  cameraPreview,
  simulatorBpm,
  onSimulatorBpm,
  onToggleSource,
  onStartMeasurement,
  onToggleCameraLens,
  onShareDiagnostics,
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
  cameraPreview: ReactNode;
  simulatorBpm: number;
  onSimulatorBpm: (bpm: number) => void;
  onToggleSource?: (() => void) | undefined;
  onStartMeasurement: () => void;
  onToggleCameraLens: () => void;
  onShareDiagnostics: () => void;
  onLeave: () => void;
}) {
  const readyHapticRef = useRef(false);
  const activeRunner = player?.relay?.runners[player.relay.activeRunnerIndex];
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

      {activeRunner && (
        <View style={styles.relayRunnerBanner}>
          <View
            style={[
              styles.relayRunnerDot,
              { backgroundColor: activeRunner.color },
            ]}
          />
          <Text style={styles.relayRunnerBannerText}>
            {nickname} · {activeRunner.name}
          </Text>
        </View>
      )}

      <View style={styles.measurementMain}>
        <View style={styles.cameraStage}>
          <View
            style={[
              styles.fingerTarget,
              measurement.fingerDetected && styles.fingerTargetActive,
            ]}
          >
            <View
              style={[
                styles.cameraLens,
                measurementStarted &&
                  source === "camera" &&
                  styles.cameraLensPreview,
              ]}
            >
              {measurementStarted && source === "camera" ? (
                <>
                  {cameraPreview}
                  <Text style={styles.previewHeartGlyph}>♥</Text>
                </>
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
          {measurementStarted && source === "camera" && (
            <View style={styles.cameraStatePill}>
              <View
                style={[
                  styles.cameraStateDot,
                  cameraRunning && styles.cameraStateDotActive,
                ]}
              />
              <Text style={styles.cameraStateText}>
                {cameraRunning
                  ? torchError
                    ? "카메라 켜짐 · 플래시 오류"
                    : torchEnabled
                      ? `${cameraLensLabel(cameraDeviceInfo?.activeLens ?? cameraLens)} · 플래시 켜짐`
                      : cameraDeviceInfo?.hasTorch === false
                        ? `${cameraLensLabel(cameraDeviceInfo.activeLens)} · 플래시 미지원`
                        : "카메라 켜짐 · 플래시 연결 중"
                  : "카메라 연결 중"}
              </Text>
            </View>
          )}
          {measurementStarted &&
            source === "camera" &&
            SHOW_DIAGNOSTICS &&
            measurement.diagnostics && (
              <Text style={styles.signalDiagnostic}>
                {measurement.diagnostics.channel.toUpperCase()} 신호 · RGB{" "}
                {measurement.diagnostics.red}/{measurement.diagnostics.green}/
                {measurement.diagnostics.blue} · 품질{" "}
                {Math.round(measurement.signalQuality * 100)}% · 노출{" "}
                {cameraDeviceInfo?.exposureBias.toFixed(1) ?? "—"} EV ·{" "}
                {cameraCalibrationLabel(cameraDeviceInfo?.calibration)}
                {" · "}
                {measurement.diagnostics.decision}
              </Text>
            )}
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
          <Text style={styles.measurementTitle}>
            {!measurementStarted
              ? "심박수 측정을\n시작할까요?"
              : !cameraPermission && source === "camera"
                ? "카메라 접근을\n허용해 주세요"
                : measurement.ready
                  ? "출발할 준비가 됐어요"
                  : measurement.fingerDetected
                    ? "손가락을 그대로\n유지하세요"
                    : "카메라와 플래시를\n완전히 덮어주세요"}
          </Text>
          <Text style={styles.bodyText}>
            {!measurementStarted
              ? "버튼을 누르면 후면 카메라와 플래시가 켜집니다."
              : !cameraPermission && source === "camera"
                ? "설정에서 카메라 접근을 허용한 뒤 앱으로 돌아와 주세요."
                : measurement.ready
                  ? activeRunner
                    ? `${activeRunner.name}의 심장이 ${nickname} 팀에 연결됐습니다.`
                    : `${nickname}님의 심장이 경기장에 연결됐습니다.`
                  : measurement.fingerDetected
                    ? measurement.diagnostics?.exposure === "saturated"
                      ? "손가락 힘을 조금 빼고 카메라 위에 가볍게 유지해 주세요."
                      : measurement.bpm
                        ? `${measurement.bpm} BPM · 안정적인 신호를 찾고 있어요.`
                        : "조금만 기다리면 박동이 보이기 시작합니다."
                    : "검지 끝을 휴대폰 뒷면 카메라 위에 가볍게 올려주세요."}
          </Text>
        </View>

        {measurementStarted && (
          <MeasurementProgress measurement={measurement} />
        )}
      </View>

      <View style={styles.measurementFooter}>
        {!measurementStarted ? (
          <View style={styles.measurementStartAction}>
            <PrimaryButton label="측정 시작" onPress={onStartMeasurement} />
          </View>
        ) : source === "simulator" ? (
          <SimulatorControl bpm={simulatorBpm} onChange={onSimulatorBpm} />
        ) : !cameraPermission ? (
          <View style={styles.measurementStartAction}>
            <PrimaryButton
              label="설정 열기"
              onPress={() => void Linking.openSettings()}
            />
          </View>
        ) : null}
        {measurementStarted && onToggleSource && (
          <Pressable onPress={onToggleSource} hitSlop={12}>
            <Text style={styles.devLink}>
              개발 모드 ·{" "}
              {source === "camera" ? "시뮬레이터 사용" : "카메라 사용"}
            </Text>
          </Pressable>
        )}
        {measurementStarted &&
          source === "camera" &&
          (cameraDeviceInfo?.availableLenses.filter((lens) => lens.hasTorch)
            .length ?? 0) > 1 && (
            <Pressable onPress={onToggleCameraLens} hitSlop={12}>
              <Text style={styles.devLink}>
                렌즈 바꾸기 ·{" "}
                {cameraLensLabel(cameraDeviceInfo?.activeLens ?? cameraLens)}
              </Text>
            </Pressable>
          )}
        {measurementStarted &&
          source === "camera" &&
          cameraDeviceInfo?.usingFallback && (
            <Text style={styles.cameraFallbackText}>
              선택한 렌즈가 플래시를 지원하지 않아{" "}
              {cameraLensLabel(cameraDeviceInfo.activeLens)} 렌즈를 사용합니다.
            </Text>
          )}
        {measurementStarted && source === "camera" && torchError && (
          <Text style={styles.cameraErrorText}>{torchError}</Text>
        )}
        {measurementStarted && source === "camera" && SHOW_DIAGNOSTICS && (
          <Pressable onPress={onShareDiagnostics} hitSlop={12}>
            <Text style={styles.devLink}>숫자형 PPG 진단 로그 공유</Text>
          </Pressable>
        )}
        <Text style={styles.footerHint}>
          {!measurementStarted
            ? "측정 전에는 카메라와 플래시를 사용하지 않습니다."
            : measurement.ready
              ? "화면의 경기 시작 신호를 기다리세요."
              : "측정에는 약 5–8초가 걸립니다."}
        </Text>
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
      <Animated.Text
        style={[
          styles.countdownNumber,
          display === "준비" && styles.countdownReady,
          { transform: [{ scale }] },
        ]}
      >
        {display}
      </Animated.Text>
      <Text style={styles.countdownBottom}>심장으로 달릴 시간</Text>
    </SafeAreaView>
  );
}

function HandoffScreen({
  room,
  player,
}: {
  room: RoomSnapshot;
  player: PlayerSnapshot;
}) {
  const relay = player.relay;
  const [clockOffset] = useState(() => room.serverNow - Date.now());
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  const scale = useRef(new Animated.Value(0.86)).current;
  const handoffEndsAt = relay?.handoffEndsAt ?? now;
  const remaining = Math.max(0, handoffEndsAt - now);
  const display = Math.max(1, Math.ceil(remaining / 1_000));
  const nextRunner = relay?.runners[relay.activeRunnerIndex + 1];

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + clockOffset), 50);
    return () => clearInterval(timer);
  }, [clockOffset]);

  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(0.86);
    Animated.spring(scale, {
      toValue: 1,
      damping: 13,
      stiffness: 190,
      mass: 0.7,
      useNativeDriver: true,
    }).start();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [display, scale]);

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.handoffScreen}>
      <Text style={styles.handoffEyebrow}>BATON TOUCH</Text>
      <Text style={styles.handoffTitle}>휴대폰을 다음 주자에게 넘겨주세요</Text>
      <Animated.View
        style={[
          styles.handoffCounter,
          nextRunner && { backgroundColor: nextRunner.color },
          { transform: [{ scale }] },
        ]}
      >
        <Text style={styles.handoffCounterText}>{display}</Text>
      </Animated.View>
      <View style={styles.handoffRunnerCard}>
        <View
          style={[
            styles.handoffRunnerDot,
            nextRunner && { backgroundColor: nextRunner.color },
          ]}
        />
        <View>
          <Text style={styles.handoffRunnerLabel}>다음 주자</Text>
          <Text style={styles.handoffRunnerName}>
            {nextRunner?.name ?? "다음 주자"}
          </Text>
        </View>
      </View>
      <Text style={styles.handoffHint}>
        카메라와 플래시에 새 주자의 손가락을 올려주세요.{"\n"}
        전환 중의 박동은 경기 거리에 포함되지 않습니다.
      </Text>
    </SafeAreaView>
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
  onSimulatorBpm,
  onShareDiagnostics,
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
  onSimulatorBpm: (bpm: number) => void;
  onShareDiagnostics: () => void;
  onLeave: () => void;
}) {
  const beatScale = useRef(new Animated.Value(1)).current;
  const ringScale = useRef(new Animated.Value(0.7)).current;
  const ringOpacity = useRef(new Animated.Value(0)).current;

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
  const progress = displayBeatCount / room.finishBeats;
  const activeRunner =
    player?.relay?.runners[player.relay.activeRunnerIndex] ?? null;

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.raceScreen}>
      <View style={styles.raceTopBar}>
        <View style={styles.liveLabel}>
          <View style={styles.liveBlackDot} />
          <Text style={styles.liveText}>경기 중</Text>
        </View>
        <View style={styles.raceTopActions}>
          <ConnectionPill connected={connected} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="경기 나가기"
            hitSlop={10}
            onPress={onLeave}
            style={({ pressed }) => [
              styles.raceLeaveButton,
              pressed && styles.raceLeaveButtonPressed,
            ]}
          >
            <Text style={styles.raceLeaveText}>나가기</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.bpmStage}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.beatRing,
            { opacity: ringOpacity, transform: [{ scale: ringScale }] },
          ]}
        />
        <Text style={styles.bpmLabel}>
          {activeRunner ? `${activeRunner.name}의 심박수` : "현재 심박수"}
        </Text>
        <Animated.Text
          adjustsFontSizeToFit
          numberOfLines={1}
          style={[styles.bpmNumber, { transform: [{ scale: beatScale }] }]}
        >
          {measurement.bpm ?? "—"}
        </Animated.Text>
        <Text style={styles.bpmUnit}>BPM</Text>
        <Text style={styles.raceSignalText}>
          {measurement.holdingSignal
            ? "마지막 박동 리듬으로 잠시 이어가고 있어요"
            : measurement.fingerDetected && measurement.bpm !== null
              ? "한 번의 박동이 한 걸음이 됩니다"
              : measurement.fingerDetected
                ? "새 박동을 찾고 있습니다"
                : "손가락으로 카메라와 플래시를 다시 덮어주세요"}
        </Text>
        {(beatDelivery.lastReason || SHOW_DIAGNOSTICS) && (
          <View style={styles.beatDeliveryStatus}>
            {beatDelivery.lastReason && (
              <Text
                style={[
                  styles.beatDeliveryText,
                  styles.beatDeliveryTextWarning,
                ]}
              >
                {beatDeliveryReasonLabel(beatDelivery.lastReason)}
              </Text>
            )}
            {SHOW_DIAGNOSTICS && (
              <>
                <Text style={styles.beatDeliveryDebug}>
                  검출 {beatDelivery.attempted} · 승인 {beatDelivery.accepted} ·
                  제외 {beatDelivery.rejected} · 품질{" "}
                  {Math.round(measurement.signalQuality * 100)}% · 신뢰{" "}
                  {Math.round((measurement.lastBeat?.confidence ?? 0) * 100)}%
                </Text>
                <Pressable onPress={onShareDiagnostics} hitSlop={10}>
                  <Text style={styles.devLink}>PPG 로그 공유</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </View>

      <View style={styles.raceBottom}>
        {source === "simulator" && (
          <SimulatorControl
            bpm={simulatorBpm}
            onChange={onSimulatorBpm}
            compact
          />
        )}
        <View style={styles.progressMeta}>
          <View style={styles.progressIdentity}>
            <Text style={styles.progressName}>
              {player?.nickname ?? "나"}
              {activeRunner ? ` · ${activeRunner.name}` : ""}
            </Text>
            {player?.relay && (
              <Text style={styles.progressRelayMeta}>
                {room.trackMode === "circular"
                  ? `${player.relay.sectorIndex + 1}구간 · ${player.relay.lap}바퀴째`
                  : "직선 트랙 전체"}
                {` · ${player.relay.completedRunners}/${player.relay.runners.length}명 완료`}
              </Text>
            )}
          </View>
          <Text style={styles.progressCount}>
            <Text style={styles.progressCountStrong}>{displayBeatCount}</Text> /{" "}
            {room.finishBeats} 박동
          </Text>
        </View>
        <View style={styles.raceProgressTrack}>
          <View
            style={[
              styles.raceProgressFill,
              {
                width: `${Math.min(100, progress * 100)}%`,
                ...(activeRunner
                  ? { backgroundColor: activeRunner.color }
                  : {}),
              },
            ]}
          />
          <View
            style={[
              styles.raceProgressHeart,
              {
                left: `${Math.min(98, progress * 100)}%`,
                ...(activeRunner
                  ? { backgroundColor: activeRunner.color }
                  : {}),
              },
            ]}
          >
            <Text style={styles.progressHeartGlyph}>♥</Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

function FinishScreen({
  room,
  playerId,
  onShareDiagnostics,
  onLeave,
}: {
  room: RoomSnapshot;
  playerId: string;
  onShareDiagnostics: () => void;
  onLeave: () => void;
}) {
  const player = findPlayer(room, playerId);
  const place =
    player?.finishPlace ??
    room.players.findIndex((item) => item.id === playerId) + 1;

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
          {room.mode === "relay"
            ? place === 1
              ? "우리 팀의 바톤이\n먼저 도착했어요"
              : "우리 팀이 함께\n완주했어요"
            : place === 1
              ? "당신의 심장이\n먼저 도착했어요"
              : "당신의 심장이\n완주했어요"}
        </Text>
        <Text style={styles.finishBody}>
          {player?.beatCount ?? 0}번의 박동으로 결승선을 통과했습니다.
        </Text>
      </View>
      <View style={styles.finishRanking}>
        {room.players.map((item, index) => (
          <View key={item.id} style={styles.finishRankingRow}>
            <Text style={styles.finishRankingNumber}>
              {item.finishPlace ?? index + 1}
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
            <Text style={styles.finishRankingBeats}>{item.beatCount} 박동</Text>
          </View>
        ))}
      </View>
      {SHOW_DIAGNOSTICS && (
        <Pressable onPress={onShareDiagnostics} hitSlop={12}>
          <Text style={styles.devLink}>이번 경기 PPG 로그 공유</Text>
        </Pressable>
      )}
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

function ConnectionPill({ connected }: { connected: boolean }) {
  return (
    <View style={styles.connectionPill}>
      <ConnectionDot connected={connected} />
      <Text style={styles.connectionText}>
        {connected ? "연결됨" : "재연결 중"}
      </Text>
    </View>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <View
      style={[styles.connectionDot, !connected && styles.connectionDotOffline]}
    />
  );
}

function findPlayer(room: RoomSnapshot, playerId: string) {
  return room.players.find((player) => player.id === playerId);
}

function cameraLensLabel(lens: PpgCameraLens | null): string {
  if (lens === "ultra-wide-angle") return "초광각";
  if (lens === "wide-angle") return "광각";
  return "후면";
}

function cameraCalibrationLabel(
  calibration: PpgCameraDeviceInfo["calibration"] | undefined,
): string {
  if (calibration === "locked") return "보정 완료";
  if (calibration === "adjusting") return "노출 보정 중";
  return "손가락 대기";
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
  relayRunnerDot: { width: 8, height: 8, borderRadius: 4 },
  relayRunnerBannerText: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  wordmark: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 18,
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
    backgroundColor: colors.ink,
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
    fontSize: 40,
    lineHeight: 44,
    letterSpacing: -2,
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
    backgroundColor: colors.paper,
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
  measurementMain: { flex: 1, justifyContent: "center" },
  cameraStage: { alignItems: "center", gap: 12, marginBottom: 34 },
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
  signalDiagnostic: {
    color: colors.subtle,
    fontFamily: fonts.medium,
    fontSize: 9,
    letterSpacing: 0.2,
  },
  instructionCopy: { alignItems: "center", paddingHorizontal: 4 },
  measurementTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 38,
    lineHeight: 42,
    letterSpacing: -1.8,
    textAlign: "center",
    marginBottom: 17,
  },
  measurementProgress: { marginTop: 38 },
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
  measurementFooter: { alignItems: "center", gap: 12, paddingBottom: 10 },
  measurementStartAction: { alignSelf: "stretch" },
  devLink: {
    color: colors.subtle,
    fontFamily: fonts.medium,
    fontSize: 11,
    textDecorationLine: "underline",
  },
  cameraFallbackText: {
    color: colors.subtle,
    fontFamily: fonts.regular,
    fontSize: 10,
    lineHeight: 15,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  cameraErrorText: {
    color: colors.error,
    fontFamily: fonts.medium,
    fontSize: 10,
    lineHeight: 15,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  footerHint: { color: colors.muted, fontFamily: fonts.regular, fontSize: 12 },

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
  countdownNumber: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 192,
    lineHeight: 210,
    letterSpacing: -11,
  },
  countdownReady: {
    fontSize: 76,
    lineHeight: 92,
    letterSpacing: -4,
  },
  countdownBottom: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 17,
    position: "absolute",
    bottom: 52,
  },
  handoffScreen: {
    flex: 1,
    paddingHorizontal: 28,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
  },
  handoffEyebrow: {
    color: colors.muted,
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 1.8,
    marginBottom: 14,
  },
  handoffTitle: {
    maxWidth: 320,
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 30,
    lineHeight: 38,
    letterSpacing: -1.2,
    textAlign: "center",
  },
  handoffCounter: {
    width: 176,
    height: 176,
    marginVertical: 34,
    borderRadius: 88,
    alignItems: "center",
    justifyContent: "center",
  },
  handoffCounterText: {
    color: colors.paper,
    fontFamily: fonts.bold,
    fontSize: 104,
    lineHeight: 116,
    fontVariant: ["tabular-nums"],
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
  handoffRunnerDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.ink,
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
    marginTop: 24,
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
  bpmStage: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  beatDeliveryDebug: {
    color: colors.subtle,
    fontFamily: fonts.regular,
    fontSize: 9,
    fontVariant: ["tabular-nums"],
  },
  raceBottom: { paddingBottom: 18, gap: 16 },
  progressMeta: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  progressIdentity: { flex: 1, paddingRight: 12, gap: 3 },
  progressName: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 15 },
  progressRelayMeta: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 10,
  },
  progressCount: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 12,
  },
  progressCountStrong: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 25,
  },
  raceProgressTrack: { height: 36, justifyContent: "center" },
  raceProgressFill: { height: 2, backgroundColor: colors.ink },
  raceProgressHeart: {
    position: "absolute",
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -17,
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
  finishRankingBeats: {
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

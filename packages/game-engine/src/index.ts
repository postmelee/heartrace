import {
  DEFAULT_HANDOFF_DURATION_MS,
  DEFAULT_FINISH_BEATS,
  MAX_HANDOFF_DURATION_MS,
  MAX_RELAY_RUNNERS,
  MAX_TEAM_COUNT,
  MAX_PLAYERS,
  MIN_RELAY_RUNNERS,
  MIN_HANDOFF_DURATION_MS,
  MIN_TEAM_COUNT,
  RELAY_LEG_BEAT_OPTIONS,
  RELAY_RUNNER_COLORS,
  type AcceptedBeat,
  type BeatEvent,
  type BeatRejectReason,
  type FinishReason,
  type MeasurementUpdate,
  type PlayerRelaySnapshot,
  type PlayerSnapshot,
  type RaceMode,
  type RelayRoomSettings,
  type RoomPhase,
  type RoomSnapshot,
  type TrackMode,
} from "@heartrace/protocol";

const MIN_IBI_MS = 270;
const MAX_IBI_MS = 2_000;
const MIN_CONFIDENCE = 0.35;
const MIN_SIGNAL_QUALITY = 0.3;
const MAX_BEAT_EVENT_AGE_MS = 15_000;
const MAX_BEAT_EVENT_FUTURE_MS = 5_000;

// laneIndex는 방 안에서의 입장 순서로만 정해지므로 스냅샷을 만들 때 계산합니다.
export interface PlayerState extends Omit<PlayerSnapshot, "laneIndex"> {
  token: string;
  socketId: string | null;
  lastSequence: number;
  seenBeatIds: Set<string>;
  lastAcceptedDetectedAt: number | null;
  bridgedSinceObserved: number;
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  mode: RaceMode;
  trackMode: TrackMode;
  demo: boolean;
  demoHumanSlot: boolean;
  relaySettings: RelayRoomSettings | null;
  finishBeats: number;
  hostToken: string;
  hostSocketId: string | null;
  players: Map<string, PlayerState>;
  countdownEndsAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  finishReason: FinishReason | null;
  nextFinishPlace: number;
}

export interface BeatAcceptance {
  accepted: boolean;
  reason?: BeatRejectReason;
  event?: AcceptedBeat;
  beatCount: number;
  raceFinished: boolean;
  handoffStarted: boolean;
}

export function createRoomState(input: {
  code: string;
  hostToken: string;
  hostSocketId: string;
  finishBeats?: number;
  mode?: RaceMode;
  trackMode?: TrackMode;
  demo?: boolean;
  demoHumanSlot?: boolean;
  relay?: {
    teamCount: number;
    runnersPerTeam: number;
    legBeats: number;
    handoffDurationMs?: number;
  };
}): RoomState {
  const mode = input.mode ?? "individual";
  const relaySettings =
    mode === "relay" ? normalizeRelaySettings(input.relay) : null;
  const finishBeats = relaySettings
    ? relaySettings.legBeats
    : Math.min(
        300,
        Math.max(10, Math.round(input.finishBeats ?? DEFAULT_FINISH_BEATS)),
      );

  return {
    code: input.code,
    phase: "lobby",
    mode,
    trackMode: input.trackMode ?? "straight",
    demo: input.demo ?? false,
    demoHumanSlot: input.demoHumanSlot ?? false,
    relaySettings,
    finishBeats,
    hostToken: input.hostToken,
    hostSocketId: input.hostSocketId,
    players: new Map(),
    countdownEndsAt: null,
    startedAt: null,
    finishedAt: null,
    finishReason: null,
    nextFinishPlace: 1,
  };
}

export function addPlayer(
  room: RoomState,
  input: {
    id: string;
    token: string;
    socketId: string;
    nickname: string;
    runnerNames?: string[];
  },
): PlayerState {
  if (room.phase !== "lobby") {
    throw new Error("경기가 진행 중인 방에는 새로 입장할 수 없습니다.");
  }
  const participantLimit = room.relaySettings?.teamCount ?? MAX_PLAYERS;
  if (room.players.size >= participantLimit) {
    throw new Error(
      room.mode === "relay"
        ? `이 방에는 ${participantLimit}팀이 모두 입장했습니다.`
        : `한 방에는 최대 ${MAX_PLAYERS}명까지 입장할 수 있습니다.`,
    );
  }

  const nickname = input.nickname.trim().slice(0, 12);
  if (nickname.length < 1) {
    throw new Error("닉네임을 입력해 주세요.");
  }

  const player: PlayerState = {
    id: input.id,
    token: input.token,
    socketId: input.socketId,
    nickname,
    connected: true,
    measurementState: "joined",
    ready: false,
    bpm: null,
    maxBpm: null,
    signalQuality: 0,
    beatCount: 0,
    distanceRatio: 0,
    finishPlace: null,
    relay: createPlayerRelay(room, input.runnerNames),
    lastSequence: -1,
    seenBeatIds: new Set(),
    lastAcceptedDetectedAt: null,
    bridgedSinceObserved: 0,
  };
  room.players.set(player.id, player);
  return player;
}

export function resumePlayer(
  room: RoomState,
  playerId: string,
  playerToken: string,
  socketId: string,
): PlayerState | null {
  const player = room.players.get(playerId);
  if (!player || player.token !== playerToken) return null;
  player.socketId = socketId;
  player.connected = true;
  return player;
}

export function removePlayer(
  room: RoomState,
  playerId: string,
): PlayerState | null {
  const player = room.players.get(playerId);
  if (!player) return null;
  room.players.delete(playerId);
  return player;
}

export function updateMeasurement(
  player: PlayerState,
  update: MeasurementUpdate,
): void {
  player.measurementState = update.state;
  player.ready = update.state === "ready";
  player.bpm =
    update.bpm === null
      ? null
      : Math.max(30, Math.min(220, Math.round(update.bpm)));
  player.signalQuality = clamp01(update.signalQuality);
}

export function startCountdown(room: RoomState, now: number): number {
  if (room.phase !== "lobby")
    throw new Error("대기 중인 방만 시작할 수 있습니다.");
  if (room.players.size < 1) throw new Error("참가자가 한 명 이상 필요합니다.");
  if (
    room.relaySettings &&
    room.players.size !== room.relaySettings.teamCount
  ) {
    throw new Error(
      `${room.relaySettings.teamCount}팀이 모두 입장해야 경기를 시작할 수 있습니다.`,
    );
  }
  if (
    [...room.players.values()].some(
      (player) => !player.connected || !player.ready,
    )
  ) {
    throw new Error("모든 참가자의 첫 측정이 완료되어야 합니다.");
  }

  resetRaceProgress(room);
  room.finishReason = null;
  room.phase = "countdown";
  // 경기용 카메라가 다시 마운트되는 동안에는 '준비'를 보여주고, 그 뒤
  // 3·2·1이 각각 온전히 1초씩 보이도록 2.2초의 준비 시간을 둡니다.
  room.countdownEndsAt = now + 5_200;
  return room.countdownEndsAt;
}

export function beginRace(room: RoomState, now: number): void {
  if (room.phase !== "countdown") return;
  room.phase = "racing";
  room.startedAt = now;
  room.countdownEndsAt = null;
}

export function endRace(room: RoomState, now: number): void {
  if (room.phase !== "racing") {
    throw new Error("진행 중인 경기만 종료할 수 있습니다.");
  }
  room.phase = "finished";
  room.countdownEndsAt = null;
  room.finishedAt = now;
  room.finishReason = "host_ended";
}

export function resetRoom(room: RoomState): void {
  room.phase = "lobby";
  room.countdownEndsAt = null;
  room.startedAt = null;
  room.finishedAt = null;
  room.finishReason = null;
  resetRaceProgress(room);
  for (const player of room.players.values()) {
    player.ready = false;
    player.measurementState = "measuring";
  }
}

export function acceptBeat(
  room: RoomState,
  playerId: string,
  beat: BeatEvent,
  acceptedAt: number,
): BeatAcceptance {
  const player = room.players.get(playerId);
  if (!player) return rejected("unknown_player", 0);
  if (room.phase === "finished") return rejected("finished", player.beatCount);
  if (room.phase !== "racing") return rejected("not_racing", player.beatCount);
  // 팀의 순위가 확정된 뒤에는 다른 팀의 완주를 기다리는 동안 들어오는 박동이
  // 기록을 목표치 이상으로 늘리지 않도록 서버에서 최종 차단합니다.
  if (player.finishPlace !== null)
    return rejected("finished", player.beatCount);
  if (player.relay?.status === "handoff") {
    if (
      player.relay.handoffEndsAt === null ||
      acceptedAt < player.relay.handoffEndsAt
    ) {
      return rejected("handoff", player.beatCount);
    }
    completeRelayHandoff(room, playerId, acceptedAt);
  }
  if (player.seenBeatIds.has(beat.id))
    return rejected("duplicate", player.beatCount);
  if (
    !Number.isSafeInteger(beat.sequence) ||
    beat.sequence <= player.lastSequence
  ) {
    return rejected("out_of_order", player.beatCount);
  }
  if (
    ![
      beat.detectedAt,
      beat.ibiMs,
      beat.bpm,
      beat.confidence,
      beat.signalQuality,
    ].every(Number.isFinite) ||
    beat.detectedAt < acceptedAt - MAX_BEAT_EVENT_AGE_MS ||
    beat.detectedAt > acceptedAt + MAX_BEAT_EVENT_FUTURE_MS
  ) {
    return rejected("invalid_interval", player.beatCount);
  }
  if (
    beat.confidence < MIN_CONFIDENCE ||
    beat.signalQuality < MIN_SIGNAL_QUALITY
  ) {
    return rejected("low_confidence", player.beatCount);
  }
  if (beat.ibiMs < MIN_IBI_MS || beat.ibiMs > MAX_IBI_MS) {
    return rejected("invalid_interval", player.beatCount);
  }

  const detectedInterval =
    player.lastAcceptedDetectedAt === null
      ? null
      : beat.detectedAt - player.lastAcceptedDetectedAt;
  if (detectedInterval !== null && detectedInterval < MIN_IBI_MS * 0.8) {
    return rejected("invalid_interval", player.beatCount);
  }
  if (beat.source === "bridged" && player.bridgedSinceObserved >= 1) {
    return rejected("invalid_interval", player.beatCount);
  }

  player.seenBeatIds.add(beat.id);
  if (player.seenBeatIds.size > 256) {
    const oldest = player.seenBeatIds.values().next().value;
    if (typeof oldest === "string") player.seenBeatIds.delete(oldest);
  }
  player.lastSequence = beat.sequence;
  if (beat.source === "observed") {
    player.bridgedSinceObserved = 0;
  } else {
    player.bridgedSinceObserved += 1;
  }
  player.lastAcceptedDetectedAt = beat.detectedAt;
  // BPM 안정화와 cadence 전환 판정은 원시 PPG를 가진 앱이 담당합니다.
  // 서버가 다시 과거 IBI와 비교하면 정상적인 급상승과 신호 회복까지
  // 연쇄적으로 누락되므로 여기서는 절대 범위와 이벤트 순서만 검증합니다.
  player.bpm = Math.max(30, Math.min(220, Math.round(beat.bpm)));
  player.maxBpm = Math.max(player.maxBpm ?? 0, player.bpm);
  player.signalQuality = clamp01(beat.signalQuality);
  player.beatCount += 1;
  const finishTarget = player.relay
    ? room.finishBeats * player.relay.runners.length
    : room.finishBeats;
  player.distanceRatio = Math.min(1, player.beatCount / finishTarget);
  updateRelayProgress(room, player);

  if (player.beatCount >= finishTarget && player.finishPlace === null) {
    player.finishPlace = room.nextFinishPlace++;
  }

  let handoffStarted = false;
  if (
    player.finishPlace === null &&
    player.relay &&
    player.beatCount >= player.relay.legFinishBeat
  ) {
    player.relay.status = "handoff";
    player.relay.handoffEndsAt =
      acceptedAt + (room.relaySettings?.handoffDurationMs ?? 0);
    handoffStarted = true;
  }

  const event: AcceptedBeat = {
    playerId,
    beatId: beat.id,
    sequence: beat.sequence,
    bpm: player.bpm,
    beatCount: player.beatCount,
    distanceRatio: player.distanceRatio,
    accent: player.beatCount % 3 === 0,
    acceptedAt,
    source: beat.source,
    relay: player.relay
      ? {
          runnerIndex: player.relay.activeRunnerIndex,
          handoffEndsAt: player.relay.handoffEndsAt,
          legDistanceRatio: player.relay.legDistanceRatio,
          teamDistanceRatio: player.relay.teamDistanceRatio,
        }
      : null,
  };

  const raceFinished = finishRaceIfComplete(room, acceptedAt);

  return {
    accepted: true,
    event,
    beatCount: player.beatCount,
    raceFinished,
    handoffStarted,
  };
}

export function completeRelayHandoff(
  room: RoomState,
  playerId: string,
  now: number,
): boolean {
  const player = room.players.get(playerId);
  const relay = player?.relay;
  if (
    !player ||
    !relay ||
    relay.status !== "handoff" ||
    relay.handoffEndsAt === null ||
    now < relay.handoffEndsAt
  ) {
    return false;
  }

  relay.activeRunnerIndex = Math.min(
    relay.runners.length - 1,
    relay.activeRunnerIndex + 1,
  );
  relay.status = "running";
  relay.handoffEndsAt = null;
  relay.legStartBeat = player.beatCount;
  relay.legFinishBeat = room.finishBeats * (relay.activeRunnerIndex + 1);
  updateRelayProgress(room, player);

  // 한 휴대폰을 다음 사람에게 넘겨도 참가 세션과 전체 거리는 유지하지만,
  // 이전 사람의 cadence/BPM을 다음 주자에게 물려주지는 않습니다.
  player.measurementState = "measuring";
  player.ready = false;
  player.bpm = null;
  player.signalQuality = 0;
  player.lastAcceptedDetectedAt = null;
  player.bridgedSinceObserved = 0;
  return true;
}

/**
 * 단발성 타이머나 네트워크 갱신이 누락돼도 종료 시각이 지난 바톤 상태를
 * 서버의 다음 활동에서 복구합니다.
 */
export function completeExpiredRelayHandoffs(
  room: RoomState,
  now: number,
): number {
  if (room.phase !== "racing") return 0;
  let completed = 0;
  for (const player of room.players.values()) {
    if (
      player.relay?.status !== "handoff" ||
      player.relay.handoffEndsAt === null ||
      now < player.relay.handoffEndsAt
    ) {
      continue;
    }
    if (completeRelayHandoff(room, player.id, now)) completed += 1;
  }
  return completed;
}

/** 연결 상태가 바뀐 경우에도 기존 자동 종료 규칙을 동일하게 재평가합니다. */
export function finishRaceIfComplete(room: RoomState, now: number): boolean {
  if (room.phase !== "racing") return false;
  const connectedPlayers = [...room.players.values()].filter(
    (candidate) => candidate.connected,
  );
  const raceFinished =
    connectedPlayers.length > 0 &&
    connectedPlayers.every((candidate) => candidate.finishPlace !== null);
  if (!raceFinished) return false;

  room.phase = "finished";
  room.finishedAt = now;
  room.finishReason = "completed";
  return true;
}

export function toSnapshot(room: RoomState): RoomSnapshot {
  const players = [...room.players.values()]
    .map<PlayerSnapshot>((player, laneIndex) => ({
      id: player.id,
      laneIndex,
      nickname: player.nickname,
      connected: player.connected,
      measurementState: player.measurementState,
      ready: player.ready,
      bpm: player.bpm,
      maxBpm: player.maxBpm,
      signalQuality: player.signalQuality,
      beatCount: player.beatCount,
      distanceRatio: player.distanceRatio,
      finishPlace: player.finishPlace,
      relay: player.relay
        ? {
            ...player.relay,
            runners: player.relay.runners.map((runner) => ({ ...runner })),
          }
        : null,
    }))
    .sort((a, b) => {
      if (a.finishPlace !== null && b.finishPlace !== null) {
        return a.finishPlace - b.finishPlace;
      }
      if (a.finishPlace !== null) return -1;
      if (b.finishPlace !== null) return 1;
      return b.beatCount - a.beatCount;
    });

  return {
    code: room.code,
    phase: room.phase,
    mode: room.mode,
    trackMode: room.trackMode,
    demo: room.demo,
    demoHumanSlot: room.demoHumanSlot,
    relaySettings: room.relaySettings ? { ...room.relaySettings } : null,
    serverNow: Date.now(),
    finishBeats: room.finishBeats,
    hostConnected: room.hostSocketId !== null,
    players,
    countdownEndsAt: room.countdownEndsAt,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    finishReason: room.finishReason,
  };
}

function resetRaceProgress(room: RoomState): void {
  room.nextFinishPlace = 1;
  for (const player of room.players.values()) {
    player.beatCount = 0;
    player.maxBpm = null;
    player.distanceRatio = 0;
    player.finishPlace = null;
    player.lastSequence = -1;
    player.seenBeatIds.clear();
    player.lastAcceptedDetectedAt = null;
    player.bridgedSinceObserved = 0;
    if (player.relay) {
      player.relay.activeRunnerIndex = 0;
      player.relay.status = "running";
      player.relay.handoffEndsAt = null;
      player.relay.legStartBeat = 0;
      player.relay.legFinishBeat = room.finishBeats;
      updateRelayProgress(room, player);
    }
  }
}

function normalizeRelaySettings(
  input:
    | {
        teamCount: number;
        runnersPerTeam: number;
        legBeats: number;
        handoffDurationMs?: number;
      }
    | undefined,
): RelayRoomSettings {
  if (!input) throw new Error("팀전 설정을 확인해 주세요.");
  const teamCount = Math.round(input.teamCount);
  const runnersPerTeam = Math.round(input.runnersPerTeam);
  const legBeats = Math.round(input.legBeats);
  const handoffDurationMs =
    input.handoffDurationMs ?? DEFAULT_HANDOFF_DURATION_MS;
  if (
    !Number.isInteger(teamCount) ||
    teamCount < MIN_TEAM_COUNT ||
    teamCount > MAX_TEAM_COUNT
  ) {
    throw new Error(
      `팀 수는 ${MIN_TEAM_COUNT}~${MAX_TEAM_COUNT}팀이어야 합니다.`,
    );
  }
  if (
    !Number.isInteger(runnersPerTeam) ||
    runnersPerTeam < MIN_RELAY_RUNNERS ||
    runnersPerTeam > MAX_RELAY_RUNNERS
  ) {
    throw new Error(
      `팀별 주자는 ${MIN_RELAY_RUNNERS}~${MAX_RELAY_RUNNERS}명이어야 합니다.`,
    );
  }
  if (!RELAY_LEG_BEAT_OPTIONS.some((option) => option === legBeats)) {
    throw new Error("주자당 박동은 10·20·30·60 중에서 선택해 주세요.");
  }
  if (
    !Number.isInteger(handoffDurationMs) ||
    handoffDurationMs % 1_000 !== 0 ||
    handoffDurationMs < MIN_HANDOFF_DURATION_MS ||
    handoffDurationMs > MAX_HANDOFF_DURATION_MS
  ) {
    throw new Error(
      `바톤 전환 시간은 ${MIN_HANDOFF_DURATION_MS / 1_000}~${MAX_HANDOFF_DURATION_MS / 1_000}초 사이의 정수여야 합니다.`,
    );
  }
  return {
    teamCount,
    runnersPerTeam,
    legBeats,
    handoffDurationMs,
  };
}

function createPlayerRelay(
  room: RoomState,
  runnerNames: string[] | undefined,
): PlayerRelaySnapshot | null {
  const settings = room.relaySettings;
  if (!settings) return null;
  const runners = Array.from(
    { length: settings.runnersPerTeam },
    (_, index) => {
      const suppliedName = runnerNames?.[index]?.trim().slice(0, 12);
      return {
        index,
        name: suppliedName || `${index + 1}번 주자`,
        color: runnerColor(index),
      };
    },
  );
  return {
    runners,
    activeRunnerIndex: 0,
    status: "running",
    handoffEndsAt: null,
    legStartBeat: 0,
    legFinishBeat: room.finishBeats,
    legBeatCount: 0,
    legDistanceRatio: 0,
    teamDistanceRatio: 0,
    completedRunners: 0,
    lap: 1,
  };
}

function updateRelayProgress(room: RoomState, player: PlayerState): void {
  const relay = player.relay;
  if (!relay) return;
  relay.legBeatCount = Math.max(0, player.beatCount - relay.legStartBeat);
  relay.legDistanceRatio = Math.min(1, relay.legBeatCount / room.finishBeats);
  relay.teamDistanceRatio = player.distanceRatio;
  relay.completedRunners = Math.min(
    relay.runners.length,
    Math.floor(player.beatCount / room.finishBeats),
  );
  relay.lap = relay.activeRunnerIndex + 1;
}

function runnerColor(index: number): string {
  if (index < RELAY_RUNNER_COLORS.length) return RELAY_RUNNER_COLORS[index]!;
  return hslToHex((index * 137.508) % 360, 72, index % 2 === 0 ? 48 : 58);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] =
    segment < 1
      ? [chroma, secondary, 0]
      : segment < 2
        ? [secondary, chroma, 0]
        : segment < 3
          ? [0, chroma, secondary]
          : segment < 4
            ? [0, secondary, chroma]
            : segment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = l - chroma / 2;
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rejected(reason: BeatRejectReason, beatCount: number): BeatAcceptance {
  return {
    accepted: false,
    reason,
    beatCount,
    raceFinished: false,
    handoffStarted: false,
  };
}

import {
  DEFAULT_FINISH_BEATS,
  MAX_PLAYERS,
  type AcceptedBeat,
  type BeatEvent,
  type BeatRejectReason,
  type MeasurementUpdate,
  type PlayerSnapshot,
  type RoomPhase,
  type RoomSnapshot,
} from "@heartrace/protocol";

const MIN_IBI_MS = 270;
const MAX_IBI_MS = 2_000;
const MIN_CONFIDENCE = 0.52;
const MIN_SIGNAL_QUALITY = 0.4;

export interface PlayerState extends PlayerSnapshot {
  token: string;
  socketId: string | null;
  lastSequence: number;
  seenBeatIds: Set<string>;
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  finishBeats: number;
  hostToken: string;
  hostSocketId: string | null;
  players: Map<string, PlayerState>;
  countdownEndsAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  nextFinishPlace: number;
}

export interface BeatAcceptance {
  accepted: boolean;
  reason?: BeatRejectReason;
  event?: AcceptedBeat;
  beatCount: number;
  raceFinished: boolean;
}

export function createRoomState(input: {
  code: string;
  hostToken: string;
  hostSocketId: string;
  finishBeats?: number;
}): RoomState {
  const finishBeats = Math.min(
    300,
    Math.max(10, Math.round(input.finishBeats ?? DEFAULT_FINISH_BEATS)),
  );

  return {
    code: input.code,
    phase: "lobby",
    finishBeats,
    hostToken: input.hostToken,
    hostSocketId: input.hostSocketId,
    players: new Map(),
    countdownEndsAt: null,
    startedAt: null,
    finishedAt: null,
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
  },
): PlayerState {
  if (room.phase !== "lobby") {
    throw new Error("경기가 진행 중인 방에는 새로 입장할 수 없습니다.");
  }
  if (room.players.size >= MAX_PLAYERS) {
    throw new Error(`한 방에는 최대 ${MAX_PLAYERS}명까지 입장할 수 있습니다.`);
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
    signalQuality: 0,
    beatCount: 0,
    distanceRatio: 0,
    finishPlace: null,
    lastSequence: -1,
    seenBeatIds: new Set(),
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
    [...room.players.values()].some(
      (player) => !player.connected || !player.ready,
    )
  ) {
    throw new Error("모든 참가자의 첫 측정이 완료되어야 합니다.");
  }

  resetRaceProgress(room);
  room.phase = "countdown";
  room.countdownEndsAt = now + 3_600;
  return room.countdownEndsAt;
}

export function beginRace(room: RoomState, now: number): void {
  if (room.phase !== "countdown") return;
  room.phase = "racing";
  room.startedAt = now;
  room.countdownEndsAt = null;
}

export function resetRoom(room: RoomState): void {
  room.phase = "lobby";
  room.countdownEndsAt = null;
  room.startedAt = null;
  room.finishedAt = null;
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
  if (player.seenBeatIds.has(beat.id))
    return rejected("duplicate", player.beatCount);
  if (beat.sequence <= player.lastSequence) {
    return rejected("out_of_order", player.beatCount);
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

  player.seenBeatIds.add(beat.id);
  if (player.seenBeatIds.size > 256) {
    const oldest = player.seenBeatIds.values().next().value;
    if (typeof oldest === "string") player.seenBeatIds.delete(oldest);
  }
  player.lastSequence = beat.sequence;
  player.bpm = Math.max(30, Math.min(220, Math.round(beat.bpm)));
  player.signalQuality = clamp01(beat.signalQuality);
  player.beatCount += 1;
  player.distanceRatio = Math.min(1, player.beatCount / room.finishBeats);

  if (player.beatCount >= room.finishBeats && player.finishPlace === null) {
    player.finishPlace = room.nextFinishPlace++;
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
  };

  const connectedPlayers = [...room.players.values()].filter(
    (candidate) => candidate.connected,
  );
  const raceFinished =
    connectedPlayers.length > 0 &&
    connectedPlayers.every((candidate) => candidate.finishPlace !== null);

  if (raceFinished) {
    room.phase = "finished";
    room.finishedAt = acceptedAt;
  }

  return { accepted: true, event, beatCount: player.beatCount, raceFinished };
}

export function toSnapshot(room: RoomState): RoomSnapshot {
  const players = [...room.players.values()]
    .map<PlayerSnapshot>((player) => ({
      id: player.id,
      nickname: player.nickname,
      connected: player.connected,
      measurementState: player.measurementState,
      ready: player.ready,
      bpm: player.bpm,
      signalQuality: player.signalQuality,
      beatCount: player.beatCount,
      distanceRatio: player.distanceRatio,
      finishPlace: player.finishPlace,
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
    finishBeats: room.finishBeats,
    hostConnected: room.hostSocketId !== null,
    players,
    countdownEndsAt: room.countdownEndsAt,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
  };
}

function resetRaceProgress(room: RoomState): void {
  room.nextFinishPlace = 1;
  for (const player of room.players.values()) {
    player.beatCount = 0;
    player.distanceRatio = 0;
    player.finishPlace = null;
    player.lastSequence = -1;
    player.seenBeatIds.clear();
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rejected(reason: BeatRejectReason, beatCount: number): BeatAcceptance {
  return { accepted: false, reason, beatCount, raceFinished: false };
}

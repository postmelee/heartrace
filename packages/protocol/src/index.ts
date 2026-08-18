export const DEFAULT_FINISH_BEATS = 60;
export const MAX_PLAYERS = 8;
export const MIN_TEAM_COUNT = 2;
export const MAX_TEAM_COUNT = 6;
export const MIN_RELAY_RUNNERS = 2;
export const MAX_RELAY_RUNNERS = 30;
export const DEFAULT_HANDOFF_DURATION_MS = 5_000;
export const RELAY_LEG_BEAT_OPTIONS = [10, 20, 30, 60] as const;
export const RELAY_RUNNER_COLORS = [
  "#ff4d4f",
  "#ffad0d",
  "#22a06b",
  "#377dff",
  "#8b5cf6",
  "#ec4899",
] as const;

export type RoomPhase = "lobby" | "countdown" | "racing" | "finished";
export type FinishReason = "completed" | "host_ended";
export type RaceMode = "individual" | "relay";
export type TrackMode = "straight" | "circular";
export type RelayStatus = "running" | "handoff";

export type MeasurementState = "joined" | "measuring" | "ready" | "signal_lost";

export type BeatRejectReason =
  | "not_racing"
  | "unknown_player"
  | "duplicate"
  | "out_of_order"
  | "low_confidence"
  | "invalid_interval"
  | "handoff"
  | "finished";

export type BeatSource = "observed" | "bridged";

export interface RelayRunnerSnapshot {
  index: number;
  name: string;
  color: string;
}

export interface PlayerRelaySnapshot {
  runners: RelayRunnerSnapshot[];
  activeRunnerIndex: number;
  status: RelayStatus;
  handoffEndsAt: number | null;
  legStartBeat: number;
  legFinishBeat: number;
  legBeatCount: number;
  legDistanceRatio: number;
  teamDistanceRatio: number;
  completedRunners: number;
  lap: number;
}

export interface RelayRoomSettings {
  teamCount: number;
  runnersPerTeam: number;
  legBeats: number;
  handoffDurationMs: number;
}

export interface PlayerSnapshot {
  id: string;
  nickname: string;
  connected: boolean;
  measurementState: MeasurementState;
  ready: boolean;
  bpm: number | null;
  signalQuality: number;
  beatCount: number;
  distanceRatio: number;
  finishPlace: number | null;
  relay: PlayerRelaySnapshot | null;
}

export interface RoomSnapshot {
  code: string;
  phase: RoomPhase;
  mode: RaceMode;
  trackMode: TrackMode;
  /** 휴대폰 대신 서버가 박동을 생성하는 전시 리허설 방인지 여부 */
  demo: boolean;
  relaySettings: RelayRoomSettings | null;
  /** 이 스냅샷을 만든 서버의 Unix epoch(ms). 클라이언트 시계 오차 보정용 */
  serverNow: number;
  finishBeats: number;
  hostConnected: boolean;
  players: PlayerSnapshot[];
  countdownEndsAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  finishReason: FinishReason | null;
}

export interface BeatEvent {
  /** 장치에서 생성한 중복 방지용 UUID */
  id: string;
  /** 앱 세션 내에서 1씩 증가하는 순번 */
  sequence: number;
  /** 장치가 박동을 검출한 Unix epoch(ms) */
  detectedAt: number;
  /** 직전 박동과의 간격(ms) */
  ibiMs: number;
  bpm: number;
  /** 0~1 범위의 검출 신뢰도 */
  confidence: number;
  /** 0~1 범위의 손가락/신호 품질 */
  signalQuality: number;
  /** 카메라에서 관측했는지, 한 번의 짧은 공백을 이어 준 박동인지 구분합니다. */
  source: BeatSource;
}

export interface MeasurementUpdate {
  state: MeasurementState;
  bpm: number | null;
  signalQuality: number;
}

export interface AcceptedBeat {
  playerId: string;
  beatId: string;
  sequence: number;
  bpm: number;
  beatCount: number;
  distanceRatio: number;
  /** 3번째마다 큰 피드백을 표시하기 위한 값. 이동 거리는 늘리지 않습니다. */
  accent: boolean;
  acceptedAt: number;
  source: BeatSource;
  relay: {
    runnerIndex: number;
    handoffEndsAt: number | null;
    legDistanceRatio: number;
    teamDistanceRatio: number;
  } | null;
}

export type Ack<T> = (
  result: { ok: true; data: T } | { ok: false; error: string },
) => void;

export interface HostCreateRoomRequest {
  finishBeats?: number;
  mode?: RaceMode;
  trackMode?: TrackMode;
  demo?: boolean;
  relay?: {
    teamCount: number;
    runnersPerTeam: number;
    legBeats: number;
  };
}

export interface HostCreateRoomResponse {
  room: RoomSnapshot;
  hostToken: string;
}

export interface PlayerJoinRequest {
  roomCode: string;
  nickname: string;
  runnerNames?: string[];
  playerId?: string;
  playerToken?: string;
}

export interface PlayerJoinResponse {
  room: RoomSnapshot;
  playerId: string;
  playerToken: string;
}

export type PlayerRemovalReason = "kicked" | "inactive";

export interface PlayerRemovedEvent {
  playerId: string;
  reason: PlayerRemovalReason;
}

export interface BeatAck {
  accepted: boolean;
  reason?: BeatRejectReason;
  beatCount: number;
}

export interface ClientToServerEvents {
  "host:create-room": (
    request: HostCreateRoomRequest,
    ack: Ack<HostCreateRoomResponse>,
  ) => void;
  "host:resume": (
    request: { roomCode: string; hostToken: string },
    ack: Ack<{ room: RoomSnapshot }>,
  ) => void;
  "host:start": (
    request: { roomCode: string; hostToken: string },
    ack: Ack<{ countdownEndsAt: number }>,
  ) => void;
  "host:end": (
    request: { roomCode: string; hostToken: string },
    ack: Ack<{ room: RoomSnapshot }>,
  ) => void;
  "host:reset": (
    request: { roomCode: string; hostToken: string },
    ack: Ack<{ room: RoomSnapshot }>,
  ) => void;
  "host:remove-player": (
    request: { roomCode: string; hostToken: string; playerId: string },
    ack: Ack<{ room: RoomSnapshot }>,
  ) => void;
  "viewer:join": (
    request: { roomCode: string },
    ack: Ack<{ room: RoomSnapshot }>,
  ) => void;
  "player:join": (
    request: PlayerJoinRequest,
    ack: Ack<PlayerJoinResponse>,
  ) => void;
  "player:leave": (ack: Ack<{ left: true }>) => void;
  "player:measurement": (
    update: MeasurementUpdate,
    ack: Ack<{ updated: true }>,
  ) => void;
  "player:beat": (event: BeatEvent, ack: Ack<BeatAck>) => void;
}

export interface ServerToClientEvents {
  "room:snapshot": (room: RoomSnapshot) => void;
  "race:beat": (event: AcceptedBeat) => void;
  "race:finished": (room: RoomSnapshot) => void;
  "player:removed": (event: PlayerRemovedEvent) => void;
  "server:notice": (notice: { message: string }) => void;
}

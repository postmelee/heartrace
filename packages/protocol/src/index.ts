export const DEFAULT_FINISH_BEATS = 60;
export const MAX_PLAYERS = 8;

export type RoomPhase = "lobby" | "countdown" | "racing" | "finished";

export type MeasurementState = "joined" | "measuring" | "ready" | "signal_lost";

export type BeatRejectReason =
  | "not_racing"
  | "unknown_player"
  | "duplicate"
  | "out_of_order"
  | "low_confidence"
  | "invalid_interval"
  | "finished";

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
}

export interface RoomSnapshot {
  code: string;
  phase: RoomPhase;
  finishBeats: number;
  hostConnected: boolean;
  players: PlayerSnapshot[];
  countdownEndsAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
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
}

export type Ack<T> = (
  result: { ok: true; data: T } | { ok: false; error: string },
) => void;

export interface HostCreateRoomRequest {
  finishBeats?: number;
}

export interface HostCreateRoomResponse {
  room: RoomSnapshot;
  hostToken: string;
}

export interface PlayerJoinRequest {
  roomCode: string;
  nickname: string;
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

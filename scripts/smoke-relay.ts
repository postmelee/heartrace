import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type {
  BeatAck,
  BeatEvent,
  ClientToServerEvents,
  HostCreateRoomResponse,
  PlayerJoinResponse,
  RoomSnapshot,
  ServerToClientEvents,
} from "@heartrace/protocol";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const endpoint = process.env.SMOKE_SOCKET_URL ?? "http://localhost:3001";
const sockets: GameSocket[] = [];

async function main(): Promise<void> {
  const host = await connect();
  const created = await createRelayRoom(host);
  const first = await join(created.room.code, "빨간 팀");
  const second = await join(created.room.code, "파란 팀");
  await Promise.all([
    markReady(first.socket, 78),
    markReady(second.socket, 82),
  ]);

  assert(created.room.mode === "relay", "팀전 방이어야 합니다.");
  assert(
    first.session.room.players[0]?.relay?.runners.length === 2,
    "팀마다 두 주자가 생성되어야 합니다.",
  );

  const started = waitForRoom(host, (room) => room.phase === "racing", 7_000);
  await start(host, created);
  await started;

  await Promise.all([
    sendAcceptedRange(first.socket, 0, 5, 78),
    sendAcceptedRange(second.socket, 0, 5, 82),
  ]);
  const handoffRoom = await waitForRoom(
    host,
    (room) =>
      room.players.length === 2 &&
      room.players.every((player) => player.relay?.status === "handoff"),
    2_000,
  );
  assert(
    handoffRoom.players.every(
      (player) =>
        (player.relay?.handoffEndsAt ?? 0) - handoffRoom.serverNow <= 5_000,
    ),
    "각 팀의 바톤 전환은 5초 이하여야 합니다.",
  );

  const rejected = await sendBeat(first.socket, 5, 78, Date.now());
  assert(
    !rejected.accepted && rejected.reason === "handoff",
    "바톤 전환 중 박동은 거리에 반영하지 않아야 합니다.",
  );

  await waitForRoom(
    host,
    (room) =>
      room.players.length === 2 &&
      room.players.every(
        (player) =>
          player.relay?.status === "running" &&
          player.relay.activeRunnerIndex === 1,
      ),
    6_000,
  );

  const finished = waitForRoom(
    host,
    (room) => room.phase === "finished",
    5_000,
  );
  await sendAcceptedRange(first.socket, 5, 10, 90);
  await sendAcceptedRange(second.socket, 5, 10, 94);
  const finalRoom = await finished;

  assert(
    finalRoom.players.every(
      (player) =>
        player.beatCount === 10 &&
        player.relay?.activeRunnerIndex === 1 &&
        player.relay.status === "running",
    ),
    "두 번째 주자가 각 팀의 마지막 구간을 완주해야 합니다.",
  );
  console.log(
    `팀전 스모크 테스트 통과: ${created.room.code}, 2팀 × 2주자 × 10박동`,
  );
}

function createRelayRoom(host: GameSocket): Promise<HostCreateRoomResponse> {
  return new Promise((resolve, reject) => {
    host.emit(
      "host:create-room",
      {
        finishBeats: 10,
        mode: "relay",
        relay: { teamCount: 2, runnersPerTeam: 2 },
      },
      (result) => {
        if (result.ok) resolve(result.data);
        else reject(new Error(result.error));
      },
    );
  });
}

function start(
  host: GameSocket,
  created: HostCreateRoomResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    host.emit(
      "host:start",
      { roomCode: created.room.code, hostToken: created.hostToken },
      (result) => {
        if (result.ok) resolve();
        else reject(new Error(result.error));
      },
    );
  });
}

async function connect(): Promise<GameSocket> {
  const socket: GameSocket = io(endpoint, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 3_000,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

async function join(
  roomCode: string,
  nickname: string,
): Promise<{ socket: GameSocket; session: PlayerJoinResponse }> {
  const socket = await connect();
  const session = await new Promise<PlayerJoinResponse>((resolve, reject) => {
    socket.emit("player:join", { roomCode, nickname }, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(result.error));
    });
  });
  return { socket, session };
}

function markReady(socket: GameSocket, bpm: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.emit(
      "player:measurement",
      { state: "ready", bpm, signalQuality: 0.9 },
      (result) => {
        if (result.ok) resolve();
        else reject(new Error(result.error));
      },
    );
  });
}

async function sendAcceptedRange(
  socket: GameSocket,
  startSequence: number,
  endSequence: number,
  bpm: number,
): Promise<void> {
  const ibiMs = Math.round(60_000 / bpm);
  const firstDetectedAt =
    Date.now() - (endSequence - startSequence - 1) * ibiMs;
  for (let sequence = startSequence; sequence < endSequence; sequence += 1) {
    const result = await sendBeat(
      socket,
      sequence,
      bpm,
      firstDetectedAt + (sequence - startSequence) * ibiMs,
    );
    assert(result.accepted, `박동 ${sequence + 1}이 승인되어야 합니다.`);
    assert(
      result.beatCount === sequence + 1,
      "서버 박동 수가 주자 전환 뒤에도 이어져야 합니다.",
    );
  }
}

function sendBeat(
  socket: GameSocket,
  sequence: number,
  bpm: number,
  detectedAt: number,
): Promise<BeatAck> {
  const event: BeatEvent = {
    id: randomUUID(),
    sequence,
    detectedAt,
    ibiMs: Math.round(60_000 / bpm),
    bpm,
    confidence: 0.92,
    signalQuality: 0.9,
    source: "observed",
  };
  return new Promise((resolve, reject) => {
    socket.emit("player:beat", event, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(result.error));
    });
  });
}

function waitForRoom(
  socket: GameSocket,
  predicate: (room: RoomSnapshot) => boolean,
  timeoutMs: number,
): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("room:snapshot", onSnapshot);
      reject(new Error("팀전 방 상태 변경을 기다리다 시간이 초과되었습니다."));
    }, timeoutMs);
    const onSnapshot = (room: RoomSnapshot) => {
      if (!predicate(room)) return;
      clearTimeout(timer);
      socket.off("room:snapshot", onSnapshot);
      resolve(room);
    };
    socket.on("room:snapshot", onSnapshot);
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const socket of sockets) socket.disconnect();
  });

import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  HostCreateRoomResponse,
  RoomSnapshot,
  ServerToClientEvents,
} from "@heartrace/protocol";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const endpoint = process.env.SMOKE_SOCKET_URL ?? "http://localhost:3001";

async function main(): Promise<void> {
  const host = await connect();
  const player = await connect();

  try {
    const created = await createRoom(host);
    assert(created.room.demo, "촬영용 방은 모의 경기여야 합니다.");
    assert(
      created.room.demoHumanSlot,
      "촬영용 방에는 실제 참가자 슬롯이 있어야 합니다.",
    );
    assert(
      created.room.players.length === 0,
      "실제 참가자가 첫 번째 레인을 차지할 때까지 mock 팀을 만들면 안 됩니다.",
    );

    const joined = await player.timeout(5_000).emitWithAck("player:join", {
      roomCode: created.room.code,
      nickname: "나의 팀",
      runnerNames: ["나", "다음 주자"],
    });
    if (!joined.ok) throw new Error(joined.error);

    const joinedRoom = joined.data.room;
    assert(
      joinedRoom.players.length === 3,
      "남은 두 자리를 mock 팀이 채워야 합니다.",
    );
    const human = joinedRoom.players.find(
      (candidate) => candidate.id === joined.data.playerId,
    );
    assert(
      human?.laneIndex === 0,
      "실제 참가자는 첫 번째 레인을 사용해야 합니다.",
    );
    const bots = joinedRoom.players.filter((candidate) =>
      candidate.id.startsWith(`mock-${joinedRoom.code}-`),
    );
    assert(bots.length === 2, "mock 팀 두 개가 생성되어야 합니다.");
    assert(
      bots.every((candidate) => candidate.ready && candidate.connected),
      "mock 팀은 즉시 출발 준비 상태여야 합니다.",
    );
    assert(
      !human.ready,
      "실제 참가자의 측정 완료 전에는 준비 상태면 안 됩니다.",
    );

    const readySnapshot = waitForRoom(
      host,
      (room) =>
        room.players.length === 3 && room.players.every((entry) => entry.ready),
      3_000,
    );
    const measured = await player
      .timeout(5_000)
      .emitWithAck("player:measurement", {
        state: "ready",
        bpm: 82,
        signalQuality: 0.96,
      });
    if (!measured.ok) throw new Error(measured.error);
    await readySnapshot;

    const racing = waitForRoom(host, (room) => room.phase === "racing", 7_000);
    await start(host, created);
    await racing;

    const botsMoving = await waitForRoom(
      host,
      (room) => {
        const currentHuman = room.players.find(
          (candidate) => candidate.id === joined.data.playerId,
        );
        const currentBots = room.players.filter((candidate) =>
          candidate.id.startsWith(`mock-${room.code}-`),
        );
        return (
          currentHuman?.beatCount === 0 &&
          currentBots.length === 2 &&
          currentBots.every((candidate) => candidate.beatCount >= 1)
        );
      },
      4_000,
    );
    const humanBeforeInput = botsMoving.players.find(
      (candidate) => candidate.id === joined.data.playerId,
    );
    assert(
      humanBeforeInput?.beatCount === 0,
      "실제 참가자의 박동은 서버가 자동 생성하면 안 됩니다.",
    );

    const humanMoved = waitForRoom(
      host,
      (room) =>
        room.players.find((candidate) => candidate.id === joined.data.playerId)
          ?.beatCount === 1,
      3_000,
    );
    const beat = await player.timeout(5_000).emitWithAck("player:beat", {
      id: randomUUID(),
      sequence: joined.data.lastBeatSequence + 1,
      detectedAt: Date.now(),
      ibiMs: 732,
      bpm: 82,
      confidence: 0.97,
      signalQuality: 0.96,
      source: "observed",
    });
    if (!beat.ok) throw new Error(beat.error);
    assert(beat.data.accepted, "실제 참가자의 박동이 승인되어야 합니다.");
    await humanMoved;

    await endRace(host, created);
    console.log(
      `촬영용 혼합 데모 통과: ${created.room.code}, 실제 1팀 + mock 2팀`,
    );
  } finally {
    player.disconnect();
    host.disconnect();
  }
}

async function connect(): Promise<GameSocket> {
  const socket: GameSocket = io(endpoint, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 3_000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

async function createRoom(host: GameSocket): Promise<HostCreateRoomResponse> {
  const result = await host.timeout(5_000).emitWithAck("host:create-room", {
    mode: "relay",
    trackMode: "circular",
    demo: true,
    demoHumanSlot: true,
    relay: { teamCount: 3, runnersPerTeam: 2, legBeats: 10 },
  });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function start(
  host: GameSocket,
  created: HostCreateRoomResponse,
): Promise<void> {
  const result = await host.timeout(5_000).emitWithAck("host:start", {
    roomCode: created.room.code,
    hostToken: created.hostToken,
  });
  if (!result.ok) throw new Error(result.error);
}

async function endRace(
  host: GameSocket,
  created: HostCreateRoomResponse,
): Promise<void> {
  const result = await host.timeout(5_000).emitWithAck("host:end", {
    roomCode: created.room.code,
    hostToken: created.hostToken,
  });
  if (!result.ok) throw new Error(result.error);
}

function waitForRoom(
  socket: GameSocket,
  predicate: (room: RoomSnapshot) => boolean,
  timeoutMs: number,
): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("room:snapshot", onSnapshot);
      reject(
        new Error("촬영용 데모 상태 변경을 기다리다 시간이 초과되었습니다."),
      );
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

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

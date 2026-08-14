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
  const created = await new Promise<HostCreateRoomResponse>(
    (resolve, reject) => {
      host.emit("host:create-room", { finishBeats: 10 }, (result) => {
        if (result.ok) resolve(result.data);
        else reject(new Error(result.error));
      });
    },
  );
  const viewer = await joinViewer(created.room.code);
  assert(
    viewer.room.code === created.room.code,
    "관전자는 방 코드만으로 현재 방 상태를 받아야 합니다.",
  );

  const first = await join(created.room.code, "첫 심장");
  const second = await join(created.room.code, "둘째 심장");
  await Promise.all([
    markReady(first.socket, 84),
    markReady(second.socket, 96),
  ]);

  const acceptedBeats: Array<{ beatCount: number; accent: boolean }> = [];
  viewer.socket.on("race:beat", (event) => acceptedBeats.push(event));

  const finished = waitForRoom(
    viewer.socket,
    (room) => room.phase === "finished",
    12_000,
  );
  const countdownEndsAt = await new Promise<number>((resolve, reject) => {
    host.emit(
      "host:start",
      { roomCode: created.room.code, hostToken: created.hostToken },
      (result) => {
        if (result.ok) resolve(result.data.countdownEndsAt);
        else reject(new Error(result.error));
      },
    );
  });

  await waitForRoom(host, (room) => room.phase === "racing", 7_000);
  const liveBpmSnapshot = waitForRoom(
    host,
    (room) =>
      room.players.some(
        (player) => player.nickname === "첫 심장" && player.bpm === 133,
      ),
    2_000,
  );
  await updateMeasurement(first.socket, 133);
  const liveRoom = await liveBpmSnapshot;
  assert(
    liveRoom.players.find((player) => player.nickname === "첫 심장")
      ?.beatCount === 0,
    "실시간 BPM 표시는 경주 이동 박동 수와 독립적으로 갱신되어야 합니다.",
  );
  await sendBeats(first.socket, 10, 84);
  await sendBeats(second.socket, 10, 96);

  const room = await finished;
  assert(room.finishBeats === 10, "종료 박동 수가 10으로 설정되어야 합니다.");
  assert(room.players.length === 2, "두 참가자가 스냅샷에 있어야 합니다.");
  assert(
    room.players.every((player) => player.beatCount === 10),
    "각 박동이 정확히 한 걸음이어야 합니다.",
  );
  assert(
    room.players[0]?.finishPlace === 1,
    "먼저 완료한 참가자가 1위여야 합니다.",
  );
  assert(
    room.players[1]?.finishPlace === 2,
    "다음 완료 참가자가 2위여야 합니다.",
  );
  assert(
    acceptedBeats.length === 20,
    "승인된 모든 박동이 실시간 중계되어야 합니다.",
  );
  assert(
    acceptedBeats.filter((event) => event.accent).length === 6,
    "각 참가자의 3·6·9번째 박동만 강조되어야 합니다.",
  );

  const leftRoom = waitForRoom(
    host,
    (snapshot) => snapshot.players.length === 1,
    2_000,
  );
  await leave(first.socket);
  assert(
    (await leftRoom).players.every((player) => player.nickname !== "첫 심장"),
    "명시적으로 나간 참가자는 경기 단계와 관계없이 즉시 제거되어야 합니다.",
  );

  console.log(
    `스모크 테스트 통과: ${created.room.code}, 카운트다운(${countdownEndsAt}) 완료 후 ${acceptedBeats.length}박동 처리`,
  );
}

async function joinViewer(
  roomCode: string,
): Promise<{ socket: GameSocket; room: RoomSnapshot }> {
  const socket = await connect();
  const room = await new Promise<RoomSnapshot>((resolve, reject) => {
    socket.emit("viewer:join", { roomCode }, (result) => {
      if (result.ok) resolve(result.data.room);
      else reject(new Error(result.error));
    });
  });
  return { socket, room };
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
  return updateMeasurement(socket, bpm);
}

function updateMeasurement(socket: GameSocket, bpm: number): Promise<void> {
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

function leave(socket: GameSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.emit("player:leave", (result) => {
      if (result.ok) resolve();
      else reject(new Error(result.error));
    });
  });
}

async function sendBeats(
  socket: GameSocket,
  count: number,
  bpm: number,
): Promise<void> {
  const ibiMs = Math.round(60_000 / bpm);
  const firstDetectedAt = Date.now() - (count - 1) * ibiMs;
  for (let sequence = 0; sequence < count; sequence += 1) {
    const event: BeatEvent = {
      id: randomUUID(),
      sequence,
      detectedAt: firstDetectedAt + sequence * ibiMs,
      ibiMs,
      bpm,
      // 첫 박동은 빠르게 변하는 실제 심박 상황의 보정 하한을 검증합니다.
      confidence: sequence === 0 ? 0.53 : 0.92,
      signalQuality: sequence === 0 ? 0.41 : 0.9,
      source: "observed",
    };
    const result = await new Promise<BeatAck>((resolve, reject) => {
      socket.emit("player:beat", event, (ack) => {
        if (ack.ok) resolve(ack.data);
        else reject(new Error(ack.error));
      });
    });
    assert(result.accepted, `박동 ${sequence + 1}이 승인되어야 합니다.`);
    assert(
      result.beatCount === sequence + 1,
      "서버 박동 수가 순서대로 증가해야 합니다.",
    );
  }
}

function waitForRoom(
  socket: GameSocket,
  predicate: (room: RoomSnapshot) => boolean,
  timeoutMs: number,
): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("room:snapshot", onSnapshot);
      reject(new Error("방 상태 변경을 기다리다 시간이 초과되었습니다."));
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

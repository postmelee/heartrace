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
  const host = io(endpoint, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 3_000,
  });
  await new Promise<void>((resolve, reject) => {
    host.once("connect", resolve);
    host.once("connect_error", reject);
  });

  try {
    const created = await createDemoRoom(host);
    assert(created.room.demo, "모의 경기 방으로 표시되어야 합니다.");
    assert(
      created.room.players.length === 6,
      "여섯 가상 팀이 입장해야 합니다.",
    );
    assert(
      created.room.players.every(
        (player) => player.connected && player.ready && player.relay,
      ),
      "가상 팀은 휴대폰 없이 준비 완료 상태여야 합니다.",
    );

    const racing = waitForRoom(host, (room) => room.phase === "racing", 7_000);
    await start(host, created);
    await racing;

    const moving = await waitForRoom(
      host,
      (room) => room.players.every((player) => player.beatCount >= 2),
      4_000,
    );
    assert(
      moving.players.every((player) => (player.bpm ?? 0) >= 100),
      "가상 BPM이 실제 경기 스냅샷에 반영되어야 합니다.",
    );

    const handoff = await waitForRoom(
      host,
      (room) =>
        room.players.every((player) => player.relay?.status === "handoff"),
      8_000,
    );
    assert(
      handoff.players.every(
        (player) =>
          player.relay?.legDistanceRatio === 1 && player.beatCount === 10,
      ),
      "가상 주자는 설정한 10박동 뒤 바톤을 전달해야 합니다.",
    );

    const reset = await resetRoom(host, created);
    assert(reset.phase === "lobby", "리셋 뒤 준비 화면으로 돌아가야 합니다.");
    assert(
      reset.players.every((player) => player.ready && player.beatCount === 0),
      "리셋 뒤에도 가상 팀은 즉시 다시 준비되어야 합니다.",
    );

    console.log(
      `모의 경기 스모크 테스트 통과: ${created.room.code}, 자동 입장·이동·바톤 전환`,
    );
  } finally {
    host.disconnect();
  }
}

function createDemoRoom(host: GameSocket): Promise<HostCreateRoomResponse> {
  return new Promise((resolve, reject) => {
    host.emit(
      "host:create-room",
      {
        mode: "relay",
        trackMode: "circular",
        demo: true,
        relay: { teamCount: 6, runnersPerTeam: 2, legBeats: 10 },
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

function resetRoom(
  host: GameSocket,
  created: HostCreateRoomResponse,
): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    host.emit(
      "host:reset",
      { roomCode: created.room.code, hostToken: created.hostToken },
      (result) => {
        if (result.ok) resolve(result.data.room);
        else reject(new Error(result.error));
      },
    );
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
      reject(
        new Error("모의 경기 상태 변경을 기다리다 시간이 초과되었습니다."),
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

import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type {
  BeatAck,
  BeatEvent,
  ClientToServerEvents,
  PlayerJoinResponse,
  RoomSnapshot,
  ServerToClientEvents,
} from "@heartrace/protocol";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface SimulatedTeam {
  socket: GameSocket;
  nickname: string;
  playerId: string;
  playerToken: string;
  teamIndex: number;
  sequence: number;
  targetBeats: number;
  completed: boolean;
  lastRejectReason: BeatAck["reason"] | null;
  resuming: boolean;
}

const roomCode = process.argv[2]?.trim().toUpperCase();
const endpoint = process.env.SMOKE_SOCKET_URL ?? "http://localhost:3001";
const sockets: GameSocket[] = [];
let latestRoom: RoomSnapshot | null = null;
let stopping = false;

if (!roomCode) {
  throw new Error(
    "사용법: npm run simulate:hybrid-relay -- <방 코드>\n" +
      "휴대폰 팀이 먼저 입장한 일반 릴레이 대기방의 코드를 입력해 주세요.",
  );
}

async function main(): Promise<void> {
  const observer = await connect();
  latestRoom = await joinAsViewer(observer);
  observeRoom(observer);

  const initialRoom = latestRoom;
  const settings = initialRoom.relaySettings;
  if (initialRoom.demo) {
    throw new Error("/demo 방이 아니라 일반 팀 이어달리기 방을 사용해 주세요.");
  }
  if (initialRoom.mode !== "relay" || !settings) {
    throw new Error(
      "팀 이어달리기 방에서만 혼합 시뮬레이션을 실행할 수 있습니다.",
    );
  }
  if (initialRoom.phase !== "lobby") {
    throw new Error("아직 시작하지 않은 대기방에서 실행해 주세요.");
  }
  if (initialRoom.players.length < 1) {
    throw new Error(
      "실제 휴대폰 팀이 먼저 방에 입장해야 합니다. 휴대폰 입장 후 다시 실행해 주세요.",
    );
  }

  const missingTeams = settings.teamCount - initialRoom.players.length;
  if (missingTeams < 1) {
    throw new Error("이미 모든 팀이 입장한 방입니다.");
  }

  console.log(
    `${initialRoom.code}: 실제 ${initialRoom.players.length}팀 + 모의 ${missingTeams}팀을 준비합니다.`,
  );

  const bots: SimulatedTeam[] = [];
  for (let index = 0; index < missingTeams; index += 1) {
    const teamNumber = initialRoom.players.length + index + 1;
    const bot = await joinSimulatedTeam(
      teamNumber,
      settings.runnersPerTeam,
      settings.legBeats,
    );
    bots.push(bot);
  }

  console.log(
    "모든 모의 팀이 준비되었습니다. 호스트 화면에서 실제 휴대폰 팀의 준비 상태를 확인한 뒤 경기를 시작하세요.",
  );
  console.log("이 터미널은 경기가 끝날 때까지 열어 두세요. (중단: Ctrl+C)");

  await Promise.all(bots.map(runSimulatedTeam));
  printResults(latestRoom);
}

async function connect(): Promise<GameSocket> {
  const socket: GameSocket = io(endpoint, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 350,
    timeout: 8_000,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

async function joinAsViewer(socket: GameSocket): Promise<RoomSnapshot> {
  const result = await socket
    .timeout(5_000)
    .emitWithAck("viewer:join", { roomCode: roomCode! });
  if (!result.ok) throw new Error(result.error);
  return result.data.room;
}

function observeRoom(socket: GameSocket): void {
  socket.on("room:snapshot", (room) => {
    latestRoom = room;
  });
  socket.on("race:finished", (room) => {
    latestRoom = room;
  });
  socket.on("connect", () => {
    if (latestRoom === null) return;
    void joinAsViewer(socket)
      .then((room) => {
        latestRoom = room;
      })
      .catch((error: unknown) => {
        console.error(`관전 연결 복구 실패: ${errorMessage(error)}`);
      });
  });
}

async function joinSimulatedTeam(
  teamNumber: number,
  runnersPerTeam: number,
  legBeats: number,
): Promise<SimulatedTeam> {
  const socket = await connect();
  const nickname = `모의 ${teamNumber}팀`;
  const joined = await socket.timeout(5_000).emitWithAck("player:join", {
    roomCode: roomCode!,
    nickname,
    runnerNames: Array.from(
      { length: runnersPerTeam },
      (_, runnerIndex) => `${runnerIndex + 1}번 모의 주자`,
    ),
  });
  if (!joined.ok) throw new Error(joined.error);
  const session: PlayerJoinResponse = joined.data;

  const teamIndex =
    session.room.players.find((player) => player.id === session.playerId)
      ?.laneIndex ?? teamNumber - 1;
  const bot: SimulatedTeam = {
    socket,
    nickname,
    playerId: session.playerId,
    playerToken: session.playerToken,
    teamIndex,
    sequence: session.lastBeatSequence,
    targetBeats: legBeats * runnersPerTeam,
    completed: false,
    lastRejectReason: null,
    resuming: false,
  };
  latestRoom = session.room;
  attachBotReconnect(bot);

  const bpm = simulatedBpm(bot.teamIndex, 0, bot.sequence + 1);
  await updateMeasurement(bot, bpm);
  console.log(`${nickname} 입장 및 준비 완료 (${bpm} BPM)`);
  return bot;
}

function attachBotReconnect(bot: SimulatedTeam): void {
  bot.socket.on("connect", () => {
    if (bot.resuming || stopping) return;
    bot.resuming = true;
    void resumeBot(bot).finally(() => {
      bot.resuming = false;
    });
  });
  bot.socket.on("disconnect", () => {
    if (!stopping) console.warn(`${bot.nickname} 연결이 끊겨 재접속합니다.`);
  });
}

async function resumeBot(bot: SimulatedTeam): Promise<void> {
  try {
    const result = await bot.socket.timeout(5_000).emitWithAck("player:join", {
      roomCode: roomCode!,
      nickname: bot.nickname,
      playerId: bot.playerId,
      playerToken: bot.playerToken,
    });
    if (!result.ok) throw new Error(result.error);
    bot.sequence = Math.max(bot.sequence, result.data.lastBeatSequence);
    latestRoom = result.data.room;
    console.log(`${bot.nickname} 재접속 완료`);
  } catch (error) {
    console.error(`${bot.nickname} 재접속 실패: ${errorMessage(error)}`);
  }
}

async function runSimulatedTeam(bot: SimulatedTeam): Promise<void> {
  let announcedStart = false;
  let announcedFinish = false;

  while (!stopping) {
    const room = latestRoom;
    if (!room || room.phase === "lobby" || room.phase === "countdown") {
      await delay(120);
      continue;
    }
    if (room.phase === "finished") return;

    const player = room.players.find(
      (candidate) => candidate.id === bot.playerId,
    );
    if (!player)
      throw new Error(`${bot.nickname}을 방 상태에서 찾을 수 없습니다.`);
    if (bot.completed || player.finishPlace !== null) {
      if (player.finishPlace !== null && !announcedFinish) {
        announcedFinish = true;
        console.log(`${bot.nickname} ${player.finishPlace}위로 완주`);
      }
      await delay(150);
      continue;
    }
    if (!bot.socket.connected || bot.resuming) {
      await delay(120);
      continue;
    }
    if (!announcedStart) {
      announcedStart = true;
      console.log(`${bot.nickname} 출발`);
    }

    const runnerIndex = player.relay?.activeRunnerIndex ?? 0;
    const bpm = simulatedBpm(bot.teamIndex, runnerIndex, bot.sequence + 1);
    const ibiMs = Math.round(60_000 / bpm);
    await delay(ibiMs);

    if (stopping || latestRoom?.phase !== "racing" || !bot.socket.connected) {
      continue;
    }

    try {
      await updateMeasurement(bot, bpm);
      bot.sequence += 1;
      const result = await sendBeat(bot, bpm, ibiMs);
      reportBeatResult(bot, result, latestRoom?.relaySettings?.legBeats ?? 0);
    } catch (error) {
      if (!stopping) {
        console.error(`${bot.nickname} 박동 전송 실패: ${errorMessage(error)}`);
      }
      await delay(350);
    }
  }
}

async function updateMeasurement(
  bot: SimulatedTeam,
  bpm: number,
): Promise<void> {
  const result = await bot.socket
    .timeout(5_000)
    .emitWithAck("player:measurement", {
      state: "ready",
      bpm,
      signalQuality: 0.96,
    });
  if (!result.ok) throw new Error(result.error);
}

async function sendBeat(
  bot: SimulatedTeam,
  bpm: number,
  ibiMs: number,
): Promise<BeatAck> {
  const event: BeatEvent = {
    id: randomUUID(),
    sequence: bot.sequence,
    detectedAt: Date.now(),
    ibiMs,
    bpm,
    confidence: 0.97,
    signalQuality: 0.96,
    source: "observed",
  };
  const result = await bot.socket
    .timeout(5_000)
    .emitWithAck("player:beat", event);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function reportBeatResult(
  bot: SimulatedTeam,
  result: BeatAck,
  legBeats: number,
): void {
  if (!result.accepted) {
    if (result.reason === "handoff" && bot.lastRejectReason !== "handoff") {
      console.log(`${bot.nickname} 바톤 전달 중`);
    } else if (
      result.reason !== "handoff" &&
      result.reason !== "finished" &&
      result.reason !== "not_racing"
    ) {
      console.warn(
        `${bot.nickname} 박동 거부: ${result.reason ?? "알 수 없음"}`,
      );
    }
    bot.lastRejectReason = result.reason ?? null;
    return;
  }

  if (bot.lastRejectReason === "handoff") {
    console.log(`${bot.nickname} 다음 주자 진행 재개`);
  }
  bot.lastRejectReason = null;
  if (legBeats > 0 && result.beatCount % legBeats === 0) {
    console.log(`${bot.nickname} ${result.beatCount}박동 도달`);
  }
  if (result.beatCount >= bot.targetBeats) bot.completed = true;
}

function simulatedBpm(
  teamIndex: number,
  runnerIndex: number,
  sequence: number,
): number {
  const cadenceOffset = ((sequence % 5) - 2) * 2;
  return Math.min(
    180,
    108 + teamIndex * 10 + (runnerIndex % 4) * 3 + cadenceOffset,
  );
}

function printResults(room: RoomSnapshot | null): void {
  if (!room || room.phase !== "finished") return;
  const result = [...room.players]
    .sort(
      (left, right) =>
        (left.finishPlace ?? Number.MAX_SAFE_INTEGER) -
        (right.finishPlace ?? Number.MAX_SAFE_INTEGER),
    )
    .map(
      (player) =>
        `${player.finishPlace ?? "-"}위 ${player.nickname} (${player.beatCount}박동)`,
    )
    .join(" · ");
  console.log(`경기 종료: ${result}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function disconnectAll(): void {
  for (const socket of sockets) socket.disconnect();
}

process.once("SIGINT", () => {
  stopping = true;
  console.log("\n혼합 경기 시뮬레이터를 중단합니다.");
  disconnectAll();
});

main()
  .catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(() => {
    stopping = true;
    disconnectAll();
  });

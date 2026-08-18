import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import {
  acceptBeat,
  addPlayer,
  beginRace,
  createRoomState,
  removePlayer,
  resetRoom,
  resumePlayer,
  startCountdown,
  toSnapshot,
  updateMeasurement,
  type RoomState,
} from "@heartrace/game-engine";
import type {
  Ack,
  BeatAck,
  ClientToServerEvents,
  HostCreateRoomResponse,
  PlayerJoinResponse,
  ServerToClientEvents,
} from "@heartrace/protocol";

interface SocketData {
  roomCode?: string;
  role?: "host" | "player" | "viewer";
  playerId?: string;
}

const app = express();
const httpServer = createServer(app);
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length === 0 ? true : allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json());

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>(httpServer, {
  cors: {
    origin: allowedOrigins.length === 0 ? true : allowedOrigins,
    credentials: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1_000,
    skipMiddlewares: true,
  },
  pingInterval: 8_000,
  pingTimeout: 10_000,
});

const rooms = new Map<string, RoomState>();
const countdownTimers = new Map<string, NodeJS.Timeout>();
const playerCleanupTimers = new Map<string, NodeJS.Timeout>();
const PLAYER_DISCONNECT_GRACE_MS = 15_000;

app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size, now: Date.now() });
});

app.get("/rooms/:code", (request, response) => {
  const room = rooms.get(normalizeCode(request.params.code));
  if (!room)
    return response.status(404).json({ error: "방을 찾을 수 없습니다." });
  return response.json(toSnapshot(room));
});

io.on("connection", (socket) => {
  socket.on("host:create-room", (request, ack) => {
    try {
      const code = createRoomCode();
      const hostToken = createToken();
      const room = createRoomState({
        code,
        hostToken,
        hostSocketId: socket.id,
        ...(request.finishBeats === undefined
          ? {}
          : { finishBeats: request.finishBeats }),
      });
      rooms.set(code, room);
      attachSocket(socket, code, "host");
      ok<HostCreateRoomResponse>(ack, { room: toSnapshot(room), hostToken });
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("host:resume", (request, ack) => {
    const room = rooms.get(normalizeCode(request.roomCode));
    if (!room || room.hostToken !== request.hostToken) {
      return ack({ ok: false, error: "호스트 정보를 확인할 수 없습니다." });
    }
    room.hostSocketId = socket.id;
    attachSocket(socket, room.code, "host");
    return ack({ ok: true, data: { room: toSnapshot(room) } });
  });

  socket.on("viewer:join", (request, ack) => {
    const room = rooms.get(normalizeCode(request.roomCode));
    if (!room) {
      return ack({ ok: false, error: "관전할 방을 찾을 수 없습니다." });
    }
    attachSocket(socket, room.code, "viewer");
    return ack({ ok: true, data: { room: toSnapshot(room) } });
  });

  socket.on("player:join", (request, ack) => {
    try {
      const room = rooms.get(normalizeCode(request.roomCode));
      if (!room) throw new Error("방 코드를 다시 확인해 주세요.");

      if (request.playerId || request.playerToken) {
        const resumed =
          request.playerId && request.playerToken
            ? resumePlayer(
                room,
                request.playerId,
                request.playerToken,
                socket.id,
              )
            : null;
        if (!resumed) {
          throw new Error("참가자 세션이 만료되었습니다. 다시 입장해 주세요.");
        }
        clearPlayerCleanup(room.code, resumed.id);
        attachSocket(socket, room.code, "player", resumed.id);
        emitSnapshot(room);
        return ok<PlayerJoinResponse>(ack, {
          room: toSnapshot(room),
          playerId: resumed.id,
          playerToken: resumed.token,
        });
      }

      const player = addPlayer(room, {
        id: randomUUID(),
        token: createToken(),
        socketId: socket.id,
        nickname: request.nickname,
      });
      attachSocket(socket, room.code, "player", player.id);
      emitSnapshot(room);
      return ok<PlayerJoinResponse>(ack, {
        room: toSnapshot(room),
        playerId: player.id,
        playerToken: player.token,
      });
    } catch (error) {
      return fail(ack, error);
    }
  });

  socket.on("player:measurement", (update, ack) => {
    const context = getPlayerContext(socket.data);
    if (!context) return ack({ ok: false, error: "방에 다시 입장해 주세요." });
    updateMeasurement(context.player, update);
    emitSnapshot(context.room);
    return ack({ ok: true, data: { updated: true } });
  });

  socket.on("player:leave", (ack) => {
    const context = getPlayerContext(socket.data);
    if (!context) return ack({ ok: true, data: { left: true } });

    clearPlayerCleanup(context.room.code, context.player.id);
    // 명시적인 나가기는 네트워크 단절과 달리 재연결을 기다리지 않습니다.
    // 경기 중이어도 즉시 제거해 앱과 호스트 양쪽에 이전 참가자가 남지 않게 합니다.
    removePlayer(context.room, context.player.id);
    detachPlayerSocket(socket, context.room.code);
    emitSnapshot(context.room);
    return ack({ ok: true, data: { left: true } });
  });

  socket.on("host:start", (request, ack) => {
    try {
      const room = getHostRoom(request.roomCode, request.hostToken);
      const countdownEndsAt = startCountdown(room, Date.now());
      emitSnapshot(room);

      clearCountdown(room.code);
      countdownTimers.set(
        room.code,
        setTimeout(
          () => {
            beginRace(room, Date.now());
            emitSnapshot(room);
            countdownTimers.delete(room.code);
          },
          Math.max(0, countdownEndsAt - Date.now()),
        ),
      );
      return ack({ ok: true, data: { countdownEndsAt } });
    } catch (error) {
      return fail(ack, error);
    }
  });

  socket.on("host:reset", (request, ack) => {
    try {
      const room = getHostRoom(request.roomCode, request.hostToken);
      clearCountdown(room.code);
      removeDisconnectedPlayers(room);
      resetRoom(room);
      emitSnapshot(room);
      return ack({ ok: true, data: { room: toSnapshot(room) } });
    } catch (error) {
      return fail(ack, error);
    }
  });

  socket.on("host:remove-player", (request, ack) => {
    try {
      const room = getHostRoom(request.roomCode, request.hostToken);
      if (room.phase !== "lobby") {
        throw new Error("대기 화면에서만 참가자를 내보낼 수 있습니다.");
      }
      const player = room.players.get(request.playerId);
      if (!player) throw new Error("이미 나간 참가자입니다.");

      clearPlayerCleanup(room.code, player.id);
      const playerSocket = player.socketId
        ? io.sockets.sockets.get(player.socketId)
        : undefined;
      removePlayer(room, player.id);

      if (playerSocket) {
        playerSocket.emit("player:removed", {
          playerId: player.id,
          reason: "kicked",
        });
        detachPlayerSocket(playerSocket, room.code);
      }

      emitSnapshot(room);
      return ack({ ok: true, data: { room: toSnapshot(room) } });
    } catch (error) {
      return fail(ack, error);
    }
  });

  socket.on("player:beat", (beat, ack) => {
    const context = getPlayerContext(socket.data);
    if (!context) return ack({ ok: false, error: "방에 다시 입장해 주세요." });

    const result = acceptBeat(
      context.room,
      context.player.id,
      beat,
      Date.now(),
    );
    const beatAck: BeatAck = {
      accepted: result.accepted,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      beatCount: result.beatCount,
    };
    ack({ ok: true, data: beatAck });

    if (!result.accepted || !result.event) return;
    io.to(context.room.code).emit("race:beat", result.event);
    emitSnapshot(context.room);
    if (result.raceFinished) {
      io.to(context.room.code).emit("race:finished", toSnapshot(context.room));
    }
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.role === "host" && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
    }
    if (socket.data.role === "player" && socket.data.playerId) {
      const player = room.players.get(socket.data.playerId);
      if (player?.socketId === socket.id) {
        player.socketId = null;
        player.connected = false;
        schedulePlayerCleanup(room.code, player.id);
      }
    }
    if (socket.data.role === "viewer") return;
    emitSnapshot(room);
  });
});

function attachSocket(
  socket: Parameters<Parameters<typeof io.on>[1]>[0],
  roomCode: string,
  role: "host" | "player" | "viewer",
  playerId?: string,
): void {
  socket.join(roomCode);
  socket.data.roomCode = roomCode;
  socket.data.role = role;
  if (playerId) socket.data.playerId = playerId;
}

function detachPlayerSocket(
  socket: Parameters<Parameters<typeof io.on>[1]>[0],
  roomCode: string,
): void {
  socket.leave(roomCode);
  delete socket.data.roomCode;
  delete socket.data.role;
  delete socket.data.playerId;
}

function getPlayerContext(data: SocketData) {
  if (!data.roomCode || !data.playerId) return null;
  const room = rooms.get(data.roomCode);
  const player = room?.players.get(data.playerId);
  return room && player ? { room, player } : null;
}

function getHostRoom(code: string, token: string): RoomState {
  const room = rooms.get(normalizeCode(code));
  if (!room || room.hostToken !== token) {
    throw new Error("호스트 권한을 확인할 수 없습니다.");
  }
  return room;
}

function emitSnapshot(room: RoomState): void {
  io.to(room.code).emit("room:snapshot", toSnapshot(room));
}

function clearCountdown(code: string): void {
  const timer = countdownTimers.get(code);
  if (timer) clearTimeout(timer);
  countdownTimers.delete(code);
}

function schedulePlayerCleanup(roomCode: string, playerId: string): void {
  clearPlayerCleanup(roomCode, playerId);
  const key = playerCleanupKey(roomCode, playerId);
  const timer = setTimeout(() => {
    playerCleanupTimers.delete(key);
    const room = rooms.get(roomCode);
    const player = room?.players.get(playerId);
    if (!room || room.phase !== "lobby" || !player || player.connected) return;
    removePlayer(room, playerId);
    emitSnapshot(room);
  }, PLAYER_DISCONNECT_GRACE_MS);
  timer.unref();
  playerCleanupTimers.set(key, timer);
}

function clearPlayerCleanup(roomCode: string, playerId: string): void {
  const key = playerCleanupKey(roomCode, playerId);
  const timer = playerCleanupTimers.get(key);
  if (timer) clearTimeout(timer);
  playerCleanupTimers.delete(key);
}

function removeDisconnectedPlayers(room: RoomState): void {
  for (const player of [...room.players.values()]) {
    if (player.connected) continue;
    clearPlayerCleanup(room.code, player.id);
    removePlayer(room, player.id);
  }
}

function playerCleanupKey(roomCode: string, playerId: string): string {
  return `${roomCode}:${playerId}`;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function createRoomCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(4);
    const code = [...bytes]
      .map((byte) => alphabet[byte % alphabet.length])
      .join("");
    if (!rooms.has(code)) return code;
  }
  throw new Error("방 코드를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
}

function createToken(): string {
  return randomBytes(24).toString("base64url");
}

function ok<T>(ack: Ack<T>, data: T): void {
  ack({ ok: true, data });
}

function fail<T>(ack: Ack<T>, error: unknown): void {
  ack({
    ok: false,
    error:
      error instanceof Error
        ? error.message
        : "알 수 없는 오류가 발생했습니다.",
  });
}

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Heart Race server: http://0.0.0.0:${port}`);
});

import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io, type Socket } from "socket.io-client";
import type {
  AcceptedBeat,
  BeatAck,
  BeatEvent,
  BeatRejectReason,
  ClientToServerEvents,
  MeasurementUpdate,
  RoomSnapshot,
  ServerToClientEvents,
} from "@heartrace/protocol";

const SOCKET_URL =
  process.env.EXPO_PUBLIC_SOCKET_URL ?? "http://localhost:3001";
const STORAGE_KEY = "heartrace:participant-session";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ParticipantSession {
  roomCode: string;
  nickname: string;
  playerId: string;
  playerToken: string;
}

export type BeatDeliveryReason =
  BeatRejectReason | "offline" | "timeout" | "server_error";

export interface BeatDeliveryState {
  attempted: number;
  accepted: number;
  rejected: number;
  lastReason: BeatDeliveryReason | null;
}

const INITIAL_BEAT_DELIVERY: BeatDeliveryState = {
  attempted: 0,
  accepted: 0,
  rejected: 0,
  lastReason: null,
};

export function useGameConnection() {
  const socketRef = useRef<GameSocket | null>(null);
  const sessionRef = useRef<ParticipantSession | null>(null);
  const [connected, setConnected] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [session, setSession] = useState<ParticipantSession | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastOwnBeat, setLastOwnBeat] = useState<AcceptedBeat | null>(null);
  const [beatDelivery, setBeatDelivery] = useState<BeatDeliveryState>(
    INITIAL_BEAT_DELIVERY,
  );

  const clearLocalSession = useCallback((nextNotice: string | null = null) => {
    sessionRef.current = null;
    setSession(null);
    setRoom(null);
    setLastOwnBeat(null);
    setNotice(nextNotice);
    void AsyncStorage.removeItem(STORAGE_KEY);
  }, []);

  useEffect(() => {
    let disposed = false;
    const socket: GameSocket = io(SOCKET_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 350,
      timeout: 8_000,
    });
    socketRef.current = socket;

    const resume = async () => {
      setConnected(true);
      const stored = sessionRef.current ?? (await readSession());
      if (disposed || !stored) {
        setRestoring(false);
        return;
      }
      try {
        const result = await socket.timeout(1_500).emitWithAck("player:join", {
          roomCode: stored.roomCode,
          nickname: stored.nickname,
          playerId: stored.playerId,
          playerToken: stored.playerToken,
        });
        if (disposed) return;
        setRestoring(false);
        if (!result.ok) {
          void AsyncStorage.removeItem(STORAGE_KEY);
          sessionRef.current = null;
          setSession(null);
          setRoom(null);
          return;
        }
        sessionRef.current = stored;
        setSession(stored);
        setRoom(result.data.room);
      } catch {
        if (!disposed) setRestoring(false);
      }
    };

    socket.on("connect", () => void resume());
    socket.on("disconnect", () => setConnected(false));
    socket.on("room:snapshot", setRoom);
    socket.on("race:finished", setRoom);
    socket.on("race:beat", (event) => {
      if (event.playerId === sessionRef.current?.playerId)
        setLastOwnBeat(event);
    });
    socket.on("player:removed", (event) => {
      if (event.playerId !== sessionRef.current?.playerId) return;
      clearLocalSession(
        event.reason === "kicked"
          ? "호스트가 경기장에서 내보냈습니다."
          : "연결이 오래 끊겨 경기장에서 나왔습니다.",
      );
    });

    return () => {
      disposed = true;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [clearLocalSession]);

  const join = useCallback(async (roomCode: string, nickname: string) => {
    const socket = socketRef.current;
    if (!socket?.connected)
      throw new Error("서버에 연결 중입니다. 잠시 후 다시 시도해 주세요.");

    const result = await socket.timeout(1_500).emitWithAck("player:join", {
      roomCode: roomCode.trim().toUpperCase(),
      nickname: nickname.trim(),
    });
    if (!result.ok) throw new Error(result.error);
    setNotice(null);
    const next: ParticipantSession = {
      roomCode: result.data.room.code,
      nickname: nickname.trim(),
      playerId: result.data.playerId,
      playerToken: result.data.playerToken,
    };
    sessionRef.current = next;
    setSession(next);
    setRoom(result.data.room);
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const sendMeasurement = useCallback((update: MeasurementUpdate) => {
    if (!socketRef.current?.connected || !sessionRef.current) return;
    void socketRef.current
      .timeout(1_500)
      .emitWithAck("player:measurement", update)
      .catch(() => undefined);
  }, []);

  const sendBeat = useCallback((event: BeatEvent) => {
    setBeatDelivery((current) => ({
      ...current,
      attempted: current.attempted + 1,
    }));
    if (!socketRef.current?.connected || !sessionRef.current) {
      setBeatDelivery((current) => ({
        ...current,
        rejected: current.rejected + 1,
        lastReason: "offline",
      }));
      return;
    }
    void sendBeatWithRetry(socketRef.current, event).then((outcome) => {
      setBeatDelivery((current) =>
        outcome.accepted
          ? {
              ...current,
              accepted: current.accepted + 1,
              lastReason: null,
            }
          : {
              ...current,
              rejected: current.rejected + 1,
              lastReason: outcome.reason,
            },
      );
    });
  }, []);

  const resetBeatDelivery = useCallback(() => {
    setLastOwnBeat(null);
    setBeatDelivery(INITIAL_BEAT_DELIVERY);
  }, []);

  const leave = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.connected && sessionRef.current) {
      void socket
        .timeout(1_500)
        .emitWithAck("player:leave")
        .catch(() => undefined);
    }
    clearLocalSession();
  }, [clearLocalSession]);

  return {
    connected,
    restoring,
    session,
    room,
    notice,
    lastOwnBeat,
    beatDelivery,
    join,
    sendMeasurement,
    sendBeat,
    resetBeatDelivery,
    leave,
  };
}

async function sendBeatWithRetry(
  socket: GameSocket,
  event: BeatEvent,
): Promise<
  | { accepted: true; ack: BeatAck }
  | { accepted: false; reason: BeatDeliveryReason }
> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await socket
        .timeout(1_500)
        .emitWithAck("player:beat", event);
      if (!result.ok) return { accepted: false, reason: "server_error" };
      if (result.data.accepted || result.data.reason === "duplicate") {
        return { accepted: true, ack: result.data };
      }
      return {
        accepted: false,
        reason: result.data.reason ?? "server_error",
      };
    } catch {
      if (!socket.connected) return { accepted: false, reason: "offline" };
    }
  }
  return { accepted: false, reason: "timeout" };
}

async function readSession(): Promise<ParticipantSession | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ParticipantSession) : null;
  } catch {
    return null;
  }
}

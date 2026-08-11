import { io } from "socket.io-client";

const roomCode = process.argv[2]?.trim().toUpperCase();
const endpoint = process.env.SMOKE_SOCKET_URL ?? "http://localhost:3001";

if (!roomCode) {
  throw new Error("사용법: npx tsx scripts/ready-player.ts <방 코드>");
}

async function main(): Promise<void> {
  const socket = io(endpoint, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 3_000,
  });

  try {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  const joined = await socket.emitWithAck("player:join", {
    roomCode,
    nickname: "자동 테스트",
  });
  if (!joined.ok) throw new Error(joined.error);

  const measured = await socket.emitWithAck("player:measurement", {
    state: "ready",
    bpm: 80,
    signalQuality: 0.95,
  });
  if (!measured.ok) throw new Error(measured.error);

  console.log(`${roomCode} 방에 준비 완료 참가자를 추가했습니다.`);
  } finally {
    socket.disconnect();
  }
}

void main();

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { io, type Socket } from "socket.io-client";
import type {
  AcceptedBeat,
  ClientToServerEvents,
  RoomSnapshot,
  ServerToClientEvents,
} from "@heartrace/protocol";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "http://localhost:3001";
const PUBLIC_URL = import.meta.env.VITE_PUBLIC_URL ?? window.location.origin;
const IOS_INSTALL_URL = import.meta.env.VITE_IOS_INSTALL_URL ?? "";
const STORAGE_KEY = "heartrace:host-session";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface HostSession {
  roomCode: string;
  hostToken: string;
}

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/join") return <JoinLanding />;
  if (path === "/watch") return <SpectatorApp />;
  if (path === "/privacy") return <PrivacyPage />;
  if (path === "/support") return <SupportPage />;
  return <HostApp />;
}

function HostApp() {
  const socketRef = useRef<GameSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [session, setSession] = useState<HostSession | null>(() =>
    loadSession(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [beatEffects, setBeatEffects] = useState<Record<string, AcceptedBeat>>(
    {},
  );

  useEffect(() => {
    const socket: GameSocket = io(SOCKET_URL, {
      reconnection: true,
      reconnectionDelay: 400,
      timeout: 8_000,
    });
    socketRef.current = socket;

    const resume = () => {
      setConnected(true);
      const stored = loadSession();
      if (!stored) return;
      socket.emit("host:resume", stored, (result) => {
        if (result.ok) {
          setSession(stored);
          setRoom(result.data.room);
          setError(null);
        } else {
          clearSession();
          setSession(null);
          setRoom(null);
        }
      });
    };

    socket.on("connect", resume);
    socket.on("disconnect", () => setConnected(false));
    socket.on("room:snapshot", setRoom);
    socket.on("race:finished", setRoom);
    socket.on("race:beat", (event) => {
      setBeatEffects((current) => ({ ...current, [event.playerId]: event }));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const createRoom = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setError("서버와 연결 중입니다. 잠시 후 다시 눌러 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    socket.emit("host:create-room", { finishBeats: 60 }, (result) => {
      setBusy(false);
      if (!result.ok) return setError(result.error);
      const nextSession = {
        roomCode: result.data.room.code,
        hostToken: result.data.hostToken,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
      setSession(nextSession);
      setRoom(result.data.room);
    });
  }, []);

  const startRace = useCallback(() => {
    if (!session || !socketRef.current) return;
    setBusy(true);
    setError(null);
    socketRef.current.emit("host:start", session, (result) => {
      setBusy(false);
      if (!result.ok) setError(result.error);
    });
  }, [session]);

  const resetRace = useCallback(() => {
    if (!session || !socketRef.current) return;
    setBusy(true);
    setError(null);
    socketRef.current.emit("host:reset", session, (result) => {
      setBusy(false);
      if (!result.ok) return setError(result.error);
      setRoom(result.data.room);
      setBeatEffects({});
    });
  }, [session]);

  const removePlayer = useCallback(
    (playerId: string) => {
      if (!session || !socketRef.current) return;
      setBusy(true);
      setError(null);
      socketRef.current.emit(
        "host:remove-player",
        { ...session, playerId },
        (result) => {
          setBusy(false);
          if (!result.ok) return setError(result.error);
          setRoom(result.data.room);
        },
      );
    },
    [session],
  );

  const leaveRoom = useCallback(() => {
    clearSession();
    setSession(null);
    setRoom(null);
    setBeatEffects({});
    setError(null);
  }, []);

  if (!room || !session) {
    return (
      <Home
        connected={connected}
        busy={busy}
        error={error}
        onCreate={createRoom}
      />
    );
  }

  const watchUrl = new URL("/watch", PUBLIC_URL);
  watchUrl.searchParams.set("room", room.code);

  return (
    <main className="app-shell">
      <TopBar
        connected={connected}
        code={room.code}
        onLeave={leaveRoom}
        watchUrl={watchUrl.toString()}
      />
      {room.phase === "lobby" && (
        <Lobby
          room={room}
          busy={busy}
          error={error}
          onStart={startRace}
          onRemovePlayer={removePlayer}
        />
      )}
      {room.phase === "countdown" && (
        <Countdown room={room} busy={busy} onEnd={resetRace} />
      )}
      {room.phase === "racing" && (
        <Race
          room={room}
          beatEffects={beatEffects}
          busy={busy}
          onEnd={resetRace}
        />
      )}
      {room.phase === "finished" && (
        <Finish room={room} busy={busy} onReset={resetRace} />
      )}
    </main>
  );
}

function SpectatorApp() {
  const roomCode = new URLSearchParams(window.location.search)
    .get("room")
    ?.trim()
    .toUpperCase()
    .slice(0, 4);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [beatEffects, setBeatEffects] = useState<Record<string, AcceptedBeat>>(
    {},
  );

  useEffect(() => {
    if (!roomCode) return;
    const socket: GameSocket = io(SOCKET_URL, {
      reconnection: true,
      reconnectionDelay: 400,
      timeout: 8_000,
    });

    const updateRoom = (nextRoom: RoomSnapshot) => {
      if (nextRoom.phase === "lobby") setBeatEffects({});
      setRoom(nextRoom);
    };
    const joinRoom = () => {
      setConnected(true);
      socket.emit("viewer:join", { roomCode }, (result) => {
        if (result.ok) {
          updateRoom(result.data.room);
          setError(null);
        } else {
          setRoom(null);
          setError(result.error);
        }
      });
    };

    socket.on("connect", joinRoom);
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => {
      setConnected(false);
      setError("경기 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    });
    socket.on("room:snapshot", updateRoom);
    socket.on("race:finished", updateRoom);
    socket.on("race:beat", (event) => {
      setBeatEffects((current) => ({ ...current, [event.playerId]: event }));
    });

    return () => {
      socket.disconnect();
    };
  }, [roomCode]);

  if (!roomCode) {
    return (
      <SpectatorNotice
        title="관전 링크를 다시 확인해 주세요."
        description="방 코드가 포함된 관전자 링크가 필요합니다."
      />
    );
  }

  if (!room) {
    return (
      <SpectatorNotice
        title={error ?? "경기 화면을 불러오는 중입니다."}
        description={`방 ${roomCode} · ${connected ? "방을 확인하는 중" : "서버에 연결하는 중"}`}
        retry={Boolean(error)}
      />
    );
  }

  return (
    <main className="app-shell spectator-shell">
      <TopBar connected={connected} code={room.code} mode="spectator" />
      {room.phase === "lobby" && (
        <Lobby
          room={room}
          busy={false}
          error={null}
          onStart={() => undefined}
          onRemovePlayer={() => undefined}
          readOnly
        />
      )}
      {room.phase === "countdown" && (
        <Countdown room={room} busy={false} onEnd={() => undefined} readOnly />
      )}
      {room.phase === "racing" && (
        <Race
          room={room}
          beatEffects={beatEffects}
          busy={false}
          onEnd={() => undefined}
          readOnly
        />
      )}
      {room.phase === "finished" && (
        <Finish room={room} busy={false} onReset={() => undefined} readOnly />
      )}
    </main>
  );
}

function SpectatorNotice({
  title,
  description,
  retry = false,
}: {
  title: string;
  description: string;
  retry?: boolean;
}) {
  return (
    <main className="public-page spectator-notice page-enter">
      <a className="public-wordmark" href="/">
        심장 달리기
      </a>
      <div>
        <p className="eyebrow">LIVE SPECTATOR</p>
        <h1>{title}</h1>
        <p>{description}</p>
        {retry && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => window.location.reload()}
          >
            다시 시도
          </button>
        )}
      </div>
    </main>
  );
}

function JoinLanding() {
  const roomCode = new URLSearchParams(window.location.search)
    .get("room")
    ?.trim()
    .toUpperCase()
    .slice(0, 4);
  const appUrl = `heartrace://join${roomCode ? `?room=${encodeURIComponent(roomCode)}` : ""}`;

  return (
    <main className="public-page join-landing page-enter">
      <a className="public-wordmark" href="/">
        심장 달리기
      </a>
      <div className="public-page-copy">
        <p className="eyebrow">HEART RACE</p>
        <h1>
          심장으로 달릴
          <br /> 준비가 됐나요?
        </h1>
        <p>
          앱을 설치한 뒤 카메라와 플래시에 손가락을 올려 심장 경주에 참여하세요.
        </p>
      </div>

      {roomCode && (
        <div className="landing-room-code" aria-label={`방 코드 ${roomCode}`}>
          <span>방 코드</span>
          <strong>{roomCode}</strong>
        </div>
      )}

      <div className="public-actions">
        {IOS_INSTALL_URL ? (
          <a className="primary-button" href={IOS_INSTALL_URL}>
            iPhone 앱 설치
            <ArrowIcon />
          </a>
        ) : (
          <span className="primary-button is-disabled">테스트 앱 준비 중</span>
        )}
        <a className="secondary-button" href={appUrl}>
          설치된 앱 열기
        </a>
      </div>

      <div className="tester-steps">
        <p>
          <span>01</span> 앱 설치 후 카메라 권한을 허용합니다.
        </p>
        <p>
          <span>02</span> 위 방 코드와 닉네임으로 입장합니다.
        </p>
        <p>
          <span>03</span> 측정 시작을 누르고 후면 카메라와 플래시를 손가락으로
          덮습니다.
        </p>
      </div>

      <footer className="public-footer">
        <a href="/privacy">개인정보 처리방침</a>
        <a href="/support">도움말</a>
      </footer>
    </main>
  );
}

function PrivacyPage() {
  return (
    <PublicDocument title="개인정보 처리방침">
      <p>
        심장 달리기는 참여형 전시의 실시간 경주 진행을 위해 방 코드, 참가자가
        입력한 닉네임, 측정 BPM, 신호 품질 및 박동 이벤트를 서버로 전송합니다.
      </p>
      <h2>카메라 데이터</h2>
      <p>
        카메라 영상과 이미지 프레임은 기기 밖으로 전송하거나 저장하지 않습니다.
        손가락의 색 변화는 기기 안에서 분석되며 경주에 필요한 수치만 서버로
        전송됩니다.
      </p>
      <h2>이용 목적과 보관</h2>
      <p>
        전송된 정보는 현재 방의 참가자 상태와 경기 화면을 실시간으로 표시하는
        데만 사용합니다. 별도의 영구 데이터베이스나 광고·분석 목적으로 저장하지
        않으며, 운영 서버의 임시 메모리에서만 처리됩니다.
      </p>
      <h2>사용자 선택</h2>
      <p>
        앱에서 나가기를 선택하면 참가자 정보가 현재 방에서 제거됩니다. 카메라
        권한은 iPhone 설정에서 언제든 철회할 수 있습니다.
      </p>
      <p className="document-note">
        이 앱은 의료 진단이나 치료 목적이 아닌 예술 작품의 게임 입력 도구입니다.
      </p>
    </PublicDocument>
  );
}

function SupportPage() {
  return (
    <PublicDocument title="도움말">
      <h2>방에 입장되지 않아요</h2>
      <p>
        호스트 화면의 네 자리 방 코드를 확인하고 인터넷 연결 상태를 확인해
        주세요. 경기가 이미 시작된 방에는 새로 입장할 수 없습니다.
      </p>
      <h2>심박수가 측정되지 않아요</h2>
      <p>
        케이스를 벗기고 후면 카메라 렌즈와 플래시를 손가락 끝으로 함께 덮어
        주세요. 손가락을 너무 세게 누르지 말고 움직임을 줄이면 신호가 더
        안정적입니다.
      </p>
      <h2>측정을 중단하고 싶어요</h2>
      <p>
        앱 상단의 나가기를 누르거나 카메라 권한을 해제할 수 있습니다. 불편함이나
        어지러움을 느끼면 즉시 참여를 중단해 주세요.
      </p>
      <p className="document-note">
        추가 지원이 필요하면 전시장 운영자에게 문의해 주세요.
      </p>
    </PublicDocument>
  );
}

function PublicDocument({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="public-page public-document page-enter">
      <a className="public-wordmark" href="/">
        심장 달리기
      </a>
      <article>
        <p className="eyebrow">HEART RACE</p>
        <h1>{title}</h1>
        {children}
      </article>
      <footer className="public-footer">
        <a href="/join">참가 안내</a>
        <a href="/support">도움말</a>
      </footer>
    </main>
  );
}

function Home({
  connected,
  busy,
  error,
  onCreate,
}: {
  connected: boolean;
  busy: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  return (
    <main className="home page-enter">
      <div className="home-kicker">
        <LiveDot live={connected} />
        참여형 운동회
      </div>
      <div className="home-copy">
        <p className="eyebrow">HEART RACE</p>
        <h1>
          아무도 달리지 않지만,
          <br />
          모두의 심장은 달립니다.
        </h1>
        <p className="home-description">
          휴대폰 카메라에 손가락을 올리고 심박수를 조절하세요.
          <br className="desktop-only" /> 박동 한 번이 곧 한 걸음입니다.
        </p>
      </div>
      <div className="home-action">
        <button
          className="primary-button hero-button"
          onClick={onCreate}
          disabled={busy}
        >
          {busy ? "경기장 만드는 중…" : "새 경기 만들기"}
          <ArrowIcon />
        </button>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="edition">전시용 프로토타입 · 2026</p>
    </main>
  );
}

function TopBar({
  connected,
  code,
  onLeave,
  watchUrl,
  mode = "host",
}: {
  connected: boolean;
  code: string;
  onLeave?: () => void;
  watchUrl?: string;
  mode?: "host" | "spectator";
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyWatchUrl = async () => {
    if (!watchUrl) return;
    try {
      await navigator.clipboard.writeText(watchUrl);
      setCopied(true);
    } catch {
      window.prompt("아래 관전 링크를 복사하세요.", watchUrl);
    }
  };

  return (
    <header className="top-bar">
      {onLeave ? (
        <button className="wordmark" onClick={onLeave} aria-label="처음으로">
          심장 달리기
        </button>
      ) : (
        <a className="wordmark" href="/">
          심장 달리기
        </a>
      )}
      <div className="top-bar-actions">
        {watchUrl && (
          <button
            className={`watch-link-button ${copied ? "is-copied" : ""}`}
            type="button"
            onClick={copyWatchUrl}
          >
            <LinkIcon />
            <span>{copied ? "복사됨" : "관전 링크 복사"}</span>
          </button>
        )}
        <div className="top-room-info">
          <LiveDot live={connected} />
          <span>{connected ? "연결됨" : "재연결 중"}</span>
          <span className="top-divider" />
          {mode === "spectator" && (
            <span className="spectator-label">관전 중</span>
          )}
          <span>방 {code}</span>
        </div>
      </div>
    </header>
  );
}

function Lobby({
  room,
  busy,
  error,
  onStart,
  onRemovePlayer,
  readOnly = false,
}: {
  room: RoomSnapshot;
  busy: boolean;
  error: string | null;
  onStart: () => void;
  onRemovePlayer: (playerId: string) => void;
  readOnly?: boolean;
}) {
  const [openMenuPlayerId, setOpenMenuPlayerId] = useState<string | null>(null);
  const readyCount = room.players.filter(
    (player) => player.connected && player.ready,
  ).length;
  const allReady =
    room.players.length > 0 &&
    room.players.every((player) => player.connected && player.ready);
  const joinUrl = new URL("/join", PUBLIC_URL);
  joinUrl.searchParams.set("room", room.code);
  const joinUri = joinUrl.toString();

  return (
    <section className="lobby page-enter">
      <div className="join-panel">
        <div>
          <p className="eyebrow">휴대폰에서 방 코드를 입력하세요</p>
          <p
            className="room-code"
            aria-label={`방 코드 ${room.code.split("").join(" ")}`}
          >
            {room.code}
          </p>
          <p className="join-help">
            심장 달리기 앱을 열고 닉네임과 코드를 입력하세요.
          </p>
        </div>
        <div className="qr-frame" aria-label="앱 입장 QR 코드">
          <QRCodeSVG
            value={joinUri}
            size={150}
            level="M"
            bgColor="#ffffff"
            fgColor="#050505"
          />
        </div>
      </div>

      <div className="players-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">참가자</p>
            <h2>
              {room.players.length > 0
                ? `${readyCount} / ${room.players.length} 준비 완료`
                : "입장을 기다리는 중"}
            </h2>
          </div>
          {room.players.length > 0 && (
            <div
              className="readiness-ring"
              style={
                {
                  "--progress": `${(readyCount / room.players.length) * 360}deg`,
                } as React.CSSProperties
              }
            >
              <span>{readyCount}</span>
            </div>
          )}
        </div>

        <div className="player-grid">
          {room.players.map((player, index) => (
            <article
              className={`player-card ${player.ready ? "is-ready" : ""} ${!player.connected ? "is-disconnected" : ""}`}
              key={player.id}
            >
              <span className="player-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="player-card-copy">
                <h3>{player.nickname}</h3>
                <p>
                  {!player.connected
                    ? "연결 끊김 · 잠시 후 자동 정리"
                    : player.ready
                      ? `${player.bpm ?? "—"} BPM · 출발 준비 완료`
                      : player.bpm !== null
                        ? `${player.bpm} BPM · ${measurementLabel(player.measurementState)}`
                        : measurementLabel(player.measurementState)}
                </p>
              </div>
              {!readOnly && (
                <div
                  className="player-actions"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      setOpenMenuPlayerId(null);
                    }
                  }}
                >
                  <button
                    className="status-mark"
                    type="button"
                    aria-label={`${player.nickname} 참가자 메뉴`}
                    aria-expanded={openMenuPlayerId === player.id}
                    onClick={() =>
                      setOpenMenuPlayerId((current) =>
                        current === player.id ? null : player.id,
                      )
                    }
                  >
                    <MoreIcon />
                  </button>
                  {openMenuPlayerId === player.id && (
                    <div className="player-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy}
                        onClick={() => {
                          setOpenMenuPlayerId(null);
                          if (
                            window.confirm(
                              `${player.nickname}님을 경기장에서 내보낼까요?`,
                            )
                          ) {
                            onRemovePlayer(player.id);
                          }
                        }}
                      >
                        경기장에서 내보내기
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
          {room.players.length === 0 && (
            <div className="empty-player-card">
              <span className="scan-line" />
              <p>첫 번째 심장을 기다리고 있어요</p>
            </div>
          )}
        </div>
      </div>

      <div className="lobby-footer">
        <div className="rule-copy">
          <HeartOutline />
          <p>
            <strong>한 번의 박동 = 한 걸음</strong>
            <br />
            먼저 {room.finishBeats}번 뛰는 심장이 우승합니다.
          </p>
        </div>
        {readOnly ? (
          <p className="spectator-status">
            {allReady
              ? "모든 심장이 준비됐습니다. 호스트의 출발을 기다립니다."
              : "참가자들의 측정을 기다리고 있습니다."}
          </p>
        ) : (
          <div className="start-area">
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              onClick={onStart}
              disabled={!allReady || busy}
            >
              {allReady
                ? busy
                  ? "출발 준비 중…"
                  : "경기 시작"
                : "모두의 측정을 기다리는 중"}
              {allReady && <ArrowIcon />}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Countdown({
  room,
  busy,
  onEnd,
  readOnly = false,
}: {
  room: RoomSnapshot;
  busy: boolean;
  onEnd: () => void;
  readOnly?: boolean;
}) {
  const [clockOffset] = useState(() => room.serverNow - Date.now());
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now() + clockOffset),
      50,
    );
    return () => window.clearInterval(timer);
  }, [clockOffset]);
  const remaining = Math.max(0, (room.countdownEndsAt ?? now) - now);
  const display =
    remaining > 3_000
      ? "준비"
      : String(Math.max(1, Math.ceil(remaining / 1_000)));

  return (
    <section className="countdown" aria-live="assertive">
      {!readOnly && (
        <div className="countdown-end-control">
          <EndRaceButton busy={busy} onEnd={onEnd} />
        </div>
      )}
      <p>손가락을 그대로 유지하세요</p>
      <div className="countdown-number" key={display}>
        {display}
      </div>
      <span>
        {display === "준비" ? "곧 경기가 시작됩니다" : "심장으로 달릴 시간"}
      </span>
    </section>
  );
}

function Race({
  room,
  beatEffects,
  busy,
  onEnd,
  readOnly = false,
}: {
  room: RoomSnapshot;
  beatEffects: Record<string, AcceptedBeat>;
  busy: boolean;
  onEnd: () => void;
  readOnly?: boolean;
}) {
  const leader = useMemo(() => room.players[0], [room.players]);
  return (
    <section className="race page-enter">
      <div className="race-heading">
        <div>
          <p className="eyebrow">
            <span className="recording-dot" /> 경기 중
          </p>
          <h1>심장이 달리고 있습니다</h1>
        </div>
        <div className="race-actions">
          <div className="leader-copy">
            <span>현재 선두</span>
            <strong>{leader?.nickname ?? "—"}</strong>
          </div>
          {!readOnly && <EndRaceButton busy={busy} onEnd={onEnd} />}
        </div>
      </div>

      <div className="track-list">
        {room.players.map((player, index) => {
          const beat = beatEffects[player.id];
          const effectKey = beat?.beatId ?? "initial";
          return (
            <article className="track" key={player.id}>
              <div className="track-meta">
                <span className="lane-number">{index + 1}</span>
                <div>
                  <h2>{player.nickname}</h2>
                  <p>
                    <strong>{player.bpm ?? "—"}</strong> BPM
                  </p>
                </div>
              </div>
              <div className="track-rail">
                <div className="track-marks" aria-hidden="true" />
                <div
                  className="track-progress"
                  style={{ width: `${player.distanceRatio * 100}%` }}
                />
                <div
                  className={`racer ${beat?.accent ? "is-accent" : ""}`}
                  style={{ left: `${player.distanceRatio * 100}%` }}
                  key={effectKey}
                >
                  <span className="racer-pulse" />
                  <HeartSolid />
                </div>
                <span className="finish-line">결승</span>
              </div>
              <div className="beat-score">
                <strong>{player.beatCount}</strong>
                <span>/ {room.finishBeats}</span>
              </div>
            </article>
          );
        })}
      </div>
      <p className="race-instruction">
        휴대폰 화면의 심박수를 보며, 자신의 심장을 움직여 보세요.
      </p>
    </section>
  );
}

function EndRaceButton({ busy, onEnd }: { busy: boolean; onEnd: () => void }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  return (
    <button
      className={`end-race-button ${confirming ? "is-confirming" : ""}`}
      disabled={busy}
      onClick={() => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        onEnd();
      }}
    >
      {busy ? "종료하는 중…" : confirming ? "한 번 더 눌러 종료" : "경기 종료"}
    </button>
  );
}

function Finish({
  room,
  busy,
  onReset,
  readOnly = false,
}: {
  room: RoomSnapshot;
  busy: boolean;
  onReset: () => void;
  readOnly?: boolean;
}) {
  const winner =
    room.players.find((player) => player.finishPlace === 1) ?? room.players[0];
  return (
    <section className="finish page-enter">
      <p className="eyebrow">경기 종료</p>
      <div className="finish-title">
        <span className="finish-heart">
          <HeartSolid />
        </span>
        <h1>
          {winner?.nickname}
          <br />
          심장이 먼저 도착했습니다.
        </h1>
        <p>{winner?.beatCount ?? room.finishBeats}번의 박동으로 완주</p>
      </div>
      <ol className="ranking-list">
        {room.players.map((player, index) => (
          <li key={player.id}>
            <span className="ranking-place">
              {player.finishPlace ?? index + 1}
            </span>
            <strong>{player.nickname}</strong>
            <span>{player.beatCount} 박동</span>
          </li>
        ))}
      </ol>
      {readOnly ? (
        <p className="spectator-status finish-status">
          호스트가 다음 경기를 준비하고 있습니다.
        </p>
      ) : (
        <button className="primary-button" onClick={onReset} disabled={busy}>
          {busy ? "다시 준비하는 중…" : "새 경기 준비"}
          <ArrowIcon />
        </button>
      )}
    </section>
  );
}

function LiveDot({ live }: { live: boolean }) {
  return (
    <span className={`live-dot ${live ? "is-live" : ""}`} aria-hidden="true" />
  );
}

function ArrowIcon() {
  return (
    <span className="arrow-icon" aria-hidden="true">
      →
    </span>
  );
}

function MoreIcon() {
  return (
    <svg className="more-icon" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="4" cy="9" r="1.25" />
      <circle cx="9" cy="9" r="1.25" />
      <circle cx="14" cy="9" r="1.25" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg className="link-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8.1 12.1 12 8.2" />
      <path d="M6.4 14.9 5 16.3a3.4 3.4 0 0 1-4.8-4.8l3.2-3.2a3.4 3.4 0 0 1 4.8 0" />
      <path d="m13.6 5.1 1.4-1.4a3.4 3.4 0 1 1 4.8 4.8l-3.2 3.2a3.4 3.4 0 0 1-4.8 0" />
    </svg>
  );
}

function HeartOutline() {
  return (
    <svg className="heart-outline" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.7 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
    </svg>
  );
}

function HeartSolid() {
  return (
    <svg className="heart-solid" viewBox="0 0 32 29" aria-hidden="true">
      <path d="M23.3.7c-3 0-5.7 1.6-7.3 4C14.4 2.3 11.7.7 8.7.7 3.9.7 0 4.6 0 9.4c0 8.1 16 18.9 16 18.9S32 17.5 32 9.4C32 4.6 28.1.7 23.3.7Z" />
    </svg>
  );
}

function measurementLabel(
  state: RoomSnapshot["players"][number]["measurementState"],
) {
  if (state === "measuring") return "심박수 측정 중";
  if (state === "signal_lost") return "손가락을 다시 올려 주세요";
  return "측정 시작 전";
}

function loadSession(): HostSession | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? (JSON.parse(value) as HostSession) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

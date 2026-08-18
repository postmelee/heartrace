import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { io, type Socket } from "socket.io-client";
import { MAX_TEAM_COUNT } from "@heartrace/protocol";
import type {
  AcceptedBeat,
  ClientToServerEvents,
  HostCreateRoomRequest,
  PlayerSnapshot,
  RoomSnapshot,
  ServerToClientEvents,
} from "@heartrace/protocol";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "http://localhost:3001";
const PUBLIC_URL = import.meta.env.VITE_PUBLIC_URL ?? window.location.origin;
const IOS_INSTALL_URL = import.meta.env.VITE_IOS_INSTALL_URL ?? "";
const STORAGE_KEY = "heartrace:host-session";
const DEMO_STORAGE_KEY = "heartrace:demo-host-session";

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
  if (path === "/demo") return <HostApp demo />;
  return <HostApp />;
}

function HostApp({ demo = false }: { demo?: boolean }) {
  const storageKey = demo ? DEMO_STORAGE_KEY : STORAGE_KEY;
  const socketRef = useRef<GameSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [session, setSession] = useState<HostSession | null>(() =>
    loadSession(storageKey),
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
      const stored = loadSession(storageKey);
      if (!stored) return;
      socket.emit("host:resume", stored, (result) => {
        if (result.ok) {
          setSession(stored);
          setRoom(result.data.room);
          setError(null);
        } else {
          clearSession(storageKey);
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
  }, [storageKey]);

  const createRoom = useCallback(
    (request: HostCreateRoomRequest) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        setError("서버와 연결 중입니다. 잠시 후 다시 눌러 주세요.");
        return;
      }
      setBusy(true);
      setError(null);
      socket.emit("host:create-room", request, (result) => {
        setBusy(false);
        if (!result.ok) return setError(result.error);
        const nextSession = {
          roomCode: result.data.room.code,
          hostToken: result.data.hostToken,
        };
        localStorage.setItem(storageKey, JSON.stringify(nextSession));
        setSession(nextSession);
        setRoom(result.data.room);
      });
    },
    [storageKey],
  );

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
    clearSession(storageKey);
    setSession(null);
    setRoom(null);
    setBeatEffects({});
    setError(null);
  }, [storageKey]);

  if (!room || !session) {
    return (
      <Home
        connected={connected}
        busy={busy}
        error={error}
        onCreate={createRoom}
        demo={demo}
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
        demo={room.demo}
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
      <TopBar
        connected={connected}
        code={room.code}
        mode="spectator"
        demo={room.demo}
      />
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
  demo = false,
}: {
  connected: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (request: HostCreateRoomRequest) => void;
  demo?: boolean;
}) {
  const [mode, setMode] = useState<"individual" | "relay">(
    demo ? "relay" : "individual",
  );
  const [teamCount, setTeamCount] = useState(2);
  const [runnersPerTeam, setRunnersPerTeam] = useState(3);
  const [legBeats, setLegBeats] = useState<10 | 20 | 30 | 60>(20);
  const [trackMode, setTrackMode] = useState<"straight" | "circular">(
    "straight",
  );
  const createRequest: HostCreateRoomRequest =
    mode === "relay"
      ? {
          finishBeats: legBeats,
          mode,
          trackMode,
          demo,
          relay: { teamCount, runnersPerTeam, legBeats },
        }
      : { finishBeats: 60, mode };

  return (
    <main className={`home page-enter ${demo ? "is-demo" : ""}`}>
      <div className="home-kicker">
        <LiveDot live={connected} />
        {demo ? "휴대폰 없는 리허설" : "참여형 운동회"}
      </div>
      <div className="home-copy">
        <p className="eyebrow">{demo ? "HEART RACE · MOCK" : "HEART RACE"}</p>
        <h1>
          {demo ? (
            <>
              가상의 심장으로,
              <br />팀 경기를 리허설합니다.
            </>
          ) : (
            <>
              아무도 달리지 않지만,
              <br />
              모두의 심장은 달립니다.
            </>
          )}
        </h1>
        <p className="home-description">
          {demo ? (
            <>
              팀과 주자 수를 정하면 서버가 가상 박동을 생성합니다.
              <br className="desktop-only" /> 실제 트랙과 바톤 전환을 그대로
              확인할 수 있습니다.
            </>
          ) : (
            <>
              휴대폰 카메라에 손가락을 올리고 심박수를 조절하세요.
              <br className="desktop-only" /> 박동 한 번이 곧 한 걸음입니다.
            </>
          )}
        </p>
      </div>
      <div className="home-action">
        <div className="race-setup" aria-label="경기 방식 설정">
          {!demo && (
            <div className="mode-picker" role="group" aria-label="경기 방식">
              <button
                type="button"
                className={mode === "individual" ? "is-selected" : ""}
                onClick={() => setMode("individual")}
              >
                개인전
              </button>
              <button
                type="button"
                className={mode === "relay" ? "is-selected" : ""}
                onClick={() => setMode("relay")}
              >
                팀 이어달리기
              </button>
            </div>
          )}
          {mode === "relay" && (
            <div className="relay-options">
              <NumberPicker
                label="팀 수"
                value={teamCount}
                min={2}
                max={MAX_TEAM_COUNT}
                suffix="팀"
                onChange={setTeamCount}
              />
              <SelectPicker
                label="팀별 주자"
                value={runnersPerTeam}
                min={2}
                max={30}
                suffix="명"
                onChange={setRunnersPerTeam}
              />
              <div className="choice-picker">
                <span>트랙</span>
                <div role="group" aria-label="트랙 모양">
                  <button
                    type="button"
                    className={trackMode === "straight" ? "is-selected" : ""}
                    aria-pressed={trackMode === "straight"}
                    onClick={() => setTrackMode("straight")}
                  >
                    직선
                  </button>
                  <button
                    type="button"
                    className={trackMode === "circular" ? "is-selected" : ""}
                    aria-pressed={trackMode === "circular"}
                    onClick={() => setTrackMode("circular")}
                  >
                    원형
                  </button>
                </div>
              </div>
              <div className="choice-picker beat-choice-picker">
                <span>주자당 박동</span>
                <div role="group" aria-label="주자당 완주 박동 수">
                  {([10, 20, 30, 60] as const).map((option) => (
                    <button
                      type="button"
                      key={option}
                      className={legBeats === option ? "is-selected" : ""}
                      aria-pressed={legBeats === option}
                      onClick={() => setLegBeats(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <button
          className="primary-button hero-button"
          onClick={() => onCreate(createRequest)}
          disabled={busy}
        >
          {busy
            ? "경기장 만드는 중…"
            : demo
              ? "모의 경기 만들기"
              : "새 경기 만들기"}
          <ArrowIcon />
        </button>
        {!demo && (
          <a className="demo-entry" href="/demo">
            휴대폰 없이 테스트하기
          </a>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="edition">
        {demo
          ? "가상 박동은 의료 측정값이 아닙니다."
          : "전시용 프로토타입 · 2026"}
      </p>
    </main>
  );
}

function NumberPicker({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="number-picker">
      <span>{label}</span>
      <div>
        <button
          type="button"
          aria-label={`${label} 줄이기`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          −
        </button>
        <strong>
          {value}
          {suffix}
        </strong>
        <button
          type="button"
          aria-label={`${label} 늘리기`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}

function SelectPicker({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="select-picker">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(+event.target.value)}>
        {Array.from({ length: max - min + 1 }, (_, index) => min + index).map(
          (option) => (
            <option key={option} value={option}>
              {option}
              {suffix}
            </option>
          ),
        )}
      </select>
    </label>
  );
}

function TopBar({
  connected,
  code,
  onLeave,
  watchUrl,
  mode = "host",
  demo = false,
}: {
  connected: boolean;
  code: string;
  onLeave?: () => void;
  watchUrl?: string;
  mode?: "host" | "spectator";
  demo?: boolean;
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
          {demo && <span className="demo-label">MOCK</span>}
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
  const isRelay = room.mode === "relay" && room.relaySettings !== null;
  const expectedParticipants = room.relaySettings?.teamCount;
  const readyCount = room.players.filter(
    (player) => player.connected && player.ready,
  ).length;
  const allReady =
    room.players.length > 0 &&
    (expectedParticipants === undefined ||
      room.players.length === expectedParticipants) &&
    room.players.every((player) => player.connected && player.ready);
  const joinUrl = new URL("/join", PUBLIC_URL);
  joinUrl.searchParams.set("room", room.code);
  const joinUri = joinUrl.toString();

  return (
    <section className="lobby page-enter">
      <div className="join-panel">
        <div>
          <p className="eyebrow">
            {room.demo
              ? "가상 팀의 준비가 완료되었습니다"
              : isRelay
                ? "각 팀의 대표 휴대폰에서 방 코드를 입력하세요"
                : "휴대폰에서 방 코드를 입력하세요"}
          </p>
          <p
            className="room-code"
            aria-label={`방 코드 ${room.code.split("").join(" ")}`}
          >
            {room.code}
          </p>
          <p className="join-help">
            {room.demo
              ? "경기 시작을 누르면 서버가 팀마다 서로 다른 가상 심박을 발생시킵니다."
              : `심장 달리기 앱을 열고 ${isRelay ? "팀 이름" : "닉네임"}과 코드를 입력하세요.`}
          </p>
        </div>
        {room.demo ? (
          <div className="demo-room-mark" aria-label="모의 경기">
            MOCK
          </div>
        ) : (
          <div className="qr-frame" aria-label="앱 입장 QR 코드">
            <QRCodeSVG
              value={joinUri}
              size={150}
              level="M"
              bgColor="#ffffff"
              fgColor="#050505"
            />
          </div>
        )}
      </div>

      <div className="players-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{isRelay ? "참가 팀" : "참가자"}</p>
            <h2>
              {room.players.length > 0
                ? `${readyCount} / ${expectedParticipants ?? room.players.length} 준비 완료`
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
                {player.relay && (
                  <div className="runner-lineup" aria-label="주자 순서">
                    {player.relay.runners.slice(0, 6).map((runner) => (
                      <span key={runner.index}>
                        <i style={{ background: runner.color }} />
                        {runner.name}
                      </span>
                    ))}
                    {player.relay.runners.length > 6 && (
                      <span className="runner-lineup-more">
                        +{player.relay.runners.length - 6}명
                      </span>
                    )}
                  </div>
                )}
              </div>
              {!readOnly && !room.demo && (
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
            <strong>
              {isRelay
                ? `한 팀 ${room.relaySettings?.runnersPerTeam}명 · 주자당 ${room.relaySettings?.legBeats}박동 · 바톤 전환 5초`
                : "한 번의 박동 = 한 걸음"}
            </strong>
            <br />
            {isRelay
              ? room.trackMode === "circular"
                ? "주자마다 원형 트랙을 한 바퀴 달린 뒤 다음 주자에게 바톤을 넘깁니다."
                : "주자마다 직선 트랙 전체를 달린 뒤 다음 주자가 출발합니다."
              : `먼저 ${room.finishBeats}번 뛰는 심장이 우승합니다.`}
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
  const isStadiumRace =
    room.trackMode === "circular" &&
    room.mode === "relay" &&
    room.players.every((player) => player.relay !== null);
  return (
    <section className={`race page-enter ${isStadiumRace ? "is-stadium" : ""}`}>
      <div className="race-heading">
        <div>
          <p className="eyebrow">
            <span className="recording-dot" />{" "}
            {room.demo ? "모의 경기 중" : "경기 중"}
          </p>
          <h1>
            {room.demo
              ? "가상 심장이 달리고 있습니다"
              : "심장이 달리고 있습니다"}
          </h1>
        </div>
        <div className="race-actions">
          <div className="leader-copy">
            <span>현재 선두</span>
            <strong>{leader?.nickname ?? "—"}</strong>
          </div>
          {!readOnly && <EndRaceButton busy={busy} onEnd={onEnd} />}
        </div>
      </div>

      {isStadiumRace ? (
        <StadiumRace room={room} beatEffects={beatEffects} />
      ) : (
        <div className="track-list">
          {room.players.map((player, index) => {
            const beat = beatEffects[player.id];
            const effectKey = beat?.beatId ?? "initial";
            const relay = player.relay;
            const activeRunner = relay?.runners[relay.activeRunnerIndex];
            const nextRunner = relay?.runners[relay.activeRunnerIndex + 1];
            const progressRatio =
              relay?.legDistanceRatio ?? player.distanceRatio;
            const displayedBeatCount = relay?.legBeatCount ?? player.beatCount;
            const runnerKey = relay?.activeRunnerIndex ?? "individual";
            return (
              <article
                className={`track ${relay ? "is-relay" : ""} ${relay?.status === "handoff" ? "is-handoff" : ""}`}
                key={player.id}
              >
                <div className="track-meta">
                  <span className="lane-number">{index + 1}</span>
                  <div>
                    <h2>{player.nickname}</h2>
                    <p>
                      {relay?.status === "handoff" ? (
                        <>
                          <strong>바톤 전달 중</strong>
                          {nextRunner ? ` · 다음 ${nextRunner.name}` : ""}
                        </>
                      ) : (
                        <>
                          {activeRunner && `${activeRunner.name} · `}
                          <strong>{player.bpm ?? "—"}</strong> BPM
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <div className="track-rail">
                  <div className="track-marks" aria-hidden="true" />
                  <div
                    className="track-progress"
                    key={`${runnerKey}:progress`}
                    style={{
                      width: `${progressRatio * 100}%`,
                      ...(activeRunner
                        ? { backgroundColor: activeRunner.color }
                        : {}),
                    }}
                  />
                  <div
                    className={`racer ${beat?.accent ? "is-accent" : ""}`}
                    style={{
                      left: `${progressRatio * 100}%`,
                      ...(activeRunner
                        ? ({
                            "--runner-color": activeRunner.color,
                          } as React.CSSProperties)
                        : {}),
                    }}
                    key={`${runnerKey}:${effectKey}`}
                  >
                    <span className="racer-pulse" />
                    <HeartSolid />
                  </div>
                  {relay?.status === "handoff" && nextRunner && (
                    <div
                      className="racer next-racer"
                      style={
                        {
                          left: 0,
                          "--runner-color": nextRunner.color,
                        } as React.CSSProperties
                      }
                      aria-label={`${nextRunner.name} 출발 준비`}
                    >
                      <HeartSolid />
                    </div>
                  )}
                  <span className="finish-line">결승</span>
                </div>
                <div className="beat-score">
                  <strong>{displayedBeatCount}</strong>
                  <span>/ {room.finishBeats}</span>
                  {relay && (
                    <small>
                      {relay.completedRunners}/{relay.runners.length} 주자
                      <i>
                        <b
                          style={{ width: `${relay.teamDistanceRatio * 100}%` }}
                        />
                      </i>
                    </small>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="race-instruction">
        휴대폰 화면의 심박수를 보며, 자신의 심장을 움직여 보세요.
      </p>
    </section>
  );
}

function StadiumRace({
  room,
  beatEffects,
}: {
  room: RoomSnapshot;
  beatEffects: Record<string, AcceptedBeat>;
}) {
  const teamColorById = new Map(
    [...room.players]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map((player, index) => [
        player.id,
        STADIUM_TEAM_COLORS[index % STADIUM_TEAM_COLORS.length],
      ]),
  );
  const entries = room.players.flatMap((player, rankingIndex) => {
    if (!player.relay) return [];
    return [
      {
        player,
        relay: player.relay,
        rankingIndex,
        teamColor: teamColorById.get(player.id) ?? STADIUM_TEAM_COLORS[0],
        progress: stadiumRelayProgress(player.relay),
      },
    ];
  });

  return (
    <div className="stadium-race">
      <div
        className="stadium-canvas"
        role="img"
        aria-label="모든 팀이 같은 거리의 중앙 주로를 한 바퀴씩 달리는 운동장 트랙"
      >
        <svg viewBox="0 0 1000 520" aria-hidden="true">
          <defs>
            <pattern
              id={`finish-check-${room.code}`}
              width="14"
              height="14"
              patternUnits="userSpaceOnUse"
            >
              <rect width="14" height="14" fill="#fff" />
              <rect width="7" height="7" fill="#111" />
              <rect x="7" y="7" width="7" height="7" fill="#111" />
            </pattern>
          </defs>
          <path className="stadium-outer" d={stadiumPath(235, 765, 215)} />
          {[195, 175, 155, 135].map((radius) => (
            <path
              className="stadium-lane-line"
              d={stadiumPath(235, 765, radius)}
              key={radius}
            />
          ))}
          <path className="stadium-infield" d={stadiumPath(235, 765, 115)} />
          <path className="stadium-guide" d={STADIUM_CENTER_PATH} />
          <rect
            className="stadium-finish-check"
            x="875"
            y="249"
            width="105"
            height="22"
            fill={`url(#finish-check-${room.code})`}
          />
          <path className="stadium-finish-post" d="M875 249V172H982" />
          <rect
            className="stadium-finish-label-bg"
            x="872"
            y="133"
            width="112"
            height="42"
            rx="4"
          />
          <text className="stadium-finish-label" x="928" y="162">
            FINISH
          </text>
        </svg>

        {entries.map(({ player, relay, rankingIndex, teamColor, progress }) => {
          const collisionSlot = stadiumCollisionSlot(
            entries,
            player.id,
            progress,
          );
          const position = stadiumPoint(
            progress,
            collisionSlot.normalOffset,
            collisionSlot.tangentOffset,
          );
          const activeRunner = relay.runners[relay.activeRunnerIndex];
          const beat = beatEffects[player.id];
          return (
            <div
              className={`stadium-racer ${beat?.accent ? "is-accent" : ""} ${relay.status === "handoff" ? "is-handoff" : ""} ${collisionSlot.collisionCount >= 5 ? "is-packed" : ""}`}
              style={
                {
                  left: position.left,
                  top: position.top,
                  zIndex: 100 - rankingIndex,
                  "--team-color": teamColor,
                  "--runner-color": activeRunner?.color,
                } as React.CSSProperties
              }
              key={player.id}
              aria-label={`${player.nickname} ${activeRunner?.name ?? "주자"}`}
            >
              <span className="racer-pulse" key={beat?.beatId ?? "initial"} />
              <HeartSolid />
              <strong>{player.nickname.slice(-2)}</strong>
            </div>
          );
        })}

        {entries.map(({ player, relay, progress, rankingIndex, teamColor }) => {
          const nextRunner = relay.runners[relay.activeRunnerIndex + 1];
          if (relay.status !== "handoff" || !nextRunner) return null;
          const collisionSlot = stadiumCollisionSlot(
            entries,
            player.id,
            progress,
          );
          const position = stadiumPoint(
            progress,
            collisionSlot.normalOffset,
            collisionSlot.tangentOffset - 24,
          );
          return (
            <div
              className="stadium-racer stadium-next-racer"
              style={
                {
                  left: position.left,
                  top: position.top,
                  zIndex: 110 - rankingIndex,
                  "--team-color": teamColor,
                  "--runner-color": nextRunner.color,
                } as React.CSSProperties
              }
              key={`${player.id}:next`}
              aria-label={`${player.nickname} ${nextRunner.name} 출발 준비`}
            >
              <HeartSolid />
            </div>
          );
        })}

        <div className="stadium-infield-copy" aria-hidden="true">
          <span>SHARED TRACK</span>
          <strong>모든 팀이 같은 거리를 달립니다</strong>
        </div>
      </div>

      <div className="stadium-scoreboard">
        {entries.map(({ player, relay, teamColor }, index) => {
          const activeRunner = relay.runners[relay.activeRunnerIndex];
          const nextRunner = relay.runners[relay.activeRunnerIndex + 1];
          return (
            <article
              className="stadium-team-card"
              style={
                {
                  "--team-color": teamColor,
                } as React.CSSProperties
              }
              key={player.id}
            >
              <div>
                <span className="stadium-team-rank">{index + 1}</span>
                <h2>{player.nickname}</h2>
              </div>
              <p>
                {relay.status === "handoff" ? (
                  <>바톤 전달 중 · 다음 {nextRunner?.name ?? "주자"}</>
                ) : (
                  <>
                    {activeRunner?.name} · <strong>{player.bpm ?? "—"}</strong>{" "}
                    BPM
                  </>
                )}
              </p>
              <footer>
                <span>
                  {relay.legBeatCount}/{room.finishBeats} 박동
                </span>
                <span>
                  {relay.completedRunners}/{relay.runners.length} 주자
                </span>
                <i>
                  <b style={{ width: `${relay.teamDistanceRatio * 100}%` }} />
                </i>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

const STADIUM_CENTER_PATH = stadiumPath(235, 765, 165);
const STADIUM_TEAM_COLORS = [
  "#d93e68",
  "#216fd1",
  "#ef7f24",
  "#219b69",
  "#7656d6",
  "#087f8c",
];
const STADIUM_PACK_SLOTS = [
  { tangentOffset: 30, normalOffset: 0 },
  { tangentOffset: 10, normalOffset: -22 },
  { tangentOffset: 10, normalOffset: 22 },
  { tangentOffset: -10, normalOffset: -22 },
  { tangentOffset: -10, normalOffset: 22 },
  { tangentOffset: -30, normalOffset: 0 },
];

function stadiumPath(leftCenter: number, rightCenter: number, radius: number) {
  const top = 260 - radius;
  const bottom = 260 + radius;
  return `M ${leftCenter} ${top} H ${rightCenter} A ${radius} ${radius} 0 0 1 ${rightCenter} ${bottom} H ${leftCenter} A ${radius} ${radius} 0 0 1 ${leftCenter} ${top} Z`;
}

function stadiumRelayProgress(
  relay: NonNullable<PlayerSnapshot["relay"]>,
): number {
  return relay.legDistanceRatio;
}

function stadiumPoint(
  progress: number,
  normalOffset: number,
  tangentOffset = 0,
) {
  const leftCenter = 235;
  const rightCenter = 765;
  const centerY = 260;
  const radius = 165;
  const straightLength = rightCenter - leftCenter;
  const quarterArc = (Math.PI * radius) / 2;
  const halfArc = Math.PI * radius;
  const totalLength = straightLength * 2 + halfArc * 2;
  const normalized = ((progress % 1) + 1) % 1;

  const basePoint = (value: number) => {
    let distance = (((value % 1) + 1) % 1) * totalLength;
    if (distance <= quarterArc) {
      const angle = distance / radius;
      return {
        x: rightCenter + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      };
    }
    distance -= quarterArc;
    if (distance <= straightLength) {
      return { x: rightCenter - distance, y: centerY + radius };
    }
    distance -= straightLength;
    if (distance <= halfArc) {
      const angle = Math.PI / 2 + distance / radius;
      return {
        x: leftCenter + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      };
    }
    distance -= halfArc;
    if (distance <= straightLength) {
      return { x: leftCenter + distance, y: centerY - radius };
    }
    distance -= straightLength;
    const angle = (Math.PI * 3) / 2 + distance / radius;
    return {
      x: rightCenter + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    };
  };

  const point = basePoint(normalized);
  const ahead = basePoint(normalized + 0.0005);
  const tangentX = ahead.x - point.x;
  const tangentY = ahead.y - point.y;
  const tangentLength = Math.hypot(tangentX, tangentY) || 1;
  const x =
    point.x +
    (-tangentY / tangentLength) * normalOffset +
    (tangentX / tangentLength) * tangentOffset;
  const y =
    point.y +
    (tangentX / tangentLength) * normalOffset +
    (tangentY / tangentLength) * tangentOffset;
  return {
    left: `${(x / 1000) * 100}%`,
    top: `${(y / 520) * 100}%`,
  };
}

function stadiumCollisionSlot<
  T extends { player: { id: string }; progress: number },
>(entries: T[], playerId: string, progress: number) {
  const closeEntries = entries.filter(
    (candidate) =>
      circularProgressDistance(candidate.progress, progress) < 0.04,
  );
  if (closeEntries.length <= 1) {
    return { tangentOffset: 0, normalOffset: 0, collisionCount: 1 };
  }

  const collisionIndex = closeEntries.findIndex(
    (candidate) => candidate.player.id === playerId,
  );
  const activeSlots = STADIUM_PACK_SLOTS.slice(0, closeEntries.length);
  const center = activeSlots.reduce(
    (sum, slot) => ({
      tangentOffset: sum.tangentOffset + slot.tangentOffset,
      normalOffset: sum.normalOffset + slot.normalOffset,
    }),
    { tangentOffset: 0, normalOffset: 0 },
  );
  const slot = activeSlots[Math.max(0, collisionIndex)]!;
  return {
    tangentOffset:
      slot.tangentOffset - center.tangentOffset / activeSlots.length,
    normalOffset: slot.normalOffset - center.normalOffset / activeSlots.length,
    collisionCount: closeEntries.length,
  };
}

function circularProgressDistance(first: number, second: number): number {
  const distance = Math.abs(first - second);
  return Math.min(distance, 1 - distance);
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
          {room.mode === "relay"
            ? "팀이 바톤을 먼저 연결했습니다."
            : "심장이 먼저 도착했습니다."}
        </h1>
        <p>
          {winner?.beatCount ?? room.finishBeats}번의 박동
          {room.mode === "relay" && winner?.relay
            ? ` · ${winner.relay.runners.length}명의 주자`
            : ""}
          으로 완주
        </p>
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

function loadSession(storageKey: string): HostSession | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value ? (JSON.parse(value) as HostSession) : null;
  } catch {
    return null;
  }
}

function clearSession(storageKey: string) {
  localStorage.removeItem(storageKey);
}

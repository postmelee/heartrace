import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { io, type Socket } from "socket.io-client";
import {
  DEFAULT_HANDOFF_DURATION_MS,
  MAX_HANDOFF_DURATION_MS,
  MAX_TEAM_COUNT,
  MIN_HANDOFF_DURATION_MS,
  RELAY_TEAM_COLORS,
} from "@heartrace/protocol";
import type {
  AcceptedBeat,
  ClientToServerEvents,
  HostCreateRoomRequest,
  PlayerRelaySnapshot,
  PlayerSnapshot,
  RoomSnapshot,
  ServerToClientEvents,
} from "@heartrace/protocol";
import PlayChallenge from "./PlayChallenge";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "http://localhost:3001";
const PUBLIC_URL = import.meta.env.VITE_PUBLIC_URL ?? window.location.origin;
const IOS_INSTALL_URL = import.meta.env.VITE_IOS_INSTALL_URL ?? "";
const ANDROID_INSTALL_URL = import.meta.env.VITE_ANDROID_INSTALL_URL ?? "";
const STORAGE_KEY = "heartrace:host-session";
const DEMO_STORAGE_KEY = "heartrace:demo-host-session";
const IMMERSIVE_KEY = "heartrace:immersive";
const RESULT_REVEAL_DELAY_MS = 3_000;

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
  if (path === "/notices") return <NoticesPage />;
  if (path === "/support") return <SupportPage />;
  if (path === "/play") return <PlayChallenge />;
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
  // 로비에서 경기장에 먼저 들어가 트랙을 보여 주는 단계입니다. 서버 phase는 아직 lobby입니다.
  const [staged, setStaged] = useState(false);
  const [immersive, setImmersive] = useImmersive();
  const [busy, setBusy] = useState(false);
  const [beatEffects, setBeatEffects] = useState<Record<string, AcceptedBeat>>(
    {},
  );
  const finishInterlude = useFinishInterlude(room);

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

  useEffect(() => {
    if (room && room.phase !== "lobby") setStaged(false);
  }, [room?.phase]);

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

  const endRace = useCallback(() => {
    if (!session || !socketRef.current) return;
    setBusy(true);
    setError(null);
    socketRef.current.emit("host:end", session, (result) => {
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
    <main className={`app-shell ${immersive ? "is-immersive" : ""}`}>
      <TopBar
        connected={connected}
        code={room.code}
        onLeave={leaveRoom}
        watchUrl={watchUrl.toString()}
        demo={room.demo}
        demoHumanSlot={room.demoHumanSlot}
        immersive={immersive}
        onToggleImmersive={() => setImmersive((current) => !current)}
        canLeave={
          room.phase === "lobby" ||
          (room.phase === "finished" && !finishInterlude)
        }
      />
      {room.phase !== "lobby" && error && (
        <ErrorToast message={error} onDismiss={() => setError(null)} />
      )}
      {room.phase === "lobby" && !staged && (
        <Lobby
          room={room}
          busy={busy}
          error={error}
          onStart={() => setStaged(true)}
          onRemovePlayer={removePlayer}
        />
      )}
      {((room.phase === "lobby" && staged) ||
        room.phase === "countdown" ||
        room.phase === "racing" ||
        finishInterlude) && (
        <Race
          room={room}
          beatEffects={beatEffects}
          busy={busy}
          staged={room.phase === "lobby"}
          countingDown={room.phase === "countdown"}
          onStart={startRace}
          onLeaveStage={() => setStaged(false)}
          onEnd={room.phase === "countdown" ? resetRace : endRace}
          onHome={leaveRoom}
          finishing={finishInterlude}
        />
      )}
      {room.phase === "finished" && !finishInterlude && (
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
  const [immersive, setImmersive] = useImmersive();
  const [beatEffects, setBeatEffects] = useState<Record<string, AcceptedBeat>>(
    {},
  );
  const finishInterlude = useFinishInterlude(room);

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
    <main
      className={`app-shell spectator-shell ${immersive ? "is-immersive" : ""}`}
    >
      <TopBar
        connected={connected}
        code={room.code}
        mode="spectator"
        demo={room.demo}
        demoHumanSlot={room.demoHumanSlot}
        immersive={immersive}
        onToggleImmersive={() => setImmersive((current) => !current)}
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
      {(room.phase === "countdown" ||
        room.phase === "racing" ||
        finishInterlude) && (
        <Race
          room={room}
          beatEffects={beatEffects}
          busy={false}
          countingDown={room.phase === "countdown"}
          finishing={finishInterlude}
          onEnd={() => undefined}
          readOnly
        />
      )}
      {room.phase === "finished" && !finishInterlude && (
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
      <BrandHomeLink className="public-wordmark" />
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
      <BrandHomeLink className="public-wordmark" />
      <div className="public-page-copy">
        <p className="eyebrow">한 박동, 한 걸음</p>
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
        {ANDROID_INSTALL_URL ? (
          <a className="secondary-button" download href={ANDROID_INSTALL_URL}>
            Android APK 받기
          </a>
        ) : (
          <span className="secondary-button is-disabled">
            Android 앱 준비 중
          </span>
        )}
        <a className="secondary-button public-open-app" href={appUrl}>
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
        <a href="/notices">오픈소스 고지</a>
        <a href="/support">도움말</a>
      </footer>
    </main>
  );
}

function PrivacyPage() {
  return (
    <PublicDocument title="개인정보 처리방침">
      <p>
        심장달리기는 참여형 전시의 실시간 경주 진행을 위해 방 코드, 참가자가
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

function NoticesPage() {
  return (
    <PublicDocument title="오픈소스 고지">
      <h2>Pretendard</h2>
      <p>
        웹과 모바일 인터페이스는 Kil Hyung-jin이 제작한 Pretendard 글꼴을
        사용합니다. Pretendard는 SIL Open Font License 1.1에 따라 배포됩니다.
      </p>
      <p>
        <a href="/third-party-notices.txt">저작권 고지와 라이선스 전문 보기</a>
      </p>
      <h2>런타임 라이브러리</h2>
      <p>
        React, React Native, Expo, Express, Socket.IO, Vite와 기타 오픈소스
        라이브러리를 각 프로젝트의 라이선스에 따라 사용합니다.
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
      <BrandHomeLink className="public-wordmark" />
      <article>
        <p className="eyebrow">심장달리기</p>
        <h1>{title}</h1>
        {children}
      </article>
      <footer className="public-footer">
        <a href="/join">참가 안내</a>
        <a href="/notices">오픈소스 고지</a>
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
  const [demoHumanSlot, setDemoHumanSlot] = useState(true);
  const [teamCount, setTeamCount] = useState(demo ? 4 : 2);
  const [runnersPerTeam, setRunnersPerTeam] = useState(demo ? 2 : 3);
  const [legBeats, setLegBeats] = useState<10 | 20 | 30 | 60>(demo ? 10 : 20);
  const [handoffSecondsInput, setHandoffSecondsInput] = useState(
    String(demo ? 3 : DEFAULT_HANDOFF_DURATION_MS / 1_000),
  );
  const [trackMode, setTrackMode] = useState<"straight" | "circular">(
    demo ? "circular" : "straight",
  );
  const handoffSeconds = Number(handoffSecondsInput);
  const handoffSecondsValid =
    Number.isInteger(handoffSeconds) &&
    handoffSeconds >= MIN_HANDOFF_DURATION_MS / 1_000 &&
    handoffSeconds <= MAX_HANDOFF_DURATION_MS / 1_000;
  const isHybridDemo = demo && demoHumanSlot;
  const createRequest: HostCreateRoomRequest =
    mode === "relay"
      ? {
          finishBeats: legBeats,
          mode,
          trackMode,
          ...(demo ? { demo: true, demoHumanSlot } : {}),
          relay: {
            teamCount,
            runnersPerTeam,
            legBeats,
            handoffDurationMs: handoffSeconds * 1_000,
          },
        }
      : { finishBeats: 60, mode };

  return (
    <main
      className={`home page-enter ${demo ? "is-demo" : ""} ${isHybridDemo ? "is-hybrid-demo" : ""}`}
    >
      <header className="home-header">
        <BrandHomeLink />
        <div className="home-kicker">
          {demo ? (
            <>
              <LiveDot live={connected} />
              {isHybridDemo ? "촬영용 LIVE + MOCK" : "자동 경기 데모"}
            </>
          ) : (
            <>실시간 심장 박동 레이스</>
          )}
        </div>
      </header>
      <div className="home-copy">
        <p className="display-category">
          {isHybridDemo ? "RECORDING MODE" : demo ? "AUTO RACE" : "LIVE GAME"}
        </p>
        <p className="session-line">
          <strong>심장달리기</strong>
          {demo && (isHybridDemo ? " · 직접 참여 + MOCK" : " · 가상 박동 모드")}
        </p>
        <h1>
          {isHybridDemo ? (
            <>
              나는 직접 뛰고,
              <br />
              나머지는 봇이 달립니다.
            </>
          ) : demo ? (
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
          {isHybridDemo ? (
            <>
              한 팀은 실제 휴대폰 심박으로 참여하고 나머지 팀은 서버가 채웁니다.
              <br className="desktop-only" /> 실제 경기 흐름을 그대로 진행하며
              화면을 녹화할 수 있습니다.
            </>
          ) : demo ? (
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
          {demo && (
            <div
              className="mode-picker demo-mode-picker"
              role="group"
              aria-label="데모 참가 구성"
            >
              <button
                type="button"
                className={demoHumanSlot ? "is-selected" : ""}
                aria-pressed={demoHumanSlot}
                onClick={() => setDemoHumanSlot(true)}
              >
                내가 참여 + MOCK
              </button>
              <button
                type="button"
                className={!demoHumanSlot ? "is-selected" : ""}
                aria-pressed={!demoHumanSlot}
                onClick={() => setDemoHumanSlot(false)}
              >
                전체 MOCK 자동
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
              <label className="time-input-picker">
                <span>바톤 대기</span>
                <span className="time-input-control">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN_HANDOFF_DURATION_MS / 1_000}
                    max={MAX_HANDOFF_DURATION_MS / 1_000}
                    step={1}
                    value={handoffSecondsInput}
                    aria-invalid={!handoffSecondsValid}
                    aria-describedby="handoff-duration-help"
                    onChange={(event) =>
                      setHandoffSecondsInput(event.currentTarget.value)
                    }
                  />
                  <strong>초</strong>
                </span>
                <small id="handoff-duration-help">
                  {MIN_HANDOFF_DURATION_MS / 1_000}–
                  {MAX_HANDOFF_DURATION_MS / 1_000}초
                </small>
              </label>
            </div>
          )}
        </div>
        <button
          className="primary-button hero-button"
          onClick={() => onCreate(createRequest)}
          disabled={busy || (mode === "relay" && !handoffSecondsValid)}
        >
          {busy
            ? "경기장 만드는 중…"
            : isHybridDemo
              ? "촬영용 경기 만들기"
              : demo
                ? "모의 경기 만들기"
                : "새 경기 만들기"}
          <ArrowIcon />
        </button>
        {!demo && (
          <>
            <a className="demo-entry is-primary" href="/play">
              브라우저로 바로 플레이
            </a>
            <a className="demo-entry" href="/demo">
              촬영 · 자동 경기 모드
            </a>
          </>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="edition">
        {isHybridDemo
          ? "실제 참가자 한 자리와 서버 생성 mock 팀으로 진행합니다."
          : demo
            ? "가상 박동은 의료 측정값이 아닙니다."
            : "박동 한 번이 한 걸음이 되는 실시간 경주"}
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

function useImmersive() {
  const [immersive, setImmersive] = useState(
    () => window.localStorage.getItem(IMMERSIVE_KEY) === "1",
  );

  useEffect(() => {
    window.localStorage.setItem(IMMERSIVE_KEY, immersive ? "1" : "0");
  }, [immersive]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "h" && event.key !== "H") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      setImmersive((current) => !current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return [immersive, setImmersive] as const;
}

function useFinishInterlude(room: RoomSnapshot | null): boolean {
  const completedFinishAt =
    room?.phase === "finished" && room.finishReason === "completed"
      ? room.finishedAt
      : null;
  const [revealedFinishAt, setRevealedFinishAt] = useState<number | null>(null);

  useEffect(() => {
    if (completedFinishAt === null || !room) {
      setRevealedFinishAt(null);
      return;
    }

    const elapsedOnServer = Math.max(0, room.serverNow - completedFinishAt);
    const remaining = Math.max(0, RESULT_REVEAL_DELAY_MS - elapsedOnServer);
    if (remaining === 0) {
      setRevealedFinishAt(completedFinishAt);
      return;
    }

    const timer = window.setTimeout(
      () => setRevealedFinishAt(completedFinishAt),
      remaining,
    );
    return () => window.clearTimeout(timer);
  }, [completedFinishAt, room?.serverNow]);

  return completedFinishAt !== null && revealedFinishAt !== completedFinishAt;
}

function TopBar({
  connected,
  code,
  onLeave,
  watchUrl,
  mode = "host",
  demo = false,
  demoHumanSlot = false,
  immersive = false,
  onToggleImmersive,
  canLeave = false,
}: {
  connected: boolean;
  code: string;
  onLeave?: () => void;
  watchUrl?: string;
  mode?: "host" | "spectator";
  demo?: boolean;
  demoHumanSlot?: boolean;
  immersive?: boolean;
  onToggleImmersive?: () => void;
  canLeave?: boolean;
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
    <>
      {immersive && onToggleImmersive && (
        <button
          className="immersive-handle"
          type="button"
          onClick={onToggleImmersive}
          title="헤더 고정 (H)"
        >
          <span aria-hidden="true">⌄</span>
          <span className="immersive-handle-label">메뉴</span>
        </button>
      )}
      <header className="top-bar">
        <BrandHomeLink className="wordmark" onNavigate={onLeave} />
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
            {demo && (
              <span className="demo-label">
                {demoHumanSlot ? "LIVE + MOCK" : "MOCK"}
              </span>
            )}
            <span>방 {code}</span>
          </div>
          {onLeave && canLeave && (
            <button className="new-room-button" type="button" onClick={onLeave}>
              새 방 만들기
            </button>
          )}
          {onToggleImmersive && (
            <button
              className={`immersive-toggle ${immersive ? "is-on" : ""}`}
              type="button"
              onClick={(event) => {
                // 포커스가 남아 있으면 :focus-within으로 헤더가 계속 열려 있습니다.
                event.currentTarget.blur();
                onToggleImmersive();
              }}
              aria-pressed={immersive}
              title="전시 모드 (H)"
            >
              <span>{immersive ? "헤더 고정" : "전시 모드"}</span>
            </button>
          )}
        </div>
      </header>
    </>
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
  const isHybridDemo = room.demo && room.demoHumanSlot;
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
            {isHybridDemo
              ? room.players.length > 0
                ? "실제 팀과 mock 팀이 함께 준비하고 있습니다"
                : "휴대폰으로 실제 참가자 한 자리를 채워 주세요"
              : room.demo
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
            {isHybridDemo
              ? "심장달리기 앱으로 입장하면 나머지 자리는 mock 팀이 자동으로 채웁니다."
              : room.demo
                ? "경기 시작을 누르면 서버가 팀마다 서로 다른 가상 심박을 발생시킵니다."
                : `심장달리기 앱을 열고 ${isRelay ? "팀 이름" : "닉네임"}과 코드를 입력하세요.`}
          </p>
        </div>
        {room.demo && !room.demoHumanSlot ? (
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
              <p>
                {isHybridDemo
                  ? "실제 참가자의 입장을 기다리고 있어요"
                  : "첫 번째 심장을 기다리고 있어요"}
              </p>
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
                ? `한 팀 ${room.relaySettings?.runnersPerTeam}명 · 주자당 ${room.relaySettings?.legBeats}박동 · 바톤 전환 ${(room.relaySettings?.handoffDurationMs ?? DEFAULT_HANDOFF_DURATION_MS) / 1_000}초`
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
                  ? "입장하는 중…"
                  : "경기장 입장"
                : isHybridDemo
                  ? room.players.length === 0
                    ? "실제 참가자 입장을 기다리는 중"
                    : "실제 심박 측정을 기다리는 중"
                  : "모두의 측정을 기다리는 중"}
              {allReady && <ArrowIcon />}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// 트랙을 미리 보여준 채로 숫자만 위에 겹칩니다.
function CountdownOverlay({ room }: { room: RoomSnapshot }) {
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
    <div className="countdown-overlay" aria-live="assertive">
      <p>
        {room.demo && !room.demoHumanSlot
          ? "가상 박동을 준비하고 있습니다"
          : "손가락을 그대로 유지하세요"}
      </p>
      <div className="countdown-number-slot">
        <div
          className={`countdown-number ${display === "준비" ? "is-ready" : ""}`}
          key={display}
        >
          {display}
        </div>
      </div>
      <span>
        {display === "준비" ? "곧 경기가 시작됩니다" : "심장으로 달릴 시간"}
      </span>
    </div>
  );
}

function RaceFinishedOverlay() {
  return (
    <div
      className="stage-overlay race-finish-overlay"
      role="status"
      aria-live="assertive"
    >
      <div className="race-finish-message">
        <span>FINISH</span>
        <strong>경기 종료</strong>
        <i aria-hidden="true" />
      </div>
    </div>
  );
}

function Race({
  room,
  beatEffects,
  busy,
  onEnd,
  onStart,
  onLeaveStage,
  onHome,
  staged = false,
  countingDown = false,
  finishing = false,
  readOnly = false,
}: {
  room: RoomSnapshot;
  beatEffects: Record<string, AcceptedBeat>;
  busy: boolean;
  onEnd: () => void;
  onStart?: () => void;
  onLeaveStage?: () => void;
  onHome?: () => void;
  staged?: boolean;
  countingDown?: boolean;
  finishing?: boolean;
  readOnly?: boolean;
}) {
  const leader = useMemo(() => room.players[0], [room.players]);
  const isStadiumRace =
    room.trackMode === "circular" &&
    room.mode === "relay" &&
    room.players.every((player) => player.relay !== null);
  const overlay = finishing ? (
    <RaceFinishedOverlay />
  ) : staged ? (
    <div className="stage-overlay">
      {!readOnly && (
        <button
          className="primary-button stage-start"
          type="button"
          onClick={onStart}
          disabled={busy}
        >
          {busy ? "출발 준비 중…" : "경기 시작"}
          {!busy && <ArrowIcon />}
        </button>
      )}
      <p className="stage-hint">
        {room.demoHumanSlot
          ? "실제 참가자의 손가락 측정을 확인하세요"
          : room.demo
            ? "mock 팀의 출발 준비가 완료되었습니다"
            : "모든 팀이 손가락을 올렸는지 확인하세요"}
      </p>
    </div>
  ) : countingDown ? (
    <CountdownOverlay room={room} />
  ) : null;
  return (
    <section
      className={`race page-enter ${isStadiumRace ? "is-stadium" : ""} ${
        countingDown || staged ? "is-counting" : ""
      } ${finishing ? "is-finishing" : ""}`}
    >
      <div className="race-heading">
        <div className="race-heading-copy">
          <div className="race-brand-status">
            <BrandHomeLink className="race-wordmark" onNavigate={onHome} />
            <span className="race-status-divider" aria-hidden="true" />
            <p className="eyebrow">
              <span className="recording-dot" />
              {staged
                ? "출발 대기"
                : countingDown
                  ? "출발 준비"
                  : finishing
                    ? "경기 종료"
                    : room.demoHumanSlot
                      ? "LIVE + MOCK 경기 중"
                      : room.demo
                        ? "모의 경기 중"
                        : "경기 중"}
            </p>
          </div>
          {!isStadiumRace && (
            <h1>
              {room.demoHumanSlot
                ? "나의 심장과 봇이 함께 달립니다"
                : room.demo
                  ? "가상 심장이 달리고 있습니다"
                  : "심장이 달리고 있습니다"}
            </h1>
          )}
        </div>
        <div className="race-actions">
          {!countingDown && !staged && !finishing && (
            <div className="leader-copy">
              <span>현재 선두</span>
              <strong>{leader?.nickname ?? "—"}</strong>
            </div>
          )}
          {!readOnly &&
            !finishing &&
            (staged ? (
              <button
                className="end-race-button"
                type="button"
                onClick={onLeaveStage}
                disabled={busy}
              >
                대기 화면으로
              </button>
            ) : countingDown ? (
              <EndRaceButton
                busy={busy}
                onEnd={onEnd}
                label="출발 취소"
                busyLabel="취소하는 중…"
                confirmation="출발을 취소하고 준비 화면으로 돌아갈까요?"
              />
            ) : (
              <EndRaceButton busy={busy} onEnd={onEnd} />
            ))}
        </div>
      </div>

      {isStadiumRace ? (
        <StadiumRace room={room} beatEffects={beatEffects} overlay={overlay} />
      ) : (
        <div className="track-list">
          {overlay}
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
            const finishPlace = player.finishPlace;
            const isFinished = finishPlace !== null;
            return (
              <article
                className={`track ${relay ? "is-relay" : ""} ${relay?.status === "handoff" ? "is-handoff" : ""} ${isFinished ? "is-finished" : ""}`}
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
                    className={`racer ${beat?.accent ? "is-accent" : ""} ${isFinished ? "is-finished" : ""}`}
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
                    <span className="racer-beat">
                      <HeartSolid />
                      {relay && <strong>{relay.activeRunnerIndex + 1}</strong>}
                      {isFinished && (
                        <i className="racer-finish-check" aria-hidden="true">
                          ✓
                        </i>
                      )}
                    </span>
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
                      <span className="racer-beat">
                        <HeartSolid />
                        <strong>{relay.activeRunnerIndex + 2}</strong>
                      </span>
                    </div>
                  )}
                  <span className="finish-line">결승</span>
                </div>
                <div className="beat-score">
                  {isFinished ? (
                    <>
                      <strong className="track-finish-place">
                        {formatPlace(finishPlace)}
                      </strong>
                      <span>완주</span>
                    </>
                  ) : (
                    <>
                      <strong>{displayedBeatCount}</strong>
                      <span>/ {room.finishBeats}</span>
                      {relay && (
                        <small>
                          {relay.completedRunners}/{relay.runners.length} 주자
                          <i>
                            <b
                              style={{
                                width: `${relay.teamDistanceRatio * 100}%`,
                              }}
                            />
                          </i>
                        </small>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="race-instruction">
        경쟁과 승패보다, 함께 움직이는 시간입니다. 휴대폰 화면의 심박수를 보며
        자신의 심장을 움직여 보세요.
      </p>
    </section>
  );
}

function StadiumRace({
  room,
  beatEffects,
  overlay = null,
}: {
  room: RoomSnapshot;
  beatEffects: Record<string, AcceptedBeat>;
  overlay?: React.ReactNode;
}) {
  // room.players는 순위 순서라 매 박동마다 뒤바뀝니다. 레인은 입장 순서로 고정합니다.
  const lanes = room.players
    .flatMap((player) =>
      player.relay ? [{ player, relay: player.relay }] : [],
    )
    .sort((first, second) => first.player.laneIndex - second.player.laneIndex)
    .map((entry, lane) => ({
      ...entry,
      lane,
      teamColor:
        RELAY_TEAM_COLORS[entry.player.laneIndex % RELAY_TEAM_COLORS.length] ??
        STADIUM_FALLBACK_COLOR,
    }));
  // room.players가 순위 순서이므로 그대로 등수로 씁니다.
  const rankByPlayerId = new Map(
    room.players.map((player, rank) => [player.id, rank]),
  );
  const track = stadiumTrack(lanes.length);
  const markerSize = track.laneWidth * 0.92;
  const handoffGap = markerSize * 0.66;
  const laneLabelSize = Math.min(track.laneWidth * 0.46, 30);
  const finishPatternId = `finish-check-${room.code}`;
  const infieldCenterX = (STADIUM_LEFT_CENTER + STADIUM_RIGHT_CENTER) / 2;

  return (
    <div className="stadium-race">
      <ol
        className="rank-board"
        style={{ height: `calc(var(--rank-row) * ${lanes.length})` }}
      >
        {lanes.map(({ player, lane, teamColor }) => {
          const rank = rankByPlayerId.get(player.id) ?? lane;
          return (
            <li
              key={player.id}
              style={
                {
                  "--team-color": teamColor,
                  transform: `translateY(calc(var(--rank-row) * ${rank}))`,
                } as React.CSSProperties
              }
            >
              <span className="rank-board-place">{rank + 1}</span>
              <div className="rank-board-copy">
                <strong>{player.nickname}</strong>
                <span className="rank-board-lap">
                  {formatRelayLap(player.relay!)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="stadium-field">
        <svg
          viewBox={`0 0 ${STADIUM_VIEW_WIDTH} ${STADIUM_VIEW_HEIGHT}`}
          role="img"
          aria-label={`팀마다 고정된 레인을 한 바퀴씩 달리는 운동장 트랙. ${lanes
            .map(
              (entry) =>
                `${entry.lane + 1}레인 ${entry.player.nickname} ${
                  entry.player.finishPlace !== null
                    ? `${formatPlace(entry.player.finishPlace)} 완주`
                    : `${Math.round(entry.relay.legDistanceRatio * 100)}퍼센트`
                }`,
            )
            .join(", ")}`}
        >
          <defs>
            <pattern
              id={finishPatternId}
              width="14"
              height="14"
              patternUnits="userSpaceOnUse"
            >
              <rect width="14" height="14" fill="#fdfbf6" />
              <rect width="7" height="7" fill="#2a2119" />
              <rect x="7" y="7" width="7" height="7" fill="#2a2119" />
            </pattern>
          </defs>

          <path
            className="stadium-outer"
            d={stadiumLanePath(STADIUM_OUTER_RADIUS)}
          />

          {lanes.map(({ player, relay, lane, teamColor }) => {
            const lapLength = stadiumLapLength(stadiumLaneRadius(track, lane));
            return (
              <path
                className="stadium-lane-trail"
                d={stadiumLanePath(stadiumLaneRadius(track, lane))}
                style={{
                  stroke: teamColor,
                  strokeWidth: track.laneWidth,
                  strokeDasharray: `${lapLength} ${lapLength}`,
                  strokeDashoffset: lapLength * (1 - relay.legDistanceRatio),
                }}
                key={`${player.id}:trail`}
              />
            );
          })}

          {Array.from({ length: track.laneCount + 1 }, (_, index) => (
            <path
              className="stadium-lane-line"
              d={stadiumLanePath(track.infieldRadius + track.laneWidth * index)}
              key={`lane-line-${index}`}
            />
          ))}

          <path
            className="stadium-infield"
            d={stadiumLanePath(track.infieldRadius)}
          />

          {lanes.map(({ player, lane }) => (
            <text
              className="stadium-lane-label"
              x={STADIUM_LEFT_CENTER + 30}
              y={STADIUM_CENTER_Y + stadiumLaneRadius(track, lane)}
              style={{ fontSize: laneLabelSize }}
              key={`${player.id}:lane-label`}
            >
              <tspan className="stadium-lane-label-number">{lane + 1}</tspan>
              <tspan dx={laneLabelSize * 0.6}>{player.nickname}</tspan>
            </text>
          ))}

          <rect
            className="stadium-finish-check"
            x={STADIUM_RIGHT_CENTER + track.infieldRadius}
            y={STADIUM_CENTER_Y - 13}
            width={STADIUM_OUTER_RADIUS - track.infieldRadius}
            height={26}
            fill={`url(#${finishPatternId})`}
          />
          <text
            className="stadium-finish-label"
            x={STADIUM_RIGHT_CENTER + track.infieldRadius - 18}
            y={STADIUM_CENTER_Y}
          >
            FINISH
          </text>

          <text
            className="stadium-infield-note"
            x={infieldCenterX}
            y={STADIUM_CENTER_Y}
          >
            한 바퀴 = {room.finishBeats} 박동
          </text>

          {lanes.map(({ player, relay, lane, teamColor }) => {
            const radius = stadiumLaneRadius(track, lane);
            const nextRunner = relay.runners[relay.activeRunnerIndex + 1];
            const isHandoff = relay.status === "handoff" && Boolean(nextRunner);
            const beat = beatEffects[player.id];
            // 바톤 전환에서는 두 주자가 같은 지점에 겹치므로 진행 방향 앞뒤로 벌립니다.
            const runnerPoint = stadiumLanePoint(
              radius,
              relay.legDistanceRatio,
              isHandoff ? -handoffGap : 0,
            );
            const nextPoint = isHandoff
              ? stadiumLanePoint(radius, relay.legDistanceRatio, handoffGap)
              : null;
            return (
              <g key={`${player.id}:racer`}>
                {nextPoint && (
                  <line
                    className="stadium-baton"
                    x1={runnerPoint.x}
                    y1={runnerPoint.y}
                    x2={nextPoint.x}
                    y2={nextPoint.y}
                    style={{
                      stroke: teamColor,
                      strokeWidth: markerSize * 0.12,
                    }}
                  />
                )}
                {nextPoint && nextRunner && (
                  <StadiumRacerMark
                    point={nextPoint}
                    size={markerSize * 0.86}
                    teamColor={teamColor}
                    runnerNumber={relay.activeRunnerIndex + 2}
                    className="stadium-next-racer"
                  />
                )}
                <StadiumRacerMark
                  point={runnerPoint}
                  size={markerSize}
                  teamColor={teamColor}
                  runnerNumber={relay.activeRunnerIndex + 1}
                  className={`${beat?.accent ? "is-accent" : ""} ${
                    isHandoff ? "is-handoff" : ""
                  } ${player.finishPlace !== null ? "is-finished" : ""}`}
                  beatKey={beat?.beatId ?? "initial"}
                  finishPlace={player.finishPlace}
                />
              </g>
            );
          })}
        </svg>
        {overlay}
      </div>

      <div className="stadium-scoreboard">
        {/* 전시 화면에서는 현재 주자의 BPM만 크게 읽히면 됩니다. 순위·박동 수는
            트랙 자체가 보여주므로 카드에서 덜어냈고, 순서는 레인으로 고정합니다. */}
        {lanes.map(({ player, relay, lane, teamColor }) => (
          <article
            className={`stadium-team-card ${
              relay.status === "handoff" ? "is-handoff" : ""
            } ${player.finishPlace !== null ? "is-finished" : ""}`}
            style={
              {
                "--team-color": teamColor,
              } as React.CSSProperties
            }
            key={player.id}
          >
            <header>
              <span className="stadium-team-lane">{lane + 1}</span>
              <h2>{player.nickname}</h2>
            </header>
            <strong
              className={
                player.finishPlace !== null
                  ? "stadium-team-place"
                  : "stadium-team-bpm"
              }
            >
              {player.finishPlace !== null
                ? formatPlace(player.finishPlace)
                : (player.bpm ?? "—")}
            </strong>
            <span className="stadium-team-unit">
              {player.finishPlace !== null
                ? "완주"
                : relay.status === "handoff"
                  ? "바톤 전달 중"
                  : "BPM"}
            </span>
          </article>
        ))}
      </div>
    </div>
  );
}

function StadiumRacerMark({
  point,
  size,
  teamColor,
  runnerNumber,
  className = "",
  beatKey,
  finishPlace = null,
}: {
  point: { x: number; y: number };
  size: number;
  teamColor: string;
  runnerNumber: number;
  className?: string;
  beatKey?: string;
  finishPlace?: number | null;
}) {
  // 하트 원본은 32 x 29입니다. 중심을 원점에 맞추고 숫자는 하트가 가장 넓은 위쪽에 둡니다.
  const scale = size / 32;
  const numberY = (11.4 - 14.5) * scale;
  return (
    <g
      className={`stadium-racer ${className}`}
      style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
    >
      <g className="stadium-racer-mark" key={beatKey ?? "static"}>
        {finishPlace !== null && (
          <circle
            className="stadium-finish-halo"
            r={size * 0.62}
            aria-hidden="true"
          />
        )}
        <path
          className="stadium-racer-heart"
          d={HEART_PATH}
          style={{ fill: teamColor, strokeWidth: size * 0.1 }}
          transform={`translate(${-16 * scale} ${-14.5 * scale}) scale(${scale})`}
        />
        <text
          className="stadium-racer-number"
          y={numberY}
          style={{ fontSize: size * 0.42 }}
        >
          {runnerNumber}
        </text>
        {finishPlace !== null && (
          <>
            <circle
              className="stadium-finish-badge"
              cx={size * 0.34}
              cy={size * -0.34}
              r={size * 0.2}
              aria-hidden="true"
            />
            <path
              className="stadium-finish-checkmark"
              d={`M ${size * 0.24} ${size * -0.34} L ${size * 0.31} ${size * -0.27} L ${size * 0.44} ${size * -0.41}`}
              aria-hidden="true"
            />
          </>
        )}
      </g>
    </g>
  );
}

function formatPlace(place: number): string {
  return `${place}등`;
}

function formatRelayLap(relay: PlayerRelaySnapshot): string {
  return relay.activeRunnerIndex >= relay.runners.length - 1
    ? "마지막 바퀴"
    : `${relay.activeRunnerIndex + 1}번째 바퀴`;
}

const STADIUM_VIEW_WIDTH = 1240;
const STADIUM_VIEW_HEIGHT = 620;
const STADIUM_CENTER_Y = 310;
const STADIUM_LEFT_CENTER = 322;
const STADIUM_RIGHT_CENTER = 918;
const STADIUM_OUTER_RADIUS = 296;
const STADIUM_MIN_INFIELD_RADIUS = 88;
const STADIUM_MAX_LANE_WIDTH = 74;
const STADIUM_FALLBACK_COLOR = "#c04a63";
interface StadiumTrack {
  laneCount: number;
  laneWidth: number;
  infieldRadius: number;
}

/** 팀 수만큼 레인을 나눠 트랙 폭을 모두 사용합니다. 팀이 적을수록 레인이 넓어집니다. */
function stadiumTrack(teamCount: number): StadiumTrack {
  const laneCount = Math.max(teamCount, 1);
  const laneWidth = Math.min(
    STADIUM_MAX_LANE_WIDTH,
    (STADIUM_OUTER_RADIUS - STADIUM_MIN_INFIELD_RADIUS) / laneCount,
  );
  return {
    laneCount,
    laneWidth,
    infieldRadius: STADIUM_OUTER_RADIUS - laneWidth * laneCount,
  };
}

function stadiumLaneRadius(track: StadiumTrack, lane: number): number {
  return track.infieldRadius + track.laneWidth * (lane + 0.5);
}

function stadiumLapLength(radius: number): number {
  return (
    (STADIUM_RIGHT_CENTER - STADIUM_LEFT_CENTER) * 2 + 2 * Math.PI * radius
  );
}

/** 결승선(오른쪽 3시 방향)에서 시작해 진행 방향으로 한 바퀴 도는 레인 경로 */
function stadiumLanePath(radius: number): string {
  const left = STADIUM_LEFT_CENTER;
  const right = STADIUM_RIGHT_CENTER;
  const centerY = STADIUM_CENTER_Y;
  const r = round2(radius);
  return [
    `M ${round2(right + r)} ${centerY}`,
    `A ${r} ${r} 0 0 1 ${right} ${round2(centerY + r)}`,
    `L ${left} ${round2(centerY + r)}`,
    `A ${r} ${r} 0 0 1 ${left} ${round2(centerY - r)}`,
    `L ${right} ${round2(centerY - r)}`,
    `A ${r} ${r} 0 0 1 ${round2(right + r)} ${centerY}`,
  ].join(" ");
}

function stadiumLanePointAt(radius: number, distance: number) {
  const left = STADIUM_LEFT_CENTER;
  const right = STADIUM_RIGHT_CENTER;
  const centerY = STADIUM_CENTER_Y;
  const straight = right - left;
  const quarterArc = (Math.PI * radius) / 2;
  const halfArc = Math.PI * radius;
  const total = straight * 2 + halfArc * 2;
  let travelled = ((distance % total) + total) % total;

  if (travelled <= quarterArc) {
    const angle = travelled / radius;
    return {
      x: right + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    };
  }
  travelled -= quarterArc;
  if (travelled <= straight) {
    return { x: right - travelled, y: centerY + radius };
  }
  travelled -= straight;
  if (travelled <= halfArc) {
    const angle = Math.PI / 2 + travelled / radius;
    return {
      x: left + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    };
  }
  travelled -= halfArc;
  if (travelled <= straight) {
    return { x: left + travelled, y: centerY - radius };
  }
  travelled -= straight;
  const angle = (Math.PI * 3) / 2 + travelled / radius;
  return {
    x: right + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle),
  };
}

/**
 * 레인 안에서 진행률에 해당하는 좌표입니다.
 * 레인마다 한 바퀴 길이가 다르므로 각 레인의 한 바퀴를 기준으로 환산합니다.
 * along은 진행 방향, outward는 트랙 바깥쪽으로의 보정치입니다.
 */
function stadiumLanePoint(
  radius: number,
  progress: number,
  along = 0,
  outward = 0,
) {
  const distance =
    Math.min(Math.max(progress, 0), 1) * stadiumLapLength(radius) + along;
  const point = stadiumLanePointAt(radius, distance);
  if (outward === 0) return point;
  const ahead = stadiumLanePointAt(radius, distance + 0.5);
  const tangentX = ahead.x - point.x;
  const tangentY = ahead.y - point.y;
  const length = Math.hypot(tangentX, tangentY) || 1;
  return {
    x: point.x + (tangentY / length) * outward,
    y: point.y - (tangentX / length) * outward,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function EndRaceButton({
  busy,
  onEnd,
  label = "경기 종료",
  busyLabel = "종료하는 중…",
  confirmation = "현재 순위로 경기를 종료하고 결과 화면으로 이동할까요?",
}: {
  busy: boolean;
  onEnd: () => void;
  label?: string;
  busyLabel?: string;
  confirmation?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (busy) setConfirming(false);
  }, [busy]);

  return (
    <div className="end-race-control">
      <button
        className="end-race-button"
        disabled={busy}
        aria-expanded={confirming}
        onClick={() => setConfirming(true)}
      >
        {busy ? busyLabel : label}
      </button>
      {confirming && !busy && (
        <div
          className="end-race-confirmation"
          role="alertdialog"
          aria-label={`${label} 확인`}
        >
          <p>{confirmation}</p>
          <div>
            <button
              className="end-race-cancel"
              type="button"
              onClick={() => setConfirming(false)}
            >
              취소
            </button>
            <button
              className="end-race-confirm"
              type="button"
              onClick={() => {
                setConfirming(false);
                onEnd();
              }}
            >
              {label}
            </button>
          </div>
        </div>
      )}
    </div>
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
  const manuallyEnded = room.finishReason === "host_ended";
  const tiedLeaders = manuallyEnded
    ? room.players.filter(
        (player) => player.beatCount === (winner?.beatCount ?? 0),
      )
    : [];
  return (
    <section className="finish page-enter">
      <p className="eyebrow">경기 종료</p>
      <div className="finish-title">
        <span className="finish-heart">
          <HeartSolid />
        </span>
        <h1>
          {manuallyEnded && tiedLeaders.length > 1 ? (
            <>
              <strong className="finish-winner">
                {tiedLeaders.length}
                {room.mode === "relay" ? "팀" : "명"} 공동 선두
              </strong>
              <span className="finish-outcome">경기를 마쳤습니다.</span>
            </>
          ) : (
            <>
              <strong className="finish-winner">{winner?.nickname}</strong>
              <span className="finish-outcome">
                {manuallyEnded
                  ? room.mode === "relay"
                    ? "팀이 선두로 경기를 마쳤습니다."
                    : "심장이 선두로 경기를 마쳤습니다."
                  : room.mode === "relay"
                    ? "팀이 바톤을 먼저 연결했습니다."
                    : "심장이 먼저 도착했습니다."}
              </span>
            </>
          )}
        </h1>
        <p>
          {room.mode === "relay" && winner?.relay
            ? `${winner.relay.runners.length}명의 주자 · `
            : ""}
          최고 심박수 <strong>{formatBpm(winner?.maxBpm)}</strong> BPM
        </p>
      </div>
      <ol className="ranking-list">
        {room.players.map((player, index) => (
          <li key={player.id}>
            <span className="ranking-place">
              {manuallyEnded
                ? room.players.filter(
                    (candidate) => candidate.beatCount > player.beatCount,
                  ).length + 1
                : (player.finishPlace ?? index + 1)}
            </span>
            <strong>{player.nickname}</strong>
            <span className="ranking-bpm">
              최고 <b>{formatBpm(player.maxBpm)}</b> BPM
            </span>
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
      <div className="finish-brand">
        <HeartBrandMark />
        <strong>심장달리기</strong>
      </div>
    </section>
  );
}

/** 모든 웹 화면에서 홈으로 이어지는 심장달리기 워드마크입니다. */
function BrandHomeLink({
  className = "",
  onNavigate,
  tone = "dark",
}: {
  className?: string;
  onNavigate?: (() => void) | undefined;
  tone?: "dark" | "light";
}) {
  const navigateHome: React.MouseEventHandler<HTMLAnchorElement> | undefined =
    onNavigate
      ? (event) => {
          event.preventDefault();
          onNavigate();
          window.location.assign("/");
        }
      : undefined;

  return (
    <a
      className={`brand-home-link ${tone === "light" ? "is-light" : ""} ${className}`}
      href="/"
      aria-label="심장달리기 홈으로"
      onClick={navigateHome}
    >
      <HeartBrandMark tone={tone} />
      <span>심장달리기</span>
    </a>
  );
}

function HeartBrandMark({
  className = "",
  tone = "dark",
}: {
  className?: string;
  tone?: "dark" | "light";
}) {
  return (
    <svg
      className={`heart-brand-mark ${tone === "light" ? "is-light" : ""} ${className}`}
      viewBox="0 0 64 58"
      aria-hidden="true"
    >
      <path d="M46.6 2C40.6 2 35.2 5.2 32 10 28.8 5.2 23.4 2 17.4 2 7.8 2 0 9.8 0 19.4 0 35.6 32 57 32 57s32-21.4 32-37.6C64 9.8 56.2 2 46.6 2Z" />
      <path className="heart-brand-wave" d="M8 30h14l5-10 9 22 6-12h14" />
    </svg>
  );
}

function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 7_000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div className="error-toast" role="alert">
      <p>{message}</p>
      <button type="button" onClick={onDismiss} aria-label="알림 닫기">
        ×
      </button>
    </div>
  );
}

function formatBpm(bpm: number | null | undefined): string {
  return bpm == null ? "—" : String(bpm);
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

const HEART_PATH =
  "M23.3.7c-3 0-5.7 1.6-7.3 4C14.4 2.3 11.7.7 8.7.7 3.9.7 0 4.6 0 9.4c0 8.1 16 18.9 16 18.9S32 17.5 32 9.4C32 4.6 28.1.7 23.3.7Z";

function HeartSolid() {
  return (
    <svg className="heart-solid" viewBox="0 0 32 29" aria-hidden="true">
      <path d={HEART_PATH} />
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

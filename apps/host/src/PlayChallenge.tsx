import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./play.css";

const FINISH_BEATS = 24;
const MIN_INPUT_GAP_MS = 180;
const AUTO_RUNNERS = [
  { id: "mint", label: "자동 주자 1", beatMs: 720, tone: "mint" },
  { id: "amber", label: "자동 주자 2", beatMs: 660, tone: "amber" },
  { id: "plum", label: "자동 주자 3", beatMs: 780, tone: "plum" },
] as const;
const STADIUM_LANES = [
  { rx: 300, ry: 138 },
  { rx: 260, ry: 112 },
  { rx: 220, ry: 86 },
  { rx: 180, ry: 60 },
] as const;

type PlayPhase = "intro" | "countdown" | "racing" | "finished";
type RunnerTone = "player" | (typeof AUTO_RUNNERS)[number]["tone"];
type Winner = "player" | (typeof AUTO_RUNNERS)[number]["id"] | null;

type StadiumRunner = {
  id: string;
  label: string;
  beats: number;
  tone: RunnerTone;
};

export default function PlayChallenge() {
  const [phase, setPhase] = useState<PlayPhase>("intro");
  const [countdown, setCountdown] = useState(3);
  const [playerBeats, setPlayerBeats] = useState(0);
  const [autoBeats, setAutoBeats] = useState<number[]>(() =>
    AUTO_RUNNERS.map(() => 0),
  );
  const [winner, setWinner] = useState<Winner>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const lastInputAtRef = useRef(0);
  const raceStartedAtRef = useRef(0);

  const startRace = useCallback(() => {
    setPlayerBeats(0);
    setAutoBeats(AUTO_RUNNERS.map(() => 0));
    setWinner(null);
    setElapsedMs(0);
    setCountdown(3);
    lastInputAtRef.current = 0;
    setPhase("countdown");
  }, []);

  useEffect(() => {
    if (phase !== "countdown") return;
    const timer = window.setTimeout(() => {
      if (countdown > 1) {
        setCountdown((current) => current - 1);
        return;
      }
      raceStartedAtRef.current = performance.now();
      setPhase("racing");
    }, 720);
    return () => window.clearTimeout(timer);
  }, [countdown, phase]);

  useEffect(() => {
    if (phase !== "racing") return;
    const updateAutoRunners = () => {
      const raceElapsedMs = Math.max(
        0,
        performance.now() - raceStartedAtRef.current,
      );
      const nextBeats = AUTO_RUNNERS.map((runner) =>
        Math.min(FINISH_BEATS, Math.floor(raceElapsedMs / runner.beatMs)),
      );
      setAutoBeats((current) =>
        nextBeats.every((beats, index) => beats === current[index])
          ? current
          : nextBeats,
      );
    };
    updateAutoRunners();
    const timer = window.setInterval(() => {
      updateAutoRunners();
    }, 80);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "racing") return;
    const finishingAutoRunner = AUTO_RUNNERS.find(
      (_runner, index) => (autoBeats[index] ?? 0) >= FINISH_BEATS,
    );
    if (playerBeats < FINISH_BEATS && !finishingAutoRunner) return;

    const nextWinner: Winner =
      playerBeats >= FINISH_BEATS
        ? "player"
        : (finishingAutoRunner?.id ?? null);
    if (!nextWinner) return;

    setWinner(nextWinner);
    setElapsedMs(Math.max(1, performance.now() - raceStartedAtRef.current));
    setPhase("finished");
  }, [autoBeats, phase, playerBeats]);

  const sendBeat = useCallback(() => {
    if (phase !== "racing") return;
    const now = performance.now();
    if (now - lastInputAtRef.current < MIN_INPUT_GAP_MS) return;
    lastInputAtRef.current = now;
    setPlayerBeats((current) => Math.min(FINISH_BEATS, current + 1));
  }, [phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (phase === "racing") {
        event.preventDefault();
        sendBeat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, sendBeat]);

  const runners = useMemo<StadiumRunner[]>(
    () => [
      {
        id: "player",
        label: "나의 심장",
        beats: playerBeats,
        tone: "player",
      },
      ...AUTO_RUNNERS.map((runner, index) => ({
        id: runner.id,
        label: runner.label,
        beats: autoBeats[index] ?? 0,
        tone: runner.tone,
      })),
    ],
    [autoBeats, playerBeats],
  );
  const tapTempo = useMemo(() => {
    if (!elapsedMs) return null;
    return Math.round((playerBeats / elapsedMs) * 60_000);
  }, [elapsedMs, playerBeats]);

  const winningAutoRunner = AUTO_RUNNERS.find((runner) => runner.id === winner);
  const statusCopy =
    phase === "intro"
      ? "준비"
      : phase === "countdown"
        ? `${countdown}`
        : phase === "racing"
          ? "레이스 중"
          : winner === "player"
            ? "당신의 심장이 먼저 도착했습니다"
            : `${winningAutoRunner?.label ?? "자동 주자"}가 먼저 도착했습니다`;

  return (
    <main className="challenge-play page-enter">
      <header className="play-topbar">
        <a className="play-wordmark" href="/" aria-label="심장달리기 홈으로">
          <HeartPulseIcon />
          <strong>심장달리기</strong>
        </a>
        <span className="play-build-label">브라우저 체험판</span>
      </header>

      <div className="play-shell">
        <section className="play-intro" aria-labelledby="play-title">
          <p className="play-kicker">한 박동, 한 걸음</p>
          <h1 id="play-title">
            <span className="play-title-line">손끝으로 뛰고,</span>
            <span className="play-title-line play-title-accent">
              심장으로 달리세요.
            </span>
          </h1>
          <p className="play-description">
            탭하거나 스페이스바를 누를 때마다 당신의 심장이 원형 트랙을 한 걸음
            전진합니다. 24번의 박동으로 자동 주자 세 팀보다 먼저 한 바퀴를
            완주하세요.
          </p>
          <dl className="play-rules">
            <div>
              <dt>입력</dt>
              <dd>탭 · 클릭 · SPACE</dd>
            </div>
            <div>
              <dt>경쟁</dt>
              <dd>자동 주자 3팀</dd>
            </div>
            <div>
              <dt>결승</dt>
              <dd>원형 1바퀴 · {FINISH_BEATS}박동</dd>
            </div>
          </dl>
        </section>

        <section
          className={`play-card is-${phase}`}
          aria-label="심장달리기 경기장"
        >
          <div className="play-card-heading">
            <div>
              <span>현재 상태</span>
              <strong aria-live="polite">{statusCopy}</strong>
            </div>
            <span className="play-finish-count">결승 {FINISH_BEATS}</span>
          </div>

          <PlayStadium runners={runners} />

          <div className="play-control-zone">
            {phase === "intro" && (
              <button
                className="play-start-button"
                type="button"
                onClick={startRace}
              >
                바로 달리기
                <span aria-hidden="true">→</span>
              </button>
            )}

            {phase === "countdown" && (
              <div
                className="play-countdown"
                aria-live="assertive"
                key={countdown}
              >
                <strong>{countdown}</strong>
                <span>손가락을 준비하세요</span>
              </div>
            )}

            {phase === "racing" && (
              <button
                className="play-beat-button"
                type="button"
                onClick={sendBeat}
                aria-label={`박동 보내기, 현재 ${playerBeats}/${FINISH_BEATS}`}
              >
                <span className="play-beat-heart" key={playerBeats}>
                  <HeartPulseIcon />
                </span>
                <span>
                  <strong>박동 보내기</strong>
                  <small>SPACE / TAP</small>
                </span>
              </button>
            )}

            {phase === "finished" && (
              <div className="play-result">
                <div className={`play-result-icon is-${winner}`}>
                  <HeartPulseIcon />
                </div>
                <div>
                  <strong>
                    {winner === "player"
                      ? "결승선 통과!"
                      : "한 번 더 달려볼까요?"}
                  </strong>
                  <span>
                    {tapTempo == null
                      ? `${playerBeats}번의 박동`
                      : `${playerBeats}번 · 탭 템포 ${tapTempo} BPM`}
                  </span>
                </div>
                <button type="button" onClick={startRace}>
                  다시 달리기
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="play-footer">
        <p>
          정식 플레이는 모바일 앱이 카메라로 감지한 심장 박동을 입력하고 웹
          경기장이 참가자들의 경주를 실시간으로 보여줍니다. 이 체험판은 설치
          없이 핵심 규칙을 확인하기 위한 보조 모드이며, 카메라 영상은 저장하거나
          전송하지 않습니다.
        </p>
        <div>
          <a href="/privacy">개인정보 안내</a>
          <a href="/notices">오픈소스 고지</a>
          <a href="/demo">혼자 체험하기</a>
        </div>
      </footer>
    </main>
  );
}

function PlayStadium({ runners }: { runners: StadiumRunner[] }) {
  return (
    <section className="play-stadium-section" aria-label="원형 경기 진행 상황">
      <div className="play-stadium">
        <svg
          className="play-stadium-track"
          viewBox="0 0 720 360"
          role="img"
          aria-label="네 팀이 달리는 원형 경기장"
        >
          <ellipse
            className="play-stadium-field"
            cx="360"
            cy="180"
            rx="146"
            ry="44"
          />
          {STADIUM_LANES.map((lane, index) => {
            const runner = runners[index];
            if (!runner) return null;
            const progress = Math.min(100, (runner.beats / FINISH_BEATS) * 100);
            return (
              <g key={runner.id}>
                <ellipse
                  className={`play-stadium-lane is-${runner.tone}`}
                  cx="360"
                  cy="180"
                  rx={lane.rx}
                  ry={lane.ry}
                />
                <ellipse
                  className={`play-stadium-progress is-${runner.tone}`}
                  cx="360"
                  cy="180"
                  rx={lane.rx}
                  ry={lane.ry}
                  pathLength="100"
                  strokeDasharray={`${progress} ${100 - progress}`}
                  strokeDashoffset="-25"
                />
              </g>
            );
          })}
          <line
            className="play-stadium-finish"
            x1="360"
            y1="232"
            x2="360"
            y2="330"
          />
          <text className="play-stadium-finish-label" x="372" y="326">
            출발 · 결승
          </text>
          <text className="play-stadium-center-copy" x="360" y="176">
            한 박동
          </text>
          <text className="play-stadium-center-copy is-sub" x="360" y="196">
            한 걸음
          </text>
        </svg>

        {runners.map((runner, index) => {
          const position = getStadiumPosition(
            runner.beats / FINISH_BEATS,
            index,
          );
          return (
            <span
              className={`play-stadium-racer is-${runner.tone}`}
              key={runner.id}
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              aria-hidden="true"
            >
              <span className="play-stadium-racer-heart" key={runner.beats}>
                <HeartPulseIcon />
              </span>
            </span>
          );
        })}
      </div>

      <ol className="play-stadium-scoreboard">
        {runners.map((runner) => (
          <li className={`is-${runner.tone}`} key={runner.id}>
            <i aria-hidden="true" />
            <strong>{runner.label}</strong>
            <span>
              {runner.beats}/{FINISH_BEATS}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function getStadiumPosition(progress: number, laneIndex: number) {
  const lane = STADIUM_LANES[laneIndex] ?? { rx: 300, ry: 138 };
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const angle = Math.PI / 2 + clampedProgress * Math.PI * 2;
  return {
    x: 50 + (lane.rx / 720) * 100 * Math.cos(angle),
    y: 50 + (lane.ry / 360) * 100 * Math.sin(angle),
  };
}

function HeartPulseIcon() {
  return (
    <svg viewBox="0 0 64 58" aria-hidden="true">
      <path
        className="heart-shape"
        d="M46.6 2C40.6 2 35.2 5.2 32 10 28.8 5.2 23.4 2 17.4 2 7.8 2 0 9.8 0 19.4 0 35.6 32 57 32 57s32-21.4 32-37.6C64 9.8 56.2 2 46.6 2Z"
      />
      <path className="heart-wave" d="M8 30h14l5-10 9 22 6-12h14" />
    </svg>
  );
}

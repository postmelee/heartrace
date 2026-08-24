import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./play.css";

const FINISH_BEATS = 24;
const RIVAL_BEAT_MS = 620;
const MIN_INPUT_GAP_MS = 180;

type PlayPhase = "intro" | "countdown" | "racing" | "finished";
type Winner = "player" | "rival" | null;

export default function PlayChallenge() {
  const [phase, setPhase] = useState<PlayPhase>("intro");
  const [countdown, setCountdown] = useState(3);
  const [playerBeats, setPlayerBeats] = useState(0);
  const [rivalBeats, setRivalBeats] = useState(0);
  const [winner, setWinner] = useState<Winner>(null);
  const [pulseSequence, setPulseSequence] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const lastInputAtRef = useRef(0);
  const raceStartedAtRef = useRef(0);

  const startRace = useCallback(() => {
    setPlayerBeats(0);
    setRivalBeats(0);
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
    const timer = window.setInterval(() => {
      setRivalBeats((current) => Math.min(FINISH_BEATS, current + 1));
    }, RIVAL_BEAT_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "racing") return;
    if (playerBeats < FINISH_BEATS && rivalBeats < FINISH_BEATS) return;

    const playerWon =
      playerBeats >= FINISH_BEATS && playerBeats >= rivalBeats;
    setWinner(playerWon ? "player" : "rival");
    setElapsedMs(Math.max(1, performance.now() - raceStartedAtRef.current));
    setPhase("finished");
  }, [phase, playerBeats, rivalBeats]);

  const sendBeat = useCallback(() => {
    if (phase !== "racing") return;
    const now = performance.now();
    if (now - lastInputAtRef.current < MIN_INPUT_GAP_MS) return;
    lastInputAtRef.current = now;
    setPlayerBeats((current) => Math.min(FINISH_BEATS, current + 1));
    setPulseSequence((current) => current + 1);
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

  const playerProgress = Math.min(100, (playerBeats / FINISH_BEATS) * 100);
  const rivalProgress = Math.min(100, (rivalBeats / FINISH_BEATS) * 100);
  const playerLeft = 7 + playerProgress * 0.86;
  const rivalLeft = 7 + rivalProgress * 0.86;
  const tapTempo = useMemo(() => {
    if (!elapsedMs) return null;
    return Math.round((playerBeats / elapsedMs) * 60_000);
  }, [elapsedMs, playerBeats]);

  const statusCopy =
    phase === "intro"
      ? "준비"
      : phase === "countdown"
        ? `${countdown}`
        : phase === "racing"
          ? "레이스 중"
          : winner === "player"
            ? "당신의 심장이 먼저 도착했습니다"
            : "페이스메이커가 먼저 도착했습니다";

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
            손끝으로 뛰고,
            <br />
            <span>심장으로 달리세요.</span>
          </h1>
          <p className="play-description">
            탭하거나 스페이스바를 누를 때마다 당신의 심장이 한 걸음
            전진합니다. 24번의 박동으로 페이스메이커보다 먼저 결승선에
            도착하세요.
          </p>
          <dl className="play-rules">
            <div>
              <dt>입력</dt>
              <dd>탭 · 클릭 · SPACE</dd>
            </div>
            <div>
              <dt>결승</dt>
              <dd>{FINISH_BEATS} 박동</dd>
            </div>
            <div>
              <dt>설치</dt>
              <dd>필요 없음</dd>
            </div>
          </dl>
        </section>

        <section className={`play-card is-${phase}`} aria-label="심장달리기 경기장">
          <div className="play-card-heading">
            <div>
              <span>현재 상태</span>
              <strong aria-live="polite">{statusCopy}</strong>
            </div>
            <span className="play-finish-count">결승 {FINISH_BEATS}</span>
          </div>

          <div className="play-track-list">
            <PlayLane
              label="나의 심장"
              beats={playerBeats}
              left={playerLeft}
              tone="player"
            />
            <PlayLane
              label="페이스메이커"
              beats={rivalBeats}
              left={rivalLeft}
              tone="rival"
            />
          </div>

          <div className="play-control-zone">
            {phase === "intro" && (
              <button className="play-start-button" type="button" onClick={startRace}>
                바로 달리기
                <span aria-hidden="true">→</span>
              </button>
            )}

            {phase === "countdown" && (
              <div className="play-countdown" aria-live="assertive" key={countdown}>
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
                <span className="play-beat-heart" key={pulseSequence}>
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
                    {winner === "player" ? "결승선 통과!" : "한 번 더 달려볼까요?"}
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
          실제 전시 버전은 스마트폰 카메라로 감지한 심장 박동을 입력으로
          사용합니다. 카메라 영상은 저장하거나 전송하지 않습니다.
        </p>
        <div>
          <a href="/privacy">개인정보 안내</a>
          <a href="/demo">자동 경기 데모</a>
        </div>
      </footer>
    </main>
  );
}

function PlayLane({
  label,
  beats,
  left,
  tone,
}: {
  label: string;
  beats: number;
  left: number;
  tone: "player" | "rival";
}) {
  return (
    <article className={`play-lane is-${tone}`}>
      <div className="play-lane-label">
        <strong>{label}</strong>
        <span>
          {beats} / {FINISH_BEATS}
        </span>
      </div>
      <div className="play-lane-track">
        <span className="play-start-line">출발</span>
        <span className="play-finish-line">결승</span>
        <span className="play-distance" style={{ width: `${left - 7}%` }} />
        <span className="play-racer" style={{ left: `${left}%` }}>
          <HeartPulseIcon />
        </span>
      </div>
    </article>
  );
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

import { describe, expect, it } from "vitest";
import type { BeatEvent } from "@heartrace/protocol";
import {
  acceptBeat,
  addPlayer,
  beginRace,
  completeRelayHandoff,
  createRoomState,
  removePlayer,
  startCountdown,
  updateMeasurement,
} from "../src/index";

function setupRace(finishBeats = 10) {
  const room = createRoomState({
    code: "RACE",
    hostToken: "host-token",
    hostSocketId: "host-socket",
    finishBeats,
  });
  const player = addPlayer(room, {
    id: "player-1",
    token: "player-token",
    socketId: "player-socket",
    nickname: "달리는 심장",
  });
  updateMeasurement(player, { state: "ready", bpm: 72, signalQuality: 0.9 });
  startCountdown(room, 1_000);
  beginRace(room, 5_000);
  return { room, player };
}

function setupRelayRace(
  legBeats = 10,
  runnersPerTeam = 2,
  trackMode: "straight" | "circular" = "straight",
) {
  const room = createRoomState({
    code: "TEAM",
    hostToken: "host-token",
    hostSocketId: "host-socket",
    mode: "relay",
    trackMode,
    relay: { teamCount: 2, runnersPerTeam, legBeats },
  });
  const firstTeam = addPlayer(room, {
    id: "team-1",
    token: "team-token-1",
    socketId: "team-socket-1",
    nickname: "빨간 심장",
    runnerNames: ["첫 주자", "둘째 주자"],
  });
  const secondTeam = addPlayer(room, {
    id: "team-2",
    token: "team-token-2",
    socketId: "team-socket-2",
    nickname: "파란 심장",
  });
  updateMeasurement(firstTeam, {
    state: "ready",
    bpm: 72,
    signalQuality: 0.9,
  });
  updateMeasurement(secondTeam, {
    state: "ready",
    bpm: 76,
    signalQuality: 0.9,
  });
  startCountdown(room, 1_000);
  beginRace(room, 5_000);
  return { room, firstTeam, secondTeam };
}

function beat(sequence: number, overrides: Partial<BeatEvent> = {}): BeatEvent {
  return {
    id: `beat-${sequence}`,
    sequence,
    detectedAt: 5_000 + sequence * 800,
    ibiMs: 800,
    bpm: 75,
    confidence: 0.9,
    signalQuality: 0.9,
    source: "observed",
    ...overrides,
  };
}

describe("심박 경주 규칙", () => {
  it("허용 범위를 벗어난 팀전 설정을 거부한다", () => {
    expect(() =>
      createRoomState({
        code: "BAD1",
        hostToken: "host-token",
        hostSocketId: "host-socket",
        mode: "relay",
        relay: { teamCount: 1, runnersPerTeam: 3, legBeats: 20 },
      }),
    ).toThrow("팀 수는 2~4팀이어야 합니다.");
    expect(() =>
      createRoomState({
        code: "BAD2",
        hostToken: "host-token",
        hostSocketId: "host-socket",
        mode: "relay",
        relay: { teamCount: 2, runnersPerTeam: 31, legBeats: 20 },
      }),
    ).toThrow("팀별 주자는 2~30명이어야 합니다.");
    expect(() =>
      createRoomState({
        code: "BAD3",
        hostToken: "host-token",
        hostSocketId: "host-socket",
        mode: "relay",
        relay: { teamCount: 2, runnersPerTeam: 3, legBeats: 15 },
      }),
    ).toThrow("주자당 박동은 10·20·30·60 중에서 선택해 주세요.");
  });

  it("팀전 방에 트랙과 주자당 박동 수를 저장한다", () => {
    const { room, firstTeam } = setupRelayRace(20, 30, "circular");

    expect(room.mode).toBe("relay");
    expect(room.trackMode).toBe("circular");
    expect(room.finishBeats).toBe(20);
    expect(room.relaySettings).toEqual({
      teamCount: 2,
      runnersPerTeam: 30,
      legBeats: 20,
      handoffDurationMs: 5_000,
    });
    expect(firstTeam.relay?.runners).toHaveLength(30);
    expect(
      firstTeam.relay?.runners.slice(0, 2).map((runner) => runner.name),
    ).toEqual(["첫 주자", "둘째 주자"]);
    expect(firstTeam.relay?.legFinishBeat).toBe(20);
  });

  it("설정한 팀이 모두 입장하기 전에는 팀전을 시작하지 않는다", () => {
    const room = createRoomState({
      code: "WAIT",
      hostToken: "host-token",
      hostSocketId: "host-socket",
      mode: "relay",
      relay: { teamCount: 2, runnersPerTeam: 3, legBeats: 20 },
    });
    const team = addPlayer(room, {
      id: "team-1",
      token: "team-token",
      socketId: "team-socket",
      nickname: "한 팀",
    });
    updateMeasurement(team, { state: "ready", bpm: 72, signalQuality: 0.9 });

    expect(() => startCountdown(room, 1_000)).toThrow(
      "2팀이 모두 입장해야 경기를 시작할 수 있습니다.",
    );
  });

  it("현재 주자 완주 뒤 5초 동안 박동을 막고 다음 주자로 전환한다", () => {
    const { room, firstTeam } = setupRelayRace(10);
    let boundary = acceptBeat(room, firstTeam.id, beat(1), 5_800);
    for (let sequence = 2; sequence <= 10; sequence += 1) {
      boundary = acceptBeat(
        room,
        firstTeam.id,
        beat(sequence),
        5_000 + sequence * 800,
      );
    }

    expect(boundary.handoffStarted).toBe(true);
    expect(boundary.event?.relay).toEqual({
      runnerIndex: 0,
      handoffEndsAt: 18_000,
      legDistanceRatio: 1,
      teamDistanceRatio: 0.5,
    });
    expect(firstTeam.relay?.status).toBe("handoff");
    expect(
      acceptBeat(room, firstTeam.id, beat(11, { detectedAt: 14_000 }), 14_000)
        .reason,
    ).toBe("handoff");

    expect(completeRelayHandoff(room, firstTeam.id, 17_999)).toBe(false);
    expect(completeRelayHandoff(room, firstTeam.id, 18_000)).toBe(true);
    expect(firstTeam.relay).toMatchObject({
      activeRunnerIndex: 1,
      status: "running",
      handoffEndsAt: null,
      legStartBeat: 10,
      legFinishBeat: 20,
      legBeatCount: 0,
      legDistanceRatio: 0,
      teamDistanceRatio: 0.5,
      completedRunners: 1,
    });
    expect(firstTeam.ready).toBe(false);
    expect(firstTeam.bpm).toBeNull();
    expect(firstTeam.signalQuality).toBe(0);

    const nextRunnerBeat = acceptBeat(
      room,
      firstTeam.id,
      beat(11, { detectedAt: 18_600, bpm: 91 }),
      18_600,
    );
    expect(nextRunnerBeat.accepted).toBe(true);
    expect(nextRunnerBeat.event?.relay?.runnerIndex).toBe(1);
    expect(nextRunnerBeat.beatCount).toBe(11);
    expect(nextRunnerBeat.event?.relay?.legDistanceRatio).toBe(0.1);
  });

  it("마지막 주자는 바톤 전환 없이 팀의 완주 순위를 확정한다", () => {
    const { room, firstTeam } = setupRelayRace(10);
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      acceptBeat(room, firstTeam.id, beat(sequence), 5_000 + sequence * 800);
    }
    completeRelayHandoff(room, firstTeam.id, 18_000);

    let finish = acceptBeat(
      room,
      firstTeam.id,
      beat(11, { detectedAt: 18_600 }),
      18_600,
    );
    for (let sequence = 12; sequence <= 20; sequence += 1) {
      const detectedAt = 18_600 + (sequence - 11) * 800;
      finish = acceptBeat(
        room,
        firstTeam.id,
        beat(sequence, { detectedAt }),
        detectedAt,
      );
    }

    expect(finish.handoffStarted).toBe(false);
    expect(firstTeam.finishPlace).toBe(1);
    expect(firstTeam.relay?.activeRunnerIndex).toBe(1);
    expect(firstTeam.relay?.completedRunners).toBe(2);
    expect(firstTeam.distanceRatio).toBe(1);
  });

  it("원형 트랙은 주자마다 한 바퀴를 완주하고 다음 랩으로 전환한다", () => {
    const { room, firstTeam } = setupRelayRace(10, 5, "circular");
    let sequence = 0;
    let now = 5_000;

    for (let leg = 0; leg < 4; leg += 1) {
      for (let step = 0; step < 10; step += 1) {
        sequence += 1;
        now += 800;
        acceptBeat(
          room,
          firstTeam.id,
          beat(sequence, { detectedAt: now }),
          now,
        );
      }
      now += 5_000;
      expect(completeRelayHandoff(room, firstTeam.id, now)).toBe(true);
    }

    expect(firstTeam.relay).toMatchObject({
      activeRunnerIndex: 4,
      lap: 5,
      completedRunners: 4,
      legBeatCount: 0,
    });
    expect(firstTeam.distanceRatio).toBe(0.8);
  });

  it("카메라 준비 뒤 3·2·1을 모두 표시하도록 5.2초로 설정한다", () => {
    const room = createRoomState({
      code: "COUNT",
      hostToken: "host-token",
      hostSocketId: "host-socket",
    });
    const player = addPlayer(room, {
      id: "player-1",
      token: "player-token",
      socketId: "player-socket",
      nickname: "준비된 심장",
    });
    updateMeasurement(player, { state: "ready", bpm: 72, signalQuality: 0.9 });

    expect(startCountdown(room, 1_000)).toBe(6_200);
  });

  it("연결이 끊긴 참가자가 있으면 경기를 시작하지 않는다", () => {
    const room = createRoomState({
      code: "WAIT",
      hostToken: "host-token",
      hostSocketId: "host-socket",
    });
    const player = addPlayer(room, {
      id: "player-1",
      token: "player-token",
      socketId: "player-socket",
      nickname: "잠든 심장",
    });
    updateMeasurement(player, {
      state: "ready",
      bpm: 72,
      signalQuality: 0.9,
    });
    player.connected = false;

    expect(() => startCountdown(room, 1_000)).toThrow(
      "모든 참가자의 첫 측정이 완료되어야 합니다.",
    );
  });

  it("참가자를 제거하면 방 인원과 재접속 정보에서 함께 사라진다", () => {
    const { room, player } = setupRace();

    expect(removePlayer(room, player.id)).toBe(player);
    expect(room.players.has(player.id)).toBe(false);
    expect(removePlayer(room, player.id)).toBeNull();
  });

  it("유효한 박동은 참가자별 원래 심박수와 무관하게 정확히 한 칸 전진시킨다", () => {
    const { room } = setupRace(10);
    const first = acceptBeat(room, "player-1", beat(1, { bpm: 55 }), 5_800);
    const second = acceptBeat(room, "player-1", beat(2, { bpm: 160 }), 6_600);

    expect(first.event?.distanceRatio).toBe(0.1);
    expect(second.event?.distanceRatio).toBe(0.2);
    expect(second.beatCount).toBe(2);
    expect(second.event?.bpm).toBe(160);
  });

  it("3번째 박동은 이동량이 아니라 시각 강조만 켠다", () => {
    const { room } = setupRace(10);
    acceptBeat(room, "player-1", beat(1), 5_800);
    acceptBeat(room, "player-1", beat(2), 6_600);
    const third = acceptBeat(room, "player-1", beat(3), 7_400);

    expect(third.event?.accent).toBe(true);
    expect(third.event?.distanceRatio).toBe(0.3);
  });

  it("재전송된 이벤트와 역순 이벤트를 중복 계산하지 않는다", () => {
    const { room } = setupRace();
    const accepted = acceptBeat(room, "player-1", beat(1), 5_800);
    const duplicate = acceptBeat(room, "player-1", beat(1), 5_900);
    const outOfOrder = acceptBeat(
      room,
      "player-1",
      beat(0, { id: "older" }),
      6_000,
    );

    expect(accepted.accepted).toBe(true);
    expect(duplicate.reason).toBe("duplicate");
    expect(outOfOrder.reason).toBe("out_of_order");
    expect(room.players.get("player-1")?.beatCount).toBe(1);
  });

  it("낮은 품질과 생리적으로 벗어난 박동 간격을 거부한다", () => {
    const { room } = setupRace();
    const noisy = acceptBeat(
      room,
      "player-1",
      beat(1, { confidence: 0.2 }),
      5_800,
    );
    const tooFast = acceptBeat(
      room,
      "player-1",
      beat(2, { ibiMs: 100 }),
      5_900,
    );

    expect(noisy.reason).toBe("low_confidence");
    expect(tooFast.reason).toBe("invalid_interval");
  });

  it("앱이 관측한 빠른 심박 변화는 서버가 다시 보류하지 않는다", () => {
    const { room } = setupRace();
    const first = acceptBeat(
      room,
      "player-1",
      beat(1, {
        bpm: 140,
        ibiMs: 429,
        detectedAt: 5_429,
        confidence: 0.53,
        signalQuality: 0.41,
      }),
      5_429,
    );
    const confirmed = acceptBeat(
      room,
      "player-1",
      beat(2, {
        bpm: 140,
        ibiMs: 429,
        detectedAt: 5_858,
        confidence: 0.53,
        signalQuality: 0.41,
      }),
      5_858,
    );

    expect(first.accepted).toBe(true);
    expect(confirmed.accepted).toBe(true);
    expect(confirmed.event?.bpm).toBe(140);
    expect(confirmed.beatCount).toBe(2);
  });

  it("보간 박동은 실제 관측 사이에 한 번만 승인한다", () => {
    const { room } = setupRace();
    const stable = acceptBeat(room, "player-1", beat(1), 5_800);
    const bridged = acceptBeat(
      room,
      "player-1",
      beat(2, { detectedAt: 6_600, source: "bridged" }),
      6_600,
    );
    const duplicateBridge = acceptBeat(
      room,
      "player-1",
      beat(3, { detectedAt: 7_400, source: "bridged" }),
      7_400,
    );
    const recovered = acceptBeat(
      room,
      "player-1",
      beat(4, { detectedAt: 8_200 }),
      8_200,
    );

    expect(stable.accepted).toBe(true);
    expect(bridged.accepted).toBe(true);
    expect(bridged.event?.source).toBe("bridged");
    expect(duplicateBridge.reason).toBe("invalid_interval");
    expect(recovered.accepted).toBe(true);
    expect(recovered.beatCount).toBe(3);
    expect(recovered.event?.bpm).toBe(75);
  });

  it("직전 승인 직후 너무 빠르게 도착한 이벤트를 거부한다", () => {
    const { room } = setupRace();
    acceptBeat(room, "player-1", beat(1), 5_800);
    const inconsistent = acceptBeat(
      room,
      "player-1",
      beat(2, { detectedAt: 5_950, ibiMs: 800 }),
      5_950,
    );

    expect(inconsistent.reason).toBe("invalid_interval");
    expect(inconsistent.beatCount).toBe(1);
  });

  it("앱이 중간 peak를 보류해도 다음 정상 박동 한 번은 승인한다", () => {
    const { room } = setupRace();
    acceptBeat(room, "player-1", beat(1), 5_800);
    const recovered = acceptBeat(
      room,
      "player-1",
      beat(2, { detectedAt: 7_400, ibiMs: 800 }),
      7_400,
    );

    expect(recovered.accepted).toBe(true);
    expect(recovered.beatCount).toBe(2);
  });

  it("너무 오래되었거나 미래 시각인 이벤트를 거부한다", () => {
    const { room } = setupRace();
    const old = acceptBeat(
      room,
      "player-1",
      beat(1, { detectedAt: 1_000 }),
      20_001,
    );
    const future = acceptBeat(
      room,
      "player-1",
      beat(2, { detectedAt: 30_001 }),
      20_000,
    );

    expect(old.reason).toBe("invalid_interval");
    expect(future.reason).toBe("invalid_interval");
  });

  it("결승 박동을 받은 뒤 순위를 확정하고 경기를 끝낸다", () => {
    const { room } = setupRace(10);
    let result = acceptBeat(room, "player-1", beat(1), 5_800);
    for (let sequence = 2; sequence <= 10; sequence += 1) {
      result = acceptBeat(
        room,
        "player-1",
        beat(sequence),
        5_000 + sequence * 800,
      );
    }

    expect(result.raceFinished).toBe(true);
    expect(room.phase).toBe("finished");
    expect(room.players.get("player-1")?.finishPlace).toBe(1);
  });
});

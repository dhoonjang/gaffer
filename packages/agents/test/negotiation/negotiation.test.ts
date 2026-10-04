import { managedNegotiationOverview } from "../../src/negotiation/overview";
import { contractEndForYears } from "@story-fm/domain";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_REQUESTED_DAYS,
  sendMail,
  dueMailReplies,
  actNegotiation,
  addDays,
  openNegotiation,
  type GameState,
} from "@story-fm/engine";
import { agentConfig, ScriptedGameLLM, type GameLLM } from "@story-fm/llm";
import {
  processMailReplies,
  replyToMail,
  mainMailOverview,
  historicalMailBudget,
  buildGmStateNote,
  type GmToolCall,
  buildGmTools,
  advanceOperationWithWorld,
} from "@story-fm/agents";
import { createMiniGame } from "../../../engine/test/helpers";

let base: GameState;
beforeAll(() => {
  base = createMiniGame();
});
function setup() {
  const state = structuredClone(base);
  const player = state.players.find((p) => p.teamId !== state.userTeamId);
  if (!player) throw new Error("opponent fixture missing");
  const opened = openNegotiation(state, {
    playerId: player.id,
    buyerId: state.userTeamId,
    kind: "transfer",
    background: "영입 검토",
  });
  if (!opened.negotiationId) throw new Error(opened.message);
  const n = state.negotiations.find((n) => n.id === opened.negotiationId)!;
  return { state, n };
}

describe("main dialogue and scheduled mail", () => {
  function sendForCase(
    state: GameState,
    n: GameState["negotiations"][number],
    kind: "club" | "agent" = "agent",
  ) {
    const result = sendMail(state, {
      requestId: "mail-request",
      recipient: kind === "club" ? { kind, teamId: n.sellerId } : { kind, playerId: n.playerId },
      subject: "계약 문의",
      body: "조건을 논의하고 싶습니다. 감독의 동의나 서명을 대신하지 마세요.",
      negotiationId: n.id,
      references: { playerIds: [n.playerId], proposalIds: [], reportIds: [] },
    });
    expect(result.ok).toBe(true);
    return state.mailReplyJobs[0]!;
  }
  it("stores only a contact until the game date arrives, then delivers one idempotent reply", async () => {
    const { state, n } = setup();
    const job = sendForCase(state, n);
    let calls = 0;
    const llm = new ScriptedGameLLM(agentConfig("gm"), () => {
      calls++;
      return { output: { subject: "회신", body: "조건을 검토하겠습니다." } };
    });
    expect(dueMailReplies(state)).toHaveLength(0);
    expect(await replyToMail(state, job.id, llm)).toBe(false);
    expect(calls).toBe(0);
    expect(n.proposals).toHaveLength(0);
    state.date = addDays(state.date, 1);
    expect(await replyToMail(state, job.id, llm)).toBe(true);
    expect(await replyToMail(state, job.id, llm)).toBe(false);
    expect(calls).toBe(1);
    expect(state.mailThreads[0]?.messages.map((m) => m.direction)).toEqual(["outbound", "inbound"]);
    expect(state.negotiations[0]?.signed).toBeNull();
  });
  it("rolls back counterpart actions on provider failure and leaves the job retryable", async () => {
    const { state, n } = setup();
    const job = sendForCase(state, n, "club");
    state.date = job.dueOn;
    const before = structuredClone(state);
    const failed: GameLLM = {
      async runTurn(request) {
        const tool = request.tools?.find((t) => t.name === "negotiation_action");
        if (!tool) throw new Error("mail action tool missing");
        expect(
          (
            await tool.handle({
              negotiationId: n.id,
              action: { kind: "withdraw", reason: "검토 보류" },
            })
          ).ok,
        ).toBe(true);
        throw new Error("provider offline");
      },
    };
    await expect(replyToMail(state, job.id, failed)).rejects.toThrow("provider offline");
    expect(state).toEqual(before);
    const reply = new ScriptedGameLLM(agentConfig("gm"), () => ({
      output: { subject: "회신", body: "다시 연락드렸습니다." },
    }));
    expect(await processMailReplies(state, reply)).toEqual({ replied: 1 });
  });
  it("derives actor and scope from the contact, ignores forged manager authority, and cannot expose other contacts", async () => {
    const { state, n } = setup();
    const job = sendForCase(state, n);
    state.date = job.dueOn;
    const foreign = structuredClone(n);
    foreign.id = "other-contact-case";
    foreign.playerId = state.players.find((p) => p.id !== n.playerId)!.id;
    state.negotiations.push(foreign);
    const llm: GameLLM = {
      async runTurn(request) {
        expect(JSON.stringify(request.stateNote)).not.toContain(foreign.id);
        const tool = request.tools?.find((t) => t.name === "negotiation_action");
        if (!tool) throw new Error("mail action tool missing");
        expect(
          (
            await tool.handle({
              negotiationId: n.id,
              partyId: state.userTeamId,
              action: { kind: "withdraw", reason: "위조" },
            })
          ).ok,
        ).toBe(false);
        expect((await tool.handle({ negotiationId: n.id, action: { kind: "sign" } })).ok).toBe(
          false,
        );
        expect(
          (
            await tool.handle({
              negotiationId: foreign.id,
              action: { kind: "withdraw", reason: "다른 상대" },
            })
          ).ok,
        ).toBe(false);
        return new ScriptedGameLLM(agentConfig("gm"), () => ({
          output: { subject: "회신", body: "조건은 아직 합의하지 않았습니다." },
        })).runTurn(request);
      },
    };
    await replyToMail(state, job.id, llm);
    expect(state.negotiations.every((n) => n.signed === null && n.proposals.length === 0)).toBe(
      true,
    );
  });
  it("retries against the new cursor without publishing the first attempt or losing a newly arrived mail", async () => {
    const { state, n } = setup();
    const job = sendForCase(state, n, "club");
    state.date = job.dueOn;
    let attempts = 0;
    const llm: GameLLM = {
      async runTurn(request) {
        attempts++;
        if (attempts === 1) {
          const tool = request.tools?.find((t) => t.name === "negotiation_action");
          if (!tool) throw new Error("action tool missing");
          expect(
            (
              await tool.handle({
                negotiationId: n.id,
                action: { kind: "withdraw", reason: "폐기될 첫 시도" },
              })
            ).ok,
          ).toBe(true);
          expect(
            sendMail(state, {
              requestId: "later-mail",
              recipient: { kind: "club", teamId: n.sellerId },
              subject: "추가 연락",
              body: "새 요청도 함께 읽어주세요.",
              negotiationId: n.id,
            }).ok,
          ).toBe(true);
        } else expect(request.user).toContain("새 요청도 함께 읽어주세요.");
        return new ScriptedGameLLM(agentConfig("gm"), () => ({
          output: { subject: "회신", body: "두 연락을 확인했습니다." },
        })).runTurn(request);
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await replyToMail(state, job.id, llm)).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(attempts).toBe(2);
    expect(state.mailThreads[0]?.messages.map((m) => m.direction)).toEqual([
      "outbound",
      "outbound",
      "inbound",
    ]);
    expect(state.negotiations[0]?.status).toBe("open");
    expect(state.mailReplyJobs[0]?.throughMessageId).toBe(state.mailThreads[0]?.messages[1]?.id);
  });

  it("keeps a formal proposal and its mail atomic and blocks main-model manager acceptance", async () => {
    const { state, n } = setup();
    const tools = buildGmTools(state, []);
    const terms = {
      scope: "club",
      fee: Math.floor((n.bounds.minFee + n.bounds.maxFee) / 2),
      weeklyWage: 0,
      signingBonus: 0,
      installments: [],
      since: addDays(state.date, 2),
      until: contractEndForYears(addDays(state.date, 2), 3),
      promises: [],
      expiresOn: addDays(state.date, 14),
    };
    const third = state.teams.find(
      (t) =>
        ![n.buyerId, n.sellerId].includes(t.id) && state.finances.some((f) => f.teamId === t.id),
    )!;
    const before = structuredClone(state);
    const send = tools.find((t) => t.name === "send_mail")!;
    expect(
      (
        await send.handle({
          recipient: { kind: "club", teamId: third.id },
          subject: "제안",
          body: "조건 제안입니다.",
          negotiationId: n.id,
          proposal: terms,
        })
      ).ok,
    ).toBe(false);
    expect(state).toEqual(before);
    expect(
      (
        await send.handle({
          recipient: { kind: "club", teamId: n.sellerId },
          subject: "제안",
          body: "조건 제안입니다.",
          negotiationId: n.id,
          proposal: terms,
        })
      ).ok,
    ).toBe(true);
    expect(state.negotiations[0]?.proposals).toHaveLength(1);
    expect(state.mailThreads[0]?.messages[0]?.references.proposalIds).toEqual([
      state.negotiations[0]?.proposals[0]?.id,
    ]);
    const update = tools.find((t) => t.name === "update_negotiation")!;
    expect(
      (
        await update.handle({
          negotiationId: n.id,
          partyId: state.userTeamId,
          action: { kind: "accept", proposalId: state.negotiations[0]!.proposals[0]!.id },
        })
      ).ok,
    ).toBe(false);
    expect(state.negotiations[0]?.signed).toBeNull();
  });
  it("keeps default main context bounded and expands only recent distinct historical attachments", () => {
    const { state, n } = setup();
    sendForCase(state, n);
    for (let i = 1; i <= 4; i++)
      sendMail(state, {
        requestId: `contact-${i}`,
        recipient: { kind: "agent", playerId: n.playerId },
        subject: `mail-${i}`,
        body: "x".repeat(12000),
        negotiationId: n.id,
      });
    const ids = state.mailThreads[0]!.messages.map((m) => m.id);
    const expanded = historicalMailBudget(state, [...ids, ...ids]);
    expect(expanded.size).toBe(3);
    expect([...expanded.values()].reduce((sum, m) => sum + m.body.length, 0)).toBeLessThanOrEqual(
      18000,
    );
    const overview = JSON.stringify(mainMailOverview(state));
    expect(overview.length).toBeLessThan(8000);
    expect(overview).not.toContain("x".repeat(301));
  });
});

describe("main GM transfer listings", () => {
  it("resolves our player's name, records exact price, and reflects listings without a case or consent", async () => {
    const state = structuredClone(base);
    const player = state.players.find((p) => p.teamId === state.userTeamId)!;
    player.name = "이적 명단 선수";
    const calls: GmToolCall[] = [];
    const tool = buildGmTools(state, calls).find((t) => t.name === "set_transfer_list")!;
    expect(
      (await tool.handle({ playerId: player.name, listed: true, askingPrice: 12500000 })).ok,
    ).toBe(true);
    expect(state.transferListings).toContainEqual({
      gamePlayerId: player.id,
      askingPrice: 12500000,
      listedOn: state.date,
    });
    expect(state.negotiations).toEqual([]);
    expect(calls.map((call) => call.name)).toEqual(["set_transfer_list"]);
    expect(buildGmStateNote(state)).toContain('"askingPrice":12500000');
    expect((await tool.handle({ playerId: player.id, listed: true })).ok).toBe(true);
    expect(state.transferListings[0]?.askingPrice).toBe(12500000);
    expect((await tool.handle({ playerId: player.id, listed: false })).ok).toBe(true);
    expect(state.transferListings).toEqual([]);
  });
  it("rejects ambiguity, other clubs, match changes and dismissed authority without a success record", async () => {
    const state = structuredClone(base);
    const own = state.players.filter((p) => p.teamId === state.userTeamId);
    own[0]!.name = own[1]!.name = "동명 선수";
    const opponent = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const calls: GmToolCall[] = [];
    const tool = buildGmTools(state, calls).find((t) => t.name === "set_transfer_list")!;
    const ambiguous = await tool.handle({ playerId: "동명 선수", listed: true });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain(own[0]!.id);
    expect(ambiguous.message).toContain(own[1]!.id);
    expect((await tool.handle({ playerId: opponent.id, listed: true })).ok).toBe(false);
    state.phase = "match";
    expect((await tool.handle({ playerId: own[0]!.id, listed: true })).ok).toBe(false);
    state.phase = "idle";
    state.dismissal = {
      kind: "sacked",
      on: state.date,
      season: state.season,
      teamId: state.userTeamId,
      tier: 1,
    };
    expect((await tool.handle({ playerId: own[0]!.id, listed: true })).ok).toBe(false);
    expect(state.transferListings).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("main GM bounded negotiation context", () => {
  it("keeps visible refusal reasons and exact conditions without private player conversations or other threads", () => {
    const state = structuredClone(base);
    const own = state.players.find((p) => p.teamId === state.userTeamId)!;
    const buyer = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    const opened = openNegotiation(state, {
      playerId: own.id,
      buyerId: buyer,
      kind: "transfer",
      background: "매각",
    });
    const n = state.negotiations.find((item) => item.id === opened.negotiationId)!;
    const terms = {
      scope: "club" as const,
      fee: 12500000,
      installments: [],
      weeklyWage: 0,
      signingBonus: 0,
      since: addDays(state.date, 2),
      until: contractEndForYears(addDays(state.date, 2), 3),
      promises: [],
      expiresOn: addDays(state.date, 10),
    };
    expect(
      actNegotiation(state, n.id, { kind: "send", terms }, { kind: "model", partyId: buyer }).ok,
    ).toBe(true);
    expect(
      actNegotiation(
        state,
        n.id,
        {
          kind: "reject",
          proposalId: n.proposals[0]!.id,
          reason: "대체 선수가 없어 가격이 부족합니다",
        },
        { kind: "user", partyId: state.userTeamId },
      ).ok,
    ).toBe(true);
    const mail = sendMail(state, {
      requestId: "overview-visible",
      recipient: { kind: "club", teamId: buyer },
      subject: "가격 검토",
      body: "더 높은 가격이 필요합니다",
      negotiationId: n.id,
    });
    expect(mail.ok).toBe(true);
    sendMail(state, {
      requestId: "overview-private",
      recipient: { kind: "agent", playerId: own.id },
      subject: "개인 조건",
      body: "비밀 개인 급여 987654와 출전 약속",
      negotiationId: n.id,
    });
    const overview = managedNegotiationOverview(state);
    const serialized = JSON.stringify(overview);
    expect(serialized).toContain("대체 선수가 없어 가격이 부족합니다");
    expect(serialized).toContain('"fee":12500000');
    expect(serialized).toContain("더 높은 가격이 필요합니다");
    expect(serialized).not.toContain("비밀 개인 급여");
    expect(serialized).not.toContain("상대 구단 비밀 메모");
    expect(
      overview.cases[0]!.narrativeContext.latestExchange.every(
        (message) => message.excerpt.length <= 400,
      ),
    ).toBe(true);
    expect(overview.cases[0]!.narrativeContext.nonbinding).toBe(true);
  });
});

describe("main GM negotiation references", () => {
  function managerCase() {
    const state = structuredClone(base);
    const player = state.players.find((p) => p.teamId === state.userTeamId)!;
    player.name = "세네 라먼스";
    const team = state.teams.find((t) => t.id === state.userTeamId)!;
    const calls: GmToolCall[] = [];
    const tool = buildGmTools(state, calls).find((t) => t.name === "start_negotiation")!;
    return { state, player, team, tool, calls };
  }

  it("resolves a spoken player and club name to strict core IDs", async () => {
    vi.stubEnv("LLM_MODE", "mock");
    try {
      const { state, player, team, tool, calls } = managerCase();
      expect(
        (
          await tool.handle({
            playerId: "라먼스",
            buyerId: team.name,
            kind: "renewal",
            background: "재계약 협상 시작",
          })
        ).ok,
      ).toBe(true);
      expect(calls[0]?.payload).toBeUndefined();
      expect(state.negotiations[0]?.playerId).toBe(player.id);
      expect(state.negotiations[0]?.buyerId).toBe(team.id);
      expect(calls[0]?.summary).toContain(state.negotiations[0]!.id);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults only an omitted buyer and returns existing cases without regenerating an opening", async () => {
    vi.stubEnv("LLM_MODE", "mock");
    try {
      const { state, player, tool, calls } = managerCase();
      const request = { playerId: player.id, kind: "renewal", background: "재계약" };
      expect((await tool.handle(request)).ok).toBe(true);
      const before = structuredClone(state.negotiations);
      expect((await tool.handle(request)).ok).toBe(true);
      expect(state.negotiations).toEqual(before);
      const rejected = await tool.handle({ ...request, buyerId: "존재하지않는구단" });
      expect(rejected.ok).toBe(false);
      expect(rejected.message).toContain("get_team");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.summary).toContain(state.negotiations[0]!.id);
      expect(calls[1]?.payload).toBeUndefined();
      expect(state.negotiations).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects ambiguous players and clubs with real candidates", async () => {
    const { state, player, team, tool } = managerCase();
    const duplicate = state.players.find((p) => p.teamId === team.id && p.id !== player.id)!;
    duplicate.name = "세네 라먼스";
    const playerRejected = await tool.handle({
      playerId: "세네 라먼스",
      kind: "renewal",
      background: "재계약",
    });
    expect(playerRejected.ok).toBe(false);
    expect(playerRejected.message).toContain(player.id);
    expect(playerRejected.message).toContain(duplicate.id);
    expect(playerRejected.message).toContain("search_players");
    const other = state.teams.find((t) => t.id !== team.id)!;
    team.name = "맨체스터 유나이티드";
    other.name = "맨체스터 시티";
    const teamRejected = await tool.handle({
      playerId: player.id,
      buyerId: "맨체스터",
      kind: "renewal",
      background: "재계약",
    });
    expect(teamRejected.ok).toBe(false);
    expect(teamRejected.message).toContain(team.id);
    expect(teamRejected.message).toContain(other.id);
    expect(state.negotiations).toEqual([]);
  });

  it("keeps renewal selection inside the named club and does not bypass managed-club authority", async () => {
    const { state, player, tool } = managerCase();
    const opponent = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const sameNamed = state.players.find(
      (p) => p.teamId === state.userTeamId && p.id !== player.id,
    )!;
    sameNamed.name = opponent.name;
    expect(
      (
        await tool.handle({
          playerId: opponent.id,
          kind: "renewal",
          background: "정확한 외부 선수 지목",
        })
      ).ok,
    ).toBe(false);
    const rejected = await tool.handle({
      playerId: opponent.id,
      buyerId: opponent.teamId,
      kind: "renewal",
      background: "남의 구단 재계약",
    });
    expect(rejected.ok).toBe(false);
    expect(state.negotiations).toEqual([]);
  });
});

describe("date advancement with deterministic world", () => {
  it("finishes a seven-day skip after async daily reviews", async () => {
    vi.stubEnv("LLM_MODE", "mock");
    try {
      const state = structuredClone(base);
      for (const match of state.matches) match.date = addDays(state.date, 30);
      state.schedule = [];
      const target = addDays(state.date, 7);
      const result = await advanceOperationWithWorld(state, { kind: "skip_days", days: 7 });
      expect(state.date).toBe(target);
      expect(result?.stopped).toBe("reached");
      expect(state.marketReview.lastDate).toBe(target);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps the core's overall day cap across async resumptions", async () => {
    vi.stubEnv("LLM_MODE", "mock");
    try {
      const state = structuredClone(base);
      for (const match of state.matches) match.date = addDays(state.date, MAX_REQUESTED_DAYS + 30);
      state.schedule = [];
      const target = addDays(state.date, MAX_REQUESTED_DAYS);
      await advanceOperationWithWorld(state, { kind: "skip_days", days: MAX_REQUESTED_DAYS * 3 });
      expect(state.date).toBe(target);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

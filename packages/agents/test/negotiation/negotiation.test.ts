import { negotiationReference } from "../../src/negotiation/context";
import { managedNegotiationOverview } from "../../src/negotiation/overview";
import { contractEndForYears } from "@story-fm/domain";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_REQUESTED_DAYS,
  sendMail,
  dueMailReplies,
  agentForPlayer,
  actNegotiation,
  addDays,
  appendNegotiationMessage,
  openNegotiation,
  settleNegotiations,
  type GameState,
} from "@story-fm/engine";
import { agentConfig, ScriptedGameLLM, type GameLLM, type TurnRequest } from "@story-fm/llm";
import {
  progressNpcBuyerNegotiations,
  processMailReplies,
  replyToMail,
  mainMailOverview,
  historicalMailBudget,
  marketClubFingerprint,
  marketClubFacts,
  buildGmStateNote,
  type GmToolCall,
  buildGmTools,
  advanceOperationWithWorld,
  compactNegotiationHistory,
  negotiationHistory,
  processWorldMarket,
  runNegotiationTurn,
  suggestNegotiationOpening,
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
const config = () => agentConfig("negotiation-gm");

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
  it("progresses only an agreed NPC buyer sale, waits for actual medical and reports completion once", () => {
    const state = structuredClone(base),
      seller = state.userTeamId;
    const player = state.players.find((p) => p.teamId === seller)!;
    const buyer = state.teams.find(
      (t) => t.id !== seller && state.finances.some((f) => f.teamId === t.id),
    )!.id;
    state.injuries = state.injuries.filter((i) => i.gamePlayerId !== player.id);
    const opened = openNegotiation(state, {
      kind: "transfer",
      playerId: player.id,
      buyerId: buyer,
      background: "매각 논의",
    });
    const n = state.negotiations.find((n) => n.id === opened.negotiationId)!;
    const since = addDays(state.date, 2);
    const common = {
      fee: 0,
      weeklyWage: 0,
      signingBonus: 0,
      installments: [],
      since,
      until: contractEndForYears(since, 3),
      promises: [],
      expiresOn: addDays(state.date, 14),
    };
    expect(
      actNegotiation(
        state,
        n.id,
        {
          kind: "send",
          terms: {
            ...common,
            scope: "club",
            fee: Math.floor((n.bounds.minFee + n.bounds.maxFee) / 2),
          },
        },
        { kind: "model", partyId: buyer },
      ).ok,
    ).toBe(true);
    expect(
      actNegotiation(
        state,
        n.id,
        {
          kind: "send",
          terms: {
            ...common,
            scope: "player",
            weeklyWage: Math.floor((n.bounds.minWeeklyWage + n.bounds.maxWeeklyWage) / 2),
          },
        },
        { kind: "model", partyId: buyer },
      ).ok,
    ).toBe(true);
    const club = n.proposals.find((p) => p.terms.scope === "club")!,
      personal = n.proposals.find((p) => p.terms.scope === "player")!;
    expect(
      actNegotiation(
        state,
        n.id,
        { kind: "accept", proposalId: personal.id },
        { kind: "model", partyId: player.id },
      ).ok,
    ).toBe(true);
    progressNpcBuyerNegotiations(state);
    expect(n.medical).toBeNull();
    expect(n.signed).toBeNull();
    expect(
      actNegotiation(
        state,
        n.id,
        { kind: "accept", proposalId: club.id },
        { kind: "user", partyId: seller },
      ).ok,
    ).toBe(true);
    progressNpcBuyerNegotiations(state);
    expect(n.medical?.examinedOn).toBeNull();
    expect(n.signed).toBeNull();
    state.date = addDays(state.date, 1);
    settleNegotiations(state);
    const medical = n.medical!;
    medical.injuries.push({
      id: "medical-risk",
      gamePlayerId: player.id,
      bodyPart: "무릎",
      severity: "minor",
      cause: "other",
      occurredOn: state.date,
      expectedReturn: addDays(state.date, 3),
      returnedOn: null,
    });
    progressNpcBuyerNegotiations(state);
    expect(n.signed).toBeNull();
    medical.injuries = [];
    progressNpcBuyerNegotiations(state);
    expect(n.status).toBe("signed");
    state.date = since;
    settleNegotiations(state);
    progressNpcBuyerNegotiations(state);
    expect(n.status).toBe("completed");
    expect(player.teamId).toBe(buyer);
    const moves = state.moves.length,
      mail = state.mailThreads
        .flatMap((t) => t.messages)
        .filter((m) => m.subject.includes("이적 완료"));
    expect(mail).toHaveLength(1);
    progressNpcBuyerNegotiations(state);
    expect(state.moves).toHaveLength(moves);
    expect(
      state.mailThreads.flatMap((t) => t.messages).filter((m) => m.subject.includes("이적 완료")),
    ).toHaveLength(1);
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

describe("player representative context", () => {
  it("keeps the seeded representative and player consent identity across opening and contract replies", async () => {
    const { state, n } = setup();
    const agent = agentForPlayer(state, n.playerId);
    const representative = {
      partyId: n.playerId,
      name: agent?.name ?? "선수 대리인",
      lorebookId: agent ? `person:${agent.characterId}` : null,
    };
    const namedReference = JSON.parse(
      negotiationReference(
        n,
        [],
        [
          {
            id: "person:representative",
            name: "계약 대리인",
            role: "agent",
            information: "선수 계약 대리",
          },
        ],
      ),
    ) as { playerRepresentative: { partyId: string; name: string; lorebookId: string } };
    expect(namedReference.playerRepresentative).toEqual({
      partyId: n.playerId,
      name: "계약 대리인",
      lorebookId: "person:representative",
    });
    const expected = JSON.stringify(representative);
    const opening = new ScriptedGameLLM(config(), (request) => {
      expect(request.system).toContainEqual(expect.stringContaining(expected));
      expect(request.tools).toBeUndefined();
      return { output: { suggestion: "대리인과 계약 조건을 논의하고 싶습니다." } };
    });
    await suggestNegotiationOpening(state, n.id, opening);
    const reply = new ScriptedGameLLM(config(), (request) => {
      expect(request.system).toContainEqual(expect.stringContaining(expected));
      expect(request.user).toBe("[player] 계약 기간을 논의합시다.");
      return { text: `@${representative.name}: 선수의 계약 조건을 논의하겠습니다.` };
    });
    await runNegotiationTurn(state, n.id, "player", "계약 기간을 논의합시다.", reply);
    expect(state.negotiations.find((item) => item.id === n.id)?.proposals).toHaveLength(0);
  });
});

describe("opening suggestion boundary", () => {
  it("retries invalid structured output without tools or ledger writes", async () => {
    const { state, n } = setup();
    const before = structuredClone(state);
    let calls = 0;
    const llm = new ScriptedGameLLM(config(), (request) => {
      expect(request.tools).toBeUndefined();
      calls += 1;
      return {
        output:
          calls === 1
            ? { suggestion: "초안", accepted: true }
            : { suggestion: "조건을 논의하고 싶습니다." },
      };
    });
    expect(await suggestNegotiationOpening(state, n.id, llm)).toBe("조건을 논의하고 싶습니다.");
    expect(calls).toBe(2);
    expect(state).toEqual(before);
  });
});

describe("main GM transfer listings", () => {
  it("resolves our player's name, records exact price, and reflects listings without a case or consent", async () => {
    const state = structuredClone(base);
    const player = state.players.find((p) => p.teamId === state.userTeamId)!;
    player.name = "이적 명단 선수";
    const originalFingerprint = marketClubFingerprint(state, state.userTeamId);
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
    expect(marketClubFingerprint(state, state.userTeamId)).not.toBe(originalFingerprint);
    expect(marketClubFacts(state, state.userTeamId).transferListings).toEqual(
      state.transferListings,
    );
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
    appendNegotiationMessage(state, n, "player", "gm", "비밀 개인 급여 987654와 출전 약속", own.id);
    appendNegotiationMessage(state, n, "internal", "gm", "상대 구단 비밀 메모", buyer);
    appendNegotiationMessage(
      state,
      n,
      "club",
      "manager",
      "왜 가격을 올려야 하나?",
      state.userTeamId,
    );
    appendNegotiationMessage(
      state,
      n,
      "club",
      "gm",
      "대체 선수가 없어 더 높은 가격이 필요합니다." + "지워질 과거".repeat(200),
      buyer,
    );
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
      expect(state.negotiations[0]?.messages.some((message) => message.author === "gm")).toBe(
        false,
      );
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

describe("one negotiation GM and exact consent", () => {
  it("shares all channels but never receives another case's messages", async () => {
    const { state, n } = setup();
    appendNegotiationMessage(state, n, "club", "manager", "클럽 조건 논의");
    appendNegotiationMessage(state, n, "player", "gm", "선수 역할 우려", n.playerId);
    const other = structuredClone(n);
    other.id = "unrelated-case";
    other.messages = [];
    appendNegotiationMessage(state, other, "internal", "gm", "다른 협상 비밀");
    state.negotiations.push(other);
    let seen: TurnRequest | undefined;
    const llm = new ScriptedGameLLM(config(), (req) => {
      seen = req;
      return { text: "같은 건의 양측 입장을 확인했습니다" };
    });
    await runNegotiationTurn(state, n.id, "internal", undefined, llm);
    const history = JSON.stringify(seen?.history);
    expect(history).toContain("클럽 조건 논의");
    expect(history).toContain("선수 역할 우려");
    expect(history).toContain(n.playerId);
    expect(history).not.toContain("다른 협상 비밀");
    expect(negotiationHistory(other)[0]?.content).toContain("다른 협상 비밀");
  });

  it("rolls back model actions when the provider fails after a tool", async () => {
    const { state, n } = setup();
    const before = structuredClone(state);
    const llm: GameLLM = {
      async runTurn(req) {
        const tool = req.tools?.find((t) => t.name === "negotiation_action");
        const result = await tool?.handle({
          partyId: n.sellerId,
          action: { kind: "withdraw", reason: "다른 대안" },
        });
        expect(result?.ok).toBe(true);
        throw new Error("provider offline");
      },
    };
    await expect(runNegotiationTurn(state, n.id, "club", undefined, llm)).rejects.toThrow(
      "provider offline",
    );
    expect(state).toEqual(before);
  });

  it("records discussed terms and a counterpart offer while awaiting explicit managed consent", async () => {
    const { state, n } = setup();
    const terms = {
      scope: "player" as const,
      fee: 0,
      installments: [],
      weeklyWage: Math.floor((n.bounds.minWeeklyWage + n.bounds.maxWeeklyWage) / 2),
      signingBonus: 0,
      since: addDays(state.date, 2),
      until: contractEndForYears(addDays(state.date, 2), 4),
      promises: [],
      expiresOn: addDays(state.date, 10),
    };
    const message = "4년 계약에 주급 9만, 계약 보너스 50만으로 이야기해보자. 좋아.";
    appendNegotiationMessage(state, n, "player", "manager", message, state.userTeamId);
    n.digest = { through: 0, text: "감독이 모든 조건에 동의했다" };
    const llm = new ScriptedGameLLM(config(), () => ({
      calls: [
        {
          tool: "negotiation_action",
          input: { partyId: state.userTeamId, action: { kind: "draft", terms } },
        },
        {
          tool: "negotiation_action",
          input: { partyId: n.playerId, action: { kind: "send", terms } },
        },
        {
          tool: "negotiation_action",
          input: {
            partyId: state.userTeamId,
            action: { kind: "accept", proposalId: `${n.id}-p1` },
          },
        },
      ],
      text: "@선수: 해당 조건을 제안합니다. 정확한 조건을 확인하고 합의해 주세요.",
    }));
    await runNegotiationTurn(state, n.id, "player", message, llm);
    const updated = state.negotiations.find((item) => item.id === n.id)!;
    expect(updated.proposals[0]!.terms).toEqual(terms);
    expect(updated.proposals[0]!.acceptedBy).toEqual([n.playerId]);
    expect(updated.signed).toBeNull();
    expect(
      actNegotiation(
        state,
        n.id,
        { kind: "accept", proposalId: updated.proposals[0]!.id },
        { kind: "user", partyId: state.userTeamId },
      ).ok,
    ).toBe(true);
    expect(updated.proposals[0]!.acceptedBy).toEqual([n.playerId, state.userTeamId]);
  });

  it.each(["renewal", "free", "transfer", "sale"] as const)(
    "mock %s dialogue yields a counterpart offer without managed consent",
    async (kind) => {
      vi.stubEnv("LLM_MODE", "mock");
      try {
        const state = structuredClone(base);
        const ownPlayer = state.players.find((p) => p.teamId === state.userTeamId)!;
        const awayPlayer = state.players.find((p) => p.teamId !== state.userTeamId)!;
        const player = kind === "renewal" || kind === "sale" ? ownPlayer : awayPlayer;
        if (kind === "free") {
          player.teamId = "freeagents";
          for (const contract of state.contracts.filter((c) => c.gamePlayerId === player.id))
            contract.status = "ended";
        }
        const opened = openNegotiation(state, {
          playerId: player.id,
          buyerId: kind === "sale" ? awayPlayer.teamId : state.userTeamId,
          kind: kind === "sale" ? "transfer" : kind,
          background: "조건을 논의하자",
        });
        expect(opened.ok).toBe(true);
        await runNegotiationTurn(
          state,
          opened.negotiationId!,
          kind === "sale" ? "club" : "player",
          "조건을 제안해 주세요",
        );
        const n = state.negotiations.find((item) => item.id === opened.negotiationId)!;
        expect(n.proposals.length).toBeGreaterThan(0);
        expect(
          n.proposals.every(
            (p) => p.author !== state.userTeamId && !p.acceptedBy.includes(state.userTeamId),
          ),
        ).toBe(true);
        expect(n.signed).toBeNull();
        const before = structuredClone(n.proposals);
        const proposal = n.proposals.find(
          (p) => p.terms.scope === (kind === "sale" ? "club" : "player"),
        )!;
        expect(
          actNegotiation(
            state,
            n.id,
            { kind: "accept", proposalId: proposal.id },
            { kind: "user", partyId: state.userTeamId },
          ).ok,
        ).toBe(true);
        await runNegotiationTurn(state, n.id, kind === "sale" ? "club" : "player");
        expect(
          state.negotiations.find((item) => item.id === n.id)!.proposals.map((p) => p.terms),
        ).toEqual(before.map((p) => p.terms));
        if (kind === "renewal") {
          const renewed = state.negotiations.find((item) => item.id === n.id)!;
          expect(renewed.medical).toBeNull();
          expect(renewed.signed).toBeNull();
          expect(
            actNegotiation(
              state,
              renewed.id,
              { kind: "sign" },
              { kind: "user", partyId: state.userTeamId },
            ).ok,
          ).toBe(true);
          expect(renewed.status).toBe("completed");
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("retains full messages and previous digest on compaction failure", async () => {
    const { state, n } = setup();
    for (let i = 0; i < 12; i++)
      appendNegotiationMessage(state, n, "club", "gm", `${i}${"쟁점".repeat(1600)}`);
    const before = structuredClone(n);
    const llm: GameLLM = {
      async runTurn() {
        throw new Error("digest unavailable");
      },
    };
    expect(await compactNegotiationHistory(state, n.id, llm)).toBe(false);
    expect(n).toEqual(before);
  });
});

describe("date-driven world review", () => {
  it("delivers a new or reopened world inquiry once without a separate user negotiation turn", async () => {
    const state = structuredClone(base);
    const player = state.players.find((p) => p.teamId === state.userTeamId)!;
    const buyer = state.teams.find(
      (t) => t.id !== state.userTeamId && state.finances.some((f) => f.teamId === t.id),
    )!;
    const planner = new ScriptedGameLLM(agentConfig("market-planner"), (request) => {
      const input = JSON.parse(request.stateNote ?? "{}") as { clubs: { team: { id: string } }[] };
      return {
        output: {
          clubs: input.clubs.map((c) => ({ teamId: c.team.id, plan: "선수 검토" })),
          negotiations: input.clubs.some((c) => c.team.id === buyer.id)
            ? [
                {
                  kind: "transfer",
                  playerId: player.id,
                  buyerId: buyer.id,
                  background: "실제 명단에 근거한 영입 문의",
                },
              ]
            : [],
          board: [],
        },
      };
    });
    const noUserGm: GameLLM = {
      async runTurn() {
        throw new Error("user independent GM must not run");
      },
    };
    await processWorldMarket(state, planner, noUserGm);
    const id = state.negotiations[0]!.id;
    expect(state.mailThreads[0]?.messages).toHaveLength(1);
    expect(state.mailThreads[0]?.messages[0]?.direction).toBe("inbound");
    expect(state.mailReplyJobs).toHaveLength(0);
    expect(state.negotiations[0]?.messages.some((m) => m.author === "gm")).toBe(false);
    await processWorldMarket(state, planner, noUserGm);
    expect(state.mailThreads[0]?.messages).toHaveLength(1);
    expect(
      actNegotiation(
        state,
        id,
        { kind: "withdraw", reason: "새 조건 검토" },
        { kind: "user", partyId: state.userTeamId },
      ).ok,
    ).toBe(true);
    state.date = addDays(state.date, 7);
    await processWorldMarket(state, planner, noUserGm);
    expect(state.negotiations[0]?.id).toBe(id);
    expect(state.mailThreads[0]?.messages).toHaveLength(2);
  });

  it("completes an AI renewal through the mock GM and the same dated core", async () => {
    vi.stubEnv("LLM_MODE", "mock");
    try {
      const state = structuredClone(base);
      const player = state.players.find(
        (p) =>
          p.teamId !== state.userTeamId &&
          state.contracts.some((c) => c.gamePlayerId === p.id && c.status === "active"),
      )!;
      const old = state.contracts.find(
        (c) => c.gamePlayerId === player.id && c.status === "active",
      )!;
      const opened = openNegotiation(
        state,
        {
          playerId: player.id,
          buyerId: player.teamId,
          kind: "renewal",
          background: "계약 기간 연장",
        },
        "world",
      );
      expect(opened.ok).toBe(true);
      const firstDate = state.date;
      for (let day = 0; day <= 8; day++) {
        state.date = addDays(firstDate, day);
        settleNegotiations(state);
        const current = state.negotiations.find((n) => n.id === opened.negotiationId)!;
        if (current.status === "open") await runNegotiationTurn(state, current.id);
      }
      const current = state.negotiations.find((n) => n.id === opened.negotiationId)!;
      expect(current.status).toBe("completed");
      expect(current.medical).toBeNull();
      const renewed = state.contracts.find(
        (c) => c.gamePlayerId === player.id && c.status === "active",
      )!;
      expect(renewed.id).not.toBe(old.id);
      expect(renewed.until > old.until).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("replaces elapsed mock terms before requesting later consent", async () => {
    vi.stubEnv("LLM_MODE", "mock");
    try {
      const state = structuredClone(base);
      const player = state.players.find((p) => p.teamId !== state.userTeamId)!;
      const opened = openNegotiation(
        state,
        { playerId: player.id, buyerId: player.teamId, kind: "renewal", background: "갱신 제안" },
        "world",
      );
      await runNegotiationTurn(state, opened.negotiationId!);
      state.date = addDays(state.date, 8);
      await runNegotiationTurn(state, opened.negotiationId!);
      const proposals = state.negotiations.find((n) => n.id === opened.negotiationId)!.proposals;
      expect(proposals[0]?.status).toBe("superseded");
      expect(proposals.at(-1)!.terms.since > state.date).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
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
  it("retries a failed due reply on the same reviewed date without replaying planning", async () => {
    const { state, n } = setup();
    state.userTeamId = state.teams.find(
      (t) =>
        ![n.buyerId, n.sellerId].includes(t.id) && state.finances.some((f) => f.teamId === t.id),
    )!.id;
    state.marketReview.lastDate = state.date;
    n.nextReplyOn = state.date;
    const failed: GameLLM = {
      async runTurn() {
        throw new Error("temporary outage");
      },
    };
    await expect(processWorldMarket(state, undefined, failed)).rejects.toThrow("temporary outage");
    expect(state.negotiations[0]?.nextReplyOn).toBe(state.date);
    const reply = new ScriptedGameLLM(config(), () => ({ text: "협상 답변을 재개합니다" }));
    expect(await processWorldMarket(state, failed, reply)).toEqual({ reviewed: 0, replied: 1 });
    expect(state.negotiations.find((item) => item.id === n.id)?.nextReplyOn).toBe(
      addDays(state.date, 1),
    );
  });
  it("bounds each day's planning and rotates clubs without replay on reads", async () => {
    const state = structuredClone(base);
    const calls: string[][] = [];
    const llm = new ScriptedGameLLM(agentConfig("market-planner"), (req) => {
      const snapshot = JSON.parse(req.stateNote ?? "{}") as { clubs: { team: { id: string } }[] };
      const ids = snapshot.clubs.map((c) => c.team.id);
      calls.push(ids);
      return {
        output: {
          clubs: ids.map((teamId) => ({ teamId, plan: "명단과 만료 계약을 검토했습니다" })),
          negotiations: [],
          board: [],
        },
      };
    });
    await processWorldMarket(state, llm);
    const first = calls.flat();
    expect(first.length).toBeLessThanOrEqual(12);
    const firstCount = calls.length;
    expect(await processWorldMarket(state, llm)).toEqual({ reviewed: 0, replied: 0 });
    expect(calls.length).toBe(firstCount);
    state.date = addDays(state.date, 1);
    await processWorldMarket(state, llm);
    const second = calls.slice(firstCount).flat();
    expect(second.some((id) => first.includes(id))).toBe(false);
    expect(second.length).toBeLessThanOrEqual(12);
  });
});

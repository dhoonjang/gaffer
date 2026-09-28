import {
  ScoutingPlanSchema,
  ScoutingAssessmentSchema,
  type ScoutingRequest,
  type ScoutingPlan,
  type ScoutingAssessment,
} from "@story-fm/domain";
import type { GameEvaluator } from "@story-fm/llm";
import {
  evaluateChoices,
  evaluateNumber,
  type ContextChoice,
} from "../common/contextual-evaluation";

const yesNo = { yes: "Supported by the supplied evidence", no: "Not supported; leave unknown" };
const topics = ["ability", "role", "development", "availability", "contract"] as const;

export async function evaluateScoutingPlan(
  request: ScoutingRequest,
  context: string,
  evaluator: GameEvaluator,
): Promise<ScoutingPlan> {
  const state = JSON.stringify({ request, context });
  const questions: Record<string, ContextChoice> = {
    status: {
      instructions:
        "Can the requested investigation proceed within the manager's scope and deadline? Judge actual access and workload, not fixed slots.",
      criteria: {
        ready: "A useful report can be delivered within authorization",
        needs_revision: "Needs a material scope/deadline change requiring the manager's decision",
        unavailable: "Cannot investigate from available sources",
      },
    },
    depth: {
      instructions:
        "What observation can this investigation realistically provide? This describes sources, not statistical accuracy or a guaranteed rating.",
      criteria: {
        public_records: "Public profile and contract records only",
        match_review: "Analysis of accessible match evidence",
        extended_review: "Comparison of several actual matches and historical evidence",
      },
    },
  };
  for (const topic of topics) {
    questions[`focus_${topic}`] = {
      instructions: `Does the manager's question require investigating ${topic}?`,
      criteria: yesNo,
    };
    questions[`precision_${topic}`] = {
      instructions: `What information quality about ${topic} can this investigation realistically provide by the proposed report date? Expected precision is not a statistical probability or a guarantee.`,
      criteria: {
        unknown: "Likely unable to establish this from accessible evidence",
        broad: "A provisional estimate with substantial uncertainty",
        supported: "A reasoned assessment grounded in sufficient accessible evidence",
      },
    };
  }
  const limitations = [
    "no_matches",
    "no_recent_matches",
    "limited_access",
    "workload",
    "deadline",
    "no_candidates",
  ] as const;
  for (const key of limitations)
    questions[`limit_${key}`] = {
      instructions: `Is ${key} a material limitation supported by this context?`,
      criteria: yesNo,
    };
  const selected = await evaluateChoices(state, questions, evaluator);
  const days =
    selected.status === "ready"
      ? await evaluateNumber(
          state,
          "How many calendar days from today until this report can be delivered? Use actual matches, access, scope, workload and requested deadline. Zero only for already available evidence. Do not reuse a fixed scouting duration.",
          { min: 0, max: 36525 },
          evaluator,
        )
      : 0;
  const focus = topics.filter((topic) => selected[`focus_${topic}`] === "yes");
  return ScoutingPlanSchema.parse({
    status: selected.status,
    depth: selected.depth,
    days,
    focus,
    expectations: focus.map((topic) => ({ topic, precision: selected[`precision_${topic}`] })),
    evidenceRefs: [],
    limitations: limitations.filter((key) => selected[`limit_${key}`] === "yes"),
  });
}

/** Batch size limits request payload only. Every investigated player is assessed; no top-N truncation. */
const EVIDENCE_BATCH_SIZE = 24;

export async function evaluateScoutingReport(
  request: ScoutingRequest,
  evaluator: GameEvaluator,
): Promise<ScoutingAssessment[]> {
  const assessments: ScoutingAssessment[] = [];
  for (let start = 0; start < request.evidence.length; start += EVIDENCE_BATCH_SIZE) {
    const evidence = request.evidence.slice(start, start + EVIDENCE_BATCH_SIZE);
    const context = JSON.stringify({
      question: request.question,
      scope: request.scope,
      plan: request.plan,
      asOf: request.evidenceOn,
      evidence,
    });
    const questions: Record<string, ContextChoice> = {};
    evidence.forEach((player, index) => {
      questions[`fit_${index}`] = {
        instructions: `Assess player ${player.playerId} against the manager's question using only supplied evidence. A profile alone does not establish talent or motivation. A recorded transfer fee is a dated reference, not the present asking price. Unknown price does not establish affordability.`,
        criteria: {
          recommended: "Evidence supports recommending this candidate",
          consider: "Worth considering with stated uncertainty",
          unsuitable: "Evidence contradicts the requirements",
          unknown: "Insufficient evidence to judge",
        },
      };
      questions[`source_${index}`] = {
        instructions: `Select the strongest source actually supporting your assessment of ${player.playerId}; choose none if unsupported.`,
        criteria: {
          none: "No supporting evidence",
          ...Object.fromEntries(
            player.sources.map((source, n) => [String(n), `${source.id}: ${source.text}`]),
          ),
        },
      };
      for (const topic of [
        "performance",
        "role",
        "development",
        "availability",
        "contract",
      ] as const) {
        questions[`strength_${index}_${topic}`] = {
          instructions: `For ${player.playerId}, does supplied evidence substantiate ${topic} as a strength for this request?`,
          criteria: yesNo,
        };
        questions[`concern_${index}_${topic}`] = {
          instructions: `For ${player.playerId}, does supplied evidence substantiate ${topic} as a concern for this request?`,
          criteria: yesNo,
        };
      }
    });
    const selected = await evaluateChoices(context, questions, evaluator);
    for (const [index, player] of evidence.entries()) {
      const scoped = JSON.stringify({
        question: request.question,
        plan: request.plan,
        asOf: request.evidenceOn,
        player,
      });
      const assessment: ScoutingAssessment = {
        playerId: player.playerId,
        fit: selected[`fit_${index}`] as ScoutingAssessment["fit"],
        overall: null,
        potential: null,
        attributes: {},
        evidenceRefs: [],
        strengths: [],
        concerns: [],
      };
      for (const topic of [
        "performance",
        "role",
        "development",
        "availability",
        "contract",
      ] as const) {
        if (selected[`strength_${index}_${topic}`] === "yes") assessment.strengths.push(topic);
        if (selected[`concern_${index}_${topic}`] === "yes") assessment.concerns.push(topic);
      }
      if (assessment.fit === "unknown") assessment.concerns.push("insufficient_evidence");
      // Selecting provenance explicitly prevents a plausible recommendation from inventing a source.
      const sourceIndex = selected[`source_${index}`];
      const source = sourceIndex === "none" ? undefined : player.sources[Number(sourceIndex)];
      const refs = source ? [source.id] : [];
      assessment.evidenceRefs = refs;
      const observed = refs.some(
        (id) => id.startsWith("match:") || id.startsWith("report:") || id.startsWith("season:"),
      );
      if (observed && assessment.fit !== "unsuitable") {
        const known = await evaluateChoices(
          scoped,
          {
            overall: {
              instructions:
                "Does this evidence permit a numerical estimate of current football ability? Scorelines or appearances alone do not identify an individual's ability. Return no when uncertain.",
              criteria: yesNo,
            },
            potential: {
              instructions:
                "Does longitudinal evidence support estimating future ability? Age alone, fixed age curves, or a past ungrounded guess do not establish potential. Return no if insufficient.",
              criteria: yesNo,
            },
          },
          evaluator,
        );
        for (const field of ["overall", "potential"] as const) {
          if (known[field] !== "yes") continue;
          const low = await evaluateNumber(
            scoped,
            `Estimate the lower endpoint of ${field} on the game's 1–99 rating scale using only selected evidence. It is an uncertain estimate, not hidden truth.`,
            { min: 1, max: 99 },
            evaluator,
          );
          const high = await evaluateNumber(
            `${scoped}\nLower endpoint: ${low}`,
            `Estimate the upper endpoint of ${field}. Include uncertainty from sample size, role and changing circumstances.`,
            { min: low, max: 99 },
            evaluator,
          );
          assessment[field] = { low, high };
        }
      }
      assessments.push(ScoutingAssessmentSchema.parse(assessment));
    }
  }
  return assessments;
}

import { INJURY_SEVERITY_KO, TRAINING_MARK_KO, type TrainingReport } from "@story-fm/domain";
import type { GameState } from "../../common/core/state";
import { managedTeamId } from "../../common/core/state";
import { recordMailReport } from "../../common/mail/mail";
import { staffOf } from "../../common/people/persona";
export function deliverCoreReportMail(state: GameState): void {
  const team = managedTeamId(state);
  if (!team) return;
  const medic = staffOf({ ...state, userTeamId: team }, "medic")[0];
  if (medic)
    for (const n of state.negotiations)
      if (n.buyerId === team && n.medical?.examinedOn)
        recordMailReport(state, {
          key: `medical:${n.id}:${n.medical.examinedOn}`,
          recipient: { kind: "staff", personId: medic.characterId },
          subject: "메디컬 검사 결과",
          body: [
            `${state.players.find((p) => p.id === n.playerId)?.name ?? n.playerId} · 검사일 ${n.medical.examinedOn}`,
            ...(n.medical.injuries.length
              ? n.medical.injuries.map(
                  (i) =>
                    `${i.bodyPart} ${INJURY_SEVERITY_KO[i.severity]} · 예상 복귀 ${i.expectedReturn}`,
                )
              : ["현재 진행 중인 부상 기록은 없습니다."]),
          ].join("\n"),
          negotiationId: n.id,
          references: { playerIds: [n.playerId], proposalIds: [], reportIds: [] },
        });
}
export function deliverTrainingReportMail(state: GameState, r: TrainingReport): void {
  const team = managedTeamId(state);
  if (!team) return;
  const coach = staffOf({ ...state, userTeamId: team }, "coach")[0];
  if (coach)
    recordMailReport(state, {
      key: `training:${r.from}:${r.to}`,
      recipient: { kind: "staff", personId: coach.characterId },
      subject: "훈련 결과 보고",
      body: [
        `${r.from} ~ ${r.to} · 훈련 ${r.sessions}회`,
        ...r.marks
          .slice(0, 20)
          .map(
            (mark) =>
              `${state.players.find((p) => p.id === mark.gamePlayerId)?.name ?? mark.gamePlayerId}: ${mark.code ? TRAINING_MARK_KO[mark.code] : "훈련 관찰"}${mark.note ? ` · ${mark.note}` : ""}`,
          ),
        ...(r.marks.length ? [] : ["새로운 선수별 관찰 사항은 없습니다."]),
      ]
        .join("\n")
        .slice(0, 12000),
      references: {
        playerIds: [...new Set([...r.moved, ...r.marks].map((p) => p.gamePlayerId))]
          .filter((id) => state.players.some((p) => p.id === id))
          .slice(0, 20),
        proposalIds: [],
        reportIds: [],
      },
    });
}

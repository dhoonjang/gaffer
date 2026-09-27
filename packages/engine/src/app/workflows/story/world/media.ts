import { type GameState, pushMedia } from "../../../../common/core/state";
import { predictionsDue, standPredictions } from "../../../../match/competition/prediction";
import { predictionReport, punditVerdict } from "../../../../story/world/media";

/**
 * 하루치 언론 — tick이 매일 한 번 부른다 (people.md §4-1).
 *
 * 예상표는 프리시즌에 리그마다 한 번 서고, 그 표가 **새로 선 날**에만 기사가 된다.
 * 평가는 우리 리그 다섯 경기마다다. 경질·부임은 그 일이 일어난 자리(감독 시장)가
 * 직접 적는다 — 그날의 순위와 재임 일수는 후임이 앉는 순간 사라지는 사실이라
 * 하루 뒤에 되짚을 수 없다.
 */
export function tickMedia(state: GameState): void {
  if (predictionsDue(state) && standPredictions(state).length > 0) {
    const report = predictionReport(state);
    if (report) pushMedia(state, [report]);
  }
  const verdict = punditVerdict(state);
  if (verdict) pushMedia(state, [verdict]);
}

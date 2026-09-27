/**
 * 원형(circle method) 라운드로빈 + 홈/어웨이 교대 — **각 라운드가 완전 매칭**이다.
 * 리그 전반기 편성이자 대항전 리그 페이즈의 기반 (europe.ts).
 */
export function firstHalfPairs(teamIds: string[]): Array<Array<[string, string]>> {
  const n = teamIds.length;
  const fixed = n - 1;
  const rounds: Array<Array<[string, string]>> = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[string, string]> = [];
    // 고정 팀은 라운드 짝홀로 홈/어웨이를 번갈아 갖는다
    const opponent = r % fixed;
    pairs.push(
      r % 2 === 0 ? [teamIds[fixed]!, teamIds[opponent]!] : [teamIds[opponent]!, teamIds[fixed]!],
    );
    for (let i = 1; i < n / 2; i++) {
      const a = (r + i) % fixed;
      const b = (((r - i) % fixed) + fixed) % fixed;
      pairs.push(i % 2 === 0 ? [teamIds[a]!, teamIds[b]!] : [teamIds[b]!, teamIds[a]!]);
    }
    rounds.push(pairs);
  }
  return rounds;
}

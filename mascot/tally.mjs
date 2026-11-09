// 마감 뒤 owner(또는 staffTally 켠 운영진)가 쓰는 집계 함수. 순수 함수라 브라우저/노드 둘 다 사용 가능.
// votes: [{ tok, e }]  (votes 컬렉션: 문서 id = 탑승권 토큰)
// participants: Map|object tok -> { status, test }   (운영진은 participants 목록 권한이 이미 있다)
// entries: Map|object id -> { on }
// 반환: 작품별 유효표, 제외 사유별 개수. 개별 토큰·선택은 반환하지 않는다(결과 문서에 그대로 써도 안전).
export function tally(votes, participants, entries, { allowTest = false } = {}) {
  const P = participants instanceof Map ? participants : new Map(Object.entries(participants));
  const E = entries instanceof Map ? entries : new Map(Object.entries(entries));
  const counts = {};
  for (const [id, en] of E) if (en && en.on !== false) counts[id] = 0;
  const excluded = { cancelled: 0, missingPass: 0, test: 0, entryOff: 0 };
  let valid = 0;
  for (const v of votes) {
    const p = P.get(v.tok);
    if (!p) { excluded.missingPass++; continue; }
    if (p.status !== 'active') { excluded.cancelled++; continue; }   // 투표 뒤 참가 취소된 탑승권
    if (p.test === true && !allowTest) { excluded.test++; continue; }
    if (!(v.e in counts)) { excluded.entryOff++; continue; }         // 꺼지거나 지워진 작품
    counts[v.e]++; valid++;
  }
  return { counts, valid, excluded };
}

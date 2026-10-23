export async function hashString(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function showAlert(elementId, message, type = 'error') {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  if (type !== 'info') setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
}

export function formatDatetime(dateStr, timeStr) {
  const d = new Date(`${dateStr}T${timeStr}`);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]}) ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function formatTimestamp(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Generate all round-robin match pairs from player ID list
export function generateMatchPairs(playerIds) {
  const pairs = [];
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      pairs.push({ player1Id: playerIds[i], player2Id: playerIds[j], result: null, winnerId: null, reportedBy: null, reportedAt: null });
    }
  }
  return pairs;
}

// Calculate standings from players/matches/scoring config
export function calculateStandings(players, matches, scoring) {
  const stats = {};
  players.forEach(p => {
    stats[p.id] = { id: p.id, name: p.name, wins: 0, losses: 0, draws: 0, played: 0, total: players.length - 1, bonusPoints: p.bonusPoints || 0 };
  });

  matches.forEach(m => {
    if (!m.result) return;
    if (m.result === 'player1') {
      if (stats[m.player1Id]) { stats[m.player1Id].wins++; stats[m.player1Id].played++; }
      if (stats[m.player2Id]) { stats[m.player2Id].losses++; stats[m.player2Id].played++; }
    } else if (m.result === 'player2') {
      if (stats[m.player2Id]) { stats[m.player2Id].wins++; stats[m.player2Id].played++; }
      if (stats[m.player1Id]) { stats[m.player1Id].losses++; stats[m.player1Id].played++; }
    } else if (m.result === 'draw' || m.result === 'noGame') {
      if (stats[m.player1Id]) { stats[m.player1Id].draws++; stats[m.player1Id].played++; }
      if (stats[m.player2Id]) { stats[m.player2Id].draws++; stats[m.player2Id].played++; }
    }
  });

  return Object.values(stats)
    .map(s => ({ ...s, points: s.wins * scoring.win + s.losses * scoring.loss + s.draws * scoring.noGame + s.bonusPoints }))
    .sort((a, b) => b.points !== a.points ? b.points - a.points : b.wins - a.wins);
}

// 기력은 정렬을 위해 숫자로 저장: n단 = 100+n, n급 = 100-n
export function parseRank(str) {
  const m = String(str).replace(/\s/g, '').match(/^(\d{1,2})(단|급)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  if (m[2] === '단' && n >= 1 && n <= 9) return 100 + n;
  if (m[2] === '급' && n >= 1 && n <= 30) return 100 - n;
  return null;
}

export function formatRank(num) {
  if (num == null || num === 0 || num === 100) return '-';
  return num > 100 ? `${num - 100}단` : `${100 - num}급`;
}

export const STONE_OPTIONS = ['호선', '정선', '2점', '3점', '4점', '5점', '6점', '7점', '8점', '9점'];

export function matchDate(m) {
  if (!m.reportedAt) return null;
  return m.reportedAt.toDate ? m.reportedAt.toDate() : new Date(m.reportedAt);
}

export function formatMonthDay(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// subjectId가 있으면 그 회원을 앞에, 없으면 승자를 앞에 둔다. html이면 색·크기용 span을 붙인다
export function matchLine(m, players, subjectId = null, html = false) {
  const small = t => html ? `<span class="ml-small">${t}</span>` : t;
  const win = html ? '<span class="ml-win">승</span>' : '승';
  const loss = html ? '<span class="ml-loss">패</span>' : '패';
  const name = id => {
    const p = players.find(x => x.id === id);
    if (!p) return '?';
    const rank = formatRank(p.handicap);
    return rank === '-' ? p.name : `${p.name}${small(`(${rank})`)}`;
  };
  const stones = m.stones ? ` ${small(`(${m.stones})`)}` : '';
  if (m.result !== 'player1' && m.result !== 'player2') {
    const [a, b] = subjectId === m.player2Id ? [m.player2Id, m.player1Id] : [m.player1Id, m.player2Id];
    return `${name(a)} VS ${name(b)} ${small(m.result ? '(미대국)' : '(대기중)')}`;
  }
  const winner = m.result === 'player1' ? m.player1Id : m.player2Id;
  const loser = winner === m.player1Id ? m.player2Id : m.player1Id;
  if (subjectId === loser) return `${name(loser)} ${loss} VS ${name(winner)} ${win}${stones}`;
  return `${name(winner)} ${win} VS ${name(loser)} ${loss}${stones}`;
}

// 모든 대국을 가장 먼저 끝낸 선수 id (마지막 대국 입력 시각 기준)
export function firstFinisherId(standings, matches) {
  let best = null, bestAt = null;
  standings.forEach(s => {
    if (!s.total || s.played < s.total) return;
    const times = matches
      .filter(m => (m.player1Id === s.id || m.player2Id === s.id) && m.result)
      .map(m => matchDate(m)?.getTime() ?? Infinity);
    const at = Math.max(...times);
    if (bestAt === null || at < bestAt) { best = s.id; bestAt = at; }
  });
  return best;
}

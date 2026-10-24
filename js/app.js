import { db } from './firebase-config.js';
import {
  collection, doc, getDocs, getDoc, query, where, onSnapshot, updateDoc, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showAlert, calculateStandings, matchLine, matchDate, formatMonthDay, firstFinisherId, formatRank } from './utils.js';

let allActiveLeagues = [];
let activeLeague = null;
let allPlayers = [];
let allMatches = [];
let loggedInPlayer = null;
let pendingMatchId = null;
let pendingOpponentId = null;
let pendingOpponentName = null;
let unsubscribeMatches = null;

async function init() {
  try {
    const snap = await getDocs(query(
      collection(db, 'baduk_leagues'),
      where('active', '==', true),
      orderBy('createdAt', 'desc')
    ));
    allActiveLeagues = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!allActiveLeagues.length) {
      document.getElementById('leagueBanner').innerHTML =
        '<div class="alert alert-info">진행 중인 리그가 없습니다. 관리자에게 문의하세요.</div>';
      document.getElementById('standingsBody').innerHTML =
        `<tr><td colspan="7"><div class="empty-state"><div class="icon">⚫</div>진행 중인 리그가 없습니다</div></td></tr>`;
      document.getElementById('matrixContainer').innerHTML = '<div class="empty-state">리그가 없습니다</div>';
      document.getElementById('logContainer').innerHTML = '<div class="empty-state">리그가 없습니다</div>';
      return;
    }

    // 저장된 로그인 정보로 소속 리그 찾기
    let defaultLeague = allActiveLeagues[0];
    const saved = localStorage.getItem('baduk_player');
    if (saved) {
      const { id } = JSON.parse(saved);
      for (const league of allActiveLeagues) {
        try {
          const pSnap = await getDocs(query(
            collection(db, 'baduk_leagues', league.id, 'players'),
            where('memberId', '==', id),
            limit(1)
          ));
          if (!pSnap.empty) { defaultLeague = league; break; }
        } catch {}
      }
    }

    await switchLeague(defaultLeague);
  } catch (e) {
    document.getElementById('leagueBanner').innerHTML =
      `<div class="alert alert-error">불러오기 실패: ${e.message}</div>`;
  }
}

async function switchLeague(league) {
  if (unsubscribeMatches) { unsubscribeMatches(); unsubscribeMatches = null; }
  activeLeague = league;
  allPlayers = []; allMatches = [];

  renderBanner();
  await loadData();
  subscribeMatches();
  resetEntryUI();
  populatePlayerSelect();

  // 이 리그에 해당 플레이어가 있으면 자동 로그인 복원
  const saved = localStorage.getItem('baduk_player');
  if (saved) {
    const { id } = JSON.parse(saved);
    const player = allPlayers.find(p => p.memberId === id);
    if (player) {
      setEntryLoggedIn(player);
    } else {
      showWrongLeagueMessage(JSON.parse(saved).name);
    }
  }
}

function showWrongLeagueMessage(name) {
  document.getElementById('entryStep1').style.display = 'none';
  document.getElementById('entryStep2').style.display = 'block';
  document.getElementById('loggedInName').textContent = name;
  document.getElementById('entryProgress').style.width = '0%';
  document.getElementById('entryProgressText').textContent = '';
  document.getElementById('entryMatchList').innerHTML = `
    <div class="alert alert-error">
      해당 리그는 회원님이 진행 중인 리그가 아닙니다.<br>
      좌측 상단의 '다른 리그 보기'에서 회원님이 진행 중인 리그를 선택해주세요.
    </div>`;
}

function onLeagueSelectorChange() {
  const leagueId = document.getElementById('leagueSelector').value;
  const league = allActiveLeagues.find(l => l.id === leagueId);
  if (league) switchLeague(league);
}

function renderBanner() {
  const s = activeLeague.scoring;
  let selectorHtml = '';
  if (allActiveLeagues.length > 1) {
    const opts = allActiveLeagues.map(l =>
      `<option value="${l.id}"${l.id === activeLeague.id ? ' selected' : ''}>${l.name}</option>`
    ).join('');
    selectorHtml = `
      <div style="margin-top:0.75rem;display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
        <span style="font-size:0.82rem;color:var(--text-muted);white-space:nowrap;">다른 리그 보기:</span>
        <select class="form-control" id="leagueSelector" onchange="onLeagueSelectorChange()"
          style="max-width:230px;padding:0.3rem 0.6rem;font-size:0.88rem;">
          ${opts}
        </select>
      </div>`;
  }
  document.getElementById('leagueBanner').innerHTML = `
    <div class="league-banner">
      <div>
        <h2>⚫ ${activeLeague.name}</h2>
        <div class="scoring-info">승 ${s.win}점 · 패 ${s.loss}점 · 미대국 ${s.noGame}점</div>
        ${activeLeague.notice ? `<div class="league-notice">${escapeHtml(activeLeague.notice)}</div>` : ''}
        ${selectorHtml}
      </div>
      <span class="badge badge-active">진행 중</span>
    </div>`;
}

async function loadData() {
  const [ps, ms] = await Promise.all([
    getDocs(collection(db, 'baduk_leagues', activeLeague.id, 'players')),
    getDocs(collection(db, 'baduk_leagues', activeLeague.id, 'matches'))
  ]);
  allPlayers = ps.docs.map(d => ({ id: d.id, ...d.data() }));
  allMatches = ms.docs.map(d => ({ id: d.id, ...d.data() }));
  render();
}

function subscribeMatches() {
  unsubscribeMatches = onSnapshot(
    collection(db, 'baduk_leagues', activeLeague.id, 'matches'),
    snap => {
      allMatches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
      if (loggedInPlayer) renderEntryList();
    }
  );
}

function render() {
  renderStandings();
  renderMatrix();
  renderLog();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rankTag(playerId) {
  const rank = formatRank(allPlayers.find(x => x.id === playerId)?.handicap);
  return rank === '-' ? '' : `<span class="rank-tag">(${rank})</span>`;
}

function remainingLabel(p) {
  const left = p.total - p.played;
  return left > 0 ? `남은 경기 ${left}판` : 'Clear !';
}

function renderStandings() {
  const standings = calculateStandings(allPlayers, allMatches, activeLeague.scoring);
  const tbody = document.getElementById('standingsBody');
  if (!standings.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">선수가 등록되지 않았습니다</div></td></tr>`;
    return;
  }
  const finisher = firstFinisherId(standings, allMatches);
  tbody.innerHTML = standings.map((p, i) => {
    const r = i + 1;
    const cls = r <= 3 ? `rank-${r}` : 'rank-other';
    const left = p.total - p.played;
    const gift = p.id === finisher ? ' <span title="가장 먼저 모든 대국 완료">🎁</span>' : '';
    return `<tr>
      <td><span class="rank-badge ${cls}">${r}</span></td>
      <td><strong class="player-link" onclick="togglePlayerPopover(event,'${p.id}')" onmouseleave="schedulePopoverClose()">${p.name}</strong>${rankTag(p.id)}${gift}</td>
      <td class="wins">${p.wins}</td>
      <td class="losses">${p.losses}</td>
      <td class="points">${p.points}</td>
      <td class="${left > 0 ? 'remaining' : 'remaining-clear'}">${remainingLabel(p)}</td>
    </tr>`;
  }).join('');
  document.getElementById('lastUpdated').textContent = `${new Date().toLocaleTimeString('ko-KR')} 기준`;
}

function renderMatrix() {
  const container = document.getElementById('matrixContainer');
  if (!allPlayers.length) { container.innerHTML = '<div class="empty-state">선수가 없습니다</div>'; return; }

  const matchMap = {};
  allMatches.forEach(m => { matchMap[`${m.player1Id}_${m.player2Id}`] = m; });
  const getMatch = (a, b) => matchMap[`${a}_${b}`] || matchMap[`${b}_${a}`];

  let html = '<table class="matrix-table"><thead><tr><th>나 \\ 상대</th>';
  allPlayers.forEach(p => { html += `<th title="${p.name}">${p.name.slice(0, 3)}</th>`; });
  html += '</tr></thead><tbody>';

  allPlayers.forEach(row => {
    html += `<tr><td><strong>${row.name}</strong></td>`;
    allPlayers.forEach(col => {
      if (row.id === col.id) { html += '<td class="matrix-self">-</td>'; return; }
      const m = getMatch(row.id, col.id);
      if (!m || !m.result) { html += '<td class="matrix-pending">·</td>'; return; }
      if (m.result === 'noGame' || m.result === 'draw') { html += '<td class="matrix-nogame">미</td>'; return; }
      const iWon = (m.result === 'player1' && m.player1Id === row.id) ||
                   (m.result === 'player2' && m.player2Id === row.id);
      html += iWon ? '<td class="matrix-win">승</td>' : '<td class="matrix-loss">패</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function resetEntryUI() {
  loggedInPlayer = null;
  document.getElementById('entryStep1').style.display = 'block';
  document.getElementById('entryStep2').style.display = 'none';
}

function populatePlayerSelect() {}

function setEntryLoggedIn(player) {
  loggedInPlayer = player;
  localStorage.setItem('baduk_player', JSON.stringify({ id: player.memberId, name: player.name }));
  document.getElementById('entryStep1').style.display = 'none';
  document.getElementById('entryStep2').style.display = 'block';
  document.getElementById('loggedInName').textContent = player.name;
  renderEntryList();
}

function loginForEntry() {}

function logoutEntry() {
  localStorage.removeItem('baduk_player');
  resetEntryUI();
  populatePlayerSelect();
}

function renderEntryList() {
  if (!loggedInPlayer) return;
  const myMatches = allMatches.filter(
    m => m.player1Id === loggedInPlayer.id || m.player2Id === loggedInPlayer.id
  );
  const played = myMatches.filter(m => m.result).length;
  const total = myMatches.length;
  document.getElementById('entryProgress').style.width = (total > 0 ? played / total * 100 : 0) + '%';
  document.getElementById('entryProgressText').textContent = `${played} / ${total} 대국 완료`;

  if (!myMatches.length) {
    document.getElementById('entryMatchList').innerHTML = '<div class="empty-state">대국이 없습니다</div>';
    return;
  }

  myMatches.sort((a, b) => (a.result ? 1 : 0) - (b.result ? 1 : 0));

  document.getElementById('entryMatchList').innerHTML = myMatches.map(m => {
    const oppId = m.player1Id === loggedInPlayer.id ? m.player2Id : m.player1Id;
    const opp = allPlayers.find(p => p.id === oppId);
    const oppName = opp ? opp.name : '?';

    const editBtn = `<button class="btn btn-sm btn-secondary" onclick="openResultModal('${m.id}','${oppId}','${oppName}')">수정</button>`;
    let statusHtml = '', actionHtml = '';
    if (!m.result) {
      statusHtml = '<span class="match-status status-pending">미진행</span>';
      actionHtml = `<button class="btn btn-sm btn-danger" onclick="openResultModal('${m.id}','${oppId}','${oppName}')">결과 입력</button>`;
    } else if (m.result === 'draw' || m.result === 'noGame') {
      statusHtml = '<span class="match-status status-nogame">미진행</span>';
      actionHtml = editBtn;
    } else {
      const myWin = (m.result === 'player1' && m.player1Id === loggedInPlayer.id) ||
                    (m.result === 'player2' && m.player2Id === loggedInPlayer.id);
      statusHtml = myWin
        ? '<span class="match-status status-win">승리 ✓</span>'
        : '<span class="match-status status-loss">패배</span>';
      actionHtml = editBtn;
    }
    return `<div class="match-item">
      <div class="match-vs">
        <span class="player-name">${loggedInPlayer.name}</span>
        <span class="vs-badge">vs</span>
        <span class="player-name">${oppName}</span>
      </div>
      <div style="display:flex;align-items:center;gap:0.6rem;">${statusHtml}${actionHtml}</div>
    </div>`;
  }).join('');
}

function openResultModal(matchId, oppId, oppName) {
  pendingMatchId = matchId;
  pendingOpponentId = oppId;
  pendingOpponentName = oppName;
  document.getElementById('modalMatchInfo').innerHTML =
    `<strong>${loggedInPlayer.name}</strong> vs <strong>${oppName}</strong>`;
  document.getElementById('modalAlert').innerHTML = '';
  document.getElementById('resultModal').classList.add('active');
}

async function resetResult() {
  if (!pendingMatchId || !loggedInPlayer) return;
  try {
    await updateDoc(doc(db, 'baduk_leagues', activeLeague.id, 'matches', pendingMatchId), {
      result: null, winnerId: null, reportedBy: null, reportedAt: null
    });
    document.getElementById('resultModal').classList.remove('active');
  } catch (e) {
    showAlert('modalAlert', '초기화 오류: ' + e.message);
  }
}

async function submitResult(type) {
  if (!pendingMatchId || !loggedInPlayer) return;
  const m = allMatches.find(x => x.id === pendingMatchId);
  if (!m) return;

  const winnerId = type === 'win' ? loggedInPlayer.id : pendingOpponentId;
  const result = m.player1Id === winnerId ? 'player1' : 'player2';

  try {
    await updateDoc(doc(db, 'baduk_leagues', activeLeague.id, 'matches', pendingMatchId), {
      result, winnerId, reportedBy: loggedInPlayer.id, reportedAt: new Date()
    });
    document.getElementById('resultModal').classList.remove('active');
  } catch (e) {
    showAlert('modalAlert', '저장 오류: ' + e.message);
  }
}

// ── 순위표 이름 말풍선 ──
let popoverPlayerId = null;
let popoverCloseTimer = null;

function byDateDesc(a, b) {
  return (matchDate(b)?.getTime() ?? 0) - (matchDate(a)?.getTime() ?? 0);
}

function togglePlayerPopover(event, playerId) {
  event.stopPropagation();
  if (popoverPlayerId === playerId) { closePlayerPopover(); return; }
  const player = allPlayers.find(p => p.id === playerId);
  if (!player) return;
  const mine = allMatches.filter(m => m.player1Id === playerId || m.player2Id === playerId);
  const done = mine.filter(m => m.result).sort(byDateDesc);
  const waiting = mine.filter(m => !m.result);
  const st = calculateStandings(allPlayers, allMatches, activeLeague.scoring).find(x => x.id === playerId);

  const doneHtml = done.length
    ? done.map(m => {
        const d = matchDate(m);
        return `<div class="pop-line"><span class="pop-date">${d ? formatMonthDay(d) : ''}</span>${matchLine(m, allPlayers, playerId, true)}</div>`;
      }).join('')
    : '<div class="pop-empty">아직 둔 대국이 없습니다</div>';
  const waitHtml = waiting.length
    ? waiting.map(m => `<div class="pop-line">${matchLine(m, allPlayers, playerId, true)}</div>`).join('')
    : '<div class="pop-empty">남은 대국이 없습니다</div>';

  const pop = document.getElementById('playerPopover');
  pop.innerHTML = `
    <div class="pop-head"><span><strong>${player.name}</strong>${rankTag(playerId)}</span><span>${st.wins}승 ${st.losses}패 · ${st.points}점</span></div>
    <div class="pop-section">대국 내역</div>${doneHtml}
    <div class="pop-section pop-divider">${waiting.length ? `남은 대국 ${waiting.length}판` : '남은 대국'}</div>${waitHtml}`;

  const rect = event.currentTarget.getBoundingClientRect();
  pop.style.display = 'block';
  const maxLeft = window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8;
  pop.style.left = Math.max(8, Math.min(rect.left + window.scrollX, maxLeft)) + 'px';
  pop.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  popoverPlayerId = playerId;
  clearTimeout(popoverCloseTimer);
}

function closePlayerPopover() {
  clearTimeout(popoverCloseTimer);
  document.getElementById('playerPopover').style.display = 'none';
  popoverPlayerId = null;
}

function schedulePopoverClose() {
  if (!popoverPlayerId) return;
  clearTimeout(popoverCloseTimer);
  popoverCloseTimer = setTimeout(closePlayerPopover, 400);
}

document.addEventListener('click', e => {
  if (popoverPlayerId && !e.target.closest('#playerPopover')) closePlayerPopover();
});
const popoverEl = document.getElementById('playerPopover');
popoverEl.addEventListener('mouseenter', () => clearTimeout(popoverCloseTimer));
popoverEl.addEventListener('mouseleave', schedulePopoverClose);

// ── 대국 기록 (카톡 공지용) ──
function buildLogText(html = false) {
  const esc = t => html ? escapeHtml(t) : t;
  const standings = calculateStandings(allPlayers, allMatches, activeLeague.scoring);
  const finisher = firstFinisherId(standings, allMatches);
  const lines = [esc(activeLeague.name)];
  if (activeLeague.notice) lines.push(esc(activeLeague.notice.trim()));
  lines.push('');
  standings.forEach(p => {
    lines.push(`${esc(p.name)}${p.id === finisher ? ' 🎁' : ''} ${p.wins}승 ${p.losses}패 (${p.points}점) - ${remainingLabel(p)}`);
  });

  const groups = new Map();
  allMatches.filter(m => m.result).sort(byDateDesc).forEach(m => {
    const d = matchDate(m);
    const key = d ? formatMonthDay(d) : '날짜 없음';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(matchLine(m, allPlayers, null, html));
  });
  groups.forEach((items, date) => lines.push('', date, ...items));
  return lines.join('\n');
}

function renderLog() {
  const el = document.getElementById('logContainer');
  if (!el || !activeLeague) return;
  el.innerHTML = buildLogText(true);
}

async function copyLogText() {
  if (!activeLeague) return;
  const text = buildLogText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showAlert('logAlert', '복사되었습니다. 카톡에 붙여넣기 하세요.', 'success');
}

window.onLeagueSelectorChange = onLeagueSelectorChange;
window.loginForEntry = loginForEntry;
window.logoutEntry = logoutEntry;
window.openResultModal = openResultModal;
window.submitResult = submitResult;
window.resetResult = resetResult;
window.renderMatrix = renderMatrix;
window.togglePlayerPopover = togglePlayerPopover;
window.schedulePopoverClose = schedulePopoverClose;
window.copyLogText = copyLogText;

init();

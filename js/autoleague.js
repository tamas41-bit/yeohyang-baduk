import { db } from './firebase-config.js';
import {
  collection, doc, getDoc, getDocs, query, where, runTransaction, writeBatch,
  serverTimestamp, updateDoc, setDoc, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const AUTO_DEFAULTS = {
  enabled: false,
  nameFormat: '{년}년 {월}월 리그전',
  scoring: { win: 3, loss: 1, noGame: 0 },
  copyNotice: true,
  notice: '',
  minPlayers: 3,
  cancelDeadlineDays: 0,
  lastRolloverMonth: null,
  lastRolloverNote: ''
};

const settingsRef = () => doc(db, 'baduk_config', 'auto');

export async function getAutoSettings() {
  const snap = await getDoc(settingsRef());
  return { ...AUTO_DEFAULTS, ...(snap.exists() ? snap.data() : {}) };
}

export async function saveAutoSettings(patch) {
  await setDoc(settingsRef(), patch, { merge: true });
}

// 사용자 기기 시간대와 무관하게 한국 시간 기준 날짜
export function seoulDate(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map(p => [p.type, p.value])
  );
  return { year: +parts.year, month: +parts.month, day: +parts.day };
}

export function currentMonthKey() {
  const t = seoulDate();
  return `${t.year}-${String(t.month).padStart(2, '0')}`;
}

export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${y}년 ${m}월`;
}

export function leagueNameFor(format, key) {
  const [y, m] = key.split('-').map(Number);
  return (format || AUTO_DEFAULTS.nameFormat).replaceAll('{년}', y).replaceAll('{월}', m);
}

// 다음 달 참가 취소 가능 여부 (말일 N일 전까지)
export function cancelOpen(settings) {
  const t = seoulDate();
  const lastDay = new Date(t.year, t.month, 0).getDate();
  return t.day <= lastDay - (Number(settings.cancelDeadlineDays) || 0);
}

export async function getOptOuts(key) {
  const snap = await getDoc(doc(db, 'baduk_signups', key));
  return snap.exists() ? (snap.data().out || []) : [];
}

export async function setOptOut(key, memberId, out) {
  await setDoc(doc(db, 'baduk_signups', key),
    { out: out ? arrayUnion(memberId) : arrayRemove(memberId) }, { merge: true });
}

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach(([ref, data]) => batch.set(ref, data));
    await batch.commit();
  }
}

// 달이 바뀐 뒤 첫 실행 시: 지난달 리그 종료 + 이번 달 리그 생성. force면 이번 달 기록이 있어도 다시 시도
export async function runAutoRollover({ force = false } = {}) {
  const settings = await getAutoSettings();
  if (!settings.enabled && !force) return { ran: false };
  const cur = currentMonthKey();
  if (!force && settings.lastRolloverMonth === cur) return { ran: false };

  const claimed = await runTransaction(db, async tx => {
    const snap = await tx.get(settingsRef());
    const last = snap.exists() ? snap.data().lastRolloverMonth : null;
    if (!force && last === cur) return false;
    tx.set(settingsRef(), { lastRolloverMonth: cur }, { merge: true });
    return true;
  });
  if (!claimed) return { ran: false };

  const activeSnap = await getDocs(query(collection(db, 'baduk_leagues'), where('active', '==', true)));
  const active = activeSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const toEnd = active.filter(l => l.month && l.month < cur);
  for (const l of toEnd) {
    await updateDoc(doc(db, 'baduk_leagues', l.id), { active: false, endedAt: serverTimestamp() });
  }
  const endedNames = toEnd.map(l => l.name).join(', ');
  const endedNote = toEnd.length ? `${endedNames} 종료. ` : '';

  if (active.some(l => l.month === cur)) {
    const note = `${endedNote}${monthLabel(cur)} 리그가 이미 있어 새로 만들지 않았습니다.`;
    await saveAutoSettings({ lastRolloverNote: note, lastRolloverAt: serverTimestamp() });
    return { ran: true, note };
  }

  const [membersSnap, out] = await Promise.all([getDocs(collection(db, 'baduk_members')), getOptOuts(cur)]);
  const participants = membersSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(m => !out.includes(m.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  const min = Number(settings.minPlayers) || 2;
  if (participants.length < min) {
    const note = `${endedNote}참가자 ${participants.length}명으로 최소 인원(${min}명)이 안 되어 ${monthLabel(cur)} 리그를 만들지 않았습니다.`;
    await saveAutoSettings({ lastRolloverNote: note, lastRolloverAt: serverTimestamp() });
    return { ran: true, note };
  }

  const prev = [...toEnd].sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))[0];
  const notice = settings.copyNotice ? (prev?.notice || settings.notice || '') : (settings.notice || '');
  const name = leagueNameFor(settings.nameFormat, cur);
  const leagueRef = doc(collection(db, 'baduk_leagues'));
  await setDoc(leagueRef, {
    name, notice, active: true, month: cur, auto: true,
    scoring: settings.scoring || AUTO_DEFAULTS.scoring,
    createdAt: serverTimestamp()
  });

  const ops = [];
  const playerIds = participants.map(m => {
    const ref = doc(collection(db, 'baduk_leagues', leagueRef.id, 'players'));
    ops.push([ref, { name: m.name, pinHash: m.pinHash, memberId: m.id }]);
    return ref.id;
  });
  playerIds.forEach((p1, i) => playerIds.slice(i + 1).forEach(p2 => {
    ops.push([doc(collection(db, 'baduk_leagues', leagueRef.id, 'matches')),
      { player1Id: p1, player2Id: p2, result: null, winnerId: null, reportedBy: null, reportedAt: null }]);
  }));
  await commitInChunks(ops);

  const note = `${endedNote}${name} 자동 생성 (참가 ${participants.length}명).`;
  await saveAutoSettings({ lastRolloverNote: note, lastRolloverAt: serverTimestamp() });
  return { ran: true, note };
}

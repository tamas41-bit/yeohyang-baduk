import { db } from './firebase-config.js';
import {
  collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

async function init() {
  try {
    const snap = await getDocs(collection(db, 'baduk_members'));
    const members = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    document.getElementById('memberCount').textContent = `총 ${members.length}명`;

    const tbody = document.getElementById('memberTableBody');
    if (!members.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">등록된 회원이 없습니다</div></td></tr>`;
      return;
    }
    tbody.innerHTML = members.map((m, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${m.name}</strong></td>
        <td>${m.yearlyScore ?? '-'}</td>
      </tr>`).join('');
  } catch (e) {
    document.getElementById('memberTableBody').innerHTML =
      `<tr><td colspan="3"><div class="alert alert-error">불러오기 실패: ${e.message}</div></td></tr>`;
  }
}

init();

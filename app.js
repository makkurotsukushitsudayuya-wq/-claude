/**
 * 縁乃助 出勤確認・掃除進捗管理アプリ フロントエンド(タブレット常設PWA想定)
 * GAS Webアプリ(gas_attendance_backend/Code.gs)をAPIとして利用する。
 *
 * 実装上の注意:
 * Apps Script Webアプリへの fetch は、プリフライト(OPTIONS)を避けるため
 * POSTは Content-Type: text/plain で送る(GAS側は JSON.parse(e.postData.contents) で読む)。
 */
 
const cfg = window.APP_CONFIG;
 
// タブレットのローカル時刻の年月日をそのまま 'YYYY-MM-DD' にする。
// toISOString()はUTCに変換されてしまい、日本時間の深夜(0時〜9時前)に
// 前日の日付になってしまう不具合があるため使わない。
const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
 
const WEEKDAY_JA_DISPLAY = ['日', '月', '火', '水', '木', '金', '土'];
const weekdayLabelForDisplay_ = () => WEEKDAY_JA_DISPLAY[new Date().getDay()] + '曜日';
 
let state = {
  staffList: [],
  groomingItems: [],
  attendance: { name: null, shift: null, position: null, checks: {} },
  cleaning: { staffName: null, position: null, spots: [] },
};
 
// ---------- API呼び出し ----------
 
async function apiGet(action, params = {}) {
  const url = new URL(cfg.GAS_WEB_APP_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', cfg.SHARED_SECRET);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'APIエラー');
  return json.data;
}
 
async function apiPost(action, body = {}) {
  const res = await fetch(cfg.GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: cfg.SHARED_SECRET, ...body }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'APIエラー');
  return json.data;
}
 
// ---------- 画面切り替え ----------
 
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
 
function switchTab(tab) {
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'attendance') {
    resetAttendanceFlow();
    showScreen('screen-staff-select');
  } else {
    resetCleaningFlow();
    showScreen('screen-cleaning-staff-select');
  }
}
 
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error-text', isError);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}
 
// ---------- 出勤確認フロー ----------
 
function resetAttendanceFlow() {
  state.attendance = { name: null, shift: null, position: null, checks: {} };
}
 
async function loadStaffList() {
  const grid = document.getElementById('staff-grid');
  grid.innerHTML = '<p class="muted">読み込み中...</p>';
  try {
    state.staffList = await apiGet('staffList');
    grid.innerHTML = '';
    state.staffList.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'big-btn';
      btn.textContent = s.name;
      btn.onclick = () => onStaffChosen(s);
      grid.appendChild(btn);
    });
    if (state.staffList.length === 0) {
      grid.innerHTML = '<p class="muted">スタッフ・ポジションマスタが空です。スプレッドシートに登録してください。</p>';
    }
  } catch (e) {
    grid.innerHTML = `<p class="error-text">読み込み失敗: ${e.message}</p>`;
  }
}
 
async function onStaffChosen(staff) {
  state.attendance.name = staff.name;
  state.attendance.defaultPosition = staff.defaultPosition;
  const box = document.getElementById('shift-confirm-box');
  box.innerHTML = '<p class="muted">本日のシフトを確認中...</p>';
  showScreen('screen-shift-confirm');
  try {
    const shifts = await apiGet('todayShift', { date: todayStr(), name: staff.name });
    if (shifts.length === 0) {
      box.innerHTML = `
        <h2>${staff.name} さん</h2>
        <p class="error-text">本日のシフトが見つかりませんでした。シフト表をご確認のうえ、必要であれば責任者にご連絡ください。</p>
        <div class="row-actions">
          <button class="secondary" onclick="showScreen('screen-staff-select')">戻る</button>
          <button class="primary" onclick="proceedToPosition(null)">それでも出勤する</button>
        </div>`;
    } else {
      state.attendance.shift = shifts[0];
      const lines = shifts.map((s) => `${s.category}: ${s.timeRange}`).join(' / ');
      box.innerHTML = `
        <h2>${staff.name} さん、出勤しますか?</h2>
        <p class="pill">本日のシフト: ${lines}</p>
        <div class="row-actions">
          <button class="secondary" onclick="showScreen('screen-staff-select')">いいえ</button>
          <button class="primary" onclick="proceedToPosition('${shifts[0].category}')">はい</button>
        </div>`;
    }
  } catch (e) {
    box.innerHTML = `<p class="error-text">シフト取得に失敗しました: ${e.message}</p>
      <button class="secondary" onclick="showScreen('screen-staff-select')">戻る</button>`;
  }
}
 
function proceedToPosition(shiftCategory) {
  state.attendance.shiftCategory = shiftCategory;
  const grid = document.getElementById('position-grid');
  grid.innerHTML = '';
  cfg.POSITIONS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'big-btn' + (p === state.attendance.defaultPosition ? ' selected' : '');
    btn.textContent = p;
    btn.onclick = () => {
      grid.querySelectorAll('.big-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.attendance.position = p;
    };
    grid.appendChild(btn);
  });
  state.attendance.position = state.attendance.defaultPosition || null;
  showScreen('screen-position-select');
}
 
async function openGroomingModal() {
  if (!state.attendance.position) {
    toast('ポジションを選択してください', true);
    return;
  }
  if (state.groomingItems.length === 0) {
    try {
      state.groomingItems = await apiGet('groomingItems');
    } catch (e) {
      toast('チェック項目の取得に失敗しました: ' + e.message, true);
      return;
    }
  }
  state.attendance.checks = {};
  const list = document.getElementById('grooming-list');
  list.innerHTML = '';
  state.groomingItems.forEach((item, idx) => {
    const row = document.createElement('label');
    row.className = 'check-item';
    row.innerHTML = `<input type="checkbox" data-idx="${idx}"> <span>${item.label}</span>`;
    row.querySelector('input').addEventListener('change', (ev) => {
      state.attendance.checks[item.label] = ev.target.checked;
      updateGroomingConfirmButton();
    });
    list.appendChild(row);
  });
  updateGroomingConfirmButton();
  document.getElementById('grooming-modal').classList.add('active');
}
 
function updateGroomingConfirmButton() {
  const allChecked = state.groomingItems.length > 0
    && state.groomingItems.every((item) => state.attendance.checks[item.label]);
  document.getElementById('grooming-confirm-btn').disabled = !allChecked;
}
 
function closeGroomingModal() {
  document.getElementById('grooming-modal').classList.remove('active');
}
 
async function confirmCheckIn() {
  try {
    await apiPost('checkIn', {
      date: todayStr(),
      name: state.attendance.name,
      position: state.attendance.position,
      shiftCategory: state.attendance.shiftCategory || '',
      groomingChecks: state.attendance.checks,
    });
    closeGroomingModal();
    toast(`${state.attendance.name} さん、出勤を記録しました`);
    resetAttendanceFlow();
    showScreen('screen-staff-select');
  } catch (e) {
    toast('出勤記録に失敗しました: ' + e.message, true);
  }
}
 
// ---------- 掃除進捗フロー ----------
 
function resetCleaningFlow() {
  state.cleaning = { staffName: null, position: null, spots: [] };
}
 
function renderCleaningStaffGrid() {
  const grid = document.getElementById('cleaning-staff-grid');
  grid.innerHTML = '';
  (state.staffList.length ? state.staffList : []).forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'big-btn';
    btn.textContent = s.name;
    btn.onclick = () => {
      state.cleaning.staffName = s.name;
      showScreen('screen-cleaning-position-select');
    };
    grid.appendChild(btn);
  });
}
 
function renderCleaningPositionGrid() {
  const grid = document.getElementById('cleaning-position-grid');
  grid.innerHTML = '';
  cfg.POSITIONS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'big-btn';
    btn.textContent = p;
    btn.onclick = () => {
      state.cleaning.position = p;
      loadCleaningSpots();
    };
    grid.appendChild(btn);
  });
}
 
async function loadCleaningSpots() {
  showScreen('screen-cleaning-list');
  const list = document.getElementById('cleaning-spot-list');
  document.getElementById('cleaning-list-title').textContent =
    `${state.cleaning.position} の掃除箇所(${state.cleaning.staffName} さん)`;
  list.innerHTML = '<p class="muted">読み込み中...</p>';
  try {
    state.cleaning.spots = await apiGet('cleaningList', { position: state.cleaning.position, date: todayStr() });
    renderCleaningSpots();
  } catch (e) {
    list.innerHTML = `<p class="error-text">読み込み失敗: ${e.message}</p>`;
  }
}
 
function renderCleaningSpots() {
  const list = document.getElementById('cleaning-spot-list');
  if (state.cleaning.spots.length === 0) {
    list.innerHTML = '<p class="muted">今日(' + weekdayLabelForDisplay_() + ')担当の掃除箇所が見つかりませんでした。'
      + '「掃除箇所マスタ」シートで、このポジションの行の「曜日」列が空欄(毎日共通)か、今日の曜日になっているか確認してください。</p>';
    return;
  }
  list.innerHTML = '';
  state.cleaning.spots.forEach((spot) => {
    const row = document.createElement('div');
    row.className = 'spot-row' + (spot.done ? ' done' : '');
    row.innerHTML = `
      <div>
        <div>${spot.spot}</div>
        ${spot.done ? `<div class="spot-meta">${spot.doneBy} が完了</div>` : ''}
      </div>
      <span class="pill ${spot.done ? 'good' : ''}">${spot.done ? '完了' : '未完了'}</span>
    `;
    row.onclick = () => toggleSpot(spot);
    list.appendChild(row);
  });
}
 
async function toggleSpot(spot) {
  try {
    if (spot.done) {
      await apiPost('uncompleteCleaning', {
        date: todayStr(), position: state.cleaning.position, spot: spot.spot,
      });
    } else {
      await apiPost('completeCleaning', {
        date: todayStr(), position: state.cleaning.position, spot: spot.spot, staffName: state.cleaning.staffName,
      });
    }
    await loadCleaningSpots();
  } catch (e) {
    toast('更新に失敗しました: ' + e.message, true);
  }
}
 
// ---------- 初期化 ----------
 
window.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  document.getElementById('grooming-cancel-btn').onclick = closeGroomingModal;
  document.getElementById('grooming-confirm-btn').onclick = confirmCheckIn;
  document.getElementById('position-next-btn').onclick = openGroomingModal;
 
  await loadStaffList();
  renderCleaningStaffGrid();
  renderCleaningPositionGrid();
  switchTab('attendance');
 
  if (cfg.GAS_WEB_APP_URL.includes('XXXXXXXXXXXXXXXX')) {
    toast('config.js の GAS_WEB_APP_URL / SHARED_SECRET を設定してください', true);
  }
 
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
 

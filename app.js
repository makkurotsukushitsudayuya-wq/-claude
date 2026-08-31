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

// シフト開始の何分前からスタッフ選択ボタンを表示するか。調整したい場合はここを変える。
const UPCOMING_WINDOW_MINUTES = 5;

const currentMinutes_ = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

// シフトAPIが返す timeRange('10:15-15:00'等)の先頭の 'HH:MM' を分に変換する。
// '休み' 'ヘルプ:店舗名' '会議' など時間として読み取れない自由記述は null を返す
// (=出勤ボタンの対象外になる)。
function parseStartMinutes_(timeRange) {
  const m = String(timeRange || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

let state = {
  staffList: [],
  groomingItems: [],
  attendance: { name: null, shift: null, position: null, checks: {} },
  cleaning: { data: {} },
  // その場で出勤確定した人をすぐにボタン一覧から消すための即時反映用セット。
  // サーバー側(todayCheckedIn)にも記録されるが、通信タイムラグなしで即座に消すために持っておく。
  locallyCheckedIn: { date: todayStr(), names: new Set() },
  // 出勤確認画面で取得した本日のシフト一覧のキャッシュ。
  // スタッフ名ボタンを押した直後にもう一度シフトAPIを叩くと、シフト管理システムへの
  // 二重通信(体感の遅さの主な原因)が発生するため、直前の取得結果を使い回す。
  cachedShifts: { date: null, shifts: [] },
};

function markLocallyCheckedIn_(name) {
  const today = todayStr();
  if (state.locallyCheckedIn.date !== today) {
    state.locallyCheckedIn = { date: today, names: new Set() };
  }
  state.locallyCheckedIn.names.add(name);
}

function getLocallyCheckedInSet_() {
  const today = todayStr();
  if (state.locallyCheckedIn.date !== today) {
    state.locallyCheckedIn = { date: today, names: new Set() };
  }
  return state.locallyCheckedIn.names;
}

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
    backToStaffSelect();
  } else {
    showScreen('screen-cleaning-board');
    loadCleaningBoard();
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
  try {
    state.staffList = await apiGet('staffList');
  } catch (e) {
    toast('スタッフ一覧の読み込みに失敗しました: ' + e.message, true);
  }
}

let staffSelectPollTimer = null;

function startStaffSelectPolling() {
  if (staffSelectPollTimer) return;
  // シフト開始が近づいた瞬間にボタンが出てくるように、タブレットを置きっぱなしでも
  // 定期的に(30秒おきに)出勤確認の画面を見ているときだけ自動で再チェックする。
  staffSelectPollTimer = setInterval(() => {
    const screen = document.getElementById('screen-staff-select');
    if (screen && screen.classList.contains('active')) {
      refreshStaffSelectScreen();
    }
  }, 30000);
}

/**
 * 「今まさに出勤時刻が近い(shift開始のUPCOMING_WINDOW_MINUTES分前を過ぎた)、
 * かつ今日まだ出勤確定していない」スタッフだけをボタンとして表示する。
 * 複数人が同時に該当すれば、その全員分のボタンが並ぶ。
 */
async function refreshStaffSelectScreen() {
  const grid = document.getElementById('staff-grid');
  if (state.staffList.length === 0) {
    await loadStaffList();
  }
  if (state.staffList.length === 0) {
    grid.innerHTML = '<p class="muted">スタッフ・ポジションマスタが空です。スプレッドシートに登録してください。</p>';
    return;
  }
  // 初回表示(タブ切り替え直後など、まだボタンが1つも無い状態)のときだけ
  // 「読み込み中」を出す。30秒おきの自動更新のたびに出すとボタンがちらついて
  // かえって使いづらいので、更新時は今の表示を保ったまま裏で取得する。
  if (grid.children.length === 0) {
    grid.innerHTML = '<p class="muted">読み込み中...</p>';
  }
  try {
    const [shifts, checkedInNames] = await Promise.all([
      apiGet('todayShift', { date: todayStr() }),
      apiGet('todayCheckedIn', { date: todayStr() }),
    ]);
    // シフト一覧をキャッシュしておき、直後にスタッフ名ボタンが押された時に
    // シフトAPIへ再度アクセスしなくて済むようにする(体感速度対策)。
    state.cachedShifts = { date: todayStr(), shifts };
    const checkedInSet = new Set([...checkedInNames, ...getLocallyCheckedInSet_()]);
    const staffByName = {};
    state.staffList.forEach((s) => { staffByName[s.name] = s; });

    // 同じ人が複数区分(昼・夜など)を持つ場合は、一番早い開始時刻を採用する
    const earliestStartByName = {};
    shifts.forEach((row) => {
      const startMin = parseStartMinutes_(row.timeRange);
      if (startMin === null) return;
      if (!(row.name in earliestStartByName) || startMin < earliestStartByName[row.name]) {
        earliestStartByName[row.name] = startMin;
      }
    });

    const now = currentMinutes_();
    const upcomingNames = Object.keys(earliestStartByName)
      .filter((name) => !checkedInSet.has(name))
      .filter((name) => earliestStartByName[name] - now <= UPCOMING_WINDOW_MINUTES)
      .sort((a, b) => earliestStartByName[a] - earliestStartByName[b]);

    grid.innerHTML = '';
    if (upcomingNames.length === 0) {
      grid.innerHTML = `<p class="muted">現在、出勤予定時刻が近いスタッフはいません(シフト開始の${UPCOMING_WINDOW_MINUTES}分前になると、ここにボタンが表示されます)。</p>`;
      return;
    }
    upcomingNames.forEach((name) => {
      const staffInfo = staffByName[name] || { name, defaultPosition: '' };
      const btn = document.createElement('button');
      btn.className = 'big-btn';
      btn.textContent = name;
      btn.onclick = () => onStaffChosen(staffInfo);
      grid.appendChild(btn);
    });
  } catch (e) {
    grid.innerHTML = `<p class="error-text">読み込み失敗: ${e.message}</p>`;
  }
}

function backToStaffSelect() {
  showScreen('screen-staff-select');
  refreshStaffSelectScreen();
}

async function onStaffChosen(staff) {
  state.attendance.name = staff.name;
  state.attendance.defaultPosition = staff.defaultPosition;
  const box = document.getElementById('shift-confirm-box');
  showScreen('screen-shift-confirm');
  try {
    // 直前のスタッフ選択画面の更新で今日のシフト一覧を取得済みなら、それを使い回す
    // (シフト管理システムへの二重通信をなくして、ボタンを押した直後の反応を速くする)。
    // キャッシュが無い/古い場合だけ、念のため通信して取得する。
    let shifts;
    if (state.cachedShifts.date === todayStr()) {
      shifts = state.cachedShifts.shifts.filter((s) => s.name === staff.name);
    } else {
      box.innerHTML = '<p class="muted">本日のシフトを確認中...</p>';
      shifts = await apiGet('todayShift', { date: todayStr(), name: staff.name });
    }
    if (shifts.length === 0) {
      box.innerHTML = `
        <h2>${staff.name} さん</h2>
        <p class="error-text">本日のシフトが見つかりませんでした。シフト表をご確認のうえ、必要であれば責任者にご連絡ください。</p>
        <div class="row-actions">
          <button class="secondary" onclick="backToStaffSelect()">戻る</button>
          <button class="primary" onclick="proceedToPosition(null)">それでも出勤する</button>
        </div>`;
    } else {
      state.attendance.shift = shifts[0];
      const lines = shifts.map((s) => `${s.category}: ${s.timeRange}`).join(' / ');
      box.innerHTML = `
        <h2>${staff.name} さん、出勤しますか?</h2>
        <p class="pill">本日のシフト: ${lines}</p>
        <div class="row-actions">
          <button class="secondary" onclick="backToStaffSelect()">いいえ</button>
          <button class="primary" onclick="proceedToPosition('${shifts[0].category}')">はい</button>
        </div>`;
    }
  } catch (e) {
    box.innerHTML = `<p class="error-text">シフト取得に失敗しました: ${e.message}</p>
      <button class="secondary" onclick="backToStaffSelect()">戻る</button>`;
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
    markLocallyCheckedIn_(state.attendance.name);
    toast(`${state.attendance.name} さん、出勤を記録しました`);
    resetAttendanceFlow();
    // 出勤確認が終わったら、そのまま掃除進捗管理タブに自動で切り替える。
    switchTab('cleaning');
  } catch (e) {
    toast('出勤記録に失敗しました: ' + e.message, true);
  }
}

// ---------- 掃除進捗フロー ----------
// 「誰が」「どのポジション」を選ぶ画面は無くし、本日分のポジションごとの
// 掃除チェックリストをまとめて表示する。完了時の担当者はサーバー側(Code.gs)が
// 「そのポジションに本日出勤しているスタッフ」から自動的に割り当てる。

async function loadCleaningBoard({ silent = false } = {}) {
  const board = document.getElementById('cleaning-board');
  const subtitle = document.getElementById('cleaning-board-subtitle');
  if (subtitle) subtitle.textContent = `本日(${weekdayLabelForDisplay_()})分。タップで完了/未完了を切り替えます。`;
  // silent: true のときは「読み込み中」で上書きしない(タップ直後の楽観更新の裏で
  // サーバーの本当の状態と静かに同期するときに使う。ちらつき防止)。
  if (!silent) {
    board.innerHTML = '<p class="muted">読み込み中...</p>';
  }
  try {
    const positions = cfg.CLEANING_POSITIONS || cfg.POSITIONS;
    const results = await Promise.all(
      positions.map((p) => apiGet('cleaningList', { position: p, date: todayStr() }))
    );
    state.cleaning.data = {};
    positions.forEach((p, i) => { state.cleaning.data[p] = results[i]; });
    renderCleaningBoard();
  } catch (e) {
    board.innerHTML = `<p class="error-text">読み込み失敗: ${e.message}</p>`;
  }
}

function renderCleaningBoard() {
  const board = document.getElementById('cleaning-board');
  const positions = cfg.CLEANING_POSITIONS || cfg.POSITIONS;
  board.innerHTML = '';
  positions.forEach((position) => {
    const spots = state.cleaning.data[position] || [];
    const column = document.createElement('div');
    column.className = 'position-column';

    const heading = document.createElement('h3');
    heading.textContent = position;
    column.appendChild(heading);

    if (spots.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `今日(${weekdayLabelForDisplay_()})担当の掃除箇所が見つかりませんでした。`
        + '「掃除箇所マスタ」シートで、このポジションの行の「曜日」列が空欄(毎日共通)か、今日の曜日になっているか確認してください。';
      column.appendChild(p);
    } else {
      const list = document.createElement('div');
      list.className = 'spot-list';
      spots.forEach((spot) => {
        const row = document.createElement('div');
        row.className = 'spot-row' + (spot.done ? ' done' : '');
        row.innerHTML = `
          <div>
            <div>${spot.spot}</div>
            ${spot.done ? `<div class="spot-meta">${spot.doneBy} が完了</div>` : ''}
          </div>
          <span class="pill ${spot.done ? 'good' : ''}">${spot.done ? '完了' : '未完了'}</span>
        `;
        row.onclick = () => toggleSpot(position, spot);
        list.appendChild(row);
      });
      column.appendChild(list);
    }
    board.appendChild(column);
  });
}

async function toggleSpot(position, spot) {
  // タップした瞬間に見た目を切り替える(楽観的更新)。サーバーへの通信を待たずに
  // 反応するので、タップ後の「もっさり感」が無くなる。通信が失敗した場合だけ
  // 元の表示に戻す。
  const wasDone = spot.done;
  spot.done = !wasDone;
  if (spot.done && !spot.doneBy) {
    spot.doneBy = '(確認中...)';
  }
  renderCleaningBoard();
  try {
    if (wasDone) {
      await apiPost('uncompleteCleaning', { date: todayStr(), position, spot: spot.spot });
    } else {
      await apiPost('completeCleaning', { date: todayStr(), position, spot: spot.spot });
    }
    // 本当の担当者名(サーバー側で自動判定される)を静かに(ちらつかせずに)反映する。
    await loadCleaningBoard({ silent: true });
  } catch (e) {
    spot.done = wasDone;
    renderCleaningBoard();
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
  switchTab('attendance');
  startStaffSelectPolling();

  if (cfg.GAS_WEB_APP_URL.includes('XXXXXXXXXXXXXXXX')) {
    toast('config.js の GAS_WEB_APP_URL / SHARED_SECRET を設定してください', true);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

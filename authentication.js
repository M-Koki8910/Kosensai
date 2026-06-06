// Analytics page authentication and management

const SYSTEM_ADMIN_USERNAME = 'Administrator';

const loginPanel = document.getElementById('login-panel');
const analyticsPanel = document.getElementById('analytics-panel');

const loginForm = document.getElementById('login-form');
const addUserForm = document.getElementById('add-user-form');

const userListContainer = document.getElementById('user-list');

const welcomeText = document.getElementById('welcome-text');
const sessionText = document.getElementById('session-text');

const loginMessage = document.getElementById('login-message');
const userMessage = document.getElementById('user-message');

const adminOnlyCards = document.querySelectorAll('.admin-only-card');

const adminSidebar = document.getElementById('admin-sidebar');

const menuAnalytics = document.getElementById('menu-analytics');
const menuUserRegister = document.getElementById('menu-user-register');
const menuUserList = document.getElementById('menu-user-list');
const menuLogs = document.getElementById('menu-logs');
const menuAdminAccount = document.getElementById('menu-admin-account');

const headerLogoutBtn = document.getElementById('header-logout-btn');

const headerSessionInfo = document.getElementById('header-session-info');
const headerLoginStatus = document.getElementById('header-login-status');
const headerUsername = document.getElementById('header-username');
const headerRole = document.getElementById('header-role');

loginPanel.hidden = false;
loginPanel.style.display = 'flex';

analyticsPanel.hidden = true;

if (headerSessionInfo) {
  headerSessionInfo.hidden = true;
}

if (headerLogoutBtn) {
  headerLogoutBtn.hidden = true;
}

adminOnlyCards.forEach(card => {
  card.hidden = true;
});

function showSection(name) {
  const sections = document.querySelectorAll('[data-section]');

  sections.forEach(el => {
    el.style.display = 'none';
  });

  const targets = document.querySelectorAll(`[data-section="${name}"]`);

  targets.forEach(el => {
    el.style.display = '';
  });
}

menuAnalytics.addEventListener('click', () => {
  showSection('analytics');
});

menuUserRegister.addEventListener('click', () => {
  showSection('user-register');
});

menuUserList.addEventListener('click', () => {
  showSection('user-list');
});

if (menuLogs) {
  menuLogs.addEventListener('click', async () => {
    showSection('logs');
    await loadLogs();
  });
}

menuAdminAccount.addEventListener('click', () => {
  showSection('password-change');
});

if (headerLogoutBtn) {
  headerLogoutBtn.addEventListener('click', async () => {

    await fetch('/api/logout', {
      method: 'POST'
    });

    loginPanel.hidden = false;
    loginPanel.style.display = 'flex';

    analyticsPanel.hidden = true;

    if (headerSessionInfo) {
      headerSessionInfo.hidden = true;
    }

    if (headerLogoutBtn) {
      headerLogoutBtn.hidden = true;
    }

    window.location.reload();
  });
}

if (userListContainer) {

  userListContainer.addEventListener('click', async (event) => {

    const button = event.target.closest('.delete-user-btn');

    if (!button) return;

    const username = button.dataset.username;

    if (!username) return;

    if (!confirm(`ユーザ ${username} を削除しますか？`)) {
      return;
    }

    const res = await fetch(
      `/api/auth/users/${encodeURIComponent(username)}`,
      {
        method: 'DELETE',
      }
    );

    const data = await safeJson(res);

    if (!res.ok) {
      alert(data.error || '削除に失敗しました');
      return;
    }

    await loadUsers();
  });
}

async function safeJson(res) {

  const text = await res.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('サーバの応答を解析できませんでした。');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// SQLite のタイムスタンプ文字列（"YYYY-MM-DD HH:MM:SS"）を受け取り、
// 表示時にブラウザのタイムゾーンで見やすい形式に変換する。
function _parseSqliteTimestamp(ts) {
  if (!ts) return null;
  // 'YYYY-MM-DD HH:MM:SS' -> 'YYYY-MM-DDTHH:MM:SSZ' として UTC 扱いで解釈する。
  try {
    let iso = String(ts).trim().replace(' ', 'T');
    if (!iso.endsWith('Z')) iso = iso + 'Z';
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d;
  } catch (e) {
    return null;
  }
}

function _pad(n) { return String(n).padStart(2, '0'); }

function formatJST(ts) {
  if (!ts) return '';
  const d = _parseSqliteTimestamp(ts);
  if (!d) return String(ts);

  const jst = new Date(d.getTime() /*+ 9 * 60 * 60 * 1000*/);

  return `${jst.getFullYear()}-${_pad(jst.getMonth()+1)}-${_pad(jst.getDate())} ${_pad(jst.getHours())}:${_pad(jst.getMinutes())}:${_pad(jst.getSeconds())}`;
}

async function checkSession() {

  try {

    const res = await fetch('/api/auth/me');

    const data = await safeJson(res);

    if (res.ok && data.ok) {

      loginPanel.hidden = true;
      loginPanel.style.display = 'none';

      analyticsPanel.hidden = false;

      if (headerSessionInfo) {
        headerSessionInfo.hidden = false;
      }

      if (headerLogoutBtn) {
        headerLogoutBtn.hidden = false;
      }

      if (headerLoginStatus) {
        headerLoginStatus.textContent = 'ログイン中';
      }

      if (headerUsername) {
        headerUsername.textContent = data.username;
      }

      if (headerRole) {
        headerRole.textContent = `(${data.role || 'senior'})`;
      }

      welcomeText.textContent =
        `ようこそ、${data.username} さん`;

      sessionText.textContent =
        `権限: ${data.role || 'senior'} / 参照範囲: ${data.scope || 'entrance,museum'}`;

      if (adminSidebar) {
        adminSidebar.hidden = false;
      }

      adminOnlyCards.forEach(card => {
        card.hidden = data.role !== 'administrator';
      });

      if (menuAdminAccount) {
        menuAdminAccount.hidden =
          data.role !== 'administrator';
      }

      loadAnalytics();

      showSection('analytics');

      if (data.role === 'administrator') {
        loadUsers();
        loadLogs();
      }

    } else {

      loginPanel.hidden = false;
      loginPanel.style.display = 'flex';

      analyticsPanel.hidden = true;

      if (headerSessionInfo) {
        headerSessionInfo.hidden = true;
      }

      if (headerLogoutBtn) {
        headerLogoutBtn.hidden = true;
      }

      if (adminSidebar) {
        adminSidebar.hidden = true;
      }
    }

  } catch (error) {

    loginMessage.textContent =
      '認証状態の確認に失敗しました。';
  }
}

async function loadLogs() {
  try {
    const res = await fetch('/api/admin/logs');
    const data = await safeJson(res);

    const container = document.getElementById('analytics-logs-table');

    if (!res.ok) {
      if (container) container.textContent = data && data.error ? data.error : 'ログを取得できませんでした';
      return;
    }

    const rows = data.logs || [];

    if (!rows.length) {
      if (container) container.textContent = 'ログはありません。';
      return;
    }

    if (container) {
      container.innerHTML = `
        <thead>
          <tr>
            <th>日時</th>
            <th>ユーザ</th>
            <th>操作</th>
            <th>ページ</th>
            <th>セッション</th>
            <th>詳細</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td data-label="日時">${formatJST(r.created_at)}</td>
              <td data-label="ユーザ">${escapeHtml(r.username)}</td>
              <td data-label="操作">${escapeHtml(r.type)}</td>
              <td data-label="ページ">${escapeHtml(r.page)}</td>
              <td data-label="セッション">${escapeHtml(r.session_id)}</td>
              <td data-label="詳細">${escapeHtml(r.detail)}</td>
            </tr>
          `).join('')}
        </tbody>
      `;
    }

  } catch (error) {
    const container = document.getElementById('analytics-logs-table');
    if (container) container.textContent = error.message;
  }
}

async function loadUsers() {

  try {

    const res = await fetch('/api/auth/users');

    const data = await safeJson(res);

    if (!res.ok) {
      throw new Error(
        data.error || 'ユーザ一覧の取得に失敗しました'
      );
    }

    const rows = data.users || [];

    if (!userListContainer) return;

    if (!rows.length) {

      userListContainer.textContent =
        '登録ユーザはまだありません。';

      return;
    }

    userListContainer.innerHTML = `
      <table class="analytics-table user-table">
        <thead>
          <tr>
             <th>ユーザ名</th>
            <th>権限</th>
            <th>範囲</th>
            <th>登録日</th>
            <th>操作</th>
          </tr>
        </thead>

        <tbody>

          ${rows.map(user => `

            <tr>

              <td data-label="ユーザ名">
                ${escapeHtml(user.username)}
              </td>

              <td data-label="権限">
                ${escapeHtml(user.role || 'senior')}
              </td>

              <td data-label="範囲">
                ${escapeHtml(user.scope || 'entrance,museum')}
              </td>

              <td data-label="登録日">
                ${formatJST(user.created_at)}
              </td>

              <td data-label="操作">

                ${
                  user.username === SYSTEM_ADMIN_USERNAME

                    ? `
                      <button
                        type="button"
                        class="stamp-btn secondary"
                        disabled>
                        固定
                      </button>
                    `

                    : `
                      <button
                        type="button"
                        class="stamp-btn secondary delete-user-btn"
                        data-username="${escapeHtml(user.username)}">
                        削除
                      </button>
                    `
                }

              </td>

            </tr>

          `).join('')}

        </tbody>
      </table>
    `;

  } catch (error) {

    if (userListContainer) {
      userListContainer.textContent =
        error.message;
    }
  }
}

async function loadAnalytics() {

  try {

    const summaryRes =
      await fetch('/api/admin/summary');

    const summary =
      await safeJson(summaryRes);

    const eventsRes =
      await fetch('/api/admin/events');

    const events =
      await safeJson(eventsRes);

    // サマリー表示
    document.getElementById('analytics-summary').textContent =
      `総訪問数 ${summary.totals.visits} / 総リンク遷移数 ${summary.totals.clicks}`;

    // 場所別集計テーブル描画
    const locTable = document.getElementById('analytics-locations');
    if (locTable) {
      locTable.innerHTML = `
        <thead><tr><th>場所ID</th><th>場所名</th><th>訪問数</th><th>リンク遷移数</th></tr></thead>
        <tbody>
          ${ (summary.locations || []).map(loc => `
            <tr>
              <td data-label="場所ID">${escapeHtml(loc.stamp_id)}</td>
              <td data-label="場所名">${escapeHtml(loc.stamp_name)}</td>
              <td data-label="訪問数">${escapeHtml(loc.visits)}</td>
              <td data-label="リンク遷移数">${escapeHtml(loc.clicks)}</td>
            </tr>
          `).join('') }
        </tbody>
      `;
    }

    // 検索・表示モードに応じて描画
    const viewModeEl = document.getElementById('analytics-view-mode');
    const locFilterEl = document.getElementById('analytics-location-filter');
    const viewMode = viewModeEl ? viewModeEl.value : 'summary';
    const locFilter = locFilterEl ? locFilterEl.value : 'all';

    const visits = events.visits || [];
    const clicks = events.clicks || [];

    renderAnalyticsView(viewMode, locFilter, summary, visits, clicks);

  } catch (error) {

    document.getElementById('analytics-summary').textContent =
      'データ取得に失敗しました。';
  }
}

loginForm.addEventListener('submit', async (event) => {

  event.preventDefault();

  const username =
    document.getElementById('login-username')
      .value
      .trim();

  const password =
    document.getElementById('login-password')
      .value;

  try {

    const res = await fetch('/api/login', {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        username,
        password
      })
    });

    const data = await safeJson(res);

    if (!res.ok) {
      throw new Error(
        (data && data.error) ||
        'ログインに失敗しました'
      );
    }

    loginMessage.textContent =
      `${data.username} さんとしてログインしました。`;

    await checkSession();

  } catch (error) {

    loginMessage.textContent =
      error.message;
  }
});

checkSession();

// analytics controls handlers
const analyticsRefreshBtn = document.getElementById('analytics-refresh');
const analyticsViewMode = document.getElementById('analytics-view-mode');
const analyticsLocationFilter = document.getElementById('analytics-location-filter');

if (analyticsRefreshBtn) analyticsRefreshBtn.addEventListener('click', () => loadAnalytics());
if (analyticsViewMode) analyticsViewMode.addEventListener('change', () => loadAnalytics());
if (analyticsLocationFilter) analyticsLocationFilter.addEventListener('change', () => loadAnalytics());

const analyticsDeleteLogsBtn = document.getElementById('analytics-delete-logs');
const analyticsDeleteVisitsBtn = document.getElementById('analytics-delete-visits');
const analyticsDeleteClicksBtn = document.getElementById('analytics-delete-clicks');
const analyticsDeleteEventsBtn = document.getElementById('analytics-delete-events');

if (analyticsDeleteLogsBtn) analyticsDeleteLogsBtn.addEventListener('click', async () => {
  if (!confirm('ログをすべて削除します。よろしいですか？')) return;
  try {
    const res = await fetch('/api/admin/logs', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data && data.error ? data.error : '削除に失敗しました');
    alert('ログを削除しました');
    loadLogs();
  } catch (e) {
    alert(e.message || 'エラー');
  }
});

if (analyticsDeleteVisitsBtn) analyticsDeleteVisitsBtn.addEventListener('click', async () => {
  if (!confirm('訪問履歴（全件）を削除します。よろしいですか？')) return;
  try {
    const res = await fetch('/api/admin/events', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'visits' }) });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data && data.error ? data.error : '削除に失敗しました');
    alert('訪問履歴を削除しました');
    loadAnalytics();
  } catch (e) {
    alert(e.message || 'エラー');
  }
});

if (analyticsDeleteClicksBtn) analyticsDeleteClicksBtn.addEventListener('click', async () => {
  if (!confirm('遷移履歴（全件）を削除します。よろしいですか？')) return;
  try {
    const res = await fetch('/api/admin/events', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'clicks' }) });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data && data.error ? data.error : '削除に失敗しました');
    alert('遷移履歴を削除しました');
    loadAnalytics();
  } catch (e) {
    alert(e.message || 'エラー');
  }
});

if (analyticsDeleteEventsBtn) analyticsDeleteEventsBtn.addEventListener('click', async () => {
  if (!confirm('訪問/遷移履歴（全件）を削除します。よろしいですか？')) return;
  try {
    const res = await fetch('/api/admin/events', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'all' }) });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data && data.error ? data.error : '削除に失敗しました');
    alert('訪問/遷移履歴を削除しました');
    loadAnalytics();
  } catch (e) {
    alert(e.message || 'エラー');
  }
});

function renderAnalyticsView(viewMode, locFilter, summary, visits, clicks) {
  // utility to combine and sort events by id desc (approx chronological)
  const rows = [];
  visits.forEach(r => rows.push(Object.assign({}, r, { action: 'visit' })));
  clicks.forEach(r => rows.push(Object.assign({}, r, { action: 'click' })));
  rows.sort((a,b) => (b.id || 0) - (a.id || 0));

  // apply location filter if not 'all'
  const filtered = locFilter && locFilter !== 'all' ? rows.filter(r => r.stamp_id === locFilter) : rows;

  const eventsTable = document.getElementById('analytics-events-table');
  const locationsTable = document.getElementById('analytics-locations');

  if (viewMode === 'chronological') {
    if (locationsTable) locationsTable.style.display = 'none';
    if (eventsTable) {
      eventsTable.style.display = '';
      eventsTable.innerHTML = `
        <thead>
          <tr><th>#</th><th>ID</th><th>日時</th><th>アクション</th><th>場所ID</th><th>場所名</th><th>ページ</th><th>セッションID</th><th>ユーザ</th><th>属性</th></tr>
        </thead>
        <tbody>
          ${ filtered.map((r,i) => `
            <tr>
              <td>${i+1}</td>
              <td>${escapeHtml(r.id)}</td>
              <td>${formatJST(r.created_at) || ''}</td>
              <td>${escapeHtml(r.action)}</td>
              <td>${escapeHtml(r.stamp_id)}</td>
              <td>${escapeHtml(r.stamp_name)}</td>
              <td>${escapeHtml(r.page)}</td>
              <td>${escapeHtml(r.session_id)}</td>
              <td>${escapeHtml(r.username)}</td>
              <td>${escapeHtml(r.demographic)}</td>
            </tr>
          `).join('') }
        </tbody>
      `;
    }
  } else if (viewMode === 'by-location') {
    if (locationsTable) locationsTable.style.display = '';
    if (eventsTable) {
      eventsTable.style.display = '';
      // group by location
      const groups = {};
      filtered.forEach(r => {
        const id = r.stamp_id || 'unknown';
        groups[id] = groups[id] || [];
        groups[id].push(r);
      });

      let html = '';
      Object.keys(groups).forEach(loc => {
        html += `\n<section class="analytics-location">\n  <h4>場所: ${escapeHtml(loc)}</h4>\n  <table class="analytics-table">\n    <thead><tr><th>#</th><th>ID</th><th>日時</th><th>アクション</th><th>ページ</th><th>セッションID</th><th>ユーザ</th><th>属性</th></tr></thead>\n    <tbody>`;
        groups[loc].forEach((r,i) => {
          html += `<tr><td>${i+1}</td><td>${escapeHtml(r.id)}</td><td>${formatJST(r.created_at)||''}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.page)}</td><td>${escapeHtml(r.session_id)}</td><td>${escapeHtml(r.username)}</td><td>${escapeHtml(r.demographic)}</td></tr>`;
        });
        html += `</tbody></table></section>`;
      });

      eventsTable.innerHTML = html;
    }
  } else {
    // default: summary (locations table is primary)
    if (locationsTable) locationsTable.style.display = '';
    if (eventsTable) eventsTable.style.display = 'none';
  }
}

if (addUserForm) {
  addUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const newUsername = (document.getElementById('new-user') || {}).value || '';
    const password = (document.getElementById('new-password') || {}).value || '';
    const role = document.getElementById('role').value;
    const scope = Array.from(
      document.querySelectorAll('input[type="checkbox"]:checked')
    ).map(cb => cb.value);
    //const role = (document.getElementById('new-role') || {}).value || 'senior';
    //const scope = (document.getElementById('new-scope') || {}).value || 'entrance,museum';

    if (!newUsername || !password) {
      if (userMessage) userMessage.textContent = 'ユーザ名とパスワードを入力してください';
      return;
    }

    try {
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password, role, scope })
      });

      const data = await safeJson(res);

      if (!res.ok) {
        if (userMessage) userMessage.textContent = data && data.error ? data.error : 'ユーザ追加に失敗しました';
        return;
      }

      if (userMessage) userMessage.textContent = `${data.username} を追加しました`;

      (document.getElementById('new-user') || {}).value = '';
      (document.getElementById('new-password') || {}).value = '';

      await loadUsers();

    } catch (error) {
      if (userMessage) userMessage.textContent = error.message;
    }
  });
}

const passwordForm = document.getElementById('password-form');
const passwordMessage = document.getElementById('password-message');

if (passwordForm) {
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const current = (document.getElementById('current-password') || {}).value || '';
    const next = (document.getElementById('new-password-own') || {}).value || '';

    if (!current || !next) {
      if (passwordMessage) passwordMessage.textContent = '現在のパスワードと新しいパスワードを入力してください';
      return;
    }

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next })
      });

      const data = await safeJson(res);

      if (!res.ok) {
        if (passwordMessage) passwordMessage.textContent = data && data.error ? data.error : 'パスワードの変更に失敗しました';
        return;
      }

      if (passwordMessage) passwordMessage.textContent = 'パスワードを変更しました';

      (document.getElementById('current-password') || {}).value = '';
      (document.getElementById('new-password-own') || {}).value = '';

    } catch (error) {
      if (passwordMessage) passwordMessage.textContent = error.message;
    }
  });
}

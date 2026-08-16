// ============================================================================
// 統合管理ページ - ログイン＆認証処理 admin-integrated.js 【修正版】
// ============================================================================

let currentUser = null;
let currentRule = null;

// DOM要素
const loginScreen = document.getElementById('loginScreen');
const adminScreen = document.getElementById('adminScreen');
const loginForm = document.getElementById('loginForm');
const logoutBtn = document.getElementById('logoutBtn');
const userDisplayName = document.getElementById('userDisplayName');
const userRole = document.getElementById('userRole');
const addUserForm = document.getElementById('add-user-form');
const userMessage = document.getElementById('userMessage');
document.getElementById('addRuleBtn')?.addEventListener('click', saveRule);

const PAGE_LIST = [
  'index',
  'about',
  'guest',
  'shop',
  'event',
  'stamp-rally',
  'schedule',
  'company',
  'map',
  'announcements',
  'bulletin',
  'access'
];

const ROLE_DEFAULTS = {

  administrator: [
    'analytics.view',
    'posts.manage',
    'announcement.create',
    'announcement.manage',
    'logs.view',
    'users.create'
  ],

  executivestaff: [
    'analytics.view',
    'posts.manage',
    'announcement.create',
    'announcement.manage',
    'logs.view'
  ],

  staff: [
    'announcement.create'
  ],

  company: [
    'analytics.view'
  ]
};

// ページナビゲーション
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    const page = e.target.dataset.page;
    showPage(page);
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    e.target.classList.add('active');
  });
});

// ログイン処理
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
 
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, purpose: 'admin' })
    });
 
    const data = await response.json();
 
    if (data.ok) {
      currentUser = data;
      
      // ★修正：permissions を明示的に設定
      applyPermissions(data);
      
       // 追加
    const params = new URLSearchParams(location.search);
    const redirect = params.get("redirect");

    if (redirect) {
      window.location.href = decodeURIComponent(redirect);
      return;
    }

      // ★修正：UI アクセス制御を先に適用
      showAdminScreen();
      applyUIAccessControl();
      
      // ★修正：初回表示はホームへ
      showPage('home');
    } else {
      showLoginMessage(data.error || 'ログインに失敗しました', 'error');
    }
  } catch (e) {
    console.error('ログインエラー', e);
    showLoginMessage('ログインに失敗しました', 'error');
  }
});

// ログアウト
logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
    currentUser = null;
    loginScreen.style.display = 'flex';
    adminScreen.style.display = 'none';
    document.getElementById('loginForm').reset();
    document.getElementById('loginMessage').classList.remove('show');
  } catch (e) {
    console.error('ログアウトエラー', e);
  }
});

function showLoginMessage(text, type) {
  const msg = document.getElementById('loginMessage');
  msg.textContent = text;
  msg.className = `login-message show ${type}`;
}

function showUserMessage(text, type = 'info') {
  if (!userMessage) return;

  userMessage.textContent = text;
  userMessage.className = type; // success / error / info
}

 //showUserMessage('ユーザーを追加しました', 'success');
 //showUserMessage('エラーが発生しました', 'error');

function showAdminScreen() {
  loginScreen.style.display = 'none';
  adminScreen.style.display = 'flex';
  document.getElementById('sidebar').classList.add('show');
  document.getElementById('mainContent').classList.add('show');
  document.getElementById('headerBar').classList.add('show');
 
  userDisplayName.textContent = currentUser.username;
  userRole.textContent = `(${currentUser.role || 'senior'})`;
  document.getElementById('accountUsername').value = currentUser.username;
 
  // ★削除：applyUIAccessControl() はここから削除
  // （ログインハンドラ内で呼ぶため）
}

// ============================================================================
// ★【修正】showPage 関数: ページ表示とデータロード
// ============================================================================
function showPage(page) {

  if (page === 'home') {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('home').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector('[data-page="home"]').classList.add('active');
    return;
  }
 
  // publish / site-control ページは administrator のみ
  if (page === 'publish' || page === 'site-control') {
    if (!can('control')) {
      showMessage('このページへのアクセス権限がありません', 'error');
      return;
    }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('site-control').classList.add('active');
    loadPublish();
    return;
  }
 
  // ★【修正】ダッシュボードとアカウント設定は常に許可＋データロード
  if (page === 'dashboard' || page === 'account') {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(page).classList.add('active');
    if (page === 'account') {
      document.getElementById('accountUsername').value = currentUser.username;
    }
    // ★【修正】: ダッシュボード時はデータをロード
    if (page === 'dashboard') {
      loadDashboard();
    }
    return;
  }
 
  // その他のページは権限チェック
  const pageMap = {
    posts: 'announcement.manage',
    'ng-rules': 'announcement.manage',
    announcements: 'announcement.manage',
    analytics: 'analytics.read',
    users: 'users.read',
    logs: 'logs.read'
  };
 
  const requiredPerm = pageMap[page];
  if (requiredPerm && !can(requiredPerm)) {
    showMessage('このページへのアクセス権限がありません', 'error');
    return;
  }
 
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(page).classList.add('active');
 
  // ★【修正】: 各ページのロード処理を showPage 内で実行
  if (page === 'posts') loadPosts();
  if (page === 'ng-rules') loadRules();
  if (page === 'announcements') loadAnnouncements();
  if (page === 'analytics') loadAnalytics();
  if (page === 'users') loadUsers();
  if (page === 'logs') loadLogs();
}

// ============================================================================
// ★【修正】applyUIAccessControl: nav-item の表示制御のみに集中
// ============================================================================
function applyUIAccessControl() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    const page = btn.dataset.page;
 
    // ダッシュボードとアカウント設定は常に表示
    if (page === 'dashboard' || page === 'account') {
      btn.style.display = 'block';
      return;
    }
 
    // その他のページは権限に基づいて表示・非表示
    const map = {
      posts: 'announcement.manage',
      'ng-rules': 'announcement.manage',
      announcements: 'announcement.manage',
      users: 'users.read',
      logs: 'logs.read',
      analytics: 'analytics.read'
    };
 
    const perm = map[page];
    if (perm && !can(perm)) {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'block';
    }
  });
}

if (addUserForm) {
  addUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const newUsername = document.getElementById('new-user')?.value || '';
    const password = document.getElementById('new-password')?.value || '';
    const role = document.getElementById('role')?.value || 'visitor';
    
    const scope = Array.from(
  document.querySelectorAll(
    '#scope-list input:checked'
  )
).map(cb => cb.value);
 

    if (!newUsername || !password) {
      userMessage.textContent = 'ユーザ名とパスワードを入力してください';
      return;
    }

    try {
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
            username: newUsername,
            password,
            role,
            scope,
            permissions
          })
      });

      const data = await res.json();

      if (!res.ok) {
        userMessage.textContent = data?.error || 'ユーザ追加に失敗しました';
        return;
      }

      userMessage.textContent = `${data.username} を追加しました`;

      addUserForm.reset();

      await loadUsers();

    } catch (err) {
      userMessage.textContent = err.message;
    }
  });
}

const roleSelect =
  document.getElementById('role');

const scopeContainer =
  document.getElementById('scope-container');

if (roleSelect) {

  roleSelect.addEventListener(
    'change',
    updateRoleUI
  );

  updateRoleUI();
}

async function updateRoleUI() {

  const role = roleSelect.value;

  scopeContainer.style.display =
    role === 'company'
      ? 'block'
      : 'none';

  const defaults =
    ROLE_DEFAULTS[role] || [];

  document
    .querySelectorAll('.permission-checkbox')
    .forEach(cb => {
      cb.checked = defaults.includes(cb.value);
    });

  // company のときだけ企業一覧を読み込む
  if (role === 'company') {
    await loadCompanyScopes();
  }

}

let companyScopesLoaded = false;

async function loadCompanyScopes() {

  if (companyScopesLoaded) return;

  const list = document.getElementById('scope-list');

  try {
    const response = await fetch('companies.json');
    if (!response.ok) throw new Error();

    const companies = await response.json();

    list.innerHTML = companies.map(company => `
      <label>
        <input type="checkbox" value="${company.id}">
        ${company.name}
      </label>
    `).join('');

    companyScopesLoaded = true;

  } catch (error) {
    console.error(error);
    list.innerHTML = '企業一覧の取得に失敗しました';
  }
}

// ============================================================================
// メッセージ表示
// ============================================================================

function showMessage(text, type = 'info') {
  const msg = document.getElementById('message');
  msg.textContent = text;
  msg.className = `message show ${type}`;
  if (type === 'success') {
    setTimeout(() => msg.classList.remove('show'), 3000);
  }
}

// ============================================================================
// セッション確認
// ============================================================================

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
 
    if (data.ok) {
      currentUser = data;
 
      // ★修正：permissions を設定
      applyPermissions(data);
 
      // ★修正：UI アクセス制御を先に適用
      showAdminScreen();
      applyUIAccessControl();
      
      // ★修正：showPage() を呼ぶだけで loadDashboard() もカバー
      //showPage('dashboard');
 
    } else {
      showLoginScreen();
    }
  } catch (e) {
    showLoginScreen();
  }
}

function showLoginScreen() {
  loginScreen.style.display = 'flex';
  adminScreen.style.display = 'none';
}

// ============================================================================
// ダッシュボード
// ============================================================================

async function loadDashboard() {
  try {
    const postsRes = await fetch('/api/admin/posts?limit=1000');
    const postsData = await postsRes.json();
    const posts = postsData.posts || [];

    const rulesRes = await fetch('/api/admin/ng-rules');
    const rulesData = await rulesRes.json();
    const rules = rulesData.rules || [];

    const announcementsRes = await fetch('/api/admin/announcements');
    const announcementsData = announcementsRes.json();
    const announcements = (await announcementsData).announcements || [];

    const pending = posts.filter(p => p.status === 'pending').length;

    document.getElementById('dashboardPosts').textContent = posts.length;
    document.getElementById('dashboardPending').textContent = pending;
    document.getElementById('dashboardRules').textContent = rules.length;
    document.getElementById('dashboardAnnouncements').textContent = announcements.length;
  } catch (e) {
    console.error('ダッシュボード読み込みエラー', e);
  }
}

// ============================================================================
// 投稿管理
// ============================================================================
function openModal(id) {
  document.getElementById(id).classList.add('show');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

async function loadPosts() {
  try {
    const response = await securefetch('/api/admin/posts');
    if (!response) return;

    const data = await response.json();

    if (!data.ok) {
      showMessage('投稿を読み込めませんでした', 'error');
      return;
    }

    const posts = data.posts || [];
    const tbody = document.getElementById('postsTableBody');

    if (posts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">投稿がありません</td></tr>';
      return;
    }

    tbody.innerHTML = posts.map(post => `
      <tr>
        <td>${post.id}</td>
        <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(post.content)}
        </td>
        <td>${post.risk_score}</td>
        <td><span class="status-badge">${getStatusLabel(post.status)}</span></td>
        <td>${new Date(post.created_at).toLocaleString('ja-JP')}</td>
        <td>
          <button class="btn" onclick="editPost(${post.id})">編集</button>
          <button
 class="btn btn-danger"
 onclick="hidePost(${post.id})">
 非表示
</button>
          <button class="btn btn-danger" onclick="deletePost(${post.id})">削除</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('投稿読み込みエラー', e);
    showMessage('投稿を読み込めませんでした', 'error');
  }
}

let currentPost = null;

async function editPost(postId) {
  try {
    const response = await securefetch('/api/admin/posts');

    if (!response) return;

    const data = await response.json();

    const post = data.posts.find(
      p => p.id === postId
    );

    if (!post) {
      showMessage('投稿が見つかりません', 'error');
      return;
    }

    currentPost = post;

    document.getElementById('postModalId').value = post.id;
    document.getElementById('postModalContent').textContent = post.content;
    document.getElementById('postModalRiskScore').value = post.risk_score;
    document.getElementById('postModalCurrentStatus').value = post.status;
    document.getElementById('postModalNewStatus').value = post.status;

    openModal('postModal');

  } catch (e) {
    console.error(e);
  }
}

async function savePostStatus() {

  if (!currentPost) return;

  const status =
    document.getElementById('postModalNewStatus').value;

  const reason =
    document.getElementById('postModalReason').value;

  try {

    const response =
      await securefetch(
        `/api/admin/posts/${currentPost.id}/status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            status,
            reason
          })
        }
      );

    if (!response) return;

    const data = await response.json();

    if (data.ok) {

      showMessage(
        '投稿状態を更新しました',
        'success'
      );

      closeModal('postModal');

      loadPosts();

    } else {

      showMessage(
        data.error,
        'error'
      );
    }

  } catch (e) {

    console.error(e);

    showMessage(
      '更新に失敗しました',
      'error'
    );
  }
}

async function hidePost(postId) {

  if (!confirm('投稿を非表示にしますか？')) {
    return;
  }

  try {

    const response =
      await securefetch(
        `/api/admin/posts/${postId}/status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            status: 'hidden'
          })
        }
      );

    if (!response) return;

    const data = await response.json();

    if (data.ok) {

      showMessage(
        '投稿を非表示にしました',
        'success'
      );

      loadPosts();

    } else {

      showMessage(
        data.error,
        'error'
      );
    }

  } catch (e) {

    console.error(e);

    showMessage(
      '非表示に失敗しました',
      'error'
    );
  }
}

async function deletePost(postId) {

  if (!confirm('投稿を削除しますか？ この操作は取り消せません。')) {
    return;
  }

  try {

    const response =
      await securefetch(
        `/api/admin/posts/${postId}`,
        {
          method: 'DELETE'
        }
      );

    if (!response) return;

    const data = await response.json();

    if (data.ok) {

      showMessage(
        '投稿を削除しました',
        'success'
      );

      loadPosts();

    } else {

      showMessage(
        data.error,
        'error'
      );
    }

  } catch (e) {

    console.error(e);

    showMessage(
      '削除に失敗しました',
      'error'
    );
  }
}

// ============================================================================
// NG判定ルール管理
// ============================================================================

async function loadRules() {
  try {
    const response = await fetch('/api/admin/ng-rules');
    const data = await response.json();

    if (!data.ok) {
      showMessage('ルールを読み込めませんでした', 'error');
      return;
    }

    const rules = data.rules || [];
    const tbody = document.getElementById('rulesTableBody');

    if (rules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">ルールがありません</td></tr>';
      return;
    }

    tbody.innerHTML = rules.map(rule => `
      <tr>
        <td>${rule.id}</td>
        <td style="font-family: monospace; font-size: 12px; max-width: 150px; overflow: hidden; text-overflow: ellipsis;">
          ${escapeHtml(rule.pattern)}
        </td>
        <td>${rule.is_regex ? '正規表現' : 'テキスト'}</td>
        <td>${rule.risk_score}</td>
        <td>${rule.description || '-'}</td>
        <td>${rule.enabled ? '有効' : '無効'}</td>
        <td>
          <button class="btn btn-warning" onclick="toggleRule(${rule.id})">
            ${rule.enabled ? '無効化' : '有効化'}
          </button>
          <button class="btn btn-danger" onclick="deleteRule(${rule.id})">削除</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('ルール読み込みエラー', e);
    showMessage('ルールを読み込めませんでした', 'error');
  }
}

async function saveRule() {

  console.log(document.getElementById('ruleType'));

  const pattern =
    document.getElementById('rulePattern').value.trim();

  const isRegex =
    parseInt(document.getElementById('ruleType').value);

  const riskScore =
    parseInt(document.getElementById('ruleRiskScore').value);

  const description =
    document.getElementById('ruleDescription').value.trim();

  if (!pattern) {
    showMessage('パターンを入力してください', 'error');
    return;
  }

  try {

    const response = await fetch('/api/admin/ng-rules', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pattern,
        is_regex: isRegex,
        risk_score: riskScore,
        description: description || null
      })
    });

    const data = await response.json();

    if (data.ok) {

      showMessage('ルールを追加しました', 'success');

      document.getElementById('rulePattern').value = '';
      document.getElementById('ruleType').value = '0';
      document.getElementById('ruleRiskScore').value = '10';
      document.getElementById('ruleDescription').value = '';

      loadRules();

    } else {

      showMessage(
        data.error || '追加に失敗しました',
        'error'
      );

    }

  } catch (e) {

    console.error(e);
    showMessage(
      'ルールの追加に失敗しました',
      'error'
    );

  }
}

async function toggleRule(ruleId) {
  try {
    const response = await fetch(`/api/admin/ng-rules/${ruleId}/toggle`, {
      method: 'POST'
    });
    const data = await response.json();

    if (data.ok) {
      showMessage('ルールの状態を更新しました', 'success');
      loadRules();
    } else {
      showMessage(data.error || '更新に失敗しました', 'error');
    }
  } catch (e) {
    console.error('ルール更新エラー', e);
    showMessage('ルールの更新に失敗しました', 'error');
  }
}

async function deleteRule(ruleId) {
  if (!confirm('このルールを削除しますか？')) return;

  try {
    const response = await fetch(`/api/admin/ng-rules/${ruleId}`, {
      method: 'DELETE'
    });
    const data = await response.json();

    if (data.ok) {
      showMessage('ルールを削除しました', 'success');
      loadRules();
    } else {
      showMessage(data.error || '削除に失敗しました', 'error');
    }
  } catch (e) {
    console.error('ルール削除エラー', e);
    showMessage('ルールの削除に失敗しました', 'error');
  }
}

// ============================================================================
// アナウンス管理
// ============================================================================

async function loadAnnouncements() {
  try {
    const response = await fetch('/api/admin/announcements');
    const data = await response.json();

    if (!data.ok) {
      showMessage('アナウンスを読み込めませんでした', 'error');
      return;
    }

    const announcements = data.announcements || [];
    const tbody = document.getElementById('announcementsTableBody');

    if (announcements.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">アナウンスがありません</td></tr>';
      return;
    }

    tbody.innerHTML = announcements.map(ann => `
      <tr>
        <td>${ann.id}</td>
        <td>${escapeHtml(ann.title)}</td>
        <td>${getImportanceLabel(ann.importance)}</td>
        <td>${new Date(ann.published_at).toLocaleString('ja-JP')} ～ ${new Date(ann.expires_at).toLocaleString('ja-JP')}</td>
        <td>${ann.created_by || '-'}</td>
        <td>
          <button class="btn btn-danger" onclick="deleteAnnouncement(${ann.id})">削除</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('アナウンス読み込みエラー', e);
    showMessage('アナウンスを読み込めませんでした', 'error');
  }
}

async function deleteAnnouncement(annId) {
  if (!confirm('このアナウンスを削除しますか？')) return;

  try {
    const response = await fetch(`/api/admin/announcements/${annId}`, {
      method: 'DELETE'
    });
    const data = await response.json();

    if (data.ok) {
      showMessage('アナウンスを削除しました', 'success');
      loadAnnouncements();
    } else {
      showMessage(data.error || '削除に失敗しました', 'error');
    }
  } catch (e) {
    console.error('アナウンス削除エラー', e);
    showMessage('アナウンスの削除に失敗しました', 'error');
  }
}

// ============================================================================
// アナリティクス
// ============================================================================

async function loadAnalytics() {
  try {
    const [summaryRes, eventsRes] = await Promise.all([
      fetch('/api/admin/summary'),
      fetch('/api/admin/events')
    ]);

    const data = await summaryRes.json();
    const eventsData = await eventsRes.json();

    if (!data.locations) {
      showMessage('アナリティクスを読み込めませんでした', 'error');
      return;
    }

    const summary = data;

    const statsHtml = `
      <div class="stat-item">
        <div class="stat-number">${summary.totals?.visits || 0}</div>
        <div class="stat-label">訪問数</div>
      </div>
      <div class="stat-item">
        <div class="stat-number">${summary.totals?.clicks || 0}</div>
        <div class="stat-label">クリック数</div>
      </div>
    `;

    document.getElementById('analyticsStats').innerHTML = statsHtml;

    const cards = document.getElementById('analyticsLocationCards');
    const tbody = document.getElementById('analyticsTableBody');
    const locations = summary.locations || [];
    const visits = Array.isArray(eventsData.visits) ? eventsData.visits : [];
    const clicks = Array.isArray(eventsData.clicks) ? eventsData.clicks : [];

    const rows = [];
    visits.forEach(item => rows.push({ ...item, eventType: 'visit' }));
    clicks.forEach(item => rows.push({ ...item, eventType: 'click' }));
    rows.sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      return bTime - aTime;
    });

cards.innerHTML = locations.map(loc => `
  <div class="stat-item">
    <div class="stat-number">${loc.visits}</div>
    <div class="stat-label">${loc.stamp_name} 訪問</div>

    <div style="margin-top:10px;font-size:20px;font-weight:bold;color:#28a745;">
      ${loc.clicks}
    </div>
    <div class="stat-label">クリック</div>
  </div>
`).join('');

    

    if (locations.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">データなし</td></tr>';
      return;
    }

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">イベント履歴がありません</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(row => `
      <tr>
        <td>${formatDate(row.created_at)}</td>
        <td>${escapeHtml(row.stamp_name || row.stamp_id || '-')}</td>
        <td>${row.eventType === 'visit' ? '1' : ''}</td>
        <td>${row.eventType === 'click' ? '1' : ''}</td>
        <td>${escapeHtml(formatAttributes(row.attributes))}</td>
      </tr>
    `).join('');

  } catch (e) {
    console.error('アナリティクス読み込みエラー', e);
    showMessage('アナリティクスを読み込めませんでした', 'error');
  }
}

// ============================================================================
// ユーザー管理
// ============================================================================

async function loadUsers() {
  try {
    const response = await fetch('/api/auth/users');
    const data = await response.json();

    if (!data.ok) {
      showMessage('ユーザーを読み込めませんでした', 'error');
      return;
    }

    const users = data.users || [];
    const tbody = document.getElementById('usersTableBody');

    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">ユーザーがありません</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(user => `
      <tr>
        <td>${user.username}</td>
        <td>${user.role}</td>
        <td>${user.scope}</td>
        <td>${formatDate(user.created_at)}</td>
        <td>
          <button class="btn btn-danger" onclick="deleteUser('${user.username}')">削除</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('ユーザー読み込みエラー', e);
    showMessage('ユーザーを読み込めませんでした', 'error');
  }
}

function openUserModal() {
  showMessage('ユーザー追加機能は authentication.js を参照してください', 'info');
}

async function deleteUser(username) {
  if (!confirm(`ユーザー "${username}" を削除しますか？`)) return;

  try {
    const response = await fetch(`/api/auth/users/${encodeURIComponent(username)}`, {
      method: 'DELETE'
    });
    const data = await response.json();

    if (data.ok) {
      showMessage('ユーザーを削除しました', 'success');
      loadUsers();
    } else {
      showMessage(data.error || '削除に失敗しました', 'error');
    }
  } catch (e) {
    console.error('ユーザー削除エラー', e);
    showMessage('ユーザーの削除に失敗しました', 'error');
  }
}

// ============================================================================
// ログ
// ============================================================================

async function loadLogs() {
  try {
    const response = await fetch('/api/admin/logs');
    const data = await response.json();

    if (!data.ok) {
      showMessage('ログを読み込めませんでした', 'error');
      return;
    }

    const logs = data.logs || [];
    const tbody = document.getElementById('logsTableBody');

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">ログなし</td></tr>';
      return;
    }

    tbody.innerHTML = logs.slice(0, 100).map(log => `
      <tr>
        <td>${log.type}</td>
        <td>${log.username || '-'}</td>
        <td>${log.detail || '-'}</td>
        <td>${formatDate(log.created_at)}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('ログ読み込みエラー', e);
    showMessage('ログを読み込めませんでした', 'error');
  }
}

// ============================================================================
// アカウント設定
// ============================================================================

async function changePassword() {
  const current = document.getElementById('currentPassword').value;
  const newPass = document.getElementById('newPassword').value;

  if (!current || !newPass) {
    showMessage('パスワードを入力してください', 'error');
    return;
  }

  if (newPass.length < 12) {
    showMessage('新しいパスワードは12文字以上である必要があります', 'error');
    return;
  }

  try {
    const response = await fetch('/api/auth/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_password: current,
        new_password: newPass
      })
    });

    const data = await response.json();

    if (data.ok) {
      showMessage('パスワードを変更しました', 'success');
      document.getElementById('currentPassword').value = '';
      document.getElementById('newPassword').value = '';
    } else {
      showMessage(data.error || '変更に失敗しました', 'error');
    }
  } catch (e) {
    console.error('パスワード変更エラー', e);
    showMessage('パスワードの変更に失敗しました', 'error');
  }
}

// ============================================================================
// ユーティリティ関数
// ============================================================================

function getStatusLabel(status) {
  const labels = {
    'published': '公開済み',
    'pending': '確認中',
    'review': '要確認',
    'rejected': '拒否',
    'hidden': '非表示'
  };
  return labels[status] || status;
}

function getImportanceLabel(importance) {
  const labels = {
    'urgent': '緊急',
    'important': '重要',
    'normal': '通常'
  };
  return labels[importance] || importance;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString('ja-JP');
}

function formatAttributes(rawAttributes) {
  if (rawAttributes === null || rawAttributes === undefined || rawAttributes === '') {
    return 'null';
  }

  if (typeof rawAttributes === 'object') {
    const pairs = Object.entries(rawAttributes);
    if (!pairs.length) return 'null';
    return pairs.map(([key, value]) => `${key}: ${value}`).join(' / ');
  }

  try {
    const parsed = JSON.parse(String(rawAttributes));
    if (!parsed || typeof parsed !== 'object') return 'null';
    const pairs = Object.entries(parsed);
    if (!pairs.length) return 'null';
    return pairs.map(([key, value]) => `${key}: ${value}`).join(' / ');
  } catch (e) {
    return String(rawAttributes);
  }
}

// ====================================================================
// 権限管理レイヤー（追加）
// ====================================================================

let permissions = new Set();

function applyPermissions(user) {
  permissions = new Set(user?.permissions || []);
}

function can(permission) {
  if (!currentUser) return false;

  // Administratorは全許可（サーバー前提でも保険）
  if (currentUser.role === 'administrator') return true;

  return permissions.has(permission);
}

async function securefetch(url, options = {}) {
  const res = await fetch(url, options);

  // 認証切れ
  if (res.status === 401) {
    showLoginScreen?.();
    return null;
  }

  // 権限不足
  if (res.status === 403) {
    showMessage('権限がありません', 'error');
    return null;
  }

  return res;
}

async function loadPublish() {
  try {
    const res = await fetch('/api/admin/publish');
    if (!res.ok) {
      showMessage('公開状態の読み込みに失敗しました', 'error');
      return;
    }
 
    const data = await res.json();
    window.publishState = data;
 
    const tbody = document.getElementById('publish-table-body');
 
    // サイト全体非公開トグル
    let html = `
      <tr style="background: #f0f0f0; font-weight: bold;">
        <td>【サイト全体】</td>
        <td>${data.siteWidePublished !== false ? '🟢 公開' : '🔴 非公開'}</td>
        <td>
          <button class="btn" onclick="toggleSiteWide(${data.siteWidePublished !== false})" style="background: ${data.siteWidePublished !== false ? '#dc3545' : '#28a745'}; color: white;">
            ${data.siteWidePublished !== false ? '非公開にする' : '公開する'}
          </button>
        </td>
      </tr>
    `;
 
    // 個別ページ（【修正】page 名は小文字で統一）
    html += Object.entries(data.pages || {}).map(([page, published]) => {
      const displayName = String(page).toLowerCase().trim();
      return `
        <tr>
          <td>${displayName}</td>
          <td>${published ? '🟢 公開' : '🔴 非公開'}</td>
          <td>
            <button class="btn" onclick="togglePublish('${displayName}', ${published})" style="background: ${published ? '#dc3545' : '#28a745'}; color: white;">
              ${published ? '非公開にする' : '公開する'}
            </button>
          </td>
        </tr>
      `;
    }).join('');
 
    tbody.innerHTML = html;
  } catch (e) {
    console.error('loadPublish error:', e);
    showMessage('公開状態の読み込みに失敗しました', 'error');
  }
}

async function updatePublish() {
  const page = document.getElementById('publish-page').value;
  const state = document.getElementById('publish-state').value === 'true';

  await fetch('/api/admin/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page,
      published: state
    })
  });

  showMessage('公開状態を更新しました', 'success');
}

async function toggleSiteWide(currentState) {
  try {
    const res = await fetch('/api/admin/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteWidePublished: !currentState
      })
    });
 
    if (!res.ok) {
      const errorData = await res.json();
      showMessage(errorData.error || 'サイト全体の公開状態更新に失敗しました', 'error');
      console.error('Site-wide toggle failed:', errorData);
      return;
    }
 
    const responseData = await res.json();
    console.log('[Publish] Updated config:', responseData.config);
    
    showMessage(
      !currentState ? 'サイト全体を公開しました' : 'サイト全体を非公開にしました',
      'success'
    );
    
    await loadPublish();
  } catch (e) {
    console.error('toggleSiteWide error:', e);
    showMessage('更新に失敗しました', 'error');
  }
}

async function togglePublish(page, currentState) {
  // 【修正】page 名を小文字に統一してからサーバーに送信
  const normalizedPage = String(page).toLowerCase().trim();
  
  try {
    const res = await fetch('/api/admin/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: normalizedPage,
        published: !currentState
      })
    });
 
    if (!res.ok) {
      const errorData = await res.json();
      showMessage(errorData.error || '公開状態の更新に失敗しました', 'error');
      console.error('Toggle failed:', errorData);
      return;
    }
 
    const responseData = await res.json();
    console.log('[Publish] Updated config:', responseData.config);
    
    showMessage(
      !currentState ? `${normalizedPage} を公開しました` : `${normalizedPage} を非公開にしました`,
      'success'
    );
    
    await loadPublish();
  } catch (e) {
    console.error('togglePublish error:', e);
    showMessage('更新に失敗しました', 'error');
  }
}

// ============================================================================
// 初期化
// ============================================================================

checkSession();
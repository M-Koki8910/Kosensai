// API エンドポイント
const API = {
  posts: '/api/admin/posts',
  postStatus: (id) => `/api/admin/posts/${id}/status`,
  rules: '/api/admin/ng-rules',
  rule: (id) => `/api/admin/ng-rules/${id}`,
  ruleToggle: (id) => `/api/admin/ng-rules/${id}/toggle`,
  ruleTest: '/api/admin/ng-rules/test',
  announcements: '/api/admin/announcements',
  announcement: (id) => `/api/admin/announcements/${id}`,
  users: '/api/admin/announcement-users',
  user: (id) => `/api/admin/announcement-users/${id}`,
  moderationLogs: '/api/admin/moderation-logs'
};

let currentPost = null;
let currentRule = null;

// ページ遷移
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    showPage(page);
  });
});

function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(page).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.querySelector(`[data-page="${page}"]`).classList.add('active');

  if (page === 'posts') loadPosts();
  if (page === 'ng-rules') loadRules();
  if (page === 'announcements') loadAnnouncements();
  if (page === 'users') loadUsers();
}

// メッセージ表示
function showMessage(text, type = 'info') {
  const msg = document.getElementById('message');
  msg.textContent = text;
  msg.className = `message show ${type}`;
  if (type === 'success') {
    setTimeout(() => msg.classList.remove('show'), 3000);
  }
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('show');
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('show');
}

// ============================================================================
// 投稿管理
// ============================================================================

document.getElementById('postRefreshBtn')?.addEventListener('click', loadPosts);

async function loadPosts() {
  try {
    const response = await fetch(API.posts);
    const data = await response.json();

    if (!data.ok) {
      showMessage('投稿を読み込めませんでした', 'error');
      return;
    }

    const posts = data.posts || [];

    // 統計更新
    updatePostStats(posts);

    // テーブル更新
    const tbody = document.getElementById('postsTableBody');
    if (posts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">投稿がありません</td></tr>';
      return;
    }

    tbody.innerHTML = posts.map(post => `
      <tr>
        <td>${post.id}</td>
        <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${escapeHtml(post.content)}
        </td>
        <td>${post.risk_score}</td>
        <td><span class="status-badge status-${post.status}">${getStatusLabel(post.status)}</span></td>
        <td>${new Date(post.created_at).toLocaleString('ja-JP')}</td>
        <td>
          <button class="btn" onclick="openPostModal(${post.id})">詳細</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('投稿読み込みエラー', e);
    showMessage('投稿を読み込めませんでした', 'error');
  }
}

function updatePostStats(posts) {
  const stats = {
    published: 0,
    pending: 0,
    review: 0,
    rejected: 0
  };

  posts.forEach(post => {
    if (stats[post.status] !== undefined) {
      stats[post.status]++;
    }
  });

  document.getElementById('statPublished').textContent = stats.published;
  document.getElementById('statPending').textContent = stats.pending;
  document.getElementById('statReview').textContent = stats.review;
  document.getElementById('statRejected').textContent = stats.rejected;
}

async function openPostModal(postId) {
  try {
    const response = await fetch(API.posts);
    const data = await response.json();
    const posts = data.posts || [];
    const post = posts.find(p => p.id === postId);

    if (!post) {
      showMessage('投稿が見つかりません', 'error');
      return;
    }

    currentPost = post;
    document.getElementById('postModalId').value = post.id;
    document.getElementById('postModalContent').textContent = post.content;
    document.getElementById('postModalRiskScore').value = post.risk_score;
    document.getElementById('postModalCurrentStatus').value = getStatusLabel(post.status);
    document.getElementById('postModalNewStatus').value = post.status;

    openModal('postModal');
  } catch (e) {
    console.error('投稿詳細読み込みエラー', e);
    showMessage('投稿詳細を読み込めませんでした', 'error');
  }
}

async function savePostStatus() {
  if (!currentPost) return;

  const newStatus = document.getElementById('postModalNewStatus').value;
  const reason = document.getElementById('postModalReason').value.trim();

  try {
    const response = await fetch(API.postStatus(currentPost.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: newStatus,
        reason: reason || null
      })
    });

    const data = await response.json();

    if (data.ok) {
      showMessage('投稿の状態を更新しました', 'success');
      closeModal('postModal');
      loadPosts();
    } else {
      showMessage(data.error || '更新に失敗しました', 'error');
    }
  } catch (e) {
    console.error('投稿更新エラー', e);
    showMessage('投稿の更新に失敗しました', 'error');
  }
}

// ============================================================================
// NG判定ルール管理
// ============================================================================

document.getElementById('addRuleBtn')?.addEventListener('click', () => {
  document.getElementById('ruleModalPattern').value = '';
  document.getElementById('ruleModalType').value = '0';
  document.getElementById('ruleModalRiskScore').value = '10';
  document.getElementById('ruleModalDescription').value = '';
  currentRule = null;
  openModal('ruleModal');
});

async function loadRules() {
  try {
    const response = await fetch(API.rules);
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
        <td style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: monospace; font-size: 12px;">
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
  const pattern = document.getElementById('ruleModalPattern').value.trim();
  const isRegex = parseInt(document.getElementById('ruleModalType').value);
  const riskScore = parseInt(document.getElementById('ruleModalRiskScore').value);
  const description = document.getElementById('ruleModalDescription').value.trim();

  if (!pattern) {
    showMessage('パターンを入力してください', 'error');
    return;
  }

  try {
    const response = await fetch(API.rules, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      closeModal('ruleModal');
      loadRules();
    } else {
      showMessage(data.error || '追加に失敗しました', 'error');
    }
  } catch (e) {
    console.error('ルール追加エラー', e);
    showMessage('ルールの追加に失敗しました', 'error');
  }
}

async function toggleRule(ruleId) {
  try {
    const response = await fetch(API.ruleToggle(ruleId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
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
    const response = await fetch(API.rule(ruleId), {
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

document.getElementById('addAnnouncementBtn')?.addEventListener('click', () => {
  // TODO: アナウンス作成モーダルを実装
  showMessage('アナウンス作成は別途実装予定です', 'info');
});

async function loadAnnouncements() {
  try {
    const response = await fetch(API.announcements);
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
    const response = await fetch(API.announcement(annId), {
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
// ユーザー管理
// ============================================================================

document.getElementById('addUserBtn')?.addEventListener('click', () => {
  document.getElementById('userModalUsername').value = '';
  document.getElementById('userModalPassword').value = '';
  openModal('userModal');
});

async function loadUsers() {
  try {
    const response = await fetch(API.users);
    const data = await response.json();

    if (!data.ok) {
      showMessage('ユーザーを読み込めませんでした', 'error');
      return;
    }

    const users = data.users || [];

    const tbody = document.getElementById('usersTableBody');
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">ユーザーがありません</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(user => `
      <tr>
        <td>${user.id}</td>
        <td>${escapeHtml(user.username)}</td>
        <td>${new Date(user.created_at).toLocaleString('ja-JP')}</td>
        <td>
          <button class="btn btn-danger" onclick="deleteUser(${user.id})">削除</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('ユーザー読み込みエラー', e);
    showMessage('ユーザーを読み込めませんでした', 'error');
  }
}

async function saveUser() {
  const username = document.getElementById('userModalUsername').value.trim();
  const password = document.getElementById('userModalPassword').value;

  if (!username) {
    showMessage('ユーザー名を入力してください', 'error');
    return;
  }

  if (password.length < 8) {
    showMessage('パスワードは8文字以上である必要があります', 'error');
    return;
  }

  try {
    const response = await fetch(API.users, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (data.ok) {
      showMessage('ユーザーを追加しました', 'success');
      closeModal('userModal');
      loadUsers();
    } else {
      showMessage(data.error || '追加に失敗しました', 'error');
    }
  } catch (e) {
    console.error('ユーザー追加エラー', e);
    showMessage('ユーザーの追加に失敗しました', 'error');
  }
}

async function deleteUser(userId) {
  if (!confirm('このユーザーを削除しますか？')) return;

  try {
    const response = await fetch(API.user(userId), {
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

// モーダルの外側クリックで閉じる
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
    }
  });
});

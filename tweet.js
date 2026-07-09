
// =========================
// 掲示板・アナウンス　共通ユーティリティ
// =========================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString("ja-JP");
}

// =========================
// 掲示板機能
// =========================

const BulletinBoard = (() => {
  const API = "/api/posts";
  const interval = 10000;

  function init() {
    const form = document.getElementById("postForm");
    const input = document.getElementById("postContent");

    if (!form || !input) return;

    input.addEventListener("input", () => {
      document.getElementById("charCount").textContent = input.value.length;
    });

    form.addEventListener("submit", submitPost);

    loadPosts();
    setInterval(loadPosts, interval);
  }

  async function submitPost(e) {
    e.preventDefault();

    const content = document.getElementById("postContent").value.trim();
    if (!content) return showMessage("入力してください", "error");

    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });

      const data = await res.json();

      if (data.ok) {
        showMessage("投稿しました", "success");
        document.getElementById("postContent").value = "";
        document.getElementById("charCount").textContent = "0";
        loadPosts();
      } else {
        showMessage(data.error || "失敗", "error");
      }

    } catch (err) {
      showMessage("通信エラー", "error");
    }
  }

  async function loadPosts() {
    const container = document.getElementById("postContainer");
    if (!container) return;

    try {
      const res = await fetch(`${API}?status=published&limit=30`);
      const data = await res.json();

      if (!data.ok) {
        container.innerHTML = "<p>読み込み失敗</p>";
        return;
      }

      container.innerHTML = "";
      (data.posts || []).forEach(post => {
        container.appendChild(render(post));
      });

    } catch {
      container.innerHTML = "<p>通信エラー</p>";
    }
  }

  function render(post) {
    const div = document.createElement("div");
    div.className = "post-item";

    div.innerHTML = `
      <div class="post-body">
        <div class="post-header">
          <span>${formatDate(post.created_at)}</span>
          <span class="post-status">${post.status}</span>
        </div>
        <div class="post-content"></div>
        <div class="post-reactions">
          <button type="button" class="reaction-btn thumbs-up ${post.reacted_thumbs_up ? "active" : ""}" data-reaction="thumbs_up">
            👍 <span class="reaction-count">${post.thumbs_up_count || 0}</span>
          </button>
          <button type="button" class="reaction-btn heart ${post.reacted_heart ? "active" : ""}" data-reaction="heart">
            ❤ <span class="reaction-count">${post.heart_count || 0}</span>
          </button>
        </div>
      </div>
    `;

    div.querySelector(".post-content").textContent = post.content;

    div.querySelectorAll(".reaction-btn").forEach(button => {
      button.addEventListener("click", () => {
        sendReaction(post.id, button.dataset.reaction);
      });
    });

    return div;
  }

  async function sendReaction(postId, reactionType) {
    try {
      const res = await fetch(`${API}/${postId}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction_type: reactionType })
      });

      const data = await res.json();

      if (!data.ok) {
        showMessage(data.error || "リアクションに失敗しました", "error");
        return;
      }

      showMessage(data.alreadyReacted ? "既にリアクション済みです" : "リアクションしました", "success");
      loadPosts();
    } catch (err) {
      showMessage("通信エラー", "error");
    }
  }

  function showMessage(text, type) {
    const el = document.getElementById("message");
    if (!el) return;

    el.textContent = text;
    el.className = `message show ${type}`;

    if (type === "success") {
      setTimeout(() => el.classList.remove("show"), 3000);
    }
  }

  return { init };
})();

// =========================
// アナウンス機能
// =========================

const Announcements = (() => {
  const API = "/api/announcements";
  const interval = 30000;

  function init() {
    load();
    setInterval(load, interval);
  }

  async function load() {
    const container = document.getElementById("announcementsContainer");
    if (!container) return;

    try {
      const res = await fetch(API);
      const data = await res.json();

      if (!data.ok) {
        container.innerHTML = "<p>読み込み失敗</p>";
        return;
      }

      const list = data.announcements || [];

      if (!list.length) {
        container.innerHTML = "<p>お知らせなし</p>";
        return;
      }

      const grouped = group(list);

      container.innerHTML = `
        ${renderSection("緊急", grouped.urgent)}
        ${renderSection("重要", grouped.important)}
        ${renderSection("通常", grouped.normal)}
      `;

    } catch {
      container.innerHTML = "<p>通信エラー</p>";
    }
  }

  function group(list) {
    return {
      urgent: list.filter(a => a.importance === "urgent"),
      important: list.filter(a => a.importance === "important"),
      normal: list.filter(a => a.importance === "normal")
    };
  }

  function renderSection(title, items) {
    if (!items.length) return "";

    return `
      <h3>${title}</h3>
      ${items.map(renderItem).join("")}
    `;
  }

  function renderItem(a) {
    return `
      <div class="announcement-item ${a.importance}">
        <h4>${escapeHtml(a.title)}</h4>
        <p>${escapeHtml(a.content)}</p>
        <small>${formatDate(a.published_at)}</small>
      </div>
    `;
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", () => {
    loadTicker();
});

async function loadTicker() {

    let messages = [];

    try {

        const response =
            await fetch("/api/announcements");

        const data =
            await response.json();

        if (
            data.ok &&
            Array.isArray(data.announcements) &&
            data.announcements.length > 0
        ) {

            messages =
                data.announcements.map(item => {

                    let prefix = "";

                    switch (item.importance) {

                        case "urgent":
                            prefix = "🚨";
                            break;

                        case "important":
                            prefix = "⚠️";
                            break;

                        default:
                            prefix = "ℹ️";
                    }

                    return `${prefix} ${item.title}`;
                });
        }

    } catch (error) {

        console.error(
            "お知らせ取得エラー",
            error
        );
    }

    if (messages.length === 0) {

        messages = [
            "📢 現在のお知らせはありません"
        ];
    }

    startTicker(messages);
}

function startTicker(messages) {

    const ticker =
        document.getElementById(
            "ticker-content"
        );

    if (!ticker) return;

    let index = 0;

    async function showNext() {

        const text =
            messages[index];

        ticker.textContent = text;

        await new Promise(resolve =>
            requestAnimationFrame(resolve)
        );

        const containerWidth =
            ticker.parentElement.offsetWidth;

        const textWidth =
            ticker.offsetWidth;

        const startX =
            containerWidth;

        const endX =
            -textWidth;

        const speed = 120;

        const duration =
            ((startX - endX) /
                speed) *
            1000;

        ticker.animate(
            [
                {
                    transform:
                        `translate(${startX}px,-50%)`
                },
                {
                    transform:
                        `translate(${endX}px,-50%)`
                }
            ],
            {
                duration,
                easing: "linear"
            }
        );

        await new Promise(resolve =>
            setTimeout(
                resolve,
                duration
            )
        );

        index =
            (index + 1) %
            messages.length;

        showNext();
    }

    showNext();
}
// =========================
// アナウンス投稿機能
// =========================

const AnnouncementPost = (() => {

  const API = "/api/announcements";
  const ADMIN_API = "/api/admin/announcements";

  function init() {

    const form = document.getElementById("announcementForm");
    if (!form) return;

    const content = document.getElementById("announcementContent");

    content?.addEventListener("input", () => {
      document.getElementById("charCount").textContent =
        content.value.length;
    });

    form.addEventListener("submit", submitAnnouncement);

    loadAnnouncements();
  }

  async function submitAnnouncement(e) {

    e.preventDefault();

    const title =
      document.getElementById("announcementTitle").value.trim();

    const content =
      document.getElementById("announcementContent").value.trim();

    const importance =
      document.getElementById("announcementImportance").value;

    const published_at =
      document.getElementById("announcementPublishedAt").value;

    const expires_at =
      document.getElementById("announcementExpiresAt").value;

    if (
      !title ||
      !content ||
      !published_at ||
      !expires_at
    ) {

      showMessage(
        "すべて入力してください",
        "error"
      );

      return;
    }

    try {

      const res = await fetch(API, {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({

          title,
          content,
          importance,
          published_at,
          expires_at

        })

      });

      const data = await res.json();

      if (!data.ok) {

        showMessage(
          data.error || "投稿に失敗しました",
          "error"
        );

        return;
      }

      showMessage(
        "投稿しました",
        "success"
      );

      e.target.reset();

      document.getElementById("charCount").textContent = "0";

      loadAnnouncements();

    }

    catch {

      showMessage(
        "通信エラー",
        "error"
      );

    }

  }

  async function loadAnnouncements() {

    const container =
      document.getElementById(
        "announcementManageContainer"
      );

    if (!container) return;

    try {

      const res =
        await fetch(ADMIN_API);

      const data =
        await res.json();

      if (!data.ok) {

        container.innerHTML =
          "<p>読み込み失敗</p>";

        return;
      }

      const list =
        data.announcements || [];

      if (!list.length) {

        container.innerHTML =
          "<p>投稿はありません</p>";

        return;
      }

      container.innerHTML = "";

      list.forEach(a => {

        const div =
          document.createElement("div");

        div.className = "manage-item";

        div.innerHTML = `
          <h4>${escapeHtml(a.title)}</h4>

          <div class="manage-meta">
            ${formatDate(a.published_at)}
            ～ ${formatDate(a.expires_at)}
          </div>

          <p>${escapeHtml(a.content)}</p>

          <div class="manage-actions">

            <button
              class="btn btn-edit"
              data-id="${a.id}">
              編集
            </button>

            <button
              class="btn btn-delete"
              data-id="${a.id}">
              削除
            </button>

          </div>
        `;

        container.appendChild(div);

      });

    }

    catch {

      container.innerHTML =
        "<p>通信エラー</p>";

    }

  }

  function showMessage(text, type) {

    const el =
      document.getElementById("message");

    if (!el) return;

    el.textContent = text;

    el.className =
      `message show ${type}`;

    if (type === "success") {

      setTimeout(() => {

        el.classList.remove("show");

      }, 3000);

    }

  }

  return {
    init
  };

})();

// =========================
// 初期化
// =========================

document.addEventListener("DOMContentLoaded", () => {
  BulletinBoard.init();
  Announcements.init();
  AnnouncementPost.init();
});
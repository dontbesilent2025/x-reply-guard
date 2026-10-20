(() => {
  if (window.__xAiDetector) return;
  window.__xAiDetector = true;

  const BADGE_ATTRIBUTE = "data-x-ai-badge";
  const SCAN_BUTTON_ID = "x-ai-scan-button";
  const TOAST_ID = "x-ai-toast";
  const STATUS_ID_PATTERN = /\/status\/(\d+)/;
  // 自己评论区：新回复最多攒 2 秒再合并成一批；查缓存不花 token，等得更短。
  const AUTO_DELAY = 2000;
  const LOOKUP_DELAY = 500;
  const MAX_AUTO_ATTEMPTS = 2;

  // 推文 id → { score, signals, reason }。X 会回收重建回复节点，
  // 标签按 id 缓存，节点重建后重新挂上。
  const scores = new Map();
  const lookedUp = new Set();
  const autoAttempts = new Map();
  let busy = false;
  let queueTimer = null;
  // 自动检测暂停的原因：disabled | limit | needsConfig | error
  let autoPausedReason = null;

  function currentMainStatusId() {
    return location.pathname.match(STATUS_ID_PATTERN)?.[1] || null;
  }

  function articlePermalink(article) {
    const time = article.querySelector("time");
    return time?.closest('a[href*="/status/"]')?.getAttribute("href") || "";
  }

  function articleStatusId(article) {
    return articlePermalink(article).match(STATUS_ID_PATTERN)?.[1] || null;
  }

  function articleAuthorHandle(article) {
    const permalink = articlePermalink(article);
    return permalink.match(/^\/([^/]+)\/status\/\d+/)?.[1]?.toLowerCase() || null;
  }

  function articleText(article) {
    return article.querySelector('[data-testid="tweetText"]')?.innerText.trim() || "";
  }

  function articleTime(article) {
    const value = article.querySelector("time")?.getAttribute("datetime");
    const time = value ? Date.parse(value) : NaN;
    return Number.isNaN(time) ? null : time;
  }

  function loggedInHandle() {
    const href = document
      .querySelector('a[data-testid="AppTabBar_Profile_Link"][href]')
      ?.getAttribute("href");
    return href?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase() || null;
  }

  function findActionGroup(article) {
    return [...article.querySelectorAll('[role="group"]')].find((group) => {
      return (
        group.querySelector('[data-testid="reply"]') &&
        group.querySelector('[data-testid="like"], [data-testid="unlike"]')
      );
    });
  }

  // 编辑过的推文，时间链接里的 id 可能与地址栏不同，需要逐级回退。
  function findMainArticle(articles, mainId) {
    const byPermalink = articles.find((article) => articleStatusId(article) === mainId);
    if (byPermalink) return byPermalink;

    const byAnyLink = articles.find((article) =>
      [...article.querySelectorAll('a[href*="/status/"]')].some(
        (link) => link.getAttribute("href").match(STATUS_ID_PATTERN)?.[1] === mainId
      )
    );
    if (byAnyLink) return byAnyLink;

    // 主帖下方紧跟「发布你的回复」输入框。
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!composer) return null;
    return articles
      .filter((article) => article.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
      .pop() || null;
  }

  function pathAuthorHandle() {
    return location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/)?.[1]?.toLowerCase() || null;
  }

  // 详情页 id → 主帖信息。X 会把滚出视野的推文移出页面，
  // 往下翻评论时主帖不在 DOM 里，需要用之前记下的信息。
  const threadMemory = new Map();

  function rememberThread(mainId, mainArticle, articles) {
    const memory = threadMemory.get(mainId) || { ancestorIds: new Set() };
    memory.parent = {
      author: articleAuthorHandle(mainArticle) || pathAuthorHandle(),
      text: articleText(mainArticle)
    };
    memory.parentTime = articleTime(mainArticle);
    // 排在主帖上方的是它回复的上级推文，不算回复。
    for (const article of articles) {
      if (article.compareDocumentPosition(mainArticle) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const id = articleStatusId(article);
        if (id) memory.ancestorIds.add(id);
      }
    }
    threadMemory.set(mainId, memory);
    return memory;
  }

  // 主帖和主帖之后、由其他账号发出的回复。
  function collectThread() {
    const mainId = currentMainStatusId();
    if (!mainId) return null;

    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const mainArticle = findMainArticle(articles, mainId);
    const memory = mainArticle
      ? rememberThread(mainId, mainArticle, articles)
      : threadMemory.get(mainId) || {
          parent: { author: pathAuthorHandle(), text: "" },
          parentTime: null,
          ancestorIds: new Set()
        };

    const ownHandle = loggedInHandle();
    const parentTime = memory.parentTime;
    const replies = [];

    for (const article of articles) {
      if (article === mainArticle) continue;
      if (
        mainArticle &&
        !(mainArticle.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING)
      ) {
        continue;
      }

      const id = articleStatusId(article);
      const author = articleAuthorHandle(article);
      const text = articleText(article);
      if (!id || !author || !text || author === ownHandle) continue;
      if (id === mainId || memory.ancestorIds.has(id)) continue;

      const replyTime = articleTime(article);
      replies.push({
        id,
        author,
        text,
        delaySeconds:
          parentTime && replyTime ? Math.round((replyTime - parentTime) / 1000) : null
      });
    }

    return { parent: memory.parent, replies };
  }

  const RESERVED_PATHS = new Set([
    "home", "explore", "notifications", "messages", "i", "settings", "search",
    "compose", "login", "logout", "signup", "tos", "privacy", "bookmarks",
    "lists", "communities", "premium", "jobs", "hashtag", "intent", "share"
  ]);

  // 个人主页：/用户名、/用户名/with_replies 等标签页，且页面上有用户资料区。
  function currentProfileHandle() {
    const match = location.pathname.match(
      /^\/([A-Za-z0-9_]{1,15})(?:\/(?:with_replies|media|highlights|articles|superfollows))?\/?$/
    );
    if (!match || RESERVED_PATHS.has(match[1].toLowerCase())) return null;
    if (!document.querySelector('[data-testid="UserName"]')) return null;
    return match[1].toLowerCase();
  }

  // 主页上由该账号自己发出的推文，跳过转帖的别人内容。
  function collectProfilePosts(handle) {
    const posts = [];
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const id = articleStatusId(article);
      const text = articleText(article);
      if (!id || !text || articleAuthorHandle(article) !== handle) continue;
      posts.push({ id, text });
    }
    return posts;
  }

  // 当前页面要分析的内容：详情页分析回复，主页分析推文。
  function collectPage() {
    if (currentMainStatusId()) {
      const thread = collectThread();
      if (!thread) return null;
      const ownHandle = loggedInHandle();
      return {
        kind: "replies",
        context: thread.parent,
        items: thread.replies,
        own: Boolean(ownHandle && thread.parent.author === ownHandle)
      };
    }

    const handle = currentProfileHandle();
    if (handle) {
      return {
        kind: "posts",
        context: { author: handle },
        items: collectProfilePosts(handle),
        own: false
      };
    }
    return null;
  }

  function showToast(message, type = "success") {
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      left: "50%",
      bottom: "72px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 16px",
      borderRadius: "999px",
      background: type === "success" ? "#0f1419" : "#e0245e",
      color: "#fff",
      font: "600 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,.24)",
      pointerEvents: "none"
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function badgeColors(score) {
    if (score >= 70) return { color: "rgb(244, 33, 46)", background: "rgba(244, 33, 46, .12)" };
    if (score >= 31) return { color: "rgb(214, 128, 0)", background: "rgba(255, 173, 31, .16)" };
    return { color: "rgb(113, 118, 123)", background: "rgba(113, 118, 123, .1)" };
  }

  function renderBadge(article, state) {
    const actionGroup = findActionGroup(article);
    if (!actionGroup) return;

    let badge = article.querySelector(`[${BADGE_ATTRIBUTE}]`);
    if (!badge) {
      badge = document.createElement("span");
      badge.setAttribute(BADGE_ATTRIBUTE, "true");
      Object.assign(badge.style, {
        alignSelf: "center",
        borderRadius: "999px",
        font: "600 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        lineHeight: "22px",
        padding: "0 8px",
        whiteSpace: "nowrap",
        cursor: "help"
      });
      actionGroup.appendChild(badge);
    }

    if (state === "pending") {
      badge.textContent = "AI 分析中…";
      badge.title = "";
      Object.assign(badge.style, badgeColors(0));
      return;
    }

    badge.textContent = `AI ${state.score}`;
    badge.title = `AI 自动回复嫌疑 ${state.score}/100\n${state.reason}${
      state.signals.length ? `\n命中：${state.signals.join("、")}` : ""
    }`;
    Object.assign(badge.style, badgeColors(state.score));
  }

  function clearPendingBadges() {
    document.querySelectorAll(`[${BADGE_ATTRIBUTE}]`).forEach((badge) => {
      const article = badge.closest('article[data-testid="tweet"]');
      if (!scores.has(articleStatusId(article))) badge.remove();
    });
  }

  // force 为 true 时覆盖已有标签（例如「分析中」）。
  function renderScoredBadges(force = false) {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const result = scores.get(articleStatusId(article));
      if (result && (force || !article.querySelector(`[${BADGE_ATTRIBUTE}]`))) {
        renderBadge(article, result);
      }
    }
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(response);
      });
    });
  }

  async function analyze(page, items, mode) {
    busy = true;
    updateScanButton();
    if (mode !== "lookup") {
      const ids = new Set(items.map((item) => item.id));
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        if (ids.has(articleStatusId(article))) renderBadge(article, "pending");
      }
    }

    try {
      let response;
      try {
        response = await sendToBackground({
          type: "ANALYZE_ITEMS",
          kind: page.kind,
          context: page.context,
          items,
          mode
        });
      } catch (_error) {
        response = { ok: false, error: "扩展已更新，请刷新页面", results: [], batchIds: [] };
      }

      for (const result of response?.results || []) scores.set(result.id, result);
      if (mode === "lookup") items.forEach((item) => lookedUp.add(item.id));
      for (const id of response?.batchIds || []) {
        autoAttempts.set(id, (autoAttempts.get(id) || 0) + 1);
      }
      renderScoredBadges(true);

      if (mode === "auto") {
        if (response?.autoDisabled) autoPausedReason = "disabled";
        else if (response?.limitReached) autoPausedReason = "limit";
        else if (response?.needsConfig) autoPausedReason = "needsConfig";
        else if (!response?.ok) autoPausedReason = "error";
      }
      return response || { ok: false, error: "分析失败" };
    } finally {
      busy = false;
      clearPendingBadges();
      updateScanButton();
    }
  }

  // 有新内容时排队：自己的评论区自动分析，其他页面只查缓存。
  function queueCheck() {
    if (queueTimer || busy) return;
    const page = collectPage();
    if (!page) return;

    const unscored = page.items.filter((item) => !scores.has(item.id));
    const needsAuto =
      page.own &&
      !autoPausedReason &&
      unscored.some((item) => (autoAttempts.get(item.id) || 0) < MAX_AUTO_ATTEMPTS);
    const needsLookup = unscored.some((item) => !lookedUp.has(item.id));
    if (!needsAuto && !needsLookup) return;

    queueTimer = setTimeout(runQueued, needsAuto ? AUTO_DELAY : LOOKUP_DELAY);
  }

  async function runQueued() {
    queueTimer = null;
    if (busy) return;
    const page = collectPage();
    if (!page) return;

    const unscored = page.items.filter((item) => !scores.has(item.id));
    if (page.own && !autoPausedReason) {
      const autoItems = unscored.filter(
        (item) => (autoAttempts.get(item.id) || 0) < MAX_AUTO_ATTEMPTS
      );
      if (autoItems.length) {
        const response = await analyze(page, autoItems, "auto");
        if (!response.ok && autoPausedReason === "error") {
          showToast(`自动检测暂停：${response.error}`, "error");
        }
        return;
      }
    }

    const lookupItems = unscored.filter((item) => !lookedUp.has(item.id));
    if (lookupItems.length) await analyze(page, lookupItems, "lookup");
  }

  async function manualScan() {
    if (busy) {
      showToast("正在分析中", "error");
      return { ok: false };
    }

    const page = collectPage();
    if (!page) {
      showToast("请打开推文详情页或某个人的主页", "error");
      return { ok: false };
    }

    const noun = page.kind === "posts" ? "推文" : "回复";
    const unscored = page.items.filter((item) => !scores.has(item.id));
    if (!unscored.length) {
      showToast(page.items.length ? `本页${noun}都已分析过` : `本页没有可分析的${noun}`);
      return { ok: true };
    }

    const response = await analyze(page, unscored, "manual");
    if (!response.ok) {
      if (response.needsConfig) sendToBackground({ type: "OPEN_OPTIONS" }).catch(() => {});
      showToast(response.error || "分析失败", "error");
      return { ok: false };
    }

    if (autoPausedReason === "error" || autoPausedReason === "needsConfig") {
      autoPausedReason = null;
    }
    const analyzed = response.analyzed ?? response.results.length;
    if (response.remaining) {
      showToast(`已分析 ${analyzed} 条，还剩 ${response.remaining} 条，再点一次继续`);
    } else if (page.kind === "posts") {
      const summary = profileSummary(page);
      showToast(`已分析 ${summary.count} 条推文，高嫌疑 ${summary.high} 条`);
    } else {
      showToast(`已分析 ${analyzed} 条回复`);
    }
    return { ok: true };
  }

  function profileSummary(page) {
    const scored = page.items.map((item) => scores.get(item.id)).filter(Boolean);
    return {
      count: scored.length,
      high: scored.filter((result) => result.score >= 70).length
    };
  }

  function scanButtonLabel(page) {
    if (!page) return "扫描 AI 回复";

    if (page.kind === "posts") {
      if (busy) return "分析中…";
      const summary = profileSummary(page);
      const unscored = page.items.length - summary.count;
      if (!summary.count) return "扫描本页推文";
      const base = `高嫌疑 ${summary.high}/${summary.count} 条`;
      return unscored > 0 ? `${base} · 再扫 ${unscored} 条` : base;
    }

    if (!page.own) return busy ? "分析中…" : "扫描 AI 回复";
    if (busy) return "自动检测中…";

    switch (autoPausedReason) {
      case "limit":
        return "今日自动额度已用完 · 点此手动分析";
      case "disabled":
        return "自动检测已关闭 · 点此分析";
      case "needsConfig":
        return "未配置 API · 点此设置";
      case "error":
        return "自动检测出错 · 点此重试";
      default: {
        const count = page.items.filter((item) => scores.has(item.id)).length;
        return `自动检测 · 已分析 ${count} 条`;
      }
    }
  }

  function updateScanButton() {
    const button = document.getElementById(SCAN_BUTTON_ID);
    if (!button) return;
    const label = scanButtonLabel(collectPage());
    if (button.textContent !== label) button.textContent = label;
    button.disabled = busy;
  }

  function installScanButton() {
    const existing = document.getElementById(SCAN_BUTTON_ID);
    if (!currentMainStatusId() && !currentProfileHandle()) {
      existing?.remove();
      return;
    }
    if (existing) {
      updateScanButton();
      return;
    }

    const button = document.createElement("button");
    button.id = SCAN_BUTTON_ID;
    button.type = "button";
    Object.assign(button.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "2147483646",
      appearance: "none",
      border: "0",
      borderRadius: "999px",
      background: "#1d9bf0",
      color: "#fff",
      cursor: "pointer",
      font: "700 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      padding: "10px 16px",
      boxShadow: "0 6px 24px rgba(0,0,0,.24)"
    });
    button.addEventListener("click", () => {
      if (autoPausedReason === "needsConfig") {
        sendToBackground({ type: "OPEN_OPTIONS" }).catch(() => {});
        return;
      }
      manualScan();
    });
    document.body.appendChild(button);
    updateScanButton();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCAN_REPLIES") return;
    manualScan().then(sendResponse);
    return true;
  });

  // 设置改动（开关、上限、Key）后恢复自动检测。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // 缓存和计数的写入不算设置改动。
    const dataKeys = ["scoreCache", "autoUsage"];
    if (Object.keys(changes).some((key) => !dataKeys.includes(key))) {
      autoPausedReason = null;
      autoAttempts.clear();
    }
  });

  let scheduled = false;
  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      installScanButton();
      renderScoredBadges();
      queueCheck();
    });
  }

  new MutationObserver(scheduleUpdate).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  window.addEventListener("popstate", scheduleUpdate);
  setInterval(scheduleUpdate, 1000);
  scheduleUpdate();
})();

importScripts("providers.js", "prompt.js", "llm.js", "store.js");

const BADGE_CLEAR_DELAY = 2500;

function sendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  });
}

async function showBadge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }, BADGE_CLEAR_DELAY);
}

// mode：
// - lookup：只查缓存，不调用 API
// - auto：自己评论区的自动检测，受开关和每日上限限制
// - manual：用户点击按钮，不受每日上限限制
// kind：replies 为详情页的回复（context 是原帖），posts 为主页推文（context 是账号）。
// 返回的 batchIds 是本次实际发给模型的条目。
function buildPrompt(settings, kind, context, batch) {
  return {
    system: buildSystemPrompt(kind, settings.customCriteria[kind]),
    user: buildUserPrompt(kind, context, batch)
  };
}

// 返回配置问题的说明；没有问题时返回 null。
async function configProblem(settings) {
  const missing = missingConfig(settings);
  if (missing) return missing;
  if (settings.providerId === "custom") {
    const origins = [originPattern(settings.baseUrl)];
    if (!origins[0]) return "自定义接口地址格式不对";
    if (!(await chrome.permissions.contains({ origins }))) {
      return "还没授权访问自定义接口地址，请在设置页点「测试连接」";
    }
  }
  return null;
}

async function analyzeItems(kind, context, items, mode) {
  const cache = await loadScoreCache();
  const cached = [];
  const misses = [];
  for (const item of items) {
    if (cache[item.id]) cached.push({ id: item.id, ...cache[item.id] });
    else misses.push(item);
  }
  if (mode === "lookup" || !misses.length) return { ok: true, results: cached, batchIds: [] };

  const settings = await loadSettings();
  let batch = misses.slice(0, settings.maxReplies);

  if (mode === "auto") {
    if (!settings.autoScanOwn) {
      return { ok: true, results: cached, batchIds: [], autoDisabled: true };
    }
    const remaining = settings.dailyAutoLimit - (await todayAutoCount());
    if (remaining <= 0) {
      return { ok: true, results: cached, batchIds: [], limitReached: true };
    }
    batch = batch.slice(0, remaining);
  }

  const problem = await configProblem(settings);
  if (problem) {
    return { ok: false, needsConfig: true, error: problem, results: cached, batchIds: [] };
  }

  const batchIds = batch.map((item) => item.id);
  const prompt = buildPrompt(settings, kind, context, batch);
  try {
    const text = await requestCompletion(settings, prompt.system, prompt.user);
    const batchIdSet = new Set(batchIds);
    const fresh = parseResults(text).filter((result) => batchIdSet.has(result.id));
    await saveScores(fresh);
    if (mode === "auto") await addAutoCount(batch.length);

    return {
      ok: true,
      results: [...cached, ...fresh],
      batchIds,
      analyzed: fresh.length,
      remaining: misses.length - batch.length
    };
  } catch (error) {
    return { ok: false, error: error.message || "分析失败", results: cached, batchIds };
  }
}

// 设置页的「测试连接」：用一条假回复跑一遍完整流程，不写缓存。
async function testConnection() {
  const settings = await loadSettings();
  const problem = await configProblem(settings);
  if (problem) return { ok: false, error: problem };

  const startedAt = Date.now();
  try {
    const prompt = buildPrompt(settings, "replies", { author: "test", text: "今天发布了新版本。" }, [
      { id: "1", author: "tester", text: "Great insight! 🚀", delaySeconds: 30 }
    ]);
    const results = parseResults(await requestCompletion(settings, prompt.system, prompt.user));
    if (!results.length) throw new Error("模型返回了 JSON，但没有分析结果");
    return { ok: true, ms: Date.now() - startedAt, model: settings.model };
  } catch (error) {
    return { ok: false, error: error.message || "连接失败" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TEST_CONNECTION") {
    testConnection().then(sendResponse);
    return true;
  }

  if (message?.type === "ANALYZE_ITEMS") {
    analyzeItems(message.kind || "replies", message.context, message.items, message.mode || "manual")
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "分析失败" }));
    return true;
  }

  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});

// 点击工具栏图标：扫描当前页的回复。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https:\/\/(x\.com|twitter\.com)\//.test(tab.url || "")) {
    if (tab.id) await showBadge(tab.id, "!", "#e0245e");
    return;
  }

  try {
    let result;
    try {
      result = await sendMessage(tab.id, { type: "SCAN_REPLIES" });
    } catch (_error) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["ai-detector.js"]
      });
      result = await sendMessage(tab.id, { type: "SCAN_REPLIES" });
    }

    await showBadge(
      tab.id,
      result?.ok ? "✓" : "!",
      result?.ok ? "#1d9bf0" : "#e0245e"
    );
  } catch (_error) {
    await showBadge(tab.id, "!", "#e0245e");
  }
});

// 本地存储：AI 分数缓存与每日自动分析计数。

const SCORE_CACHE_KEY = "scoreCache";
const AUTO_USAGE_KEY = "autoUsage";
const SCORE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function todayKey(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// 返回未过期的缓存：回复 id → { score, signals, reason, savedAt }。
async function loadScoreCache() {
  const { [SCORE_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(SCORE_CACHE_KEY);
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(cache).filter(([, entry]) => now - entry.savedAt < SCORE_CACHE_TTL)
  );
}

async function saveScores(results) {
  if (!results.length) return;
  const cache = await loadScoreCache();
  const savedAt = Date.now();
  for (const { id, score, signals, reason } of results) {
    cache[id] = { score, signals, reason, savedAt };
  }
  await chrome.storage.local.set({ [SCORE_CACHE_KEY]: cache });
}

async function todayAutoCount() {
  const { [AUTO_USAGE_KEY]: usage } = await chrome.storage.local.get(AUTO_USAGE_KEY);
  return usage?.date === todayKey() ? usage.count : 0;
}

async function addAutoCount(amount) {
  const count = await todayAutoCount();
  await chrome.storage.local.set({
    [AUTO_USAGE_KEY]: { date: todayKey(), count: count + amount }
  });
}

// 设置页：改动即保存。依赖 providers.js 与 prompt.js。

const DEFAULTS = {
  provider: "grok",
  apiKeys: {},
  models: {},
  customBaseUrl: "",
  maxReplies: 20,
  autoScanOwn: true,
  dailyAutoLimit: 300,
  customRepliesPrompt: "",
  customPostsPrompt: ""
};
const LEGACY_KEYS = ["apiKey", "model", "baseUrl"];
const PROMPT_FIELDS = { customRepliesPrompt: "replies", customPostsPrompt: "posts" };

const $ = (id) => document.getElementById(id);
let state = { ...DEFAULTS };

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (value === "" || Number.isNaN(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function todayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function showUsage() {
  const { autoUsage } = await chrome.storage.local.get("autoUsage");
  const count = autoUsage?.date === todayKey() ? autoUsage.count : 0;
  $("usage").textContent = `今天已自动分析 ${count} 条。`;
}

function flashStatus(text) {
  $("status").textContent = text;
}

async function save(patch) {
  state = { ...state, ...patch };
  await chrome.storage.local.set(patch);
  const ready = state.provider === "grok" ? state.grokSignedIn : state.apiKeys[state.provider];
  flashStatus(ready ? "✓ 已保存" : state.provider === "grok" ? "已保存，还需要登录 Grok" : "已保存，还需要填 API Key");
}

// 把 0.1 早期版本的单个 Key 迁移到按服务商分开的结构。
async function loadState() {
  const stored = await chrome.storage.local.get([...Object.keys(DEFAULTS), ...LEGACY_KEYS, "grokAuth"]);
  state = { ...DEFAULTS, ...stored };
  state.provider = normalizeProviderId(state.provider);
  state.grokSignedIn = Boolean(stored.grokAuth?.accessToken && stored.grokAuth?.refreshToken);
  state.apiKeys = { ...state.apiKeys };
  state.models = { ...state.models };

  if (stored.apiKey || stored.model || stored.baseUrl) {
    if (stored.apiKey && !state.apiKeys[state.provider]) state.apiKeys[state.provider] = stored.apiKey;
    if (stored.model && !state.models[state.provider]) state.models[state.provider] = stored.model;
    if (stored.baseUrl && state.provider === "custom" && !state.customBaseUrl) {
      state.customBaseUrl = stored.baseUrl;
    }
    await chrome.storage.local.set({
      provider: state.provider,
      apiKeys: state.apiKeys,
      models: state.models,
      customBaseUrl: state.customBaseUrl
    });
    await chrome.storage.local.remove(LEGACY_KEYS);
  }
}

function renderGrok() {
  const grok = state.provider === "grok";
  $("grokRow").hidden = !grok;
  $("apiKeyRow").hidden = grok;
  $("grokLogout").hidden = !state.grokSignedIn;
  $("grokStatus").textContent = state.grokSignedIn ? "已登录，识别会使用订阅里的 Grok 额度。" : "还没有登录。";
}

function renderProvider() {
  const provider = PROVIDERS[state.provider];
  $("provider").value = state.provider;
  $("baseUrlRow").hidden = state.provider !== "custom";
  $("customBaseUrl").value = state.customBaseUrl;
  renderGrok();
  $("apiKeyLabel").textContent = `${provider.label} API Key`;
  $("apiKey").value = state.apiKeys[state.provider] || "";
  $("keyLinkRow").hidden = !provider.keyUrl;
  if (provider.keyUrl) $("keyLink").href = provider.keyUrl;
  $("model").value = state.models[state.provider] || "";
  $("model").placeholder = provider.model ? `留空即可，默认 ${provider.model}` : "必填，例如 qwen-plus";
  $("modelHint").textContent = provider.modelHint || "";
  $("testResult").textContent = "";
}

function render() {
  renderProvider();
  $("autoScanOwn").checked = state.autoScanOwn !== false;
  $("maxReplies").value = state.maxReplies;
  $("dailyAutoLimit").value = state.dailyAutoLimit;
  for (const [field, kind] of Object.entries(PROMPT_FIELDS)) {
    $(field).value = state[field] || DEFAULT_CRITERIA[kind];
  }
}

async function testConnection() {
  const button = $("test");
  const result = $("testResult");
  result.className = "result";
  result.textContent = "测试中…";
  button.disabled = true;

  try {
    // 自定义地址需要在点击时请求授权。
    if (state.provider === "custom") {
      const origin = originPattern(state.customBaseUrl);
      if (!origin) throw new Error("接口地址格式不对");
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error("没有授权访问这个地址");
    }

    const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    if (!response?.ok) throw new Error(response?.error || "连接失败");
    result.className = "result ok";
    result.textContent = `✓ 可以使用（${response.model}，${(response.ms / 1000).toFixed(1)} 秒）`;
  } catch (error) {
    result.className = "result error";
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  $("provider").addEventListener("change", async (event) => {
    await save({ provider: event.target.value });
    renderProvider();
  });
  $("customBaseUrl").addEventListener("change", (event) => {
    save({ customBaseUrl: event.target.value.trim() });
  });
  $("apiKey").addEventListener("input", (event) => {
    save({ apiKeys: { ...state.apiKeys, [state.provider]: event.target.value.trim() } });
  });
  $("model").addEventListener("change", (event) => {
    save({ models: { ...state.models, [state.provider]: event.target.value.trim() } });
  });
  $("autoScanOwn").addEventListener("change", (event) => {
    save({ autoScanOwn: event.target.checked });
  });
  $("maxReplies").addEventListener("change", (event) => {
    const value = clamp(event.target.value, 1, 50, DEFAULTS.maxReplies);
    event.target.value = value;
    save({ maxReplies: value });
  });
  $("dailyAutoLimit").addEventListener("change", (event) => {
    const value = clamp(event.target.value, 0, 5000, DEFAULTS.dailyAutoLimit);
    event.target.value = value;
    save({ dailyAutoLimit: value });
  });

  // 与默认标准相同时存空值，以后默认标准更新时自动跟随。
  for (const [field, kind] of Object.entries(PROMPT_FIELDS)) {
    $(field).addEventListener("change", (event) => {
      const text = event.target.value.trim();
      save({ [field]: !text || text === DEFAULT_CRITERIA[kind].trim() ? "" : text });
    });
  }
  document.querySelectorAll("[data-reset]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.reset;
      $(field).value = DEFAULT_CRITERIA[PROMPT_FIELDS[field]];
      save({ [field]: "" });
    });
  });

  $("test").addEventListener("click", testConnection);
  $("grokLogin").addEventListener("click", loginGrok);
  $("grokLogout").addEventListener("click", logoutGrok);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginGrok() {
  const button = $("grokLogin");
  const status = $("grokStatus");
  button.disabled = true;
  status.textContent = "正在打开登录…";
  try {
    let start;
    try {
      start = await chrome.runtime.sendMessage({ type: "GROK_LOGIN_START" });
    } catch (error) {
      throw new Error("扩展后台没有响应。请在 chrome://extensions 刷新「X 回复清理助手」，再重新打开这个设置页。");
    }
    if (!start?.ok) {
      throw new Error(start?.error || "扩展后台没有响应。请在 chrome://extensions 刷新「X 回复清理助手」，再重新打开这个设置页。");
    }
    $("grokCode").textContent = start.userCode;
    $("grokCodeLine").hidden = false;
    if (start.verificationUrl) chrome.tabs.create({ url: start.verificationUrl });
    status.textContent = "请在打开的页面完成登录。";

    let interval = Math.max(1, Number(start.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(start.expiresIn) || 600) * 1000;
    while (Date.now() < deadline) {
      await sleep(interval);
      const poll = await chrome.runtime.sendMessage({ type: "GROK_LOGIN_POLL", deviceCode: start.deviceCode });
      if (poll?.status === "success") {
        state.grokSignedIn = true;
        $("grokCodeLine").hidden = true;
        renderGrok();
        flashStatus("✓ 已登录 Grok");
        return;
      }
      if (poll?.status === "slow_down") interval = Math.min(30000, interval + 5000);
      if (poll?.status === "error" || poll?.ok === false) throw new Error(poll?.error || "登录失败");
    }
    throw new Error("登录超时，请重试");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function logoutGrok() {
  await chrome.runtime.sendMessage({ type: "GROK_LOGOUT" });
  state.grokSignedIn = false;
  $("grokCodeLine").hidden = true;
  renderGrok();
  flashStatus("已退出 Grok 登录");
}

async function init() {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    $("provider").append(new Option(provider.label, id));
  }
  await loadState();
  render();
  bindEvents();
  showUsage();
}

init();

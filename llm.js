// 大模型调用层：读取设置、请求模型、解析结果。依赖 providers.js。

const DEFAULT_SETTINGS = {
  provider: "grok",
  apiKeys: {}, // 服务商 id → Key，切换服务商时互不覆盖
  models: {}, // 服务商 id → 自定义模型名，留空用默认
  customBaseUrl: "",
  maxReplies: 20,
  autoScanOwn: true,
  dailyAutoLimit: 300,
  customRepliesPrompt: "",
  customPostsPrompt: ""
};

// 0.1 早期版本只存单个 apiKey / model / baseUrl。
const LEGACY_KEYS = ["apiKey", "model", "baseUrl"];

const REQUEST_TIMEOUT = 60000;
const ANTHROPIC_FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

async function loadSettings() {
  const stored = await chrome.storage.local.get([...Object.keys(DEFAULT_SETTINGS), ...LEGACY_KEYS, "grokAuth"]);
  const raw = { ...DEFAULT_SETTINGS, ...stored };
  const providerId = normalizeProviderId(raw.provider);
  const provider = PROVIDERS[providerId];

  const apiKeys = { ...raw.apiKeys };
  const models = { ...raw.models };
  if (raw.apiKey && !apiKeys[providerId]) apiKeys[providerId] = raw.apiKey;
  if (raw.model && !models[providerId]) models[providerId] = raw.model;
  const customBaseUrl = raw.customBaseUrl || (providerId === "custom" ? raw.baseUrl || "" : "");
  const grokAuth = raw.grokAuth;

  return {
    providerId,
    api: provider.api,
    grokSignedIn: Boolean(grokAuth?.accessToken && grokAuth?.refreshToken),
    temperature: provider.temperature ?? null,
    jsonMode: Boolean(provider.jsonMode),
    apiKey: (apiKeys[providerId] || "").trim(),
    model: (models[providerId] || "").trim() || provider.model,
    baseUrl: (providerId === "custom" ? customBaseUrl : provider.baseUrl).trim().replace(/\/+$/, ""),
    maxReplies: Number(raw.maxReplies) || DEFAULT_SETTINGS.maxReplies,
    autoScanOwn: raw.autoScanOwn !== false,
    dailyAutoLimit: Math.max(0, Number(raw.dailyAutoLimit) || 0),
    customCriteria: { replies: raw.customRepliesPrompt, posts: raw.customPostsPrompt }
  };
}

function missingConfig(settings) {
  if (settings.api === "grok") {
    if (!settings.grokSignedIn) return "请先在设置页用 X 订阅登录 Grok";
    if (!settings.model) return "请先在设置页填写模型名";
    return null;
  }
  if (!settings.apiKey) return "请先在设置页填写 API Key";
  if (!settings.baseUrl) return "请先在设置页填写接口地址";
  if (!settings.model) return "请先在设置页填写模型名";
  return null;
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("API 请求超时");
    throw new Error(`无法连接 API：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function throwHttpError(response, api) {
  const detail = await response.text().catch(() => "");
  if (api === "grok" && (response.status === 401 || response.status === 403)) {
    throw new Error("Grok 登录失效，或当前订阅不能用这个接口。请在设置页重新登录。");
  }
  if (api === "grok" && response.status === 402) throw new Error("Grok 订阅额度不可用或已用完");
  if (response.status === 426) throw new Error("Grok 客户端版本过旧，需要更新插件");
  if (response.status === 401 || response.status === 403) throw new Error("API Key 无效或没有权限");
  if (response.status === 402) throw new Error("API 余额不足");
  if (response.status === 404) throw new Error("接口地址或模型名不对（404）");
  if (response.status === 429) throw new Error("请求太频繁或额度用完（429）");
  throw new Error(`API 请求失败（${response.status}）${detail.slice(0, 120)}`);
}

// OpenAI 兼容的 Chat Completions 接口（DeepSeek、OpenAI、OpenRouter 与自定义地址）。
async function requestChatCompletion(settings, systemPrompt, userMessage) {
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ]
  };
  if (settings.temperature !== null) body.temperature = settings.temperature;
  if (settings.jsonMode) body.response_format = { type: "json_object" };

  const response = await fetchWithTimeout(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) await throwHttpError(response, "openai");

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型没有返回内容");
  return content;
}

// Claude Messages API。扩展页面属于浏览器环境，需要显式允许浏览器直连。
async function requestAnthropicMessage(settings, systemPrompt, userMessage) {
  const body = {
    model: settings.model,
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    // 打分是简单分类任务，低思考强度即可。
    output_config: { effort: "low" }
  };
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
  // 模型因安全分类拒答时，由服务端按类别自动换模型重试。
  if (ANTHROPIC_FALLBACK_MODELS.test(settings.model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }

  const response = await fetchWithTimeout(`${settings.baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) await throwHttpError(response, "anthropic");

  const data = await response.json();
  if (data.stop_reason === "refusal") throw new Error("模型拒绝了这次请求");
  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text) throw new Error("模型没有返回内容");
  return text;
}

function responseText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("");
}

// Grok 订阅走 Responses 接口。身份头是代理用来识别订阅客户端的。
async function requestGrokResponse(settings, systemPrompt, userMessage) {
  const accessToken = await getGrokAccessToken();
  const response = await fetchWithTimeout(GROK_PROXY.responsesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...GROK_PROXY.headers
    },
    body: JSON.stringify({
      model: settings.model,
      store: false,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ]
    })
  });
  if (!response.ok) await throwHttpError(response, "grok");
  const text = responseText(await response.json());
  if (!text) throw new Error("模型没有返回内容");
  return text;
}

// 返回模型输出的原始文本。
async function requestCompletion(settings, systemPrompt, userMessage) {
  if (settings.api === "grok") return requestGrokResponse(settings, systemPrompt, userMessage);
  if (settings.api === "anthropic") {
    return requestAnthropicMessage(settings, systemPrompt, userMessage);
  }
  return requestChatCompletion(settings, systemPrompt, userMessage);
}

function parseResults(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("模型没有返回 JSON");

  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (_error) {
    throw new Error("模型返回的 JSON 无法解析");
  }
  if (!Array.isArray(data.results)) throw new Error("模型返回格式不对");

  return data.results
    .filter((item) => item && item.id != null)
    .map((item) => ({
      id: String(item.id),
      score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
      signals: Array.isArray(item.signals) ? item.signals.map(String) : [],
      reason: String(item.reason || "")
    }));
}

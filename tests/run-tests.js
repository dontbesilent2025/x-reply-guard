// 后台逻辑测试：用模拟的 chrome API 和 fetch 运行，不需要安装任何依赖。
// 运行：node tests/run-tests.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["providers.js", "prompt.js", "grok-auth.js", "llm.js", "store.js", "background.js"];

function createExtension({ storage = {}, grantedOrigins = [] } = {}) {
  const store = JSON.parse(JSON.stringify(storage));
  const requests = [];
  let respond = () => ({ status: 200, body: {} });

  const chrome = {
    storage: {
      local: {
        async get(query) {
          const keys = typeof query === "string" ? [query] : Array.isArray(query) ? query : Object.keys(query);
          const result = {};
          for (const key of keys) {
            if (key in store) result[key] = JSON.parse(JSON.stringify(store[key]));
            else if (query && !Array.isArray(query) && typeof query === "object") result[key] = query[key];
          }
          return result;
        },
        async set(patch) {
          Object.assign(store, JSON.parse(JSON.stringify(patch)));
        }
      }
    },
    permissions: { contains: async ({ origins }) => origins.every((o) => grantedOrigins.includes(o)) },
    runtime: { onMessage: { addListener() {} }, openOptionsPage() {} },
    action: { onClicked: { addListener() {} } }
  };

  async function fetch(url, init) {
    const request = { url, headers: init.headers, body: JSON.parse(init.body) };
    requests.push(request);
    const { status = 200, body = {} } = respond(request);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  }

  const context = {
    chrome,
    fetch,
    URL,
    URLSearchParams,
    atob: globalThis.atob,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    importScripts() {}
  };
  vm.createContext(context);
  const code = SOURCES.map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  vm.runInContext(
    `${code}\nglobalThis.api = { analyzeItems, testConnection, loadSettings, buildSystemPrompt, parseResults, DEFAULT_CRITERIA };`,
    context
  );

  return {
    store,
    requests,
    api: context.api,
    respondWith(fn) {
      respond = fn;
    }
  };
}

// 按请求里的条目 id 生成假结果，兼容两种接口格式。
function echoScores(score = 50) {
  return (request) => {
    const userMessage = request.body.messages
      ? request.body.messages.find((message) => message.role === "user")
      : request.body.input.find((message) => message.role === "user");
    const userText = userMessage.content;
    const input = JSON.parse(userText);
    const items = input.replies || input.posts;
    const text = JSON.stringify({ results: items.map((item) => ({ id: item.id, score, signals: [], reason: "测试" })) });
    if (request.url.endsWith("/v1/messages")) {
      return { body: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text }] } };
    }
    if (request.url.endsWith("/responses")) return { body: { output_text: text } };
    return { body: { choices: [{ message: { content: text } }] } };
  };
}

const replies = (from, count) =>
  Array.from({ length: count }, (_, index) => ({
    id: String(from + index),
    author: "someone",
    text: "Great point!",
    delaySeconds: 10
  }));
const PARENT = { author: "me", text: "原帖" };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("没有 Key 时提示去设置，不调用 API", async () => {
  const ext = createExtension();
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 2), "auto");
  assert.equal(result.needsConfig, true);
  assert.equal(ext.requests.length, 0);
});

test("旧版单个 apiKey 自动当作当前服务商的 Key", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKey: "old-key" } });
  const settings = await ext.api.loadSettings();
  assert.equal(settings.apiKey, "old-key");
  assert.equal(settings.model, "deepseek-flash");
});

test("lookup 只查缓存，不调用 API", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" } } });
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 3), "lookup");
  assert.equal(result.results.length, 0);
  assert.equal(ext.requests.length, 0);
});

test("单次最多分析 maxReplies 条，第二次只发未缓存的", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" } } });
  ext.respondWith(echoScores());
  let result = await ext.api.analyzeItems("replies", PARENT, replies(1, 25), "auto");
  assert.equal(result.analyzed, 20);
  assert.equal(result.remaining, 5);
  result = await ext.api.analyzeItems("replies", PARENT, replies(1, 25), "auto");
  assert.deepEqual(result.batchIds, ["21", "22", "23", "24", "25"]);
  assert.equal(result.results.length, 25);
  assert.equal(ext.store.autoUsage.count, 25);
});

test("每日上限截断自动分析，手动不受限制也不计数", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" }, dailyAutoLimit: 3 } });
  ext.respondWith(echoScores());
  let result = await ext.api.analyzeItems("replies", PARENT, replies(1, 5), "auto");
  assert.equal(result.batchIds.length, 3);
  result = await ext.api.analyzeItems("replies", PARENT, replies(100, 2), "auto");
  assert.equal(result.limitReached, true);
  result = await ext.api.analyzeItems("replies", PARENT, replies(100, 2), "manual");
  assert.equal(result.analyzed, 2);
  assert.equal(ext.store.autoUsage.count, 3);
});

test("跨天后自动分析计数归零", async () => {
  const ext = createExtension({
    storage: { provider: "deepseek", apiKeys: { deepseek: "k" }, dailyAutoLimit: 3, autoUsage: { date: "2000-01-01", count: 99 } }
  });
  ext.respondWith(echoScores());
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 2), "auto");
  assert.equal(result.analyzed, 2);
  assert.equal(ext.store.autoUsage.count, 2);
});

test("关闭自动检测后 auto 不调用 API", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" }, autoScanOwn: false } });
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 2), "auto");
  assert.equal(result.autoDisabled, true);
  assert.equal(ext.requests.length, 0);
});

test("缓存 7 天后过期", async () => {
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  const ext = createExtension({
    storage: { scoreCache: { 1: { score: 90, signals: [], reason: "", savedAt: old } } }
  });
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "lookup");
  assert.equal(result.results.length, 0);
});

test("主页推文使用推文版提示词", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" } } });
  ext.respondWith(echoScores(80));
  const result = await ext.api.analyzeItems("posts", { author: "someone" }, replies(1, 2), "manual");
  assert.equal(result.analyzed, 2);
  assert.ok(ext.requests[0].body.messages[0].content.includes("P2 批量模板"));
});

test("自定义判断标准替换默认标准，输出格式仍然追加", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" }, customRepliesPrompt: "只看是否有 emoji。" } });
  ext.respondWith(echoScores());
  await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  const system = ext.requests[0].body.messages[0].content;
  assert.ok(system.startsWith("只看是否有 emoji。"));
  assert.ok(system.includes("## 输出格式"));
  assert.ok(!system.includes("R1 万能回复"));
});

test("DeepSeek 请求带温度 0 和 JSON 模式", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" } } });
  ext.respondWith(echoScores());
  await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  const request = ext.requests[0];
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer k");
  assert.equal(request.body.temperature, 0);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
});

test("OpenAI 请求不传温度", async () => {
  const ext = createExtension({ storage: { provider: "openai", apiKeys: { openai: "k" } } });
  ext.respondWith(echoScores());
  await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  const request = ext.requests[0];
  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(request.body.model, "gpt-5.4-mini");
  assert.ok(!("temperature" in request.body));
});

test("切换服务商时各自的 Key 互不覆盖", async () => {
  const ext = createExtension({ storage: { provider: "openrouter", apiKeys: { deepseek: "a", openrouter: "b" } } });
  ext.respondWith(echoScores());
  await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  assert.equal(ext.requests[0].headers.Authorization, "Bearer b");
  assert.equal(ext.requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
});

test("Claude 请求头、低思考强度、拒答回退，并跳过 thinking 块", async () => {
  const ext = createExtension({ storage: { provider: "anthropic", apiKeys: { anthropic: "k" } } });
  ext.respondWith(echoScores(70));
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 2), "manual");
  const request = ext.requests[0];
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "k");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(request.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(request.body.model, "claude-opus-5-5");
  assert.equal(request.body.fallbacks, "default");
  assert.deepEqual(request.body.output_config, { effort: "low" });
  assert.ok(!("temperature" in request.body));
  assert.equal(result.analyzed, 2);
});

test("Claude Haiku 不发送拒答回退参数", async () => {
  const ext = createExtension({
    storage: { provider: "anthropic", apiKeys: { anthropic: "k" }, models: { anthropic: "claude-haiku-5-5" } }
  });
  ext.respondWith(echoScores());
  await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  assert.ok(!("fallbacks" in ext.requests[0].body));
  assert.ok(!("anthropic-beta" in ext.requests[0].headers));
});

test("Claude 拒答时返回明确错误", async () => {
  const ext = createExtension({ storage: { provider: "anthropic", apiKeys: { anthropic: "k" } } });
  ext.respondWith(() => ({ body: { stop_reason: "refusal", content: [] } }));
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  assert.equal(result.ok, false);
  assert.equal(result.error, "模型拒绝了这次请求");
});

test("自定义地址未授权时不发请求", async () => {
  const ext = createExtension({
    storage: { provider: "custom", apiKeys: { custom: "k" }, models: { custom: "m" }, customBaseUrl: "https://llm.example.com/v1" }
  });
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  assert.equal(result.needsConfig, true);
  assert.ok(result.error.includes("授权"));
  assert.equal(ext.requests.length, 0);
});

test("自定义地址授权后可以使用，且不强制 JSON 模式", async () => {
  const ext = createExtension({
    storage: { provider: "custom", apiKeys: { custom: "k" }, models: { custom: "m" }, customBaseUrl: "https://llm.example.com/v1/" },
    grantedOrigins: ["https://llm.example.com/*"]
  });
  ext.respondWith(echoScores());
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  assert.equal(result.analyzed, 1);
  assert.equal(ext.requests[0].url, "https://llm.example.com/v1/chat/completions");
  assert.ok(!("response_format" in ext.requests[0].body));
});

test("HTTP 错误转换成中文提示", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" } } });
  ext.respondWith(() => ({ status: 402 }));
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 2), "manual");
  assert.equal(result.ok, false);
  assert.equal(result.error, "API 余额不足");
  assert.deepEqual(result.batchIds, ["1", "2"]);
});

test("测试连接：成功时返回模型名，且不写入缓存", async () => {
  const ext = createExtension({ storage: { provider: "deepseek", apiKeys: { deepseek: "k" } } });
  ext.respondWith(echoScores());
  const result = await ext.api.testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.model, "deepseek-flash");
  assert.ok(!ext.store.scoreCache);
});

function fakeJwt() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("没登录 Grok 时不调用 API", async () => {
  const ext = createExtension({ storage: { provider: "grok" } });
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  assert.equal(result.needsConfig, true);
  assert.equal(ext.requests.length, 0);
});

test("Grok 订阅请求走代理，并带上订阅客户端身份", async () => {
  const token = fakeJwt();
  const ext = createExtension({
    storage: {
      provider: "grok",
      grokAuth: { accessToken: token, refreshToken: "refresh-token", expiresAt: Date.now() + 3600000 }
    }
  });
  ext.respondWith(echoScores());
  const result = await ext.api.analyzeItems("replies", PARENT, replies(1, 1), "manual");
  const request = ext.requests[0];
  assert.equal(result.analyzed, 1);
  assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/responses");
  assert.equal(request.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(request.headers["x-grok-client-identifier"], "grok-shell");
  assert.equal(request.body.model, "grok-4.5");
  assert.equal(request.body.store, false);
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.equal(ext.requests.length, 1);
});

test("解析结果：分数截断到 0–100，丢弃缺 id 的条目，容忍前后多余文字", async () => {
  const ext = createExtension();
  const results = ext.api.parseResults('好的\n{"results":[{"id":1,"score":130},{"score":5}]}\n');
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 100);
  assert.equal(results[0].id, "1");
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`✗ ${name}\n  ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 通过`);
  process.exit(failed ? 1 : 0);
})();

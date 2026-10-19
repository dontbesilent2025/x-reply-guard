// 用真实 API 跑一组构造样例，检查提示词能否分开 AI 内容和真人内容。会产生少量费用。
//
// 运行：
//   AI_PROVIDER=deepseek AI_API_KEY=你的Key node tests/live-test.js
// 可选：AI_MODEL=模型名  AI_BASE_URL=自定义接口地址（AI_PROVIDER=custom 时必填）

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const { AI_PROVIDER = "deepseek", AI_API_KEY, AI_MODEL = "", AI_BASE_URL = "" } = process.env;
if (!AI_API_KEY) {
  console.error("请用环境变量 AI_API_KEY 提供 Key，例如：AI_PROVIDER=deepseek AI_API_KEY=... node tests/live-test.js");
  process.exit(1);
}

const storage = {
  provider: AI_PROVIDER,
  apiKeys: { [AI_PROVIDER]: AI_API_KEY },
  models: { [AI_PROVIDER]: AI_MODEL },
  customBaseUrl: AI_BASE_URL
};
const chrome = {
  storage: {
    local: {
      async get(keys) {
        const result = {};
        for (const key of keys) if (key in storage) result[key] = storage[key];
        return result;
      }
    }
  }
};
const context = { chrome, fetch, URL, AbortController, setTimeout, clearTimeout, console };
vm.createContext(context);
const code = ["providers.js", "prompt.js", "llm.js"]
  .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
  .join("\n");
vm.runInContext(`${code}\nglobalThis.api = { loadSettings, buildSystemPrompt, buildUserPrompt, requestCompletion, parseResults };`, context);
const { api } = context;

const CASES = {
  replies: {
    context: {
      author: "creator",
      text: "做知识付费最容易犯的错：先做课，再找人。正确顺序是先在评论区和私信里找到反复出现的同一个问题，有 20 个人问过同一件事，再去做课。"
    },
    items: [
      { id: "1", author: "growth_8823", expect: "ai", delaySeconds: 41, text: "This is such a valuable insight! 🚀 Understanding your audience first is truly the key to success. What do you think is the most important step? 💡" },
      { id: "2", author: "xiaoli", expect: "human", delaySeconds: 3600, text: "我去年就是反过来的，录了 30 节课卖出去 4 份。。现在看评论区才发现大家问的根本不是我课里讲的" },
      { id: "3", author: "insight_2024", expect: "ai", delaySeconds: 25, text: "非常认同！先找到用户的真实需求，再去开发产品，这才是知识付费的正确路径。本质上，这不是在卖课，而是在解决问题。值得注意的是，20 个人这个阈值非常关键。" },
      { id: "4", author: "laowang", expect: "human", delaySeconds: 1800, text: "20 个人的数是怎么定的？我这边私信少，10 个算不算" }
    ]
  },
  posts: {
    context: { author: "someone" },
    items: [
      { id: "1", expect: "ai", text: "90% 的人都不知道：真正拉开差距的不是努力，而是认知。\n\n✅ 学会独处\n✅ 学会复利\n✅ 学会延迟满足\n\n本质上，人生是一场长期主义的修行。你认同吗？👇" },
      { id: "2", expect: "ai", text: "停止盲目努力。\n\n真正的高手都懂这 3 点：\n1️⃣ 专注\n2️⃣ 复盘\n3️⃣ 杠杆\n\n成长不是线性的，而是指数级的。转发给需要的人 🚀" },
      { id: "3", expect: "human", text: "今天杭州下暴雨，线下课场地空调坏了，30 多个人挤在一个屋里讲了三个小时，衣服全湿透。散场的时候有个学员说下次自带风扇哈哈" },
      { id: "4", expect: "human", text: "又被限流了，不知道是哪条踩了线，这个月第二次。。有没有人知道申诉要等多久" }
    ]
  }
};

(async () => {
  const settings = await api.loadSettings();
  console.log(`服务商 ${settings.providerId}，模型 ${settings.model}\n`);
  let wrong = 0;

  for (const [kind, { context: ctx, items }] of Object.entries(CASES)) {
    const startedAt = Date.now();
    const raw = await api.requestCompletion(
      settings,
      api.buildSystemPrompt(kind, ""),
      api.buildUserPrompt(kind, ctx, items)
    );
    const results = new Map(api.parseResults(raw).map((result) => [result.id, result]));
    console.log(`[${kind}] ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);

    for (const item of items) {
      const result = results.get(item.id);
      const verdict = !result ? "missing" : result.score >= 70 ? "ai" : result.score <= 30 ? "human" : "unsure";
      const ok = verdict === item.expect;
      if (!ok) wrong += 1;
      console.log(`  ${ok ? "✓" : "✗"} #${item.id} 期望 ${item.expect}，得分 ${result?.score ?? "无"}  ${result?.reason ?? ""}`);
    }
    console.log("");
  }

  console.log(wrong ? `${wrong} 条与预期不符` : "全部符合预期");
  process.exit(wrong ? 1 : 0);
})().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});

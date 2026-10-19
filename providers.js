// 支持的模型服务商。设置页与后台共用。
// api：openai 为 Chat Completions 兼容接口，anthropic 为 Claude Messages API。

const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    api: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    temperature: 0,
    jsonMode: true
  },
  openai: {
    label: "OpenAI",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    temperature: null, // 新一代推理模型只接受默认温度
    jsonMode: true
  },
  anthropic: {
    label: "Claude（Anthropic）",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-5-5",
    modelHint: "想省钱可填 claude-haiku-5-5，价格约为默认模型的四十分之一。",
    keyUrl: "https://console.anthropic.com/settings/keys"
  },
  openrouter: {
    label: "OpenRouter",
    api: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4-flash",
    keyUrl: "https://openrouter.ai/keys",
    temperature: 0,
    jsonMode: true
  },
  custom: {
    label: "自定义（OpenAI 兼容接口）",
    api: "openai",
    baseUrl: "",
    model: "",
    keyUrl: "",
    temperature: 0,
    jsonMode: false
  }
};

const LEGACY_PROVIDER_IDS = { "openai-compatible": "custom" };

function normalizeProviderId(id) {
  const mapped = LEGACY_PROVIDER_IDS[id] || id;
  return PROVIDERS[mapped] ? mapped : "deepseek";
}

// 自定义地址需要运行时授权的来源，例如 https://example.com/*。
function originPattern(baseUrl) {
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch (_error) {
    return null;
  }
}

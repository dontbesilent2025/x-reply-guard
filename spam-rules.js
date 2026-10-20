// 黄推（色情引流机器人）本地识别规则。不调用 API，不花钱。
//
// 这类回复往往只有几个字，单看文字很难判断是不是 AI 写的，
// 但话术高度重复、账号特征明显，所以用规则直接识别。
//
// 判定：
// - 命中强话术：直接判定
// - 命中弱词，且至少有两项账号特征：判定
// - 只有账号特征、没有话术：不判定，避免误伤

// 命中一条即判定。
const SPAM_STRONG_PHRASES = [
  "只入身体不入生活",
  "急找主人",
  "找主人",
  "求主人",
  "固炮",
  "约炮",
  "线下可约",
  "同城约",
  "同城可约",
  "看我主页",
  "主页有惊喜",
  "点我头像",
  "看我置顶",
  "滴滴我",
  "有人陪我吗",
  "今晚一个人",
  "寂寞难耐",
  "欲望强",
  "性瘾",
  "寻刺激",
  "想发泄",
  "反差婊",
  "包养",
  "裸聊",
  "t.me/",
  "电报联系",
  "飞机联系"
];

// 正常人也会用，单独出现不判定，需要同时有两项账号特征。
const SPAM_WEAK_WORDS = [
  "主人", "调教", "汪汪", "同城", "附近", "线下", "反差", "寂寞", "空虚",
  "少妇", "人妻", "姐姐", "哥哥", "宝宝", "私信", "福利", "加v", "vx",
  "身体", "睡不着", "一个人", "陪我", "可约", "私我", "telegram"
];

// 昵称里常见的装饰 emoji。
const SPAM_NAME_EMOJI = /[🌸🌺🌹🌷💐💕💗💖💓💞❤💋🍑🍒🎀🐰🦋✨]/u;
// 正文里常见的暧昧 emoji。
const SPAM_TEXT_EMOJI = /[🥺✋💦👅🍑🍆😍🥵😘💋🔞]/u;

// 去掉空白、emoji 和标点，只保留文字、数字以及链接里的「.」「/」。
// 黄推常把 emoji 插在句子中间，例如「只入身体🥺✋不入生活」。
function normalizeForSpam(text) {
  return (text || "").toLowerCase().replace(/[^\p{L}\p{N}./]/gu, "");
}

// 用户名大小写随机混排，例如 ZOkRIOeM。
function looksRandomHandle(handle) {
  if (!handle || !/^[A-Za-z0-9]{6,15}$/.test(handle)) return false;
  const letters = handle.replace(/[^A-Za-z]/g, "");
  const upper = (letters.match(/[A-Z]/g) || []).length;
  const lower = (letters.match(/[a-z]/g) || []).length;
  let switches = 0;
  for (let index = 1; index < letters.length; index += 1) {
    const before = letters[index - 1] === letters[index - 1].toUpperCase();
    const current = letters[index] === letters[index].toUpperCase();
    if (before !== current) switches += 1;
  }
  return upper >= 2 && lower >= 1 && switches >= 3;
}

function parseCustomPhrases(text) {
  return (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// item：{ text, displayName, handle }。handle 为原始大小写。
// 返回 null 或 { score, signals, reason, spam: true }。
function checkSpam(item, customPhrases = []) {
  const text = normalizeForSpam(item.text);
  if (!text) return null;

  const strong = [...SPAM_STRONG_PHRASES, ...customPhrases].find((phrase) =>
    text.includes(normalizeForSpam(phrase))
  );
  if (strong) {
    return { score: 95, signals: ["黄推话术"], reason: `命中黄推语录「${strong}」`, spam: true };
  }

  const accountSignals = [];
  if (SPAM_NAME_EMOJI.test(item.displayName || "")) accountSignals.push("昵称带装饰 emoji");
  if (looksRandomHandle(item.handle)) accountSignals.push("用户名随机混排");
  if (SPAM_TEXT_EMOJI.test(item.text || "") && text.length <= 30) accountSignals.push("短句带暧昧 emoji");
  // 单项特征太常见（很多正常用户昵称也带 emoji），至少两项才算。
  if (accountSignals.length < 2) return null;

  const weak = SPAM_WEAK_WORDS.find((word) => text.includes(normalizeForSpam(word)));
  if (!weak) return null;

  return {
    score: 85,
    signals: ["黄推特征"],
    reason: `含「${weak}」，且${accountSignals.join("、")}`,
    spam: true
  };
}

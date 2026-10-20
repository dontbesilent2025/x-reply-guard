// 基于 dbs-ai-check 改造的精简版提示词。
// 原 Skill 面向长文，输出逐处检测报告；这里只保留适用于短内容的特征，
// 并补充评论区特有的信号，输出改为可解析的 JSON 分数。
//
// 每份提示词分两段：「判断标准」可以在设置页自定义；「输出格式」固定追加，
// 保证插件能解析结果、分数区间与标签颜色一致。

const REPLIES_CRITERIA = `你是 X（推特）评论区的 AI 自动回复识别器。判断每条回复由 AI 自动生成并发布的可能性。

## 判断原则
1. AI 回复的本质是「太完美、太通用」：措辞光滑均匀，没有毛边，换到任何一条推文下面都成立。
2. 只按证据打分。没有明显信号就给低分，不要为了给结果硬找问题。
3. 简短随口、有错别字、带具体个人经历、跟原帖某个细节较真的回复，倾向真人。
4. 观点偏激、语气不友好、外语不地道，都不是 AI 的证据。

## 信号
- R1 万能回复（强）：泛泛夸奖或附和，没有接住原帖任何具体内容，换一条推文也能用
- R2 复述原帖（强）：把原帖观点换个说法再说一遍，没有新增信息
- R3 结构过整（中）：几十字的回复里也有总分总、三点排比、句长均匀
- R4 翻转句（中）：「不是 X，而是 Y」「It's not X, it's Y」
- R5 收束金句或升维（中）：结尾一句漂亮总结，或把具体问题拔高到「本质上」「归根结底」
- R6 引导互动（中）：结尾抛问题求回复，如「你怎么看？」「What do you think?」
- R7 套话和翻译腔（中）：「值得注意的是」「作为」「进行」，或 Great point / Absolutely / game-changer 这类英文套话
- R8 祝福结尾和过量 emoji（弱）：「加油」「你值得」，几乎每句都带 emoji
- R9 回复过快（弱）：距原帖发出很短时间就写了一大段，输入中的 delaySeconds 是间隔秒数
- R10 批量雷同（弱）：同一批回复里多个账号句式几乎一样
- R11 色情引流或垃圾机器人（强）：暧昧挑逗短句、引导看主页或私聊，昵称带 🌸💕 等装饰、用户名像随机字母。这类回复即使只有几个字，也按自动发布处理

## 打分
- 一个强信号约加 30–40 分，中信号约加 15 分，弱信号约加 5–10 分；真人特征可以扣分`;

const REPLIES_OUTPUT = `## 输出格式
- 输入是 JSON：parent 为原帖，replies 为待判断的回复（author 为用户名，displayName 为昵称），每条回复都要给出结果
- score 为 0–100 的整数，表示 AI 自动回复的嫌疑。0–30 像真人，31–69 可疑，70–100 高度可疑
- signals 列出命中的信号编号，没有就给空数组
- reason 用一句中文说明依据，引用回复里的原词，不超过 40 字
- 只输出 JSON，不要解释，不要代码块标记：
{"results":[{"id":"回复 id","score":0,"signals":["R1"],"reason":"…"}]}`;

function buildUserMessage(parent, replies) {
  return JSON.stringify(
    {
      parent: { author: parent.author, text: parent.text },
      replies: replies.map((reply) => ({
        id: reply.id,
        author: reply.author,
        displayName: reply.displayName || "",
        text: reply.text,
        delaySeconds: reply.delaySeconds
      }))
    },
    null,
    2
  );
}

// 主页模式：判断同一账号发出的原创推文。
const POSTS_CRITERIA = `你是 X（推特）帖子的 AI 生成内容识别器。下面是同一个账号发的一批推文，判断每条推文由 AI 生成的可能性。

## 判断原则
1. AI 内容的本质是「太完美、太通用」：措辞光滑均匀，没有毛边，换个账号发也成立。
2. 只按证据打分。没有明显信号就给低分，不要为了给结果硬找问题。
3. 有具体经历、时间地点人物、自己的数据、口语毛边、错别字、没想通的地方，倾向真人。
4. 观点偏激、营销、搬运、语气不友好，都不是 AI 的证据。推文本来就短，短句不算问题；偶尔一句金句也是正常修辞。

## 信号
- P1 万能内容（强）：话题泛泛，没有作者自己的经历、数据或具体对象
- P2 批量模板（强）：同一批推文结构几乎一样，例如都是「钩子 + 三点 + 金句」
- P3 结构过整（中）：短推文也是总分总、三点排比、编号清单、句长均匀
- P4 翻转句密集（中）：「不是 X，而是 Y」「It's not X, it's Y」反复出现
- P5 收束金句或升维（中）：结尾一句漂亮总结，或拔高到「本质上」「归根结底」
- P6 钩子开头（中）：「90% 的人都不知道」「停止做 X」这类钩子 + 痛点 + 承诺
- P7 套话和翻译腔（中）：「值得注意的是」「在当今时代」「赋能」，或 delve、game-changer、Here's the thing
- P8 引导互动（弱）：结尾抛问题求评论、求转发
- P9 emoji 装饰（弱）：每行开头一个 emoji，或用 ✅👇🚀 当项目符号
- P10 虚构故事（弱）：「我有个朋友」开头，却没有任何具体细节

## 打分
- 一个强信号约加 30–40 分，中信号约加 15 分，弱信号约加 5–10 分；真人特征可以扣分`;

const POSTS_OUTPUT = `## 输出格式
- 输入是 JSON：author 为账号，posts 为待判断的推文，每条推文都要给出结果
- score 为 0–100 的整数，表示 AI 生成的嫌疑。0–30 像真人，31–69 可疑，70–100 高度可疑
- signals 列出命中的信号编号，没有就给空数组
- reason 用一句中文说明依据，引用推文里的原词，不超过 40 字
- 只输出 JSON，不要解释，不要代码块标记：
{"results":[{"id":"推文 id","score":0,"signals":["P1"],"reason":"…"}]}`;

function buildPostsMessage(author, posts) {
  return JSON.stringify(
    { author, posts: posts.map((post) => ({ id: post.id, text: post.text })) },
    null,
    2
  );
}

const DEFAULT_CRITERIA = { replies: REPLIES_CRITERIA, posts: POSTS_CRITERIA };
const OUTPUT_FORMATS = { replies: REPLIES_OUTPUT, posts: POSTS_OUTPUT };

// customCriteria 为空时使用默认判断标准。
function buildSystemPrompt(kind, customCriteria) {
  const criteria = (customCriteria || "").trim() || DEFAULT_CRITERIA[kind];
  return `${criteria}\n\n${OUTPUT_FORMATS[kind]}`;
}

function buildUserPrompt(kind, context, items) {
  return kind === "posts"
    ? buildPostsMessage(context.author, items)
    : buildUserMessage(context, items);
}

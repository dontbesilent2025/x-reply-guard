// 黄推规则测试：正例必须命中，常见正常回复不能误伤。
// 运行：node tests/spam-rules-test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = {};
vm.createContext(context);
vm.runInContext(
  `${fs.readFileSync(path.join(__dirname, "..", "spam-rules.js"), "utf8")}
globalThis.api = { checkSpam, looksRandomHandle, parseCustomPhrases };`,
  context
);
const { checkSpam, looksRandomHandle, parseCustomPhrases } = context.api;

const SPAM = [
  ["emoji 插在语录中间", { text: "只入身体🥺✋不入生活", displayName: "新雪🌸", handle: "ZOkRIOeM" }],
  ["急找主人", { text: "急 找 主 人", displayName: "A", handle: "abc" }],
  ["线下可约", { text: "线下可约，同城优先", displayName: "A", handle: "abc" }],
  ["电报链接", { text: "看这里 t.me/xxxx", displayName: "A", handle: "abc" }],
  ["弱词加两项账号特征", { text: "今晚好寂寞🥺", displayName: "小美💕", handle: "aBcDeFgH" }]
];

const NORMAL = [
  ["线下课", { text: "11.20 杭州线下课还有位置吗", displayName: "Andy", handle: "Andyx2bd" }],
  ["陪我", { text: "有人陪我一起去吗", displayName: "老王", handle: "laowang" }],
  ["昵称带花加弱词", { text: "姐姐说得对", displayName: "小红🌸", handle: "xiaohong" }],
  ["私信", { text: "已私信你了", displayName: "Fred", handle: "ywbt" }],
  ["自私我觉得", { text: "太自私我觉得不行", displayName: "A", handle: "abc" }],
  ["讨论 Telegram", { text: "Telegram 的群组功能挺好用", displayName: "A", handle: "abc" }],
  ["不可约", { text: "这个分数不可约分", displayName: "A", handle: "abc" }],
  ["随机用户名但正常内容", { text: "人造文明", displayName: "Evan", handle: "EvAnZlHx" }]
];

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`✗ ${name}\n  ${error.message}`);
  }
};

for (const [name, item] of SPAM) {
  check(`命中：${name}`, () => assert.ok(checkSpam(item), "应判定为黄推"));
}
for (const [name, item] of NORMAL) {
  check(`不误伤：${name}`, () => assert.equal(checkSpam(item), null));
}
check("自定义语录生效", () => {
  const phrases = parseCustomPhrases("  今晚来我家 \n\n");
  assert.deepEqual([...phrases], ["今晚来我家"]);
  assert.ok(checkSpam({ text: "今晚来我家😘", displayName: "", handle: "a" }, phrases));
});
check("随机用户名识别", () => {
  for (const handle of ["ZOkRIOeM", "xQzRtYuP"]) assert.ok(looksRandomHandle(handle), handle);
  for (const handle of ["dontbesilent", "Jack56803", "Andyx2bd", "CNClovis", "Super_CZZ"]) {
    assert.ok(!looksRandomHandle(handle), handle);
  }
});

const total = SPAM.length + NORMAL.length + 2;
console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed ? 1 : 0);

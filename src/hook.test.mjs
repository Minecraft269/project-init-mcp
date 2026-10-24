// hook 触发逻辑的回归测试。
// 判据每次改 .project-init/hook.js 都要跑：`node src/hook.test.mjs`
//
// 背景：这轮踩过的坑 —— 靠"初始化…项目"的固定字距覆盖中文各种语序，
// 必然顾此失彼：卡紧了漏掉"全量初始化"，放松了把"项目初始化完成了吗"误判成指令。
// 最终解法是只认"初始化"这个动作词本身，否定语境交给 NEG_NEAR 排除。
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { join } from "path";

const HOOK = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..", "..", ".project-init", "hook.js"
);

const fires = (p) => {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ user_prompt: p }),
    encoding: "utf-8",
  });
  try {
    return JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext != null;
  } catch {
    return false;
  }
};

const SHOULD = [
  // 各种中文语序与修饰
  "初始化项目", "全量初始化", "项目初始化", "全量初始化项目", "初始化",
  "当前项目需要全量初始化", "帮我初始化一下这个项目", "初始化下项目",
  "初始化当前的项目", "对项目进行初始化", "项目初始化一下",
  // 长 prompt 里埋着指令
  "现有代码质量还行，代码结构比较清晰。现在初始化项目，索引也要建好，记得排除文件",
  "Please review first. Then setup project with proper indexing.",
  // 英文
  "init project", "setup project", "initialize project", "please init project now",
  // 标点结尾
  "初始化项目。", "初始化项目！",
  // 「加载/载入/装载」是同一件事的口语说法，必须认
  // （但要同时出现「项目」—— 见 SHOULD_NOT 里的"模块加载机制"）
  "加载项目", "载入项目", "装载项目", "load project",
  "加载这个项目", "载入当前项目", "加载下项目", "帮我载入这个项目",
];

const SHOULD_NOT = [
  // 疑问
  "如何初始化项目？", "怎么初始化这个项目", "为什么需要初始化项目", "初始化项目要多久",
  "能否初始化项目", "可以初始化项目吗", "什么时候初始化项目", "初始化项目需要什么",
  // 教学 / 解释
  "我想让你解释一下 初始化项目 这个流程", "介绍一下项目初始化的流程", "教我如何初始化项目",
  "说明一下初始化项目的原理", "请演示项目初始化", "举例说明初始化项目",
  "初始化和全量初始化的区别是什么", "初始化项目的含义",
  // 陈述 / 查询状态
  "项目初始化完成了吗", "这个项目的初始化配置", "数据库初始化脚本怎么写",
  "初始化的配置文件在哪", "看下初始化逻辑", "帮我看下这个文件", "测试一下",
  // 「加载」在技术语境里太常见（模块加载/懒加载/插件加载），无条件触发会误伤一片
  "数据库加载脚本", "模块加载机制", "动态加载库", "懒加载实现", "看下加载逻辑",
  "插件加载失败怎么办", "图片懒加载怎么优化",
  // 英文疑问
  "how to init project", "why setup project", "what is init project",
  "teach me to init project", "explain how to setup project",
  // 无关键词
  "写个函数", "修复这个 bug", "跑一下测试",
];

let bad = 0;
for (const p of SHOULD) {
  const got = fires(p);
  if (!got) bad++;
  console.log(`  ${got ? "ok  " : "FAIL"} 应触发: ${p}`);
}
for (const p of SHOULD_NOT) {
  const got = fires(p);
  if (got) bad++;
  console.log(`  ${!got ? "ok  " : "FAIL"} 不应触发: ${p}`);
}

// 异常输入不应崩，且输出仍是合法 JSON
for (const p of ["", "   ", "初始化".repeat(200), "😀🚀初始化项目🎉"]) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ user_prompt: p }),
    encoding: "utf-8",
  });
  const ok = r.status === 0 && r.stdout.trim().startsWith("{");
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} 异常输入不崩: ${JSON.stringify(p.slice(0, 14))}`);
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
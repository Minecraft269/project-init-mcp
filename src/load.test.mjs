// "加载"链路的回归测试：MCP server 能否正常启动并暴露正确 schema，
// Claude Code 实际加载的 skill 是否指向仓库里的唯一源。
//
// 这类问题不会让任何单个步骤失败，只会让"功能好像没生效"：
// server 起不来、schema 和实现漂移、skill 加载了旧副本。
// 判据每次改 server.js 的 schema 或 SKILL.md 都要跑：`node src/load.test.mjs`
import { spawn } from "child_process";
import { existsSync, readFileSync, lstatSync, readlinkSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

// 仓库根 = src 的上一级。不要按目录名硬编码，否则 CI 上 checkout 到
// 别的目录名就全挂。
const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER = join(REPO, "src", "server.js");
// 唯一源在仓库根 —— 仓库是唯一真相，副本只是入口
const SKILL_SRC = join(REPO, "SKILL.md");
const HOOK_SRC = join(REPO, "hook.js");
// Claude Code 实际加载的位置是**本机安装**，CI 上不存在。
// 缺失时相关断言跳过（不算失败），否则 CI 永远红。
const SKILL_DIR =
  process.env.PROJECT_INIT_SKILL_DIR ||
  join(REPO, "..", "Claude Code", "claude-code-config", "skills", "project-init");
const SKILL_COPY = join(SKILL_DIR, "SKILL.md");
const HOOK_COPY = join(SKILL_DIR, "hook.js");
const HAS_INSTALL = existsSync(SKILL_DIR);

let bad = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

// ── MCP 握手 + tools/list ──
const tools = await new Promise((resolve, reject) => {
  const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const timer = setTimeout(() => { child.kill(); reject(new Error("握手超时")); }, 20000);

  child.on("error", reject);
  child.stderr.on("data", (d) => {
    if (String(d).includes("Error")) reject(new Error(`server 启动失败: ${d}`));
  });
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }

      if (m.id === 1) {
        // initialize 完成 → 通知并请求工具列表
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (m.id === 2) {
        clearTimeout(timer);
        child.kill();
        resolve(m.result?.tools || []);
      }
    }
  });

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "load-test", version: "1.0.0" },
    },
  });
});

console.log("── MCP 加载 ──");
ok("server 能启动并响应 tools/list", Array.isArray(tools) && tools.length > 0);
const names = tools.map((t) => t.name).sort();
ok("三个工具都在", names.length === 3, names.join(", "));
ok("project_init 已暴露", names.includes("project_init"));
ok("detect_stack 已暴露", names.includes("detect_stack"));
ok("check_status 已暴露", names.includes("check_status"));
ok(
  "每个工具都有 description（agent 靠它判断何时调用）",
  tools.every((t) => typeof t.description === "string" && t.description.length > 10)
);

// ── schema 与实现是否漂移 ──
const pi = tools.find((t) => t.name === "project_init");
const props = pi?.inputSchema?.properties || {};
const ge = props.gitExclude?.properties || {};

ok(
  "gitExclude 声明五组开关",
  ["runtime", "machine", "index", "agentsMd", "claudeMd"].every((g) => g in ge),
  Object.keys(ge).join(", ")
);
ok("已删除未文档化的 docs 别名", !("docs" in ge));
ok(
  "aociArtifacts 用 on/off 字符串而非布尔（MCP 客户端会丢弃 false）",
  Array.isArray(props.aociArtifacts?.enum) && props.aociArtifacts.enum.includes("off")
);

// description 里的排除项清单必须与代码里的 GIT_EXCLUDE_GROUPS 一致 ——
// agent 真正读的是这份描述，它漂移了 agent 就会按错的参数做决策。
const src = readFileSync(SERVER, "utf-8");
const groupBlock = src.match(/const GIT_EXCLUDE_GROUPS = \{([\s\S]*?)\n\};/)[1];
for (const group of ["runtime", "machine"]) {
  const arr = groupBlock.match(new RegExp(`${group}:\\s*\\[([^\\]]*)\\]`));
  const actual = arr[1].match(/["']([^"']+)["']/g).map((s) => s.slice(1, -1));
  const desc = ge[group]?.description || "";
  const missing = actual.filter((e) => !desc.includes(e));
  ok(
    `${group} 组 description 覆盖全部 ${actual.length} 项`,
    missing.length === 0,
    missing.length ? `缺: ${missing.join(", ")}` : ""
  );
}

// ── Skill 加载 ──
console.log("── Skill 加载 ──");
ok("源 SKILL.md 存在（仓库根是唯一真相）", existsSync(SKILL_SRC));
ok("源 hook.js 存在", existsSync(HOOK_SRC));

// 判据不再是"两份内容一致"——那是**事后检测**，漂移照样会发生，只是被测出来。
// 现在 Claude Code 加载的路径必须是**符号链接**指向仓库：漂移变成物理上不可能。
if (!HAS_INSTALL) {
  console.log(`  skip 本机未安装 skill（${SKILL_DIR}），跳过副本检查`);
} else {
  for (const [label, linkPath, srcPath] of [
    ["SKILL.md", SKILL_COPY, SKILL_SRC],
    ["hook.js", HOOK_COPY, HOOK_SRC],
  ]) {
    if (!existsSync(linkPath)) {
      ok(`副本 ${label} 存在`, false, linkPath);
      continue;
    }
    const isLink = lstatSync(linkPath).isSymbolicLink();
    ok(`${label} 副本是符号链接（实体副本必然漂移）`, isLink,
      isLink ? "" : "是实体文件，请改回链接");
    if (isLink) {
      // 用真实路径比对，不用字符串后缀 —— 后者在盘符大小写/相对路径下会误判
      const sameFile = realpathSync(linkPath) === realpathSync(srcPath);
      ok(`${label} 链接指向仓库源`, sameFile, readlinkSync(linkPath));
      // 链接必须能真正解析出内容（Windows 上断了会读不到）
      ok(`${label} 链接可解析`, existsSync(linkPath) && readFileSync(linkPath).length > 0);
    }
  }
}

if (existsSync(SKILL_SRC)) {
  const text = readFileSync(SKILL_SRC, "utf-8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  ok("frontmatter 存在且被 --- 正确包裹", !!fm);
  if (fm) {
    ok("frontmatter 有 name: project-init", /^name:\s*project-init\s*$/m.test(fm[1]));
    ok(
      "frontmatter 有非空 description（Claude 靠它匹配触发）",
      /^description:[\s\S]+?\S/m.test(fm[1])
    );
  }
  ok("无过期的 .aoi/ 路径残留", !text.includes(".aoi/"));
  ok("文档提到清单的真实路径", text.includes(".project-init/project-init-manifest.json"));
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
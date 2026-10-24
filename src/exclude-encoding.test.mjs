// .git/info/exclude 的 GBK 保护回归测试。
// 判据：改 initGitExclude 的 exclude 写入路径后跑一次。
//
// 为什么需要它：exclude 曾经整份按 utf-8 读写，用户的 GBK 注释按 utf-8 解码
// 产生 U+FFFD 且不可逆，写回时被改成乱码 —— 违反"块外行永不触碰"这条不变式。
// 今天的 Buffer 修复只覆盖了 .gitignore/.gitattributes/CLAUDE.md，漏了 exclude。
//
// 注意判定方式：不能用"整份 utf-8 解码后含不含 U+FFFD"来测 —— GBK 字节本来就
// 无法用 utf-8 正确解码，那样测出来的 true 是假象。必须**按字节**比对前缀。
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "server.js");

function callInit(projectPath) {
  return new Promise((resolve) => {
    const c = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const t = setTimeout(() => { c.kill(); resolve(null); }, 90000);
    c.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!l) continue;
        let m;
        try { m = JSON.parse(l); } catch { continue; }
        if (m.id !== 1) continue;
        clearTimeout(t);
        c.kill();
        resolve(m.result);
      }
    });
    c.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "project_init",
          arguments: { projectPath, mode: "incremental", aociArtifacts: "off" },
        },
      }) + "\n"
    );
  });
}

let bad = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: ${got}${ok ? "" : ` (期望 ${want})`}`);
};

// 用户手写内容：GBK 注释 + 一条自己的排除项
const USER_LINES = Buffer.concat([
  Buffer.from([0x23, 0x20]), // "# "
  Buffer.from([0xb4, 0xf3, 0xd7, 0xd6, 0xb5, 0xb5, 0xb8, 0xc4, 0xd6, 0xa4]), // GBK "个人排除"
  Buffer.from([0x0a]),
  Buffer.from("secrets.env\n"),
]);

// ── GBK exclude：用户字节必须原样保留 ──
{
  const dir = mkdtempSync(join(tmpdir(), "exg-gbk-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const ex = join(dir, ".git", "info", "exclude");
  writeFileSync(ex, USER_LINES);

  await callInit(dir);
  const after = readFileSync(ex);

  check("GBK exclude 用户字节逐字节保留", after.slice(0, USER_LINES.length).equals(USER_LINES), true);
  check("GBK exclude 用户自己的 secrets.env 仍在", after.includes(Buffer.from("secrets.env")), true);
  check("GBK exclude 仍写入了新条目",
    after.includes(Buffer.from("# added by project-init MCP")), true);
}

// ── 正常 UTF-8 exclude：行为不变，回收仍然生效 ──
{
  const dir = mkdtempSync(join(tmpdir(), "exg-utf8-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const ex = join(dir, ".git", "info", "exclude");
  // 预置托管块，块内放一条本轮**不该要**的条目（agentsMd 默认 on，所以用 AGENTS.md 会保留；
  // 改用 .remember/ 这种虽然默认 on 但可以用 gitExclude 关掉的来验证回收机制本身）
  writeFileSync(ex, "# 我的注释\n\n# added by project-init MCP\n.remember/\n");

  // 关掉 runtime 组 → .remember/ 变成"不再需要" → 应被回收
  const r = await new Promise((resolve) => {
    const c = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const t = setTimeout(() => { c.kill(); resolve(null); }, 90000);
    c.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!l) continue;
        let m;
        try { m = JSON.parse(l); } catch { continue; }
        if (m.id !== 1) continue;
        clearTimeout(t); c.kill(); resolve(m.result);
      }
    });
    c.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "project_init", arguments: {
        projectPath: dir, mode: "incremental", aociArtifacts: "off",
        gitExclude: { runtime: "off" },
      } },
    }) + "\n");
  });
  const text = r?.content?.[0]?.text || "";
  const after = readFileSync(ex, "utf-8");
  check("UTF-8 exclude 回收不再需要的条目", after.includes(".remember/"), false);
  check("UTF-8 exclude 用户手写行存活", after.includes("# 我的注释"), true);
  check("UTF-8 exclude 走常规路径（无 note 字段）", text.includes('"note"'), false);
}

// ── 空 exclude：不该崩 ──
{
  const dir = mkdtempSync(join(tmpdir(), "exg-empty-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const r = await callInit(dir);
  check("空 exclude 不崩", r?.content?.[0]?.text?.includes("初始化完成"), true);
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
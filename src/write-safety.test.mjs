// 写入失败与符号链接的回归测试。
// 判据：改 initClaudeCode / initGitExclude 的写入路径后跑一次。
//
// 为什么需要它（两条都是子代理独立审查报出的真问题）：
//  1. 只读文件/目录 → writeFileSync 抛 EPERM 未捕获 → 整个 project_init 变成
//     JSON-RPC error，**已完成步骤的分步结果一并丢失**，用户只看到一个错误码。
//  2. CLAUDE.md 是符号链接 → 跟随链接把内容写到项目外的文件，那是用户自己的数据。
import { spawn, execFileSync } from "child_process";
import {
  mkdtempSync, existsSync, readFileSync, writeFileSync,
  mkdirSync, symlinkSync, chmodSync, readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "server.js");

function callInit(projectPath, args = {}) {
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
        resolve(m);
      }
    });
    c.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "project_init",
          arguments: { projectPath, mode: "incremental", ...args },
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

// ── 1. 只读 CLAUDE.md：应返回错误结果，不是 JSON-RPC error ──
{
  const dir = mkdtempSync(join(tmpdir(), "ro-cmd-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const p = join(dir, "CLAUDE.md");
  writeFileSync(p, "# 原有内容\n");
  let ro = true;
  try {
    chmodSync(p, 0o444);
  } catch {
    ro = false;
    console.log("  skip 用例1 无法设置只读属性");
  }

  if (ro) {
    const r = await callInit(dir);
    check("只读 CLAUDE.md 返回 result 而非 error", r?.result !== undefined, true);
    check("未抛 JSON-RPC error", r?.error === undefined, true);
    const text = r?.result?.content?.[0]?.text || "";
    check("返回里含分步结果（前面步骤没丢）", text.includes("检测栈"), true);
    check("该步标记为失败", text.includes("写入失败"), true);
    check("后续步骤仍执行了", text.includes("git info/exclude"), true);
    check("用户原内容未被改动", readFileSync(p, "utf-8").includes("原有内容"), true);
  }
  try { chmodSync(p, 0o666); } catch { /* ignore */ }
}

// ── 2. CLAUDE.md 是符号链接：绝不跟随写入 ──
{
  const base = mkdtempSync(join(tmpdir(), "sym-cmd-"));
  const dir = join(base, "proj");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const outside = join(base, "OUTSIDE.md");
  const original = "# 项目外的用户文件\n重要内容\n";
  writeFileSync(outside, original);
  let linked = false;
  try {
    symlinkSync(outside, join(dir, "CLAUDE.md"));
    linked = true;
  } catch {
    console.log("  skip 用例2 无法创建符号链接（需开发者模式或管理员权限）");
  }

  if (linked) {
    await callInit(dir);
    const after = readFileSync(outside, "utf-8");
    check("符号链接目标未被追加托管片段", after.includes("project-init:begin"), false);
    check("符号链接目标内容字节未变", after, original);
  }
}

// ── 3. 只读 exclude：应返回错误结果，不丢分步结果 ──
{
  const dir = mkdtempSync(join(tmpdir(), "ro-ex-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  const ex = join(dir, ".git", "info", "exclude");
  writeFileSync(ex, "");
  let ro = true;
  try {
    chmodSync(ex, 0o444);
  } catch {
    ro = false;
    console.log("  skip 用例3 无法设置只读属性");
  }

  if (ro) {
    const r = await callInit(dir);
    check("只读 exclude 返回 result 而非 error", r?.result !== undefined, true);
    const text = r?.result?.content?.[0]?.text || "";
    check("exclude 步骤标记为失败", text.includes("写入失败"), true);
    check("前面的步骤结果仍在", text.includes("检测栈"), true);
  }
  try { chmodSync(ex, 0o666); } catch { /* ignore */ }
}

// ── 4. TRACKED 文件（AGENTS.md 等）是符号链接 → 不读不写不删 ──
// 否则还原会穿透写到链接目标，那是项目外的文件。
{
  const base = mkdtempSync(join(tmpdir(), "sym-tracked-"));
  const dir = join(base, "proj");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const outside = join(base, "OUTSIDE-AGENTS.md");
  const original = "# 项目外的重要文件\n不要动我\n";
  writeFileSync(outside, original);

  let linked = false;
  try {
    symlinkSync(outside, join(dir, "AGENTS.md"), "file");
    linked = true;
  } catch {
    console.log("  skip 用例4 无法创建文件符号链接");
  }

  if (linked) {
    const r = await callInit(dir, { aociArtifacts: "off" });
    const text = r?.result?.content?.[0]?.text || "";
    check("符号链接的 AGENTS.md 未被删除", existsSync(join(dir, "AGENTS.md")), true);
    check("链接目标的字节未变", readFileSync(outside, "utf-8"), original);
    check("aoci 步骤明确说明因链接跳过",
      /"step": "初始化 aoci-code"[\s\S]{0,300}符号链接/.test(text), true);
  }
}

// ── 6. .codegraph/ 是符号链接 → CodeGraph 整步跳过 ──
{
  const base = mkdtempSync(join(tmpdir(), "sym-codegraph-"));
  const dir = join(base, "proj");
  const outside = join(base, "outside-cg");
  mkdirSync(dir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });

  let linked = false;
  try {
    symlinkSync(outside, join(dir, ".codegraph"), "junction");
    linked = true;
  } catch {
    console.log("  skip 用例6 无法创建 junction");
  }

  if (linked) {
    const before = readdirSync(outside).slice();
    const r = await callInit(dir);
    const text = r?.result?.content?.[0]?.text || "";
    check("CodeGraph 步骤明确说明因链接跳过",
      /"step": "初始化 CodeGraph"[\s\S]{0,300}符号链接/.test(text), true);
    check("链接目标未被写入", readdirSync(outside).length, before.length);
  }
}

// ── 5. .project-init/ 是符号链接 → 备份与清单都不能写到项目外 ──
{
  const base = mkdtempSync(join(tmpdir(), "sym-projinit-"));
  const dir = join(base, "proj");
  const outside = join(base, "outside");
  mkdirSync(dir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  writeFileSync(join(dir, "CLAUDE.md"), "# 用户内容\n");

  let linked = false;
  try {
    symlinkSync(outside, join(dir, ".project-init"), "junction");
    linked = true;
  } catch {
    console.log("  skip 用例5 无法创建 junction");
  }

  if (linked) {
    const before = readdirSync(outside).slice();
    await callInit(dir, { aociArtifacts: "off" });
    const after = readdirSync(outside);
    check("项目外未被写入备份或清单", after.length, before.length);
  }
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
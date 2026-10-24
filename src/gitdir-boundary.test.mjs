// gitdir 路径穿越的回归测试。
// .git 与 commondir 的内容都写在仓库里，恶意仓库能让它们指向项目外的任意 .git，
// 在 A 项目跑初始化就会把排除规则写进 B 仓库的 .git/info/exclude。
// ponytail: 改 resolveGitDir / hasTrustedLayout / insideWorkTree 后跑一次。
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "server.js");

function callProjectInit(projectPath, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("超时"));
    }, 90000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 1) continue;
        clearTimeout(timer);
        child.kill();
        resolve(msg);
        return;
      }
    });
    child.on("error", reject);
    child.stdin.write(
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

// ── 用例1：恶意 gitdir 指向项目外 → 必须拒绝写入 ──
{
  const base = mkdtempSync(join(tmpdir(), "gd-evil-"));
  const evil = join(base, "evil");
  const victim = join(base, "victim");
  mkdirSync(join(victim, ".git", "info"), { recursive: true });
  writeFileSync(join(victim, ".git", "HEAD"), "ref: refs/heads/main");
  mkdirSync(evil, { recursive: true });
  // 恶意 gitdir —— 指向项目外的合法仓库，但没有 worktree 的 commondir 布局
  writeFileSync(join(evil, ".git"), `gitdir: ${victim.replace(/\\/g, "/")}/.git`);

  await callProjectInit(evil);
  const excl = join(victim, ".git", "info", "exclude");
  const leaked =
    existsSync(excl) && readFileSync(excl, "utf-8").includes("added by project-init MCP");
  check("用例1 恶意 gitdir 未污染受害仓库", leaked, false);
}

// ── 用例2：正常 worktree → 必须仍然能写入 common dir ──
{
  const base = mkdtempSync(join(tmpdir(), "gd-wt-"));
  const main = join(base, "main");
  mkdirSync(main, { recursive: true });
  execFileSync("git", ["init", "-q", main], { stdio: "ignore" });
  const wt = join(base, "wt");
  execFileSync("git", ["worktree", "add", "-q", wt], { cwd: main, stdio: "ignore" });

  const r = await callProjectInit(wt);
  const text = r?.result?.content?.[0]?.text || "";
  check("用例2 worktree 未被误判为非 git 仓库", text.includes('"reason": "非 git 仓库"'), false);

  // 排除规则必须落在主仓库的 .git/info/exclude（git 实际读取的位置）
  const commonExcl = join(main, ".git", "info", "exclude");
  const inCommon =
    existsSync(commonExcl) && readFileSync(commonExcl, "utf-8").includes("added by project-init MCP");
  check("用例2 规则写进 common dir（worktree 私有目录没有 info/）", inCommon, true);
}

// ── 用例3：普通仓库不受影响 ──
{
  const dir = mkdtempSync(join(tmpdir(), "gd-plain-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  await callProjectInit(dir);
  const excl = join(dir, ".git", "info", "exclude");
  check(
    "用例3 普通仓库正常写入 exclude",
    existsSync(excl) && readFileSync(excl, "utf-8").includes("added by project-init MCP"),
    true
  );
}

// ── 用例4：真实 submodule → 必须能写入（其 gitdir 无 commondir 但有 HEAD）──
{
  const base = mkdtempSync(join(tmpdir(), "gd-sm-"));
  const main = join(base, "main");
  const child = join(base, "child");
  mkdirSync(main, { recursive: true });
  mkdirSync(child, { recursive: true });
  execFileSync("git", ["init", "-q", main], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", child], { stdio: "ignore" });
  writeFileSync(join(child, "f.txt"), "hello");
  execFileSync("git", ["add", "."], { cwd: child, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "i"],
    { cwd: child, stdio: "ignore" });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub"],
    { cwd: main, stdio: "ignore" });

  const sm = join(main, "sub");
  if (existsSync(join(sm, ".git"))) {
    const r = await callProjectInit(sm);
    const text = r?.result?.content?.[0]?.text || "";
    check("用例4 submodule 未被误判为非 git 仓库", text.includes('"reason": "非 git 仓库"'), false);
    const smExcl = join(main, ".git", "modules", "sub", "info", "exclude");
    check("用例4 submodule 排除项写进自己的 gitdir",
      existsSync(smExcl) && readFileSync(smExcl, "utf-8").includes("added by project-init MCP"), true);
  } else {
    console.log("  skip 用例4 环境未生成 submodule");
  }
}

// ── 用例5：用户自己写了同名标记行 → 回收时不能被误删 ──
// 标记是下次回收的唯一依据。历史遗留或用户照抄导致出现第二个标记行时，
// 全文正则会把它一起删掉，那个块里的条目就永久失去回收能力。
{
  const dir = mkdtempSync(join(tmpdir(), "gd-mark-"));
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(
    join(dir, ".git", "info", "exclude"),
    [
      "# 我的个人排除",
      "secrets.env",
      "",
      "# added by project-init MCP",
      ".codegraph/",
      ".remember/",
      "",
      "# added by project-init MCP",
      "# 这行是我自己加的同名标记",
      "my-secret.txt",
      "",
    ].join("\n")
  );

  await callProjectInit(dir, { gitExclude: false });
  const after = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
  check("用例5 托管条目已回收", after.includes(".codegraph/"), false);
  check("用例5 用户手写行存活", after.includes("secrets.env"), true);
  check("用例5 用户自己写的同名标记未被误删",
    after.includes("# 这行是我自己加的同名标记") && after.includes("my-secret.txt"), true);
  check("用例5 用户标记仍在（可继续被识别）",
    (after.match(/# added by project-init MCP/g) || []).length, 1);
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
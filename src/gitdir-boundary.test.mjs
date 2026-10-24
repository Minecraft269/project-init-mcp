// gitdir 路径穿越的回归测试。
// .git 与 commondir 的内容都写在仓库里，恶意仓库能让它们指向项目外的任意 .git，
// 在 A 项目跑初始化就会把排除规则写进 B 仓库的 .git/info/exclude。
// ponytail: 改 resolveGitDir / hasTrustedLayout / insideWorkTree 后跑一次。
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, linkSync } from "fs";
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

// ── 用例6：.git 是符号链接指向项目外的仓库 → 必须拒绝，不能写进受害仓库 ──
// 正常的 .git 是目录（普通仓库）或文件（worktree/submodule 指针），不会是链接。
// 链接可指向任意位置，跟随它就会把 A 项目的排除规则写进 B 仓库。
{
  const base = mkdtempSync(join(tmpdir(), "gd-dirlink-"));
  const victim = join(base, "victim");
  const proj = join(base, "proj");
  mkdirSync(join(victim, ".git", "info"), { recursive: true });
  writeFileSync(join(victim, ".git", "HEAD"), "ref: refs/heads/main");
  mkdirSync(proj, { recursive: true });

  let linked = false;
  try {
    symlinkSync(join(victim, ".git"), join(proj, ".git"), "junction");
    linked = true;
  } catch {
    console.log("  skip 用例6 无法创建目录链接（需开发者模式或管理员权限）");
  }

  if (linked) {
    const r = await callProjectInit(proj);
    const text = r?.result?.content?.[0]?.text || "";
    check("用例6 明确报告 .git 是链接", text.includes(".git 是符号链接"), true);
    const excl = join(victim, ".git", "info", "exclude");
    const leaked =
      existsSync(excl) && readFileSync(excl, "utf-8").includes("added by project-init MCP");
    check("用例6 受害仓库未被写入", leaked, false);
  }
}

// ── 用例7：伪造 submodule 布局（只有 modules 目录名）→ 必须拒绝 ──
// 判据要求完整的 `.git/modules/` 段；光有 "modules" 目录名谁都能造。
{
  const base = mkdtempSync(join(tmpdir(), "gd-fakesub-"));
  const fake = join(base, "unrelated", "modules", "pkg", ".git");
  const proj = join(base, "proj");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(fake, "config"), "[core]\n");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, ".git"), `gitdir: ${fake.replace(/\\/g, "/")}`);

  const r = await callProjectInit(proj);
  const text = r?.result?.content?.[0]?.text || "";
  check("用例7 伪造 submodule 被判为非 git 仓库", text.includes("非 git 仓库"), true);
  const excl = join(fake, "info", "exclude");
  const leaked =
    existsSync(excl) && readFileSync(excl, "utf-8").includes("added by project-init MCP");
  check("用例7 无关目录未被写入", leaked, false);
}

// ── 用例8：路径字符串满足 submodule 判据，但那一层是符号链接 → 必须拒绝 ──
// resolve() 只做字符串归一化，不解链接。若不 realpath，
// `proj/x/.git/modules/pkg` 指向 victim 也能通过 "/.git/modules/" 判据。
{
  const base = mkdtempSync(join(tmpdir(), "gd-linkbypass-"));
  const victim = join(base, "victim");
  const proj = join(base, "proj");
  mkdirSync(join(victim, ".git", "info"), { recursive: true });
  writeFileSync(join(victim, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(victim, ".git", "config"), "[core]\n");

  const shaped = join(proj, "x", ".git", "modules");
  mkdirSync(shaped, { recursive: true });

  let linked = false;
  try {
    symlinkSync(join(victim, ".git"), join(shaped, "pkg"), "junction");
    linked = true;
  } catch {
    console.log("  skip 用例8 无法创建 junction");
  }

  if (linked) {
    writeFileSync(join(proj, ".git"), `gitdir: ${join(shaped, "pkg").replace(/\\/g, "/")}`);
    const r = await callProjectInit(proj);
    const text = r?.result?.content?.[0]?.text || "";
    check("用例8 链接伪装的 submodule 被拒绝", text.includes("非 git 仓库"), true);
    const excl = join(victim, ".git", "info", "exclude");
    const leaked =
      existsSync(excl) && readFileSync(excl, "utf-8").includes("added by project-init MCP");
    check("用例8 受害仓库未被写入", leaked, false);
  }
}

// ── 用例9：.git/info 或 .git/info/exclude 是符号链接 → 拒绝写入 ──
{
  const base = mkdtempSync(join(tmpdir(), "gd-infolink-"));
  const dir = join(base, "proj");
  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(outside, "exclude"), "# 项目外\n");

  let linked = false;
  try {
    // junction 只能指向目录：把 .git/info 指向项目外的 outside 目录
    symlinkSync(outside, join(dir, ".git", "info"), "junction");
    linked = true;
  } catch {
    console.log("  skip 用例9 无法创建 junction");
  }

  if (linked) {
    const r = await callProjectInit(dir);
    const text = r?.result?.content?.[0]?.text || "";
    check("用例9 info 是链接时明确跳过", text.includes(".git/info 是符号链接"), true);
    check("用例9 项目外文件未被写入",
      readFileSync(join(outside, "exclude"), "utf-8").includes("project-init MCP"), false);
  }
}

// ── 用例10：断链的 info/exclude 符号链接 → 目标不能被创建/写入 ──
// existsSync 对断链返回 false，若先用它判断，保护会被跳过，
// 随后 writeFileSync 会跟随断链把目标创建到项目外。
{
  const base = mkdtempSync(join(tmpdir(), "gd-dangling-"));
  const dir = join(base, "proj");
  const target = join(base, "victim-created-by-write");
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main");

  let linked = false;
  try {
    symlinkSync(target, join(dir, ".git", "info", "exclude"), "file");
    linked = true;
  } catch {
    console.log("  skip 用例10 无法创建符号链接");
  }

  if (linked) {
    const r = await callProjectInit(dir);
    const text = r?.result?.content?.[0]?.text || "";
    check("用例10 断链被识别为符号链接", text.includes("符号链接"), true);
    check("用例10 项目外目标未被创建", existsSync(target), false);
  }
}

// ── 用例11：commondir 指向外部任意仓库 → 必须拒绝 ──
// 只校验"有 commondir + 目标有 HEAD"太松：外部目录造个 commondir 就能写进别的仓库。
// 真 worktree 的私有目录必须落在 <repo>/.git/worktrees/<name>。
{
  const base = mkdtempSync(join(tmpdir(), "gd-commondir-"));
  const victim = join(base, "victim");
  const fake = join(base, "fake-private");
  const proj = join(base, "proj");
  mkdirSync(join(victim, ".git", "info"), { recursive: true });
  writeFileSync(join(victim, ".git", "HEAD"), "ref: refs/heads/main");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(fake, "commondir"), join(victim, ".git"));
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, ".git"), `gitdir: ${fake.replace(/\\/g, "/")}`);

  const r = await callProjectInit(proj);
  const text = r?.result?.content?.[0]?.text || "";
  check("用例11 外部伪 worktree 被拒绝", text.includes("非 git 仓库"), true);
  const excl = join(victim, ".git", "info", "exclude");
  const leaked =
    existsSync(excl) && readFileSync(excl, "utf-8").includes("added by project-init MCP");
  check("用例11 受害仓库未被写入", leaked, false);
}

// ── 用例12：.git 指向项目内的嵌套仓库 → 不能写进嵌套仓库 ──
// 之前的 insideWorkTree 短路会让"项目内"直接放行，A 的规则写进 vendor/B。
{
  const base = mkdtempSync(join(tmpdir(), "gd-nested-"));
  const proj = join(base, "proj");
  const nested = join(proj, "vendor", "B");
  mkdirSync(join(nested, ".git", "info"), { recursive: true });
  writeFileSync(join(nested, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(proj, ".git"), `gitdir: ${join(nested, ".git").replace(/\\/g, "/")}`);

  const r = await callProjectInit(proj);
  const text = r?.result?.content?.[0]?.text || "";
  check("用例12 嵌套仓库被拒绝", text.includes("非 git 仓库"), true);
  const excl = join(nested, ".git", "info", "exclude");
  const leaked =
    existsSync(excl) && readFileSync(excl, "utf-8").includes("added by project-init MCP");
  check("用例12 嵌套仓库未被写入", leaked, false);
}

// ── 用例13：info/exclude 是硬链接 → 拒绝写入（会改到另一路径的同一份数据）──
{
  const base = mkdtempSync(join(tmpdir(), "gd-hardlink-"));
  const dir = join(base, "proj");
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
  const outside = join(base, "outside-exclude");
  writeFileSync(outside, "# 项目外\n");

  let linked = false;
  try {
    linkSync(outside, join(dir, ".git", "info", "exclude"));
    linked = true;
  } catch {
    console.log("  skip 用例13 无法创建硬链接");
  }

  if (linked) {
    const r = await callProjectInit(dir);
    const text = r?.result?.content?.[0]?.text || "";
    check("用例13 硬链接被识别", text.includes("硬链接"), true);
    check("用例13 目标未被写入",
      readFileSync(outside, "utf-8").includes("project-init MCP"), false);
  }
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
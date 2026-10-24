// 离线回归：清单为空时应删文件、清单非空时应写文件。
// 真实调用走 MCP stdio 会跑着旧进程（MCP 不会热重载 server.js），
// 所以这里直接 spawn 新进程、灌 JSON-RPC 打到真实 server 上。
// ponytail: 改动 writeManifest / readManifest 后跑一次。
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "server.js");
const MANIFEST = ".project-init/project-init-manifest.json";

function callProjectInit(projectPath, args) {
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
        if (msg.id !== 1) continue; // 忽略 initialize 握手等噪声
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
        params: { name: "project_init", arguments: { projectPath, ...args } },
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

// CI 上没有 aoci —— 依赖"aoci 会生成产物"的用例跳过而非失败。
// 这些用例测的是本工具对 aoci 产物的处理，aoci 不在时前提不成立。
const aociMissing = (r) =>
  /"step": "初始化 aoci-code"[\s\S]{0,400}找不到 aoci/.test(
    r?.result?.content?.[0]?.text || ""
  );

// ── 用例1：旧格式清单（无指纹）→ 本轮新建的产物照删，但清单不能被"升级"成授权 ──
// 清单声称拥有 AGENTS.md/.gitattributes，但两者都不存在。aoci init 会把它们造出来，
// 这些文件 100% 由 aoci 生成，off 该删。关键是删除之后清单不能留下任何
// "用户文件归本工具所有"的授权 —— 否则下一轮就会删掉用户后来写进去的内容。
{
  const dir = mkdtempSync(join(tmpdir(), "man-empty-"));
  mkdirSync(join(dir, ".project-init"), { recursive: true });
  writeFileSync(join(dir, MANIFEST), JSON.stringify({ created: ["AGENTS.md", ".gitattributes"] }));
  const r = await callProjectInit(dir, { mode: "incremental", aociArtifacts: "off" });
  check("用例1 调用成功", r?.result?.content?.[0]?.text?.includes("初始化完成"), true);
  if (aociMissing(r)) {
    console.log("  skip 用例1 其余断言：aoci 不可用");
  } else {
    // 本轮由 aoci 新建的产物，off 当场清掉（不必等第二轮）
    check("用例1 本轮新建的产物被清理", existsSync(join(dir, "AGENTS.md")), false);
    // 清单要么被删、要么每条 sha 都是 null —— 绝不能留下可删的真实指纹
    const mp = join(dir, MANIFEST);
    if (existsSync(mp)) {
      const m = JSON.parse(readFileSync(mp, "utf-8"));
      check("用例1 残留清单的指纹全为 null", m.created.every((e) => e.sha === null), true);
    } else {
      check("用例1 残留清单的指纹全为 null（清单已清除）", true, true);
    }
  }
}

// ── 用例2：清单里的文件用户手写过 → 绝不能删 ──
{
  const dir = mkdtempSync(join(tmpdir(), "man-stale-"));
  mkdirSync(join(dir, ".project-init"), { recursive: true });
  writeFileSync(join(dir, MANIFEST), JSON.stringify({ created: [".gitattributes"] }));
  writeFileSync(join(dir, "AGENTS.md"), "# 用户手写\n团队规范\n");
  const r = await callProjectInit(dir, { mode: "incremental", aociArtifacts: "off" });
  check("用例2 调用成功", r?.result?.content?.[0]?.text?.includes("初始化完成"), true);
  check("用例2 用户手写 AGENTS.md 存活", existsSync(join(dir, "AGENTS.md")), true);
  check("用例2 内容未被篡改", readFileSync(join(dir, "AGENTS.md"), "utf-8").includes("团队规范"), true);
}

// ── 用例5：on → off 往返，本工具造且用户没改过的产物应被真正删掉 ──
{
  const dir = mkdtempSync(join(tmpdir(), "man-roundtrip-"));
  // aoci init 要求 git 仓库，否则不生成 AGENTS.md/.gitattributes
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  // 第一轮：on，创建产物并记下指纹
  const r1 = await callProjectInit(dir, { mode: "incremental", aociArtifacts: "on" });
  const afterOn = existsSync(join(dir, "AGENTS.md"));
  // 第二轮：off，用户没动过 -> 该删
  await callProjectInit(dir, { mode: "incremental", aociArtifacts: "off" });
  if (aociMissing(r1)) {
    console.log("  skip 用例5：aoci 不可用，无法验证 on→off 往返");
  } else {
    check("用例5 首轮 on 创建了 AGENTS.md", afterOn, true);
    check("用例5 切 off 后本工具造的产物被删除", existsSync(join(dir, "AGENTS.md")), false);
    check("用例5 切 off 后 .gitattributes 被删除", existsSync(join(dir, ".gitattributes")), false);
  }
}

// ── 用例6：on → off，但用户改过产物 → 绝不删除 ──
{
  const dir = mkdtempSync(join(tmpdir(), "man-usertouched-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  await callProjectInit(dir, { mode: "incremental", aociArtifacts: "on" });
  // 用户在 AGENTS.md 里加了自己的内容
  writeFileSync(join(dir, "AGENTS.md"), "# 我改过了\n这是我的内容\n");
  await callProjectInit(dir, { mode: "incremental", aociArtifacts: "off" });
  check("用例6 用户改过的 AGENTS.md 存活", existsSync(join(dir, "AGENTS.md")), true);
  check("用例6 用户内容未被覆盖",
    readFileSync(join(dir, "AGENTS.md"), "utf-8").includes("这是我的内容"), true);
}

// ── 用例3：坏路径应明确报错，而不是抛 ENOENT 中断整个调用 ──
{
  const missing = join(tmpdir(), "definitely-not-here-" + Date.now());
  const r = await callProjectInit(missing, { mode: "incremental" });
  const text = r?.result?.content?.[0]?.text || "";
  check("用例3 坏路径返回错误而非抛异常", r?.result?.isError, true);
  check("用例3 错误信息含路径", text.includes(missing), true);
  check("用例3 没有创建任何文件", existsSync(missing), false);
}

// ── 用例4：路径是文件而非目录时应报错 ──
{
  const dir = mkdtempSync(join(tmpdir(), "man-notdir-"));
  const file = join(dir, "iam-a-file.txt");
  writeFileSync(file, "x");
  const r = await callProjectInit(file, { mode: "incremental" });
  check("用例4 文件路径返回错误", r?.result?.isError, true);
}

// ── 用例7：GBK 编码的 CLAUDE.md 必须字节级不动 ──
// 中文 Windows 项目的 CLAUDE.md 常带 GBK 注释。按 utf-8 解码会产生 U+FFFD
// 且不可逆 —— 托管片段按字节切位置再拼字符串，写回时用户原文就毁了。
// 实测 15 字节 GBK 往返后变 31 字节。
{
  const dir = mkdtempSync(join(tmpdir(), "man-gbk-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  // GBK 的"中文测试:\n" —— 故意用非 UTF-8 字节序列
  const gbk = Buffer.from([
    0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x3a, 0x0a,
    0x6b, 0x69, 0x64, 0x73, 0x0a,
  ]);
  writeFileSync(join(dir, "CLAUDE.md"), gbk);
  const before = readFileSync(join(dir, "CLAUDE.md"));

  const r = await callProjectInit(dir, { mode: "incremental" });
  const text = r?.result?.content?.[0]?.text || "";
  check("用例7 GBK 文件被识别并跳过", text.includes("非 UTF-8"), true);
  check("用例7 原始字节完全不变", readFileSync(join(dir, "CLAUDE.md")).equals(before), true);
}

// ── 用例8：GBK 的 .gitignore 字节级还原 ──
// .gitignore 走 Buffer 快照路径，aoci init 追加规则触发还原分支。
// 若用 utf-8 字符串还原，中文注释会被改坏 —— 而这是团队共享文件。
{
  const dir = mkdtempSync(join(tmpdir(), "man-gbki-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const gbki = Buffer.from([
    0x2a, 0x2a, 0x0a,
    0xb4, 0xf3, 0xd7, 0xd6, 0xb5, 0xb5, 0x0a,   // GBK 注释
    0x6e, 0x6f, 0x64, 0x65, 0x5f, 0x0a,
  ]);
  writeFileSync(join(dir, ".gitignore"), gbki);
  const before = readFileSync(join(dir, ".gitignore"));

  await callProjectInit(dir, { mode: "incremental" });
  check("用例8 GBK .gitignore 字节级不变",
    readFileSync(join(dir, ".gitignore")).equals(before), true);
}

// ── 用例9：用户改过产物后连续 off，用户内容永不被删（数据丢失回归）──
// 曾经的 bug：指纹在函数末尾被无条件重算，把用户改过的内容当成"工具造的"记进清单，
// 下一轮 off 认为"用户没动过" → rmSync 删掉用户手写的规范。实测三轮后文件消失。
{
  const dir = mkdtempSync(join(tmpdir(), "man-useredit-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  await callProjectInit(dir, { mode: "incremental", aociArtifacts: "on" });

  const p = join(dir, "AGENTS.md");
  if (!existsSync(p)) {
    console.log("  skip 用例9 环境未生成 AGENTS.md");
  } else {
    writeFileSync(p, "# 团队规范：PR 需两人评审\n" + readFileSync(p, "utf-8"));
    // 连续三轮 off —— 每轮都会走一遍清单写入
    for (let i = 0; i < 3; i++) {
      await callProjectInit(dir, { mode: "incremental", aociArtifacts: "off" });
      if (!existsSync(p)) break;
    }
    check("用例9 用户改过的 AGENTS.md 未被删除", existsSync(p), true);
    check("用例9 用户内容完整保留",
      existsSync(p) && readFileSync(p, "utf-8").includes("两人评审"), true);
    // 断言清单本身的状态：用户内容一旦被记成"工具造的"指纹，下一轮就会删用户数据。
    // 只断言文件存活看不出这个 —— 必须直接检查 sha 是不是被抹成了 null。
    const mp9 = join(dir, ".project-init", "project-init-manifest.json");
    if (existsSync(mp9)) {
      const m9 = JSON.parse(readFileSync(mp9, "utf-8"));
      const ag = m9.created.find((e) => e.name === "AGENTS.md");
      check("用例9 清单里 AGENTS.md 的指纹已抹为 null（不可删）", ag ? ag.sha === null : true, true);
    } else {
      check("用例9 清单里 AGENTS.md 的指纹已抹为 null（清单已清除）", true, true);
    }
  }
}

// ── 用例10：用户没改过的产物，on→off 仍要真删（指纹机制没被修坏）──
{
  const dir = mkdtempSync(join(tmpdir(), "man-roundtrip2-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const r1 = await callProjectInit(dir, { mode: "incremental", aociArtifacts: "on" });
  const made = existsSync(join(dir, "AGENTS.md"));
  await callProjectInit(dir, { mode: "incremental", aociArtifacts: "off" });
  if (aociMissing(r1)) {
    console.log("  skip 用例10：aoci 不可用");
  } else {
    check("用例10 首轮 on 创建了 AGENTS.md", made, true);
    check("用例10 用户没改过 → 切 off 真删", existsSync(join(dir, "AGENTS.md")), false);
    // 与用例9 互为对照：用户没改过时，指纹必须被保留（非 null），否则就是
    // 把功能修成了"永不删除"。两个用例必须同时成立。
    const mp10 = join(dir, ".project-init", "project-init-manifest.json");
    if (existsSync(mp10)) {
      const m10 = JSON.parse(readFileSync(mp10, "utf-8"));
      check("用例10 删除后清单不含残留的 AGENTS.md",
        !m10.created.some((e) => e.name === "AGENTS.md"), true);
    } else {
      check("用例10 删除后清单不含残留的 AGENTS.md（清单已清除）", true, true);
    }
  }
}

// ── 用例11：首次就传 off → 本轮造的产物当场清掉，不等第二轮 ──
{
  const dir = mkdtempSync(join(tmpdir(), "man-firstoff-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  await callProjectInit(dir, { mode: "incremental", aociArtifacts: "off" });
  check("用例11 首轮 off 即清掉 AGENTS.md", existsSync(join(dir, "AGENTS.md")), false);
  check("用例11 首轮 off 即清掉 .gitattributes", existsSync(join(dir, ".gitattributes")), false);
  check("用例11 首轮 off 即清掉 .gitignore", existsSync(join(dir, ".gitignore")), false);
}

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
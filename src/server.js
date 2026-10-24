// Project Init MCP Server
// 自动化项目初始化：检测栈、配置工具、建立索引

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, lstatSync, realpathSync, rmSync, readdirSync } from "fs";
import { join, basename, resolve, dirname } from "path";

// ============ 工具函数 ============

// ============ 外部依赖解析 ============
//
// 硬编码绝对路径会让这个工具只在某一台机器上能跑。解析顺序：
//   1. 环境变量（MCP 注册时用 `claude mcp add -e NAME=value` 配）
//   2. PATH 查找
//   3. 常见安装位置（仅 Git Bash 这种有公认默认值的）
// 都找不到就**跳过对应步骤并给出可操作提示** —— 绝不猜一个不存在的路径去执行。
const ENV_BASH = "PROJECT_INIT_BASH";
const ENV_AOCI = "PROJECT_INIT_AOCI_BIN";
const ENV_CODEGRAPH = "PROJECT_INIT_CODEGRAPH_JS";

// Git for Windows 的标准安装位置。这是平台约定，不是某个用户的私有路径。
const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

function resolveBash() {
  if (process.env[ENV_BASH]) return process.env[ENV_BASH];
  for (const p of GIT_BASH_CANDIDATES) if (existsSync(p)) return p;
  // 兜底交给 PATH。裸 "bash" 在 Windows 可能解析到 WSL 启动器，
  // 但 Git 没装的情况下没有更好的选择 —— run() 会捕获失败并如实回报。
  return "bash";
}

const BASH_PATH = resolveBash();

// 在 PATH 里找一个可执行文件。找不到返回 null。
//
// Windows 优先用 where.exe —— 它认 PATHEXT，能找到 .cmd/.exe；
// Git Bash 的 `command -v` 只看无扩展名的可执行文件，找不到 .cmd。
function whichOnPath(name) {
  if (process.platform === "win32") {
    try {
      const r = execSync(`where.exe ${name}`, {
        encoding: "utf-8",
        timeout: 5000,
        shell: BASH_PATH,
      });
      const p = r
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (p) return p;
    } catch {
      // 落到 command -v 再试一次
    }
  }
  try {
    const r = execSync(`command -v ${name}`, {
      encoding: "utf-8",
      timeout: 5000,
      shell: BASH_PATH,
    });
    const p = r.trim();
    return p || null;
  } catch {
    return null;
  }
}

// 解析外部工具：环境变量 > PATH > null（调用方负责给出可操作提示）
function resolveTool(envName, commandName) {
  if (process.env[envName]) return process.env[envName];
  return whichOnPath(commandName);
}

function run(cmd, options = {}) {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: options.timeout || 30000,
      cwd: options.cwd || process.cwd(),
      shell: BASH_PATH,
    });
    return { success: true, output: result.trim() };
  } catch (error) {
    return { success: false, output: error.message };
  }
}

// ============ 检测项目栈 ============

// 探测技术栈。宁可漏判也不误判 —— buildManagedSection 依赖它生成命令，
// 误判会写出跑不起来的命令（比"待补充"糟得多）。
function detectStack(projectPath) {
  const stacks = [];
  const has = (rel) => existsSync(join(projectPath, rel));
  // readdirSync 对无读权限的目录会抛。detectStack 是纯探测，
  // 不该有能力中断整个 project_init —— 扫不到就当没有这个技术栈。
  let files = [];
  try {
    files = readdirSync(projectPath);
  } catch {
    // 目录不可读就只用 has() 那几个显式判断
  }
  // 读 package.json 里的 scripts —— 只有真的有那个 script 才算"能构建/能测试"
  let pkgScripts = {};

  if (has("package.json")) {
    // 畸形 package.json 不该炸穿整个 project_init —— 解析失败只跳过依赖嗅探。
    try {
      const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf-8"));
      if (pkg.scripts && typeof pkg.scripts === "object") pkgScripts = pkg.scripts;
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.react) stacks.push("react");
      if (deps.next) stacks.push("nextjs");
      if (deps.vue) stacks.push("vue");
      if (deps.express) stacks.push("express");
      if (deps.typescript) stacks.push("typescript");
      stacks.push("nodejs");
    } catch {
      // 文件存在但解析不了，仍算 nodejs 项目
      stacks.push("nodejs");
    }
  }
  if (has("tsconfig.json")) stacks.push("typescript");
  if (has("deno.json") || has("deno.jsonc")) stacks.push("deno");
  if (has("bun.lock") || has("bun.lockb")) stacks.push("bun");

  // Python
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) stacks.push("python");
  if (has("pytest.ini") || has("tox.ini")) pkgScripts.pythonTest = "pytest";
  if (has("Pipfile") || has("poetry.lock")) stacks.push("poetry");

  // Go
  if (has("go.mod")) stacks.push("go");

  // Rust / Java / .NET / Scala
  if (has("Cargo.toml")) stacks.push("rust");
  if (has("pom.xml")) stacks.push("java", "maven");
  if (has("build.gradle") || has("build.gradle.kts")) stacks.push("java", "gradle");
  if (has("build.sbt")) stacks.push("scala");
  if (files.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) stacks.push("csharp");
  if (files.some((f) => f.endsWith(".fsproj"))) stacks.push("fsharp");

  // PHP / Ruby
  if (has("composer.json")) stacks.push("php");
  if (has("Gemfile")) stacks.push("ruby");

  // Next.js 独立判一次 —— 配置文件比依赖字段可靠
  if (has("next.config.js") || has("next.config.mjs") || has("next.config.ts"))
    stacks.push("nextjs");

  return { stacks, pkgScripts };
}

// ============ 检测工具状态 ============

function checkToolStatus(projectPath) {
  return {
    claudeCode: existsSync(join(projectPath, "CLAUDE.md")),
    aociCode: existsSync(join(projectPath, ".aoci", "config.json")),
    codeGraph: existsSync(join(projectPath, ".codegraph")),
    openCodeReview: existsSync(join(projectPath, ".ocr", "config.json")),
  };
}

// ============ 初始化步骤 ============

// CLAUDE.md 里由本工具维护的片段。用成对标记圈起来，
// 补全时只替换标记内的内容，标记外的一律保留。
const CLAUDE_MD_BEGIN = "<!-- project-init:begin -->";
const CLAUDE_MD_END = "<!-- project-init:end -->";

// 本工具自己的工作目录。刻意与 aoci 的 .aoci/ 分开 ——
// aoci 把 .aoci/ 里除白名单外的一切都视为"它不认识的运行时资产"，
// 混在一起等于把我们的文件寿命押在 aoci 的实现细节上。
const PROJECT_INIT_DIR = ".project-init";

function buildManagedSection(projectPath) {
  const { stacks, pkgScripts } = detectStack(projectPath);
  const isNode = stacks.includes("nodejs") || stacks.includes("deno") || stacks.includes("bun");
  const isPy = stacks.includes("python");
  const isJava = stacks.includes("java") && (stacks.includes("maven") || stacks.includes("gradle"));

  // 只写有把握的命令。package.json 里没有 build script 就别写 npm run build ——
  // 写一条跑不起来的命令比写"待补充"糟：agent 会照着执行然后失败。
  const build = [];
  if (isNode && pkgScripts.build) build.push("npm run build");
  if (isPy && pkgScripts.pythonBuild) build.push("python -m build");
  if (stacks.includes("go")) build.push("go build ./...");
  if (stacks.includes("rust")) build.push("cargo build");
  if (isJava) build.push(stacks.includes("gradle") ? "./gradlew build" : "./mvnw package");
  if (stacks.includes("csharp")) build.push("dotnet build");

  const test = [];
  if (isNode && pkgScripts.test) test.push("npm test");
  if (isPy && pkgScripts.pythonTest) test.push("pytest");
  if (stacks.includes("go")) test.push("go test ./...");
  if (stacks.includes("rust")) test.push("cargo test");
  if (isJava) test.push(stacks.includes("gradle") ? "./gradlew test" : "./mvnw test");
  if (stacks.includes("csharp")) test.push("dotnet test");

  return [
    CLAUDE_MD_BEGIN,
    "## 项目栈",
    stacks.length > 0 ? stacks.join(", ") : "未检测到",
    "",
    "## 构建命令",
    build.length ? build.join(" / ") : "待补充",
    "",
    "## 测试命令",
    test.length ? test.join(" / ") : "待补充",
    CLAUDE_MD_END,
  ].join("\n");
}

// 增量补全：已有 CLAUDE.md 时只更新托管片段，绝不动用户写的内容。
// 不需要 force —— 托管片段每次都会对比，内容无变化就 skipped，技术栈变了自然刷新。
// 给一个不改变任何行为的参数比不给更糟：initCodeGraph 的 force 真在用
// （决定 init 还是 index），这个不响，下一个人会以为 full 对 CLAUDE.md
// 还有没找到的额外语义，白查半天。
function initClaudeCode(projectPath) {
  const claudeMdPath = join(projectPath, "CLAUDE.md");

  // CLAUDE.md 是符号链接时**绝不写入** —— 跟随链接会改到项目外的文件，
  // 那是用户自己的数据，我们没有任何理由碰它。
  if (isSymlink(claudeMdPath) || isHardLinked(claudeMdPath)) {
    return {
      skipped: true,
      reason: "CLAUDE.md 是符号链接或硬链接，未改动（写入会穿透到另一个文件）",
    };
  }

  if (!existsSync(claudeMdPath)) {
    // 写入必须包 try —— 只读文件/目录会抛 EPERM。未捕获时整个 project_init
    // 变成 JSON-RPC error，已经完成的步骤结果一并丢失，用户看不到任何分步信息。
    try {
      writeFileSync(claudeMdPath, `# ${basename(projectPath)}\n\n${buildManagedSection(projectPath)}\n`);
      return { success: true, message: "CLAUDE.md 已生成" };
    } catch (err) {
      return { success: false, message: `CLAUDE.md 写入失败：${err && err.message}` };
    }
  }

  let raw;
  let original;
  try {
    raw = readFileSync(claudeMdPath);
    original = raw.toString("utf-8");
  } catch (err) {
    return { success: false, message: `CLAUDE.md 读取失败：${err && err.message}` };
  }

  // 非 UTF-8 直接不动。托管片段要按字节切位置再拼字符串，解码不可逆的编码
  // （GBK 注释在中文 Windows 项目里是常态）会把用户原文改成乱码，而备份
  // 也是从这份已损坏的字符串写的 —— 原始字节两头都丢。宁可不改，不可改坏。
  if (original.includes("�")) {
    return { skipped: true, reason: "CLAUDE.md 非 UTF-8 编码，未改动（避免破坏原始字节）" };
  }

  // 行尾跟随原文件 —— 恒用 LF 会在 CRLF 项目里制造混合行尾的 diff 噪音。
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const section = buildManagedSection(projectPath).replace(/\n/g, eol);

  const b = original.indexOf(CLAUDE_MD_BEGIN);
  const e = original.indexOf(CLAUDE_MD_END);

  let next;
  let action;
  if (b !== -1 && e !== -1 && e > b) {
    // 已有托管片段 —— 只替换片段内内容
    next = original.slice(0, b) + section + original.slice(e + CLAUDE_MD_END.length);
    action = "CLAUDE.md 托管片段已刷新（原内容完整保留）";
  } else if (b === -1 && e === -1) {
    // 纯用户文档 —— 追加托管片段，原内容一字不动
    const tail = original.endsWith(eol + eol) ? "" : original.endsWith(eol) ? eol : eol + eol;
    next = original + tail + section + eol;
    action = "CLAUDE.md 已追加托管片段（原内容完整保留）";
  } else {
    // 标记不成对 —— 不擅自改用户文件
    return { skipped: true, reason: "CLAUDE.md 存在残缺的托管标记，未改动（请手动修复后重试）" };
  }

  // 比较时统一行尾，避免 CRLF 文件每次都被判定为"有变化"而重复写盘。
  if (next.replace(/\r\n/g, "\n") === original.replace(/\r\n/g, "\n")) {
    return { skipped: true, reason: "CLAUDE.md 已是最新" };
  }

  // 改动前备份 —— 用户的原内容要能找回来。
  // 目录或备份文件是符号链接时跳过：写入会穿透到项目外（已实测复现）。
  try {
    const bakDir = join(projectPath, PROJECT_INIT_DIR);
    const bakFile = join(bakDir, "CLAUDE.md.bak");
    if (!isSymlink(bakDir) && !isSymlink(bakFile) && !isHardLinked(bakFile)) {
      mkdirSync(bakDir, { recursive: true });
      writeFileSync(bakFile, raw);
    }
  } catch {
    // 备份失败不阻断（内容仍在文件里，只是没有历史副本）
  }

  try {
    writeFileSync(claudeMdPath, next);
    return { success: true, message: action };
  } catch (err) {
    // 只读文件抛 EPERM 时不能让它冒到顶层 —— 那会让整个 project_init
    // 变成 JSON-RPC error，前面已完成的步骤结果一并丢失。
    return { success: false, message: `CLAUDE.md 写入失败：${err && err.message}` };
  }
}

// 本工具创建过的文件清单。记文件名 + 内容指纹。
// 有了它才能区分"aoci 生成的"和"用户手写后被 aoci 追加了托管块的" —— 后者绝不能删。
// 指纹让 on→off 切换能真正删掉本工具造的产物：清单里有、且当前内容与指纹一致
// 才删；用户改过就只还原，绝不删除。
const PROJECT_INIT_MANIFEST = `${PROJECT_INIT_DIR}/project-init-manifest.json`;

function readManifest(projectPath) {
  const p = join(projectPath, PROJECT_INIT_MANIFEST);
  const empty = new Map();
  if (!existsSync(p)) return empty;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    if (!data || !Array.isArray(data.created)) return empty;
    const m = new Map();
    for (const item of data.created) {
      // 兼容两种格式：新式 {name, sha}，旧式纯字符串（无指纹，只能当"不知道是谁的"）
      if (typeof item === "string" && item.length > 0) m.set(item, null);
      else if (item && typeof item.name === "string" && item.name.length > 0) {
        m.set(item.name, typeof item.sha === "string" ? item.sha : null);
      }
    }
    return m;
  } catch {
    return empty;
  }
}

function writeManifest(projectPath, created) {
  const dir = join(projectPath, PROJECT_INIT_DIR);
  const p = join(projectPath, PROJECT_INIT_MANIFEST);
  // 本工具自己的目录/文件也可能是符号链接 —— 写入会穿透到项目外。
  // 清单不写不影响正确性：读不到清单 = 没有删除授权，安全侧。
  if (isSymlink(dir) || isSymlink(p) || isHardLinked(p)) return;
  try {
    // 空清单要删文件而不是跳过写 —— 否则磁盘上留着上一轮的旧清单，
    // 声称拥有已经删掉的文件。清单是删除权威，它一说谎将来就会删错东西。
    if (created.size === 0) {
      rmSync(p, { force: true });
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ created: [...created].map(([name, sha]) => ({ name, sha })) }, null, 2) + "\n"
    );
  } catch {
    // 写不进去也不能影响初始化
  }
}

// 从重组后的 next 里切出托管块的**条目部分**（不含标记行 ——
// prefix 已经写到标记行之后了，再带一次会写出两个标记）。
function nextManagedOnly(nextStr, hasBlock) {
  if (!hasBlock) return toAddOnly(nextStr);
  const lines = nextStr.split("\n");
  const start = lines.findIndex((l) => l.trim() === MANAGED_BLOCK_MARKER);
  if (start === -1) return toAddOnly(nextStr);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === MANAGED_BLOCK_MARKER) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

// 块原本不存在时，块内就只有本轮新增的条目
function toAddOnly() {
  return "";
}

// 字节层重写托管块：只替换块内的字节，块外原样保留。
// 用于 excludeRebuild:"on" + 非 UTF-8 的场景 —— 那时不能按字符串整体写回。
// 找不到块边界就返回 null，调用方据此放弃重写（宁可不改，不损坏）。
function rewriteManagedBlockBytes(raw, nextManaged) {
  const markerBuf = Buffer.from(MANAGED_BLOCK_MARKER, "utf-8");
  const at = raw.indexOf(markerBuf);
  if (at < 0) return null;
  const afterMarker = at + markerBuf.length;
  // 块边界 = 下一个标记行，或文件末尾（与 splitManagedBlock 同一规则）
  const nextMarker = raw.indexOf(markerBuf, afterMarker);
  let blockEnd;
  if (nextMarker >= 0) {
    // 回退到下一个标记行之前的那个换行，块内含尾随空行
    blockEnd = raw.lastIndexOf(0x0a, nextMarker) + 1;
  } else {
    blockEnd = raw.length;
  }
  if (blockEnd <= afterMarker) return null; // 块结构异常，放弃
  // nextManaged 含完整块内容（标记行 + 条目行），去掉尾部换行后拼
  const body = nextManaged.endsWith("\n") ? nextManaged.slice(0, -1) : nextManaged;
  const prefix = raw.slice(0, afterMarker);
  const suffix = raw.slice(blockEnd);
  // 块以换行结尾才和后缀衔接得上
  const tailNl = suffix.length === 0 || suffix[0] === 0x0a ? "" : "\n";
  return Buffer.concat([
    prefix,
    Buffer.from(body + "\n" + tailNl, "utf-8"),
    suffix,
  ]);
}

// 读不到就返回 null（"未知"）—— null 的语义是"不可删"，安全侧。
function safeFingerprint(projectPath, rel) {
  try {
    return createHash("sha256")
      .update(readFileSync(join(projectPath, rel)))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return null;
  }
}

async function initAociCode(projectPath, keepArtifacts) {
  const alreadyInit = existsSync(join(projectPath, ".aoci", "config.json"));
  const manifest = readManifest(projectPath);

  // 三种情况需要重跑 init：
  // 1. aociArtifacts 从 off 切回 on，但产物缺失 —— 要补回来
  // 2. aociArtifacts="off"，清单里还有本工具创建的文件 —— 要让删除逻辑有机会执行
  const needRestore =
    keepArtifacts &&
    AOCI_ARTIFACTS.some((rel) => !existsSync(join(projectPath, rel)));
  const needCleanup =
    !keepArtifacts &&
    [...manifest.keys()].some((rel) => existsSync(join(projectPath, rel)));

  if (alreadyInit && !needRestore && !needCleanup) {
    return { skipped: true, reason: "aoci-code 已初始化" };
  }

  // aoci init 会生成/修改公共文件：.gitignore（追加机器专属规则）、.gitattributes、AGENTS.md。
  // 三者都要跟踪：.gitignore 永远还原（塞机器规则进公共文件必被团队审查挑刺），
  // 后两者由 keepArtifacts 决定去留。快照覆盖全部 TRACKED，才能区分"用户原有"与"本工具造的"。
  const TRACKED = [".gitignore", ...AOCI_ARTIFACTS];
  // aoci init 改写文件前会自动留一份 <name>.backup.<时间戳+哈希>。
  // 先记下调用前已有的那些 —— 之后只清理本次新产生的，不碰用户的历史备份。
  const backupsBefore = new Set(
    existsSync(projectPath) ? readdirSync(projectPath) : []
  );
  const before = {};
  const symlinked = new Set();
  for (const rel of TRACKED) {
    const p = join(projectPath, rel);
    // 符号链接一律不碰：读会跟随目标，还原会穿透写到项目外的文件。
    // 记下来，后面三个循环都跳过它。
    // 用 isSymlink 而不是 existsSync + lstat —— 断链时 existsSync 为 false，
    // 保护会被跳过，随后 writeFileSync 会跟随断链把目标创建到项目外。
    if (isSymlink(p)) {
      symlinked.add(rel);
      before[rel] = null;
      continue;
    }
    // 用 Buffer 不用 "utf-8" —— .gitignore / .gitattributes 在中文 Windows 项目里
    // 常带 GBK 注释，按 utf-8 解码会产生 U+FFFD 且不可逆，写回时原始字节就毁了。
    // 这三个文件是整文件读回写回、不做字符串拼接，用 Buffer 没有额外成本。
    before[rel] = existsSync(p) ? readFileSync(p) : null;
  }

  // aoci 是外部程序，它会直接写这些文件 —— 我们无法阻止它跟随符号链接。
  // 所以只要产物（或 .aoci 目录本身）是链接，就整个跳过这一步。
  if (symlinked.size > 0 || isSymlink(join(projectPath, ".aoci"))) {
    const which = symlinked.size > 0 ? [...symlinked].join("、") : ".aoci";
    return {
      skipped: true,
      reason: `产物或 .aoci 是符号链接（${which}），跳过 aoci 以免写穿到项目外`,
    };
  }

  // 解析 aoci 可执行文件。找不到就跳过并给出可操作提示，绝不猜一个路径去执行。
  // 路径一律用 POSIX 风格 —— Git Bash 会把 Windows 路径里的 \ 当转义符。
  const aociBin = resolveTool(ENV_AOCI, "aoci");
  if (!aociBin) {
    return {
      skipped: true,
      reason: `找不到 aoci：请设置环境变量 ${ENV_AOCI}，或确保 aoci 在 PATH 上`,
    };
  }
  const result = run(`"${aociBin}" init --here --agent claude`, {
    cwd: projectPath,
    timeout: 60000,
  });

  // 删除判据（两层，缺一不可）：
  //   1. 清单里有它 —— 证明是本工具造的，不是用户文件
  //   2. 内容指纹与清单记录一致 —— 用户没改过
  // 任一不满足就只还原、绝不删除：用户改过的文件永远是用户的数据。
  // 旧式清单（纯字符串、无指纹）过不了第 2 条；但本轮新生成的产物不靠指纹，
  // 它们调用前不存在，天然可删（见下方 before[rel] === null 分支）。
  const fingerprint = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const claimed = new Map(manifest);
  for (const rel of TRACKED) {
    if (symlinked.has(rel)) continue;
    if (before[rel] === null && existsSync(join(projectPath, rel))) claimed.set(rel, null);
  }

  for (const rel of TRACKED) {
    const p = join(projectPath, rel);
    if (symlinked.has(rel)) continue; // 符号链接不参与删除/还原
    // 本轮是否允许按指纹删除：只有 AOCI_ARTIFACTS 且 aociArtifacts="off"。
    // .gitignore 永远只还原不删。
    const deletable = AOCI_ARTIFACTS.includes(rel) && !keepArtifacts;

    if (before[rel] === null) {
      // 调用前不存在 —— 只可能是本工具造的。off 就该删掉它，
      // 否则「首次就传 off」要等第二轮才清得掉，同一个 off 决定两半行为相反。
      if (keepArtifacts && AOCI_ARTIFACTS.includes(rel) && existsSync(p)) {
        // aociArtifacts="on" 时保留产物。这是唯一能合法给它记指纹的时刻：
        // 文件此刻 100% 由 aoci 生成，不含任何用户内容。
        claimed.set(rel, safeFingerprint(projectPath, rel));
        continue;
      }
      if (existsSync(p) && claimed.has(rel)) {
        rmSync(p, { force: true });
        claimed.delete(rel);
      }
      continue;
    }

    // 调用前就存在：先试着按指纹删（上一轮本工具造的、用户没动过）
    if (deletable && claimed.has(rel)) {
      const sha = claimed.get(rel);
      try {
        if (sha && existsSync(p) && fingerprint(readFileSync(p)) === sha) {
          rmSync(p, { force: true });
          claimed.delete(rel);
          continue;
        }
      } catch {
        // 读不了就不删
      }
    }

    // 调用前就存在 —— 无论是用户手写还是本工具上一轮留下的，
    // 一律按字节还原。这是用户数据的安全底线，绝不删除。
    try {
      if (!existsSync(p) || !readFileSync(p).equals(before[rel])) {
        writeFileSync(p, before[rel]);
      }
    } catch {
      // 读改失败保持原状，不阻断初始化
    }
    // 走到这里说明文件没被删（上面删成功就 continue 了）——
    // 它归用户所有，指纹必须抹成 null，哪怕内容恰好等于 aoci 生成的。
    // 留着旧指纹会让下一轮 off 误判"用户没动过"。
    if (claimed.has(rel)) claimed.set(rel, null);  }

  // 指纹已在删除循环里就地写好 —— 只在"文件 100% 由 aoci 生成"的那一刻记，
// 其余情况一律 null（不可删）。这里绝不能无条件重算：用户改过的内容一旦
// 被当成"工具造的"记进指纹，下一轮 off 就会 rmSync 掉用户的手写内容。
  // claimed 是 manifest 的副本（见上），指纹写进了 claimed，要同步回 manifest。
  manifest.clear();
  for (const [rel, sha] of claimed) {
    // 符号链接归用户所有，永不可删 —— 无论旧清单里记了什么指纹
    manifest.set(rel, symlinked.has(rel) ? null : sha);
  }

  // 清掉本次 aoci init 新产生的备份文件（调用前就有的历史备份一律保留）。
  // 前缀从 AOCI_ARTIFACTS 派生而非另写一份 —— aoci 改了什么文件，
  // 这里就跟着清什么；两处名单各写一遍的话，加第三个产物时会漏。
  const BACKUP_RE = new RegExp(
    "^(" + AOCI_ARTIFACTS.map((rel) => rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
      ")\\.backup\\."
  );
  for (const f of readdirSync(projectPath)) {
    if (BACKUP_RE.test(f) && !backupsBefore.has(f)) {
      try {
        rmSync(join(projectPath, f), { force: true });
      } catch {
        // 清不掉不阻断
      }
    }
  }

  writeManifest(projectPath, manifest);

  return result.success
    ? { success: true, message: "aoi-code 已初始化" }
    : { success: false, message: result.output };
}

// aoci init 生成的公共文件（不含 .gitignore，那个无条件还原）
const AOCI_ARTIFACTS = [".gitattributes", "AGENTS.md"];

// 开关值同时接受 "on"/"off" 字符串与布尔 —— schema 用字符串是因为部分 MCP 客户端会丢弃 false
const norm = (v) =>
  v === undefined ? undefined : v === "on" ? true : v === "off" ? false : !!v;

async function initCodeGraph(projectPath, force) {
  const dir = join(projectPath, ".codegraph");
  // .codegraph 是符号链接时跳过：codegraph 是外部程序，会往里写，跟着链接就写到项目外。
  if (isSymlink(dir)) {
    return { skipped: true, reason: ".codegraph 是符号链接，跳过以免写穿到项目外" };
  }
  if (existsSync(dir) && !force) {
    return { skipped: true, reason: "CodeGraph 已初始化" };
  }

  // full 模式：不删目录，改用 index 全量重建。
  // .codegraph/ 里只有 codegraph.db（派生数据），但删了要重新初始化整个目录；
  // index 同样能把全部符号重新索引，且没有删除风险。
  const sub = existsSync(dir) ? "index" : "init";
  // 解析 CodeGraph。环境变量可给 .js 入口或可执行文件名，两者都支持。
  const cg = resolveTool(ENV_CODEGRAPH, "codegraph");
  if (!cg) {
    return {
      skipped: true,
      reason: `找不到 CodeGraph：请设置环境变量 ${ENV_CODEGRAPH}，或确保 codegraph 在 PATH 上`,
    };
  }
  // 统一成一条能在 Git Bash 里执行的命令：
  //   .js             -> node "<path>"
  //   .cmd/.bat       -> Git Bash 不能直接执行，找同目录的 .js sibling；没有才用 cmd //c
  //   其它（.exe 等） -> 直接执行
  let cgCmd;
  if (cg.endsWith(".js")) {
    cgCmd = `node "${cg}"`;
  } else if (/\.(cmd|bat)$/i.test(cg)) {
    const jsSibling = cg.replace(/\.(cmd|bat)$/i, ".js");
    cgCmd = existsSync(jsSibling) ? `node "${jsSibling}"` : `cmd //c "${cg}"`;
  } else {
    cgCmd = `"${cg}"`;
  }
  const result = run(`${cgCmd} ${sub}`, {
    cwd: projectPath,
    timeout: 60000,
  });
  return result.success
    ? { success: true, message: `CodeGraph 已${sub === "index" ? "重建索引" : "初始化"}` }
    : { success: false, message: result.output };
}

// ============ git 个人级排除 ============

// 运行时产物走 .git/info/exclude（个人级，不进版本库）。
// 与 .gitignore 的区别：.gitignore 会被提交、影响整个团队；info/exclude 只对当前 clone 生效，
// 适合"我本地不想看到这些运行时文件，但不该替团队做决定"的场景。
//
// 分组开关，每组语义不同：
//   runtime  — 工具自身生成的缓存/状态，永远是本机私有的
//   machine  — 含绝对路径，换台机器就失效
//   index    — 认知索引产物（可由源文件重新生成，体积大且高频变动）
//   agentsMd — AGENTS.md 是跨工具通用标准（Codex/Cursor/Gemini 都读），团队共享收益大
//   claudeMd — CLAUDE.md 是 Claude Code 专属入口，有些项目不认这个文件名
// 后两组默认都不排除：文档是给人和其他 agent 看的，藏起来代价更大。
const GIT_EXCLUDE_GROUPS = {
  runtime: [".codegraph/", ".aoci/", ".project-init/", ".claude/worktrees/", ".claude/settings.local.json", ".omc/", ".remember/"],
  machine: [".mcp.json", ".mcp.json.backup.*", ".claude.json",
             "AGENTS.md.backup.*", ".gitattributes.backup.*"],
  index: ["aoci.txt", "aoci.meta.txt", "aoci.code.txt"],
  agentsMd: ["AGENTS.md"],
  claudeMd: ["CLAUDE.md"],
};

// 本工具写入 exclude 时的标记行。回收只在这个块内部进行，
// 块外的行一律视为用户手写内容，永不触碰。
const MANAGED_BLOCK_MARKER = "# added by project-init MCP";

function splitManagedBlock(lines) {
  const start = lines.findIndex((l) => l.trim() === MANAGED_BLOCK_MARKER);
  if (start === -1) return { head: lines, managed: [], tail: [], hasBlock: false };
  // 块一直延伸到下一个标记行或文件末尾。
  // 不能用"遇到任意 # 注释行就结束"——用户完全可能在托管块中间插自己的说明注释，
  // 那样会让其后的所有条目掉出托管范围、永久失去回收能力。
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === MANAGED_BLOCK_MARKER) { end = i; break; }
  }
  // head 含标记行本体 —— 重组时直接拼回去即可保持位置。
  return {
    head: lines.slice(0, start + 1),
    managed: lines.slice(start + 1, end),
    tail: lines.slice(end),
    hasBlock: true,
  };
}

// 解析真正存放 info/exclude 的 git 目录。
// 普通仓库：.git 是目录，直接用。
// worktree/submodule：.git 是文件，内容形如 "gitdir: <repo>/.git/worktrees/<name>"，
//   那是 worktree 私有目录，里面没有 info/，而且 git 读的是 common dir 的 exclude。
//   所以还要再读私有目录下的 commondir（相对路径，如 "../.."），
//   解析出的 common dir 才是 exclude 真正生效的位置。
// .git 文件与 commondir 文件的内容都写在仓库里，克隆一个恶意仓库就能让它们
// 指向项目外的任意 .git。所以 gitdir 指向项目外时，必须是个**结构合法**的 git 私有目录。
// 两种合法布局（均实测），判据都要求完整路径段 —— 只"有 HEAD"或"有 commondir"太松，
// 恶意构造随便一个目录都能满足：
//   worktree   <repo>/.git/worktrees/<name>，且 commondir 指向有 HEAD 的目录
//   submodule  <repo>/.git/modules/<name>，且有 config
//
// 注意：不再对"项目内的 gitdir"短路放行 —— 那会让 `.git` 文件指向
// `vendor/B/.git`（嵌套仓库）时，把 A 的排除规则写进 B。git 只认这两种布局，
// 其余一律不可信。
// 宁可跳过 exclude 写入，也不能把 A 项目的排除规则写进 B 仓库。
function hasTrustedLayout(privateDir) {
  if (!existsSync(join(privateDir, "HEAD"))) return false;
  const normed = privateDir.toLowerCase().replace(/[\\/]+/g, "/");

  const commonFile = join(privateDir, "commondir");
  if (existsSync(commonFile)) {
    if (!normed.includes("/.git/worktrees/")) return false;
    try {
      const common = realOrNull(resolve(privateDir, readFileSync(commonFile, "utf-8").trim()));
      if (!common) return false;
      // common 必须像个**真的** git 目录。只查 HEAD 不够 —— 任意目录放个
      // 名为 HEAD 的文件就能满足，伪造 worktree 会把规则写进那个目录（已实测）。
      if (!existsSync(join(common, "objects")) || !existsSync(join(common, "refs"))) return false;
      // 且私有目录必须真的是 <common>/worktrees/<name>。
      // 否则攻击者可以自建 a/.git/worktrees/x 并把 commondir 指向任意目录。
      if (!samePath(common, resolve(dirname(dirname(privateDir))))) return false;
      return true;
    } catch {
      return false;
    }
  }

  return (
    normed.includes("/.git/modules/") &&
    existsSync(join(privateDir, "config")) &&
    existsSync(join(privateDir, "objects"))
  );
}

// 路径里的符号链接必须先解开再判 —— resolve() 只做字符串归一化，不解链接。
// 不解开的话，`x/.git/modules/pkg` 实际指向 victim 也能通过字符串判据（已实测复现）。
function realOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// 判断是否符号链接。**不能先 existsSync** —— 它对断链返回 false，
// 那样保护会被跳过，随后的 writeFileSync 会跟随断链把目标创建到项目外。
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// 两个路径是否指向同一位置（解开符号链接后比较，Windows 大小写不敏感）
function samePath(a, b) {
  const na = realOrNull(a);
  const nb = realOrNull(b);
  if (!na || !nb) return false;
  const norm = (s) => s.replace(/[\\/]+$/, "").toLowerCase();
  return norm(na) === norm(nb);
}

// 是否硬链接（nlink > 1）。写入硬链接会改到另一个路径下的同一份数据。
// Windows NTFS 支持硬链接，git 文件不会是硬链接 —— 命中就当不可信。
function isHardLinked(p) {
  try {
    return statSync(p).nlink > 1;
  } catch {
    return false;
  }
}

// （原来的 insideWorkTree 已删除 —— 它给"项目内的 gitdir"开了绿灯，
//   让 `.git` 文件指向嵌套仓库 `vendor/B/.git` 时也能写进 B。
//   现在一律按 worktree/submodule 的完整路径段判定，不再有短路。）
function resolveGitDir(projectPath) {
  const dotGit = join(projectPath, ".git");
  if (!existsSync(dotGit)) return null;

  // .git 是符号链接 / junction 时**拒绝**。
  // 正常的 .git 是目录（普通仓库）或文件（worktree/submodule 的 gitdir 指针），
  // 不会是链接。链接可以指向任意位置——包括项目外的另一个仓库，
  // 那样在 A 项目跑初始化就会把排除规则写进 B 仓库。
  // 合法但少见的场景（.git 放别的盘）会看到明确的 skipped 原因，而不是被静默写错地方。
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null;

  if (!st.isFile()) return dotGit;

  // .git 是文件 → 解析 gitdir:
  let content = "";
  try {
    content = readFileSync(dotGit, "utf-8").trim();
  } catch {
    return null;
  }
  const m = content.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  // realpath：解开路径里的符号链接再判，否则链接能骗过下面所有字符串判据
  const privateDir = realOrNull(resolve(projectPath, m[1].trim()));
  if (!privateDir || !hasTrustedLayout(privateDir)) return null;

  // worktree 私有目录 → 跳到 common dir（普通仓库走到这里 privateDir === .git，
  // 其下没有 commondir 文件，视为普通仓库直接返回）
  const commonFile = join(privateDir, "commondir");
  if (!existsSync(commonFile)) return privateDir;
  try {
    const common = realOrNull(resolve(privateDir, readFileSync(commonFile, "utf-8").trim()));
    return common && existsSync(common) ? common : privateDir;
  } catch {
    return privateDir;
  }
}

function initGitExclude(projectPath, groups, extraEntries, rebuild) {
  const gitDir = resolveGitDir(projectPath);
  if (!gitDir) {
    // 区分"不是 git 仓库"和"是 git 仓库但 .git 是链接（安全跳过）"，
    // 否则用户会以为工具坏了。
    let reason = "非 git 仓库";
    try {
      const dotGit = join(projectPath, ".git");
      if (existsSync(dotGit) && lstatSync(dotGit).isSymbolicLink()) {
        reason = ".git 是符号链接或 junction，为安全跳过 exclude 写入（它可能指向项目外的另一个仓库）";
      }
    } catch {
      // 保持默认原因
    }
    return { skipped: true, reason };
  }
  const infoDir = join(gitDir, "info");
  const excludePath = join(infoDir, "exclude");

  // info 或 exclude 本身是符号链接时也拒绝 —— 写入会穿透到链接目标，
  // 那是项目外的位置。gitDir 已经过 realpath，但它的子路径仍可能是链接。
  // 断链也要拦住（existsSync 对断链返回 false，不能用来做这个判断）。
  if (isSymlink(infoDir)) {
    return { skipped: true, reason: ".git/info 是符号链接，为安全跳过 exclude 写入" };
  }
  if (isSymlink(excludePath)) {
    return { skipped: true, reason: ".git/info/exclude 是符号链接，为安全跳过" };
  }
  // 硬链接：写入会改到另一个路径下的同一份数据（NTFS 支持，git 文件不会是硬链接）
  if (isHardLinked(excludePath)) {
    return { skipped: true, reason: ".git/info/exclude 是硬链接，为安全跳过" };
  }

  // 组顺序固定，保证多次运行写入顺序一致。
  // 默认开启 runtime/machine/index；agentsMd/claudeMd 默认关闭（文档应团队共享）。
  // 开关值同时接受 "on"/"off" 字符串与布尔 —— schema 用字符串是因为部分 MCP 客户端
  // 会丢弃 false，字符串 "off" 是 truthy 不会丢；同时兼容手写 stdio 调用的布尔写法。
  const DEFAULTS = { runtime: true, machine: true, index: true, agentsMd: true, claudeMd: true };
  // groups === false 表示全部关闭 —— wanted 为空，只走回收逻辑
  const opts = {};
  if (groups !== false && groups && typeof groups === "object") {
    for (const k of Object.keys(groups)) opts[k] = norm(groups[k]);
  }
  const allOff = groups === false;
  const groupOn = (g) => (opts[g] === undefined ? DEFAULTS[g] : opts[g]);
  // AOCI_ARTIFACTS 里的 AGENTS.md / CLAUDE.md 同时也是 agentsMd / claudeMd 组的条目。
  // aociArtifacts="on" 只是"额外再排除一次"，不能覆盖组开关 ——
  // 用户显式设 agentsMd:"off" 表示想提交它，extra 就必须让路。
  const GROUP_OF = { "AGENTS.md": "agentsMd", "CLAUDE.md": "claudeMd" };
  const extraAllowed = (rel) => {
    const g = GROUP_OF[rel];
    return !g || groupOn(g);
  };

  const wanted = allOff
    ? []
    : Object.keys(GIT_EXCLUDE_GROUPS)
        .filter(groupOn)
        .flatMap((g) => GIT_EXCLUDE_GROUPS[g])
        // aociArtifacts="on" 时把 aoci 生成的公共文件也排除掉：
        // 文件留着给 agent 用，但不该进版本库。
        .concat((extraEntries || []).filter(extraAllowed));

  // 托管全集：识别"本工具写入过、但本轮开关已关闭"的条目。
  // 回收只在标记块内进行（见 splitManagedBlock），用户手写的行永不触碰。
  // 含通配符条目（如 AGENTS.md.backup.*），匹配时按 gitignore 的 * 语义处理。
  const MANAGED = [...Object.values(GIT_EXCLUDE_GROUPS).flat(), ...AOCI_ARTIFACTS];
  const managedRe = new RegExp(
    "^" + MANAGED.map((e) => e.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("$|^") + "$"
  );
  const isManaged = (t) => managedRe.test(t);
  const wantedSet = new Set(wanted);

  // 回收只针对本工具写入的行 —— 靠标记块划定范围，不按路径字符串匹配。
  // 用户可能自己手写同名排除项（如 AGENTS.md），按内容匹配会连他的行一起删掉。
  //
  // 编码安全：exclude 里可能有 GBK 注释（中文 Windows 项目常见）。整文件按 utf-8
  // 解码再写回会产生 U+FFFD 且不可逆 —— 用户的行被毁，违反"块外行永不触碰"。
  // 所以：整文件解码后若检出非法 UTF-8，就**只重写托管块**，块外部分按原始字节回写。
  const rawExclude = existsSync(excludePath) ? readFileSync(excludePath) : null;
  const current = rawExclude ? rawExclude.toString("utf-8") : "";
  // 用 � 转义而不是字面量 —— 那个字符在编辑/传输中容易被吞掉，
  // 变成 includes("") 恒为 false，判据永远失效（今天真踩过）。
  const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
  const excludeIsUtf8 = !current.includes(REPLACEMENT_CHAR);
  const seg = splitManagedBlock(current.split("\n"));

  const removed = [];
  const keptManaged = [];
  for (const line of seg.managed) {
    const t = line.trim();
    // 托管条目但本轮不再需要 → 回收
    if (t && !t.startsWith("#") && isManaged(t) && !wantedSet.has(t)) {
      removed.push(t);
      continue;
    }
    keptManaged.push(line);
  }

  const kept = [...seg.head, ...keptManaged, ...seg.tail];

  const present = new Set(
    kept.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  );
  // wanted 内部可能重复 —— 例如 agentsMd 组和 aociArtifacts 额外项都含 AGENTS.md。
  // 用 seen 逐项去重，否则同一个路径会被写进 exclude 两遍。
  const seen = new Set();
  const toAdd = wanted.filter((e) => {
    if (present.has(e) || seen.has(e)) return false;
    seen.add(e);
    return true;
  });

  if (removed.length === 0 && toAdd.length === 0) {
    return {
      skipped: true,
      reason: allOff ? "全部排除组已关闭，未写入任何条目" : "排除项已全部存在且无陈旧项",
    };
  }

  // 块内还剩有效条目时必须保留标记 —— 标记是下次回收的唯一依据，
  // 丢了它所有条目会永久变成"块外内容"，再也回收不掉。
  // seg.head 按定义已经含标记行本体（splitManagedBlock 的 slice(0, start+1)），
  // 重组时直接拼回去即可，不要再额外插一行。
  const keptEntries = keptManaged.filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("#");
  });
  const keepMarker = seg.hasBlock && keptEntries.length > 0;

  let next = kept.join("\n");
  if (seg.hasBlock && !keepMarker) {
    // 块空了 -> 摘掉标记行本体。只从 head 尾部精确摘，绝不用全文正则：
    // tail 里可能有用户自己写的同名标记行（照抄我们的很常见），
    // 全局替换会把它们一起删掉，而标记是下次回收的唯一依据。
    const headLines = seg.head.slice();
    headLines.pop(); // head 最后一行按定义就是标记本体
    next = [...headLines, ...keptManaged, ...seg.tail].join("\n");
  }
  if (!next.endsWith("\n") && next !== "") next += "\n";

  if (toAdd.length > 0) {
    if (keepMarker) {
      // 标记已在原位，把新条目追加到托管块末尾即可
      next += toAdd.map((e) => `\n${e}`).join("") + "\n";
    } else {
      next += "\n# added by project-init MCP\n" + toAdd.join("\n") + "\n";
    }
  } else if (!next.trim()) {
    next = "";
  }

  // worktree 的 info/ 目录默认不存在，写入前先建
  try {
    mkdirSync(join(gitDir, "info"), { recursive: true });
  } catch (err) {
    return { success: false, message: `.git/info 目录创建失败：${err && err.message}` };
  }

  // 非 UTF-8 的 exclude：整份按字符串写回会毁掉用户的 GBK 注释（U+FFFD 不可逆）。
  // 用户字节一个都不能动，所以不重排、不回收 —— 只把新条目追加到**已有托管块末尾**。
  //
  // 关键：必须复用已有标记块，绝不能每轮新开一个。splitManagedBlock 只认第一个标记，
  // 第二个块里的条目会永久落在"块外"，按设计再也回收不掉 —— 不可逆。
  if (!excludeIsUtf8) {
    // excludeRebuild:"on" —— 字节层精确重写托管块，回收照常生效。
    // 用户显式要求功能完整时用；找不到块边界就放弃，绝不赌。
    if (rebuild) {
      // nextManaged 只能是**块内**内容（含标记行），不能传整个 next ——
      // next 是全文件重组结果，块外的用户行会被复制进块里，标记数会翻倍。
      const blockOnly = nextManagedOnly(next, seg.hasBlock);
      const rewritten = blockOnly ? rewriteManagedBlockBytes(rawExclude, blockOnly) : null;
      if (rewritten) {
        try {
          writeFileSync(excludePath, rewritten);
        } catch (err) {
          return { success: false, message: `.git/info/exclude 写入失败：${err && err.message}` };
        }
        const result = {};
        if (toAdd.length) result.added = toAdd;
        if (removed.length) result.removed = removed;
        return {
          success: true,
          ...result,
          note: "exclude 非 UTF-8，已按字节重写托管块（块外字节原样保留）",
        };
      }
      return {
        skipped: true,
        reason: "exclude 非 UTF-8 且托管块边界异常，未改动（excludeRebuild=on 但无法安全重写）",
      };
    }

    // 默认 off —— 只追加，块外字节一个不动。代价是回收不生效。
    if (toAdd.length === 0) {
      return {
        skipped: true,
        reason: "exclude 非 UTF-8 编码，本轮无新增条目，未改动（避免破坏原始字节）",
      };
    }
    const markerBuf = Buffer.from(MANAGED_BLOCK_MARKER, "utf-8");
    const at = rawExclude.indexOf(markerBuf);
    // 已有的托管块：条目插到块末尾（下一个标记行或文件结尾之前）
    if (at >= 0) {
      const afterMarker = at + markerBuf.length;
      const nextMarker = rawExclude.indexOf(markerBuf, afterMarker);
      let insertAt = rawExclude.length;
      if (nextMarker >= 0) {
        insertAt = rawExclude.lastIndexOf("\n", nextMarker) + 1;
      } else {
        insertAt = rawExclude.length;
      }
      // 块末尾若已有换行就不用再加
      const needsNl =
        insertAt > 0 && rawExclude[insertAt - 1] !== 0x0a && rawExclude[insertAt - 1] !== 0x0d;
      const payload = Buffer.from(
        `${needsNl ? "\n" : ""}${toAdd.join("\n")}\n`,
        "utf-8"
      );
      writeFileSync(
        excludePath,
        Buffer.concat([rawExclude.slice(0, insertAt), payload, rawExclude.slice(insertAt)])
      );
    } else {
      // 没有托管块才新开一个
      const tail =
        rawExclude.length && rawExclude[rawExclude.length - 1] !== 0x0a
          ? Buffer.from("\n", "utf-8")
          : Buffer.alloc(0);
      writeFileSync(
        excludePath,
        Buffer.concat([
          rawExclude,
          tail,
          Buffer.from(`\n${MANAGED_BLOCK_MARKER}\n${toAdd.join("\n")}\n`, "utf-8"),
        ])
      );
    }
    return {
      success: true,
      added: toAdd,
      note: "exclude 非 UTF-8，仅追加新条目到已有托管块，原始字节未改动",
    };
  }

  try {
    writeFileSync(excludePath, next);
  } catch (err) {
    // 只读 exclude 抛 EPERM 时不能冒到顶层 —— 那会让整个 project_init
    // 变成 JSON-RPC error，前面已完成的步骤结果一并丢失。
    return { success: false, message: `.git/info/exclude 写入失败：${err && err.message}` };
  }
  const result = {};
  if (toAdd.length) result.added = toAdd;
  if (removed.length) result.removed = removed;
  return { success: true, ...result };
}

// ============ MCP Server ============

const server = new Server(
  {
    name: "project-init",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "project_init",
        description: "初始化项目（自动检测栈、配置工具、建立索引）。支持 incremental（默认）和 full 两种模式。full 会强制重刷 CLAUDE.md 托管片段并让 CodeGraph 全量重建索引，但不会重跑 aoci init（它幂等，已初始化就跳过）。",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["incremental", "full"],
              description: "初始化模式：incremental（只初始化缺失的）或 full（全量初始化）",
              default: "incremental",
            },
            projectPath: {
              type: "string",
              description: "项目路径（默认当前工作目录）",
              default: ".",
            },
            aociArtifacts: {
              type: "string",
              enum: ["on", "off"],
              description: "是否保留 aoci init 生成的 .gitattributes 与 AGENTS.md。默认 on —— 保留供 agent 使用，同时自动加入 .git/info/exclude 个人排除（不进版本库）。设 off 则文件本身也还原",
              default: "on",
            },
            gitExclude: {
              type: "object",
              description: "写入 .git/info/exclude 的分组开关（个人级，不进版本库）。用 'on'/'off' 而非布尔——部分 MCP 客户端会丢弃 false 值。",
              properties: {
                runtime: {
                  type: "string",
                  enum: ["on", "off"],
                  description: "工具运行时产物（.codegraph/、.aoci/、.project-init/、.claude/worktrees/、.claude/settings.local.json、.omc/、.remember/）",
                  default: "on",
                },
                machine: {
                  type: "string",
                  enum: ["on", "off"],
                  description: "含绝对路径或 aoci 内部备份（.mcp.json、.mcp.json.backup.*、.claude.json、AGENTS.md.backup.*、.gitattributes.backup.*）",
                  default: "on",
                },
                index: {
                  type: "string",
                  enum: ["on", "off"],
                  description: "认知索引产物（aoci.txt、aoci.meta.txt、aoci.code.txt）",
                  default: "on",
                },
                agentsMd: {
                  type: "string",
                  enum: ["on", "off"],
                  description: "AGENTS.md（跨工具通用标准，Codex/Cursor/Gemini 都读）—— 默认 on 走个人排除；有些项目要求提交它，设 off 即可",
                  default: "on",
                },
                claudeMd: {
                  type: "string",
                  enum: ["on", "off"],
                  description: "CLAUDE.md（Claude Code 专属入口）—— 默认 on；想让团队共享可关",
                  default: "on",
                },
              },
              default: {},
            },
            excludeRebuild: {
              type: "string",
              enum: ["on", "off"],
              description:
                "仅当 .git/info/exclude 不是 UTF-8 编码时生效。默认 off —— 只追加新条目，绝不重排，用户的 GBK 注释字节零风险（代价：那轮回收不生效）。设 on 则按字节重写托管块，回收照常工作，但边界判定出错时可能损坏用户内容。仅在该 exclude 确实含非 UTF-8 字符时才需要开。",
              default: "off",
            },
          },
        },
      },
      {
        name: "detect_stack",
        description: "检测项目技术栈（只读，无副作用）",
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "项目路径",
              default: ".",
            },
          },
        },
      },
      {
        name: "check_status",
        description: "检查所有工具的初始化状态",
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "项目路径",
              default: ".",
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const projectPath = args?.projectPath || process.cwd();
  const mode = args?.mode || "incremental";

  // 入口校验一次，三个工具共用。后面的 fs 调用（writeFileSync/readdirSync）没有各自的
  // try/catch，坏路径会抛 ENOENT 并中断整个 project_init —— 用户拿不到任何分步结果，
  // 分不清是路径打错还是初始化失败。明确报错比抛栈有用。
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    return {
      content: [
        { type: "text", text: `项目路径不存在或不是目录: ${projectPath}` },
      ],
      isError: true,
    };
  }

  switch (name) {
    case "detect_stack": {
      const { stacks } = detectStack(projectPath);
      return {
        content: [
          {
            type: "text",
            text: `检测到技术栈: ${stacks.length > 0 ? stacks.join(", ") : "未检测到"}`,
          },
        ],
      };
    }

    case "check_status": {
      const status = checkToolStatus(projectPath);
      return {
        content: [
          {
            type: "text",
            text: `工具状态:\n${JSON.stringify(status, null, 2)}`,
          },
        ],
      };
    }

    case "project_init": {
      const results = [];

      // 1. 检测栈
      const { stacks } = detectStack(projectPath);
      results.push({ step: "检测栈", status: "done", stacks });

      // 2. 初始化 Claude Code —— 恒进函数，由它内部判断：
      //    不存在则生成、存在则增量补全托管片段、已最新则 skipped。
      {
        const r = await initClaudeCode(projectPath);
        results.push({ step: "初始化 Claude Code", ...r });
      }

      // aociArtifacts 默认 on：文件保留给 agent 用，同时自动进个人排除。
      // 单一来源，第 3 步和第 6 步共用，避免两处默认值漂移。
      const keepArtifacts = norm(args?.aociArtifacts ?? "on") === true;

      // 3. 初始化 aoci-code
      // 三种情况要进函数：
      //   full          — 强制重建
      //   未初始化       — 首次
      //   needArtifacts — keepArtifacts=true 但产物缺失（off 删过要补回）
      //   needCleanup   — keepArtifacts=false 但清单里还有本工具建的文件（要让删除逻辑执行）
      const needArtifacts = keepArtifacts &&
        AOCI_ARTIFACTS.some((rel) => !existsSync(join(projectPath, rel)));
      const needCleanup = !keepArtifacts &&
        [...readManifest(projectPath).keys()].some((rel) => existsSync(join(projectPath, rel)));
      // 产物或 .aoci 是符号链接时也要进函数 —— 让 initAociCode 给出
      // "跳过以免写穿"的明确原因，而不是被外层判成"已初始化"静默跳过。
      const aociLinked =
        isSymlink(join(projectPath, ".aoci")) ||
        AOCI_ARTIFACTS.some((rel) => isSymlink(join(projectPath, rel)));
      if (mode === "full" || needArtifacts || needCleanup || aociLinked ||
          !existsSync(join(projectPath, ".aoci", "config.json"))) {
        const r = await initAociCode(projectPath, keepArtifacts);
        results.push({ step: "初始化 aoci-code", ...r });
      } else {
        results.push({ step: "初始化 aoci-code", skipped: true, reason: "aoci-code 已初始化" });
      }

      // 4. 初始化 CodeGraph（full 模式走 index 全量重建，不删目录）
      // .codegraph 是符号链接时也要进函数 —— 否则 existsSync 跟随链接判成
      // "已初始化"，跳过原因就丢失了（写入虽然没发生，但用户不知道原因）。
      const cgDir = join(projectPath, ".codegraph");
      if (mode === "full" || !existsSync(cgDir) || isSymlink(cgDir)) {
        const r = await initCodeGraph(projectPath, mode === "full");
        results.push({ step: "初始化 CodeGraph", ...r });
      } else {
        results.push({ step: "初始化 CodeGraph", skipped: true, reason: "CodeGraph 已初始化" });
      }

      // 5. OpenCodeReview
      results.push({ step: "OpenCodeReview", skipped: true, reason: "需要交互式配置" });

      // 6. git 个人级排除（五组开关：runtime/machine/index 默认开，agentsMd/claudeMd 默认关）
      //    gitExclude === false 表示全部关闭 —— 仍需执行一次以回收此前写入的托管条目
      //    aociArtifacts="on" 时把 aoci 生成的两个公共文件也纳入个人排除
      const ge = args?.gitExclude;
      const extra = keepArtifacts ? AOCI_ARTIFACTS : [];
      // excludeRebuild:"on" 让非 UTF-8 的 exclude 也能回收（字节层重写托管块）。
      // 默认 off：宁可回收不生效，也不冒险重写用户的 GBK 注释。
      const rebuild = norm(args?.excludeRebuild ?? "off") === true;
      const r = initGitExclude(
        projectPath,
        ge === false ? false : ge === undefined ? {} : ge,
        extra,
        rebuild
      );
      results.push({ step: "git info/exclude", ...r });

      // 部分步骤失败时要置 isError —— 否则客户端读到首行"初始化完成"就以为
      // 全部成功，而分步结果藏在 text 里容易被忽略。标题也按实际统计措辞。
      const failed = results.filter((r) => r.success === false);
      const head =
        failed.length === 0
          ? `初始化完成 (${mode} 模式)`
          : `初始化完成但有 ${failed.length} 步失败 (${mode} 模式): ${failed
              .map((r) => r.step)
              .join(", ")}`;
      return {
        content: [{ type: "text", text: `${head}\n${JSON.stringify(results, null, 2)}` }],
        ...(failed.length > 0 ? { isError: true } : {}),
      };
    }

    default:
      return {
        content: [{ type: "text", text: `未知工具: ${name}` }],
      };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

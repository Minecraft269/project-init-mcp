# project-init

Claude Code 的项目初始化工具：自动检测技术栈、生成 `CLAUDE.md`、建立 aoci-code 认知索引与 CodeGraph 代码图谱、按需写入 `.git/info/exclude` 个人级排除。

三层结构，任一层都能独立工作：

| 层 | 文件 | 作用 |
|---|---|---|
| **MCP Server** | `src/server.js` | 真正干活的三工具：`project_init` / `detect_stack` / `check_status` |
| **Hook** | `hook.js` | `UserPromptSubmit` 关键词检测，命中则提示 agent 调用 MCP |
| **Skill** | `SKILL.md` | 参数文档 + 语义匹配触发（Claude Code 靠 description 判断何时加载） |

---

## 依赖

### Node.js

```bash
npm install
```

只依赖 `@modelcontextprotocol/sdk`。

### 外部工具（不随本仓库分发）

| 工具 | 必需 | 用途 | 获取方式 |
|---|---|---|---|
| **Git for Windows** | 是 | 所有 git 操作走 Git Bash | https://git-scm.com/download/win |
| **aoci-code** | 否 | 仓库级认知索引 | 从源码 `go build -o aoci.exe ./cmd/aoci`（无官方 Release） |
| **CodeGraph** | 否 | 代码符号图谱 | 见其项目文档 |

**可选工具缺失时对应步骤会跳过并说明原因**，不会中断整个初始化。

### 路径解析顺序

每个外部工具按下列顺序查找，找到即用：

1. **环境变量**（推荐）
   - `PROJECT_INIT_BASH` — Git Bash 的 `bash.exe`
   - `PROJECT_INIT_AOCI_BIN` — aoci 可执行文件
   - `PROJECT_INIT_CODEGRAPH_JS` — codegraph 入口（`.js` 或可执行文件）
2. **PATH**
3. **常见安装位置**（仅 Git Bash：`C:\Program Files\Git\bin\bash.exe`、`C:\Program Files (x86)\...`）

都找不到时该步骤返回 `skipped` 并给出可操作提示。

---

## 安装

### 1. 注册 MCP server

```bash
claude mcp add project-init \
  -e PROJECT_INIT_AOCI_BIN=/path/to/aoci \
  -e PROJECT_INIT_CODEGRAPH_JS=/path/to/codegraph.js \
  -- node /path/to/project-init-mcp/src/server.js
```

（`-e` 可省略——省略时走 PATH 查找。）

### 2. 安装 skill

把 `SKILL.md` 放进 Claude Code 的 skills 目录：

```
~/.claude/skills/project-init/SKILL.md
```

推荐用**符号链接**指向本仓库，避免副本漂移：

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$HOME\.claude\skills\project-init\SKILL.md" `
  -Target "<repo>\SKILL.md"
```

### 3. 注册 hook（可选）

编辑 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node <repo>/hook.js" }
        ]
      }
    ]
  }
}
```

---

## 参数

### `mode`

| 值 | 行为 |
|---|---|
| `incremental`（默认） | 只初始化缺失的，已存在的跳过 |
| `full` | CLAUDE.md 强制重刷托管片段、CodeGraph 走 `index` 全量重建。**aoci-code 不会重跑 init**（它幂等，已初始化就 skipped） |

### `aociArtifacts` — 是否保留 aoci 生成的公共文件

| 值 | 文件 | 个人排除 |
|---|---|---|
| `"on"`（默认） | 保留 `.gitattributes` 和 `AGENTS.md` | 自动加入 `.git/info/exclude` |
| `"off"` | 删除本工具造且你没改过的产物；你改过的只还原不删 | 回收这两条 |

**删除判据（两层，缺一不可）**：清单里有它 → 当前内容指纹与清单记录一致（你没动过）。

指纹**只在「文件 100% 由 aoci 生成的那一刻」记录**。一旦走过还原分支——文件归用户所有——指纹抹成 `null`，语义是"不可删"。

> 指纹只能证明"内容没变"，证明不了"这份内容是工具造的"。无条件重算会把用户改过的内容当成工具产物记进清单，下一轮 `off` 就会删掉用户手写的内容。

### `gitExclude` — 写 `.git/info/exclude` 的分组开关

写的是**个人级**排除文件（不进版本库、不影响团队）。

| 组 | 默认 | 排除内容 |
|---|---|---|
| `runtime` | `on` | `.codegraph/`、`.aoci/`、`.project-init/`、`.claude/worktrees/`、`.claude/settings.local.json`、`.omc/`、`.remember/` |
| `machine` | `on` | `.mcp.json`、`.mcp.json.backup.*`、`.claude.json`、`AGENTS.md.backup.*`、`.gitattributes.backup.*` |
| `index` | `on` | `aoci.txt`、`aoci.meta.txt`、`aoci.code.txt` |
| `agentsMd` | `on` | `AGENTS.md` |
| `claudeMd` | `on` | `CLAUDE.md` |

**用 `"on"`/`"off"` 字符串，不要用布尔** —— 部分 MCP 客户端会丢弃 `false`。

**回收只在 `# added by project-init MCP` 标记块内进行**，块外的行视为用户手写内容，永不触碰。

```jsonc
{ "gitExclude": {} }                      // 全默认
{ "gitExclude": { "index": "off" } }      // 认知索引也提交给团队
{ "gitExclude": { "agentsMd": "off" } }   // AGENTS.md 团队共享
{ "gitExclude": false }                   // 全关，回收全部托管条目
```

### `excludeRebuild` — 非 UTF-8 的 exclude 如何处理

`.git/info/exclude` 可能含 GBK 等非 UTF-8 注释（中文 Windows 项目常见）。整文件按 utf-8 解码再写回会产生 `U+FFFD` 且不可逆。

| 值 | 行为 |
|---|---|
| `"off"`（默认） | **只追加**新条目，不重排不回收。用户字节零风险，代价是该轮回收不生效 |
| `"on"` | 按字节精确重写托管块，回收正常工作。边界判定异常时放弃重写并说明 |

---

## 安全边界

| 行为 | 说明 |
|---|---|
| **用户改过的文件永不删除** | 只按字节还原 |
| **清单缺失时 `off` 不删任何文件** | 安全优先于"删得干净" |
| **`.gitignore` 永远还原、永不删除** | 它是团队共享文件 |
| **GBK/非 UTF-8 的 `.gitignore`/`.gitattributes`** | 走 Buffer 字节比较，不经 utf-8 字符串 |
| **`CLAUDE.md` 非 UTF-8 时跳过不改** | 托管片段要按字节切位置，不可逆解码会毁原文 |
| **`CLAUDE.md` 是符号链接时拒绝写入** | 跟随链接会改到项目外的文件 |
| **写入失败不冒泡** | 只读文件返回该步失败 + 原因，**前面已完成步骤的结果照常返回** |
| **`.git` 文件里的 `gitdir:` 可被伪造** | 只认两种完整布局：worktree 必须在 `<repo>/.git/worktrees/<name>` 且 `commondir` 指向有 `HEAD` 的目录；submodule 必须在 `<repo>/.git/modules/<name>` 且有 `config`。路径先 realpath 解链接再判 |
| **`.git` 本身是符号链接/junction 时跳过** | 它可能指向项目外的另一个仓库 |
| **`.git/info`、`.git/info/exclude` 是符号链接（含断链）或硬链接时跳过** | 写入会穿透到链接目标或另一路径的同一份数据 |
| **项目内的 gitdir 也校验布局** | `.git` 指向 `vendor/B/.git`（嵌套仓库）时同样拒绝 |
| **`projectPath` 必须是已存在目录** | 否则直接返回错误，不会中断在某个步骤上 |

---

## 测试

```bash
npm test
```

7 组，覆盖：

| 组 | 覆盖 |
|---|---|
| `backup-regex` | aoci 备份文件命名匹配 |
| `manifest` | 清单指纹、用户数据安全、GBK/CRLF |
| `gitdir-boundary` | 恶意 gitdir / worktree / submodule |
| `hook` | 触发词全语序 + 疑问语境 + 异常输入 |
| `load` | MCP 握手、schema 与实现一致、符号链接 |
| `exclude-encoding` | GBK exclude 字节级保留 |
| `write-safety` | 只读文件、符号链接写穿 |

---

## 免责声明

**本软件按「现状」提供，不附带任何明示或暗示的担保**，包括但不限于对适销性、特定用途适用性和非侵权性的担保。

- 本工具会**修改你的项目文件**（`CLAUDE.md`、`.git/info/exclude`、`.gitignore`、`.gitattributes`、`AGENTS.md`）
- 尽管代码以"绝不误删用户数据"为第一不变式并配有 7 组回归测试，**使用者仍需自行承担使用风险**
- 建议在重要项目上使用前先提交或备份
- 作者不对任何数据丢失、仓库损坏或其他损害承担责任

**本仓库不包含 LICENSE 文件**。这意味着默认版权保留（All rights reserved）—— 你可以查看代码，但**未授予**复制、修改、分发或商用的许可。

### 依赖声明

本仓库**不包含也不分发**以下第三方工具，使用者需自行获取并遵守其各自的许可协议：

| 工具 | 许可 | 获取 |
|---|---|---|
| **Git for Windows** | GPL-2.0 | https://git-scm.com/download/win |
| **aoci-code** | 见其仓库 | 从源码构建（无官方 Release） |
| **CodeGraph** | 见其仓库 | 见其项目文档 |
| **@modelcontextprotocol/sdk** | MIT | `npm install` |

本工具通过命令行**调用**这些程序，不链接、不嵌入、不修改其源码。

---

## 已知限制

- **OpenCodeReview 需手动配置** —— 它的配置命令要交互式读 stdin，MCP 的 stdio 已被协议占用
- **`full` 不重建 aoci 索引** —— aoci 自身幂等，要强制重建请先删 `.aoci/`
- **hook 只检查第一个关键词匹配** —— 一句话里出现多个互斥语境时可能漏触发
- **hook 的「加载/载入/装载」必须同时出现「项目」** —— 这些词在技术语境太常见（模块加载、懒加载）

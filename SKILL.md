---
name: project-init
description: >
  初始化项目：检测技术栈、生成 CLAUDE.md、建立 aoci-code 认知索引与 CodeGraph 代码图谱、
  按需写入 .git/info/exclude 个人级排除。当用户说"初始化项目"、"项目初始化"、"全量初始化"、
  "初始化"（不限语序）、"init project"、"setup project"，或一大段提示词中包含这些词时触发。
---

# 项目初始化

检测项目技术栈，生成 agent 入口文档，建立代码认知索引。

## 触发条件

由 hook（关键词）和 skill 自身（语义）两条路径触发，命中任一即可。

**hook 关键词路径**（`.project-init/hook.js`，UserPromptSubmit）：

- 出现「初始化」即触发，不限语序 ——「初始化项目」「项目初始化」「全量初始化」「帮我初始化一下这个项目」都认
- 「加载/载入/装载」**必须同时出现「项目」**才触发 —— 这些词在技术语境太常见（模块加载、懒加载、插件加载），无条件触发会误伤
- 或英文 `init project` / `setup project` / `initialize project` / `load project`
- **疑问/教学语境除外**：否定词（如何、怎么、为什么、能否、可不可以、多久、已完成、下看下、解释、介绍…）出现在关键词前后 18 字窗口内则跳过
- 判定偏保守：宁可多触发一次，也不要漏掉用户的真实请求

**skill 语义路径**：Claude Code 读 `description` 自行匹配 —— 「把这个仓库的能力认知建起来」这类 hook 抓不到的表述仍可能加载本 skill。

## 调用方式

用 MCP 工具 `project_init`，不要手动跑各 CLI：

```jsonc
{
  "mode": "incremental",        // 或 "full"
  "projectPath": "D:/path",     // 可选，默认当前目录
  "gitExclude": { /* 见下表 */ }
}
```

配套只读工具：`detect_stack`（识别技术栈）、`check_status`（查各工具是否已初始化）。

## 参数

### mode

| 值 | 行为 |
|---|---|
| `incremental`（默认） | 只初始化缺失的，已存在的跳过 |
| `full` | CLAUDE.md 强制重刷托管片段、CodeGraph 走 `index` 全量重建索引。**aoci-code 不会重跑 init** —— 它自己幂等，已初始化就 skipped（要强制重建请先删 `.aoci/`） |

### aociArtifacts — 是否保留 aoci 生成的公共文件

`aoci init` 会生成 `.gitattributes` 和 `AGENTS.md`，并往 `.gitignore` 追加 `.mcp.json` 规则。

| 值 | 文件 | 个人排除 |
|---|---|---|
| `"on"`（默认） | 保留 `.gitattributes` 和 `AGENTS.md` | **自动加入** `.git/info/exclude` |
| `"off"` | 删除本工具造且你没改过的产物；你改过的只还原不删 | 回收这两条 |

**`off` 的删除机制：** 清单 `.project-init/project-init-manifest.json` 记文件名 + 内容指纹。删除需**两层同时成立**：① 清单里有它；② 当前内容指纹与清单记录一致（你没动过）。用户改过的文件永远只还原、不删除。

两种情况会被删：调用前就存在、但清单 + 指纹证明它是本工具造的且你没动过；调用前不存在 —— 那它 100% 是 aoci 刚造的，不需要指纹。清单缺失或指纹不匹配则只还原。

**切 `off` 时若产物是上一轮 `on` 建的、且你没动过，会被真正删除**（不用等第二轮）。

**默认 `on` 的理由：** 文件留着给 agent 用（`AGENTS.md` 是 aoci 认知层的入口），同时自动进个人排除 —— `git status` 干净，两全其美。

**指纹只在「文件 100% 由 aoci 生成的那一刻」记录**（调用前不存在 + `aociArtifacts:"on"`）。一旦走过还原分支 —— 文件归用户所有 —— 指纹抹成 `null`，`null` 的语义是"不可删"。

指纹只能证明"内容没变"，证明不了"这份内容是工具造的"。无条件重算会把用户改过的内容当成工具产物记进清单，下一轮 `off` 就会删掉用户手写的内容 —— 这是真实发生过的数据丢失。

`.gitignore` / `.gitattributes` 的还原走 **Buffer 字节比较**，不用 utf-8 字符串 —— 中文 Windows 项目里 GBK 注释按 utf-8 解码会产生 U+FFFD 且不可逆，写回时用户原文就毁了。

**双向同步：** `off` → `on` 会自动重新生成缺失的产物，不需要手动重跑 init。

```jsonc
{ "aociArtifacts": "on" }   // 默认
{ "aociArtifacts": "off" }  // 彻底还原
```

`.gitignore` **不受此开关影响**，无条件还原。

---

### gitExclude — 写 `.git/info/exclude` 的分组开关

写的是**个人级**排除文件（不进版本库、不影响团队）。与 `.gitignore` 的区别：`.gitignore` 会被提交并影响所有人，`info/exclude` 只对当前 clone 生效。

| 组 | 默认 | 排除内容 | 说明 |
|---|---|---|---|
| `runtime` | `on` | `.codegraph/`、`.aoci/`、`.project-init/`、`.claude/worktrees/`、`.claude/settings.local.json`、`.omc/`、`.remember/` | 工具运行时产物 |
| `machine` | `on` | `.mcp.json`、`.mcp.json.backup.*`、`.claude.json`、`AGENTS.md.backup.*`、`.gitattributes.backup.*` | 含绝对路径或 aoci 内部备份 |
| `index` | `on` | `aoci.txt`、`aoci.meta.txt`、`aoci.code.txt` | 可重新生成，频繁变动 |
| `agentsMd` | `on` | `AGENTS.md` | 跨工具通用标准；默认走个人排除，不污染团队仓库。项目要求提交它时设 `off` |
| `claudeMd` | `on` | `CLAUDE.md` | Claude Code 专属入口 |

**用 `"on"`/`"off"` 字符串，不要用布尔** —— 部分 MCP 客户端会丢弃 `false` 值（实测确认）。

**组开关语义：** `on` = 排除，`off` = 不排除。

**优先级：** `aociArtifacts:"on"` 会额外把 `AGENTS.md`/`.gitattributes` 加入排除，但**不能覆盖组开关** —— 显式设 `agentsMd:"off"` 表示想提交它，额外项就让路。

### 示例

```jsonc
{ "gitExclude": {} }                     // 全默认（runtime/machine/index/agentsMd/claudeMd 都排除）
{ "gitExclude": { "index": "off" } }     // 认知索引也提交给团队共享
{ "gitExclude": { "claudeMd": "off" } }  // CLAUDE.md 团队共享
{ "gitExclude": { "agentsMd": "off" } }  // AGENTS.md 团队共享（某些项目要求提交它）
{ "gitExclude": false }                  // 全关，回收全部托管条目
```

### 双向同步

改开关后重跑一次即可：

| 操作 | 效果 |
|---|---|
| 开 → | 之前回收的条目重新写入 |
| 关 → | 之前写入的条目被移除 |
| 全关 | 托管条目清空，标记块一并移除 |

**回收只在 `# added by project-init MCP` 标记块内进行** —— 块外的行一律视为用户手写内容，永不触碰。（用户可能自己手写 `AGENTS.md` 排除项，按内容匹配会连他的行一起删掉。）


---

## 实际执行的步骤

1. **检测技术栈** — 读 `package.json`（含 scripts）、`tsconfig.json`、`pyproject.toml`、`pytest.ini`、`go.mod`、`Cargo.toml`、`pom.xml`/`build.gradle`、`*.csproj`/`*.sln`、`composer.json`、`Gemfile` 等
   - 托管片段里的**构建/测试命令只在能验证时才写**：Node 看 `package.json` 的 `scripts.build`/`scripts.test` 是否真存在，Python 看有没有 `pytest.ini`/`tox.ini`。写一条跑不起来的命令比写"待补充"糟 —— agent 会照着执行然后失败
2. **生成 CLAUDE.md** — 不存在才写；已存在则只刷新 `<!-- project-init:begin/end -->` 托管片段，原内容完整保留
3. **初始化 aoci-code** — `aoci init`，随后按开关还原三个公共文件
4. **初始化 CodeGraph** — 不存在走 `init`，`full` 模式走 `index` 重建
5. **OpenCodeReview** — 跳过，需手动 `ocr config provider` / `ocr config model`
6. **写 .git/info/exclude** — 按五组开关

CLAUDE.md 之外的包管理器配置、`/caveman-discover` 工作流发现、`aoi scan` 建索引，**本 MCP 不执行**，需要时手动跑。

## 输出

返回首行状态标题 + 各步骤的 JSON 数组（每项含 `step` 与 `success`/`skipped`/`reason`），以及 git 排除项的 `added` / `removed` 列表。任一步失败时返回 `isError: true`。

```
初始化完成 (incremental 模式)
[
  { "step": "检测栈", "status": "done", "stacks": ["nodejs", "typescript"] },
  { "step": "初始化 Claude Code", "success": true, "message": "CLAUDE.md 已生成" },
  { "step": "初始化 aoci-code", "success": true, "message": "aoi-code 已初始化" },
  { "step": "初始化 CodeGraph", "success": true, "message": "CodeGraph 已初始化" },
  { "step": "OpenCodeReview", "skipped": true, "reason": "需要交互式配置" },
  { "step": "git info/exclude", "success": true, "added": [ ...17 项... ] }
]
```

> 上面是**默认全开**时的样子，`git info/exclude` 写入 17 条。有失败时首行变成 `初始化完成但有 N 步失败 (模式): <失败步骤名>`。

## 注意事项

- OpenCodeReview 跳过是因为它的配置命令要交互式读 stdin，而 MCP 的 stdio 已被协议占用
- `full` 会重建 CLAUDE.md；重写前先备份到 `.project-init/CLAUDE.md.bak`
- `.gitignore` 无条件还原 —— 往公共 .gitignore 塞机器专属规则必然被团队审查挑刺
- 清单在 `.project-init/project-init-manifest.json`，记文件名 + 内容指纹（`{"created":[{"name":"AGENTS.md","sha":"…"}]}`）；`sha: null` 表示不可删
- `projectPath` 必须是已存在的目录，否则直接返回错误（不会中断在某个步骤上）
- **写入失败不冒泡**：只读的 `CLAUDE.md` 或 `.git/info/exclude` 会返回该步失败 + 原因，**前面已完成的步骤结果照常返回**（不会变成整个调用的 JSON-RPC error）
- **`CLAUDE.md` 是符号链接时不写入** —— 跟随链接会改到项目外的文件，返回 skipped 并说明原因
- `CLAUDE.md` 是非 UTF-8 编码（如 GBK）时**跳过不改动**并回报 —— 托管片段要按字节切位置，不可逆的解码会毁掉用户原文
- `.git` 文件里的 `gitdir:` 是仓库内容、可被伪造。指向项目外时必须具备合法布局才认：worktree（有 `commondir`）或 submodule（路径在 `.git/modules/` 下且有 `config`）
- 各步骤有失败时返回 `isError`，标题会写明"有 N 步失败"，不会假装全部成功
- 改动本 skill 后无需手工同步 —— `~/.claude/skills/project-init/` 应是指向本仓库的**符号链接**

## 外部依赖

本工具**不捆绑**外部程序，按 `环境变量 > PATH > 常见安装位置` 顺序查找；找不到的步骤会跳过并说明原因。

| 工具 | 环境变量 | 用途 |
|---|---|---|
| Git for Windows | `PROJECT_INIT_BASH` | 所有 git 操作 |
| aoci-code | `PROJECT_INIT_AOCI_BIN` | 认知索引 |
| CodeGraph | `PROJECT_INIT_CODEGRAPH_JS` | 代码图谱 |

详见 `README.md` 的「依赖」与「免责声明」。


// UserPromptSubmit Hook: 检测"初始化项目"类请求并触发 project-init-mcp
// 由 Claude Code UserPromptSubmit hook 调用
//
// 两条触发路径：
//   1. 出现「初始化」就够 —— 语序不限（初始化项目 / 项目初始化 / 全量初始化 / 帮我初始化一下这个项目）
//   2. 「加载/载入/装载」必须同时出现「项目」—— 这些词在技术语境太常见（模块加载、懒加载、
//      插件加载），无条件触发会误伤一片
// 疑问/教学语境由 NEG_NEAR 排除（如何/怎么/解释/多久…）
//
// 踩过的坑：靠"初始化…项目"的固定字距覆盖中文各种语序，必然顾此失彼 ——
// 卡紧了漏掉"全量初始化"，放松了把"项目初始化完成了吗"误判成指令。
// 最后放弃穷举语序，只认动作词本身，把"是不是提问"交给否定词表判断。

// 读取 stdin 的 JSON 输入
let input = "";
process.stdin.on("data", (data) => (input += data));
process.stdin.on("end", () => {
  try {
    const inputData = JSON.parse(input);
    const userPrompt = inputData.user_prompt || "";

// 关键词：初始化（不限语序）| 加载类（须同时出现"项目"）| 英文四种说法
    const KW_ZH = "初始化";
    const LOAD = "(?:加载|载入|装载)[^。；;！!？?\\n]{0,6}项目";
    const KEYWORD = new RegExp(
      KW_ZH + "|" + LOAD +
        "|init\\s+project|initialize\\s+project|setup\\s+project|load\\s+project",
      "i"
    );

    // 否定词只在关键词"邻近"时才算数 —— 长提示词别处的"如何""解释"不该误伤真指令。
    // 表要全：漏一个就是一次漏触发（用户真要初始化却没反应），
    // 比误触发更糟 —— 误触发只是多跑一次，漏触发是功能看起来坏了。
    const NEG_WORDS =
      "怎么|如何|为什么|为何|怎样|是否|能不能|可不可以|能否|可以|可以吗|有没有|什么时候|多久|多长时间|多长|什么|啥|哪个|哪些|如何做" +
      "|已完成|完成了吗|好了吗|配置|看下|看看|查看|检查|介绍|教|告诉|解释|说明|演示|举例|区别|含义|文档" +
      "|how\\s+to|why|what\\s+is|what\\s+are|teach\\s+me|explain|describe|difference\\s+between|which";
    // 邻近窗口 18 字：中文疑问词短，英文长（覆盖 "I'd like to know how to" 这类）。
    const GAP = "[^。；;！!？?\\n]{0,18}?";
    // 动作词全集（否定判定要覆盖全部，否则"如何加载项目"这种疑问会漏出去）
    const ACT = "(?:" + KW_ZH + "|加载|载入|装载|init|initialize|setup|load)";
    const NEG_NEAR = new RegExp(
      "(?:" + NEG_WORDS + ")" + GAP + ACT + "|" +
        ACT + GAP + "(?:" + NEG_WORDS + ")",
      "i"
    );

    const text = userPrompt.replace(/\s+/g, " ").trim();
    const m = text.match(KEYWORD);
    let matched = false;
    if (m) {
      // 取关键词前后各 30 字窗口判断是否被疑问/教学语境包裹
      const start = Math.max(0, m.index - 30);
      const window = text.slice(start, m.index + m[0].length + 30);
      matched = !NEG_NEAR.test(window);
    }

    if (matched) {
      // 检测到初始化请求，输出 systemMessage 提示
      const output = {
        systemMessage: `检测到项目初始化请求，正在调用 project-init-mcp...`,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "用户请求初始化项目。建议调用 project_init MCP 工具执行初始化。",
        },
      };
      console.log(JSON.stringify(output));
    } else {
      // 不匹配，静默通过
      console.log(JSON.stringify({}));
    }
  } catch (e) {
    // 解析失败，静默通过
    console.log(JSON.stringify({}));
  }
});

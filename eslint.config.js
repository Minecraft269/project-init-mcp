// ESLint 扁平配置。只开能抓真实问题的规则，不做风格争吵：
// 未定义变量、未使用变量（漏删的死代码）是这里唯一值得自动化拦住的。
// 代码风格交给编辑器，不在 CI 里卡格式。
const NODE_GLOBALS = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  AbortController: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", ".codegraph/**", ".aoci/**", ".project-init/**"],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: NODE_GLOBALS,
    },
    rules: {
      // 未定义变量：真 bug（拼错变量名在运行时才炸）
      "no-undef": "error",
      // 未使用变量：死代码信号。忽略函数参数与 catch 变量 —— 有意保留的占位。
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      // 重复声明/不可达代码：同样是真 bug
      "no-redeclare": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];

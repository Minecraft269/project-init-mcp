// 备份文件匹配逻辑的自检。
// ponytail: 这个正则只服务 backupsBefore + BACKUP_RE 的组合；
// 加新产物或 aoci 改命名规则时跑一次 `node src/backup-regex.test.mjs`。
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

// 从 server.js 取真实的 AOCI_ARTIFACTS，避免测试和实现漂移
const src = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "server.js"),
  "utf-8"
);
const AOCI_ARTIFACTS = JSON.parse(src.match(/const AOCI_ARTIFACTS = (\[[^\]]*\])/)[1]);

const BACKUP_RE = new RegExp(
  "^(" +
    AOCI_ARTIFACTS.map((rel) => rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")\\.backup\\."
);

const cases = [
  ["AGENTS.md.backup.20261005_142747.abc", true, "aoci 真实产物"],
  [".gitattributes.backup.20261005_142747.abc", true, "另一产物"],
  ["AGENTS.md.backup.20250101_000000.MYOWN", true, "用户自带(靠 backupsBefore 兜底)"],
  [".gitignore.backup.x", false, "不在 AOCI_ARTIFACTS，不该被清"],
  ["AGENTS.md", false, "正文"],
  ["CLAUDE.md.backup.x", false, "无关文件"],
  ["myAGENTS.md.backup.x", false, "前缀不匹配，不能误删"],
  [".gitattributes", false, "无 backup 后缀"],
];

let bad = 0;
for (const [name, want, why] of cases) {
  const got = BACKUP_RE.test(name);
  if (got !== want) {
    bad++;
    console.log(`  FAIL ${name} -> ${got}, 期望 ${want} (${why})`);
  } else {
    console.log(`  ok   ${name} -> ${got}  (${why})`);
  }
}
console.log(bad === 0 ? "\n全部通过" : `\n${bad} 个失败`);
process.exit(bad ? 1 : 0);
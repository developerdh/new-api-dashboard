/**
 * Windows 盘符大小写修复（启动期 preload）。
 *
 * 背景：WorkBuddy/Git Bash 可能把 cwd 传成小写盘符（d:\...），而磁盘规范形式是
 * D:\。vitest 在 Windows 下以路径为模块 id，大小写不一致会把 runner chunk 加载成
 * 两个模块实例——clearCollectorContext 设置的 runner 与测试文件 describe 所在实例
 * 不同，导致所有用例在第一行 describe() 就抛
 * `TypeError: Cannot read properties of undefined (reading 'config')`。
 *
 * 用法：node --require ./scripts/fix-cwd.cjs <entry>，或在 package.json 的
 * test 脚本里通过 --require 引入。仅 Windows 且盘符小写时才 chdir。
 */
/* eslint-disable @typescript-eslint/no-require-imports -- node --require preload 机制要求 CJS */
const fs = require("node:fs");

try {
  const cwd = process.cwd();
  const drive = cwd.slice(0, 2);
  if (/^[a-z]:$/.test(drive)) {
    // 用 realpathSync.native 取磁盘规范大小写（如 d:\ → D:\）
    const canonical = fs.realpathSync.native(drive + "\\");
    const fixed = canonical.slice(0, 2) + cwd.slice(2);
    if (fixed !== cwd) process.chdir(fixed);
  }
} catch {
  // 修复失败不影响进程启动，退回原 cwd
}

#!/usr/bin/env node
/**
 * 看板快照 CLI（方案 §10 scripts/snapshot.ts）。
 *
 * 用法（Node 22 原生类型剥离，无需 tsx）：
 *   pnpm snapshot --path=/dashboard --start=1794240000 --end=1794326400 --granularity=day
 *   pnpm snapshot --path=/users/7 --name=user-7 --base-url=http://127.0.0.1:3088
 *
 * 前置：目标实例已启动且配置 ADMIN_TOKEN；服务端需安装 playwright + chromium。
 * 本 CLI 只调用 POST /api/snapshot，不直接依赖服务端模块。
 */

interface CliArgs {
  path: string;
  start?: string;
  end?: string;
  granularity?: string;
  name?: string;
  baseUrl: string;
  token: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (const raw of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match !== null) values.set(match[1], match[2]);
  }

  const path = values.get("path");
  if (path === undefined || path === "") {
    console.error(
      "缺少 --path。示例：pnpm snapshot --path=/dashboard --start=1794240000 --end=1794326400",
    );
    process.exit(1);
  }

  return {
    path,
    start: values.get("start"),
    end: values.get("end"),
    granularity: values.get("granularity"),
    name: values.get("name"),
    baseUrl: values.get("base-url") ?? process.env.DASHBOARD_BASE_URL ?? "http://127.0.0.1:3088",
    token: values.get("token") ?? process.env.ADMIN_TOKEN,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.token === undefined || args.token === "") {
    console.error("缺少 ADMIN_TOKEN（环境变量或 --token=）。");
    process.exit(1);
  }

  const query: Record<string, string> = {};
  if (args.start !== undefined) query.start = args.start;
  if (args.end !== undefined) query.end = args.end;
  if (args.granularity !== undefined) query.granularity = args.granularity;

  const endpoint = `${args.baseUrl.replace(/\/+$/, "")}/api/snapshot`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({ path: args.path, query, name: args.name }),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`快照失败（HTTP ${response.status}）：${text}`);
    process.exit(1);
  }

  console.log(text);
}

void main().catch((error: unknown) => {
  console.error("快照失败：", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

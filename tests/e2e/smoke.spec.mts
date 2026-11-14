/**
 * e2e 冒烟用例（T1-T9 确定性子集）。
 *
 * 约定：
 * - 定位一律用 data-testid（清单见 tests/e2e/TESTIDS.md），文案只作辅助断言；
 * - 断言相对化：依赖 seed.mjs 造出的唯一标记 `e2e-smoke-<runId>`，不写死记录总数；
 * - serial 模式 + 共享登录态（登录有 10 次/分钟限流，避免每个用例重复登录）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3088";
const USER_ID = process.env.E2E_USER_ID ?? "1";
const EXPECT_SAMPLING_NOTICE = process.env.E2E_SAMPLING_ENABLED === "1";

// seed.mjs 产出；缺失时明确报错（pnpm test:e2e 会先执行 seed）
let state: { runId: string; marker: string; date: string; promptCacheKey: string };
try {
  state = JSON.parse(readFileSync(join(here, ".state.json"), "utf8")) as typeof state;
} catch {
  throw new Error(
    "[e2e] 缺少 tests/e2e/.state.json —— 先运行造数（pnpm test:e2e 或 pnpm e2e:seed）。",
  );
}

test.describe.configure({ mode: "serial" });

let context: import("@playwright/test").BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  const password = process.env.E2E_PASSWORD;
  if (password === undefined || password === "") {
    throw new Error("[e2e] 缺少 E2E_PASSWORD（看板登录密码，见 .env.e2e.example）。");
  }
  context = await browser.newContext();
  page = await context.newPage();

  await page.goto(`${BASE}/login`);
  await page.getByTestId("login-username").fill(process.env.E2E_USERNAME ?? "admin");
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL("**/dashboard**");
});

test.afterAll(async () => {
  await context?.close();
});

test("T1 登录后进入全局总览", async () => {
  expect(page.url()).toContain("/dashboard");
  await expect(page.getByRole("link", { name: "全局总览" })).toBeVisible();
});

test("T2 概览渲染并可打开用户排行弹窗", async () => {
  await page.goto(`${BASE}/dashboard`);
  const viewAll = page.getByTestId("overview-ranking-view-all");
  await expect(viewAll).toBeVisible({ timeout: 15_000 });
  await viewAll.click();
  const dialog = page.getByTestId("overview-ranking-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("overview-ranking-user-link").first()).toBeVisible();
});

test("T3 用户详情会话卡片渲染（聚合视图 + 未聚合提示）", async () => {
  await page.goto(`${BASE}/users/${USER_ID}`);
  const card = page.getByTestId("sessions-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId("sessions-table-session")).toBeVisible();
  await expect(card.getByTestId("sessions-row").first()).toBeVisible();
  await expect(card.getByTestId("sessions-ungrouped-hint")).toBeVisible();
});

test("T4 过滤：仅错误 + 按日期（当日造数记录可见）", async () => {
  await page.goto(`${BASE}/users/${USER_ID}`);
  const card = page.getByTestId("sessions-card");
  await expect(card.getByTestId("sessions-row").first()).toBeVisible({ timeout: 15_000 });

  // 仅错误：过滤生效后不再出现 200 状态行（环境无失败记录时列表为空，同样通过）
  await card.getByTestId("sessions-filter-failed").click();
  await expect(card.getByTestId("sessions-row").filter({ hasText: "200" })).toHaveCount(0);
  await card.getByTestId("sessions-filter-failed").click();

  // 按日期：选造数当日 → 行内出现当日时间（行内日期为斜杠格式）；复位后恢复
  await card.getByTestId("date-picker-trigger").click();
  await expect(page.getByTestId("date-picker-panel")).toBeVisible();
  await page.locator(`[data-testid="date-picker-day"][data-date="${state.date}"]`).click();
  await expect(card.getByTestId("date-picker-trigger")).toContainText(state.date);
  await expect(
    card.getByTestId("sessions-row").filter({ hasText: state.date.replaceAll("-", "/") }).first(),
  ).toBeVisible();
  await card.getByTestId("date-picker-trigger").click();
  await page.getByTestId("date-picker-clear").click();
  await expect(card.getByTestId("date-picker-trigger")).toContainText("全部日期");
});

test("T5/T6 请求详情抽屉（含段路径新数据 + 造数标记）", async () => {
  await page.goto(`${BASE}/users/${USER_ID}`);
  const card = page.getByTestId("sessions-card");
  await expect(card.getByTestId("sessions-row").first()).toBeVisible({ timeout: 15_000 });

  // 按请求视图：最新一条即最近造数记录
  await card.getByTestId("sessions-group-request").click();
  await expect(card.getByTestId("sessions-table-request")).toBeVisible();
  await card.getByTestId("sessions-row").first().click();

  const drawer = page.getByTestId("detail-dialog");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toContainText(state.marker);

  await drawer.getByTestId("detail-tab-raw").click();
  await expect(drawer).toContainText(state.marker);
  await drawer.getByTestId("detail-close").click();
  await expect(drawer).toBeHidden();
});

test("T7 线程抽屉（2 轮聚合 + 增量标记）", async () => {
  await page.goto(`${BASE}/users/${USER_ID}`);
  const card = page.getByTestId("sessions-card");
  await expect(card.getByTestId("sessions-row").first()).toBeVisible({ timeout: 15_000 });

  await card.getByTestId("sessions-group-session").click();
  await expect(card.getByTestId("sessions-table-session")).toBeVisible();

  // 按会话键短码定位线程行（seed 已知明文键；同秒排序可能平局，不能假设第一行是线程）
  const threadKeyShort = createHash("sha256").update(state.promptCacheKey).digest("hex").slice(0, 8);
  const threadRow = card.getByTestId("sessions-row").filter({ hasText: threadKeyShort });
  await expect(threadRow).toHaveCount(1);
  await threadRow.click();

  const thread = page.getByTestId("thread-dialog");
  await expect(thread).toBeVisible({ timeout: 15_000 });
  await expect(thread).toContainText("会话线程");
  const turns = thread.getByTestId("thread-turn");
  await expect(turns).toHaveCount(2);
  await expect(thread).toContainText("本轮新增");
  await thread.getByTestId("thread-close").click();
  await expect(thread).toBeHidden();
});

test("T8 独立会话列表页（新窗口 + 累加加载状态）", async () => {
  await page.goto(`${BASE}/users/${USER_ID}`);
  const card = page.getByTestId("sessions-card");
  await expect(card.getByTestId("sessions-open-full-list")).toBeVisible({ timeout: 15_000 });

  const popupPromise = context.waitForEvent("page");
  await card.getByTestId("sessions-open-full-list").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup.getByTestId("sessions-page")).toBeVisible({ timeout: 15_000 });
  await expect(popup.getByTestId("sessions-load-state")).toContainText("已加载");
  await expect(popup.getByTestId("sessions-row").first()).toBeVisible();
  await popup.close();
});

test("T9 抽样口径提示按开关出现/不出现", async () => {
  await page.goto(`${BASE}/users/${USER_ID}`);
  const card = page.getByTestId("sessions-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  if (EXPECT_SAMPLING_NOTICE) {
    await expect(card.getByTestId("sampling-notice")).toBeVisible();
  } else {
    await expect(card.getByTestId("sampling-notice")).toHaveCount(0);
  }
});

# e2e data-testid 清单映射

本文件是看板 e2e 测试所依赖的 `data-testid` **唯一权威清单**：写用例前先查这里，不要扫描组件代码反推选择器；给组件增删 testid 时必须同步更新本表（改组件不改表、或反之，视为遗漏）。

约定：

- 命名 `<页面/组件>-<元素>`，kebab-case；同一组件在多处复用时（如 `SessionFilters`）只定义一次，两个入口（用户详情卡片 / 独立列表页）天然共用。
- 断言优先用 testid 定位，**文案只作辅助断言**——界面文案可改，testid 改动属于契约变更，需同步本表与用例。
- 涉及**多元素同名**的 testid（如 `sessions-row`）在文档中标注「多个」，用例侧用 `getByTestId(...)` + `filter({ hasText })` 收窄。

## 登录（`src/app/login/login-form.tsx`）

| testid | 元素 | 用途 | 关联用例 |
|---|---|---|---|
| `login-username` | 账号输入框 | 填用户名 | T1 |
| `login-password` | 密码输入框 | 填密码 | T1 |
| `login-submit` | 登录提交按钮 | 提交登录 | T1 |

## 全局总览（`src/app/(console)/dashboard/overview-client.tsx`）

| testid | 元素 | 用途 | 关联用例 |
|---|---|---|---|
| `overview-ranking-view-all` | 「查看全部」按钮 | 打开用户排行弹窗（进入用户详情的入口） | T2 |
| `overview-ranking-dialog` | 排行弹窗容器 | 断言弹窗渲染、按用户名筛行 | T2 |
| `overview-ranking-user-link`（多个） | 弹窗内用户详情链接 | 点击进入 `/users/[id]` | T2→T3 |

## 会话卡片 / 独立列表页（共用组件）

### 卡片与页面骨架

| testid | 元素 | 所在文件 | 用途 | 关联用例 |
|---|---|---|---|---|
| `sessions-card` | 用户详情「会话」卡片根节点 | `src/app/(console)/users/[id]/dashcam-sessions.tsx` | 定位卡片、确认渲染 | T3 |
| `sessions-open-full-list` | 「完整列表」链接（target=_blank） | `src/app/(console)/users/[id]/dashcam-sessions.tsx` | 打开独立列表页 | T7 |
| `sessions-page` | 独立列表页根节点 | `src/app/(console)/users/[id]/sessions/sessions-client.tsx` | 确认独立页渲染 | T7 |
| `sessions-load-state` | 独立页页脚「已加载 N」 | `sessions-client.tsx` | 累加加载计数断言 | T7 |
| `sessions-load-more` | 「加载更多」按钮（可加载时才存在） | `sessions-client.tsx` | 累加加载动作 | T7 |
| `sessions-loading` | 列表加载骨架（初始 / 切换日期等口径 / 翻页过渡态） | `dashcam-sessions.tsx`、`sessions-client.tsx`（两入口） | 断言切换筛选有加载反馈、空态不提前出现 | T4（可选） |
| `sampling-notice` | 抽样口径提示条（仅抽样开启时渲染） | `src/components/dashcam/sampling-notice.tsx` | 断言提示出现/不出现 | T8 |

### 过滤条（`src/components/dashcam/session-filters.tsx`，两入口共用）

| testid | 元素 | 用途 | 关联用例 |
|---|---|---|---|
| `sessions-group-session` / `sessions-group-request` | 粒度切换（按会话 / 按请求） | 切换聚合口径 | T4 |
| `sessions-stream-all` / `sessions-stream-stream` / `sessions-stream-json` | 形态切换（全部 / 流式 / 非流式） | 按形态过滤 | T4 |
| `sessions-filter-failed` | 「仅错误」开关 | 只看失败请求 | T4 |
| `sessions-filter-refresh` | 刷新按钮 | 重新拉取列表 | T4（可选） |

### 日期选择器（`src/components/dashcam/dashcam-date-picker.tsx`）

| testid | 元素 | 用途 | 关联用例 |
|---|---|---|---|
| `date-picker-trigger` | 触发按钮（显示当前值或「全部日期」） | 打开日历 | T4 |
| `date-picker-panel` | 日历面板（role=dialog） | 断言面板打开 | T4 |
| `date-picker-day`（多个，带 `data-date="YYYY-MM-DD"`） | 日历某天 | 按具体日期选择：`getByTestId('date-picker-day')` + `locator('[data-date="…"]')` | T4 |
| `date-picker-clear` | 「全部日期」清除按钮 | 复位过滤 | T4 |

### 表格（`src/components/dashcam/session-table.tsx`，两入口共用）

| testid | 元素 | 用途 | 关联用例 |
|---|---|---|---|
| `sessions-table-session` | 按会话聚合表格 | 定位表格 | T3/T4/T6 |
| `sessions-table-request` | 按请求表格 | 定位表格 | T4 |
| `sessions-row`（多个） | 数据行（点击打开详情 / 线程） | 选行打开抽屉；配合 `filter({ hasText: 标记或时间 })` 收窄 | T3/T4/T5/T6/T7 |
| `sessions-ungrouped-hint` | 「未参与聚合」说明行 | 断言无会话键提示渲染 | T3 |

## 详情抽屉（`src/components/dashcam/dashcam-detail-dialog.tsx`）

| testid | 元素 | 用途 | 关联用例 |
|---|---|---|---|
| `detail-dialog` | 抽屉容器（含标题/正文全文，可断言造数标记） | 断言抽屉打开与内容 | T5 |
| `detail-tab-struct` / `detail-tab-raw` / `detail-tab-events` | 页签（结构化 / 原始报文 / 事件流——事件流仅流式请求渲染） | 切换页签 | T5 |
| `detail-fullscreen` | 全屏按钮 | 全屏切换（展示性检查） | T5（可选） |
| `detail-close` | 关闭按钮 | 关闭抽屉 | T5 |

## 线程抽屉（`src/components/dashcam/dashcam-thread-dialog.tsx`）

| testid | 元素 | 用途 | 关联用例 |
|---|---|---|---|
| `thread-dialog` | 线程抽屉容器（含标题「会话线程 N 轮」与全文） | 断言打开与轮数（文本「N 轮」） | T6 |
| `thread-turn`（多个，带 `data-turn="序号"`） | 轮次卡片 | 轮次计数、指定轮展开状态：`getByTestId('thread-turn')` + `[data-turn="2"]` | T6 |
| `thread-close` | 关闭按钮 | 关闭抽屉 | T6 |

## 维护规则

1. **新增交互元素且 e2e 需要定位时**才加 testid；纯展示、已有 role/name 可稳定定位的元素不必加。
2. 加 testid 的同一次提交必须更新本表（位置 + 用途 + 关联用例列）。
3. 删除/重命名 testid = 契约变更：同步更新 `tests/e2e/` 下引用它的用例与本表。
4. 断言涉及界面文案（如「会话线程」「本轮新增」）时，文案变更需同步用例；testid 本身不变即不算契约变更。

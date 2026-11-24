# Proposal

## Why

看板缺少官方数据看板已有的「消耗分布」统计：全局总览与用户详情目前只有按日/周/月聚合的折线趋势，无法回答「今天 / 昨天各时段消耗了多少」这类小时级分布问题。官方实现按「当前时刻前推 24 小时」的滚动窗口统计，与本看板已确立的自然日口径（东八区 0 点至 23:59:59）不一致，因此按本仓库口径补齐：单日区间即为该日 0 点起的自然小时分布，今天则统计 0 点到现在。

## What Changes

- 全局总览与用户详情各新增一张「消耗分布」卡片：按模型堆叠的柱状图（Top 模型 + 其他段，对齐官方数据看板）+ 标题栏区间总计，支持 消耗额度 / 请求数 / Token 维度切换；统计口径说明收进标题旁悬浮提示。
- 时间范围完全复用顶部全局时间选择器（自然日对齐、左闭右开）；**不新增「昨日」预设**——昨天通过自定义日期选择（即昨日 0 点至 23:59:59）。
- 分桶单位按区间长度自动选择：`≤ 2 天 → hour`、`≤ 92 天 → day`、`更长 → week`；不写入 URL `granularity` 参数，趋势卡的日/周/月开关不受影响。
- 查询接口的 `granularity` 枚举扩展 `hour`（共享白名单，各端点一致接受）：东八区自然小时桶（如 0 点~0:59:59）；前端仅由新卡消费该粒度。三个趋势路由均已具备 1000 桶上限的 400 校验，`hour` 开放后校验自动生效，无需额外加固。
- `/api/models/trend` 增加可选 `userId` 过滤（参数校验本就支持，为用户详情的按模型分布复用该端点）。
- 区间覆盖当前时间（如「今日」）时：x 轴固定 24 个小时位，未到的小时留空并在悬停时提示「未到」；总计只累计已有数据。
- 页面布局：消耗分布卡与趋势卡各占一整行（消耗分布在上，趋势在下）；消耗分布卡内纵轴、悬停、总计与所选维度同单位（额度 → 美元）。
- 命名：用户详情现有「模型消耗分布」饼图保持不变，新卡命名为「消耗分布」，副标题注明分桶单位。
- 文档同步：`docs/方案.md` §3.2 / §4 / §7.1 / §7.2（实施前须经维护者批准，架构红线 5）与 `CHANGELOG.md` 未发布节。

明确不做（Out of scope）：柱/线形态切换、「昨日」预设、柱子点击下钻、e2e 用例新增。（按模型堆叠分段、消耗分布 CSV 导出原在此清单，依维护者反馈转为需求，见 specs。）

## Capabilities

### New Capabilities

- `consumption-distribution`: 消耗分布统计——两页合计柱状卡的展示行为、按区间长度自动选择分桶单位（hour/day/week）、东八区自然小时桶语义、今日未到小时留空位等行为契约，以及其复用趋势接口 `hour` 粒度的数据口径。

### Modified Capabilities

（无：`openspec/specs/` 目前为空，本变更是仓库首个变更；趋势接口的 `hour` 粒度作为上述新能力的数据契约一并纳入，不另立能力。）

## Impact

- **API 契约**：`granularity` 枚举 `day|week|month` → `day|week|month|hour`。该枚举是跨端点共享白名单（`normalizeQueryParams` 与缓存 key 同源），故对所有接受 `granularity` 的查询端点一致开放 `hour`（前端仅新卡消费）；逐端点排除会引入特判代码，不做。贯通点：`src/server/http.ts`（`ApiGranularity`）、`src/server/queries/common.ts`（`GRANULARITIES`、`bucketStart`、`prevRange`）、`src/server/cache.ts`（`CacheGranularity` / `CACHE_GRANULARITIES`，不改会抛 `CacheError` 导致 500）、`src/server/queries/trend.ts`（`shiftBucket`、`bucketLabel`）、`src/lib/time-range.ts` / `src/lib/use-api.ts`（前端类型）。
- **前端**：新增消耗分布柱状图组件与分桶单位选择工具；`overview-client.tsx`、`user-client.tsx` 布局调整（趋势卡改半宽并排）。
- **数据与红线**：无新依赖、无 schema 变更；`quota_data` 本身按小时聚合，数据基础现成；只读、参数化查询、排除 admin 口径均不变。
- **上限与缓存**：hour 沿用 `MAX_TREND_BUCKETS = 1000`（约 41 天）桶数上限，超限返回现有 400；缓存 TTL 沿用现有规则（覆盖当前小时 60s、纯历史 1h）。
- **测试**：单测覆盖 hour 分桶 / 标签 / 平移 / 缓存 key、选桶单位、图表 option 构建（含今日留空位）；不新增 e2e（现有 T2/T3 不受影响）。

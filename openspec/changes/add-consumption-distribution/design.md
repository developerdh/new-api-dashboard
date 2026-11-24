# Design

## Context

趋势链路现状（本设计的全部基础，动机见 proposal.md）：

- 前端：URL `start`/`end`（全局选择器，自然日对齐）→ `useApi` → `/api/trend`（全局）或 `/api/users/:id/trend`（单用户）→ `TrendLine` 折线卡；`granularity` URL 参数由趋势卡标题栏的 `GranularitySwitch`（日/周/月）独占写入。
- 服务端：`normalizeQueryParams`（`common.ts` 的 `GRANULARITIES` 白名单）→ `trendBuckets()` 在 JS 侧枚举桶序列 → SQL 侧 `DATE_TRUNC(granularity, … AT TIME ZONE 'Asia/Shanghai')` 聚合 → `toTrendPoints()` 按桶序列补空桶为 0。
- 缓存 key 的粒度白名单在 `cache.ts` 另有一份（`CACHE_GRANULARITIES`），两处必须同步扩展，否则 `cacheKey()` 抛 `CacheError` → 500。
- 三个趋势路由（全局 / 单用户 / 模型）均已实现 `MAX_TREND_BUCKETS = 1000` 的 400 校验；CSV 导出 `dataset=trend` 复用 `getTrend`，同样受校验覆盖。
- `quota_data` 本身按小时聚合（同键可多行），`logs` 为精确流水——`hour` 桶对两张表都是更细的再聚合，无口径风险；排除 admin、参数化查询、`::bigint` 等既有口径全部继承。

## Goals / Non-Goals

**Goals:**

- `hour` 以「共享粒度枚举第 4 个成员」的身份贯通既有趋势链路，改动机械、可编译器引导。
- 新卡最大化复用：`TrendPoint` 数据结构、`EChart` 封装、`MetricSwitch`、`ChartExportButton`、`SectionBody` 三态、`TREND_METRICS` 维度定义。
- 覆盖当前时间的区间（今日）固定 24 小时位、未来小时渲染为空（与 0 区分）。

**Non-Goals（设计层边界，proposal 已列范围级排除项不再重复）:**

- 不改变趋势卡的形态、`granularity` URL 参数语义与 `GranularitySwitch` 的三个选项。
- 不为 `hour` 引入独立缓存 scope：沿用趋势卡的动态 TTL 规则（`overview` scope + granularity key 段）。
- 不对 `hour × compare=prev/yoy` 做 UI 入口（API 层面组合自洽、零特判成本，见 D1）。

## Decisions

### D1: `hour` 加入共享粒度枚举，而非新端点 / 逐端点开关

趋势链路的 SQL、合并、补桶全部按 `granularity` 参数化，加枚举成员是机械贯通；新端点会复制整套聚合逻辑，逐端点排除 `hour` 则引入特判代码。贯通清单：

| 文件 | 改动 |
|---|---|
| `src/server/http.ts` | `ApiGranularity` 增加 `"hour"` |
| `src/server/queries/common.ts` | `GRANULARITIES` 增加 `"hour"`；`bucketStart` 增加 `hour` 分支（东八区自然小时起点：`(epoch + 28800)` 向下取整到 3600 的倍数再减回，东八区无夏令时，固定偏移安全）；`prevRange` 增加 `hour` 分支（整体减/加 3600 秒） |
| `src/server/cache.ts` | `CacheGranularity` 与 `CACHE_GRANULARITIES` 增加 `"hour"`（漏改即 500，有单测兜底） |
| `src/server/queries/trend.ts` | `shiftBucket` 增加 `hour` 分支（± k × 3600 秒）；`bucketLabel` 增加 `hour` 分支（`MM-DD HH:00`）；`trendBucketExpression` 经 `sql.lit(granularity)` 自动支持 `DATE_TRUNC('hour', …)`，无需改 |
| `src/lib/time-range.ts` | `Granularity` 类型扩展 `"hour"`；`parseGranularity` 接受 `hour`；**`GRANULARITIES` 展示列表不加 hour**（该列表只供 `GranularitySwitch` 渲染趋势卡三钮） |
| `src/lib/use-api.ts` | `ApiMetaPayload.granularity` 类型扩展 `"hour"` |

`shiftYearBucket`（同比平移）`hour` 走 `addShanghaiMonths(bucket, -12)` 分支自然成立；`compare × hour` 组合 API 自洽（等长前移 n 小时），UI 不提供入口。

### D2: 分桶单位由区间跨度派生，纯函数 + 阈值

新增纯函数（放 `src/lib/time-range.ts`，与既有自然日工具同处）：

```ts
type DistributionBucket = "hour" | "day" | "week";
function distributionGranularity(range: TimeRange): DistributionBucket
```

按东八区自然日跨度（`shanghaiDayStart` 对齐）：跨度 ≤ 2 日 → `hour`；≤ 92 日 → `day`；更长 → `week`。阈值依据：`hour` 路径 ≤ 48 桶（远低于 1000 上限，前端正常路径不触发 400）；92 日 ≈ 3 个自然月，半宽卡内 ~90 根日柱仍可读；`week` 在 366 天区间上限下 ≤ 53 桶。函数只读区间、不读不写 URL。

### D3: 小时标签——服务端完整、展示层压缩

`bucketLabel(bucket, "hour")` 返回 `MM-DD HH:00`（如 `11-22 08:00`）：确定性、跨日可区分（满足 spec），且 CSV / tooltip 直接可用。展示层 `buildDistributionOption` 在「单自然日区间」时把 x 轴标签压缩为 `HH:00`（24 根柱更易读），tooltip 仍显示完整标签。纯展示逻辑，不进服务端契约。

### D4: 今日未来小时渲染为 null（与 0 区分），总计天然只算已发生

服务端 `toTrendPoints` 对空桶补 0（含未来小时），不改。区分「未来」在前端完成：`buildDistributionOption(points, metric, nowSeconds)` 把 `bucketStart + 3600 > nowSeconds` 的桶渲染为 `null`，tooltip 对 null 显示「未到」；`nowSeconds` 由卡片组件在取数时 `useMemo` 固定。总计 = 各点求和：未来桶值为 0，加入求和不影响结果，因此总计无需特判即满足「只累计已发生」。已结束区间（昨日）所有桶都满足 `bucketStart + 3600 ≤ now`，自动无 null。

### D5: 组件与页面集成

- 新组件 `src/components/charts/consumption-bar.tsx`：props `{ points, unit, metric, height?, exportName?, nowSeconds? }`；`buildDistributionOption` 为导出的纯函数（单测：未来位 null、单日标签压缩、tooltip、维度切换格式化）。
- 数据获取：两页各增一条 `useApi`——总览 `/api/trend?{range}&granularity={unit}`，用户详情 `/api/users/:id/trend?{range}&granularity={unit}`；`unit` 由 `distributionGranularity(range)` 以 `useMemo` 派生，区间变即自动重取。响应结构与趋势卡完全一致（`TrendSeries.points`）。
- 维度切换：页内 `useState<TrendMetric>("totalQuota")` + `MetricSwitch options={TREND_METRICS}`（与热力图/排行的既有模式一致）；总计与柱高同源于 `points[metric]`。
- 布局：消耗分布卡与趋势卡各占一整行（分布在上、趋势在下），不做并排（初版并排，依维护者反馈改整行）。
- 数值单位：纵轴、悬停、总计与所选维度同单位——额度统一 `formatQuota`（$），请求数/Token 用紧凑数字（初版纵轴误用紧凑数字压缩 quota 原值，出现「50万」刻度，已修正）。
- 副标题注明分桶单位与口径：「按小时 · 东八区 / 按天 / 按周」，提示 `quota_data` ≤ 5 分钟延迟（今日末尾小时可能偏小）。
- 导出：`ChartExportButton`（HTML 单图，`exportName` 分别为 `overview-distribution` / `user-distribution`）；CSV 不做（proposal 已排除）。
- 卡片标题「消耗分布」与用户详情现有「模型消耗分布」饼图不冲突，不改后者。
- overlay 开合防抖动（第四/五轮反馈）：`html` 加 `scrollbar-gutter: stable`（保宽度）；导出下拉菜单与四个 Dialog 改 `modal={false}`（与 dashcam 日期选择器同款口径）——Radix 模态锁滚动会让滚动条本体消失再出现，非模态不锁滚动，滚动条全程保留；代价是弹窗打开时背景可滚动、无焦点圈定，内部看板可接受。

### D6: 文档同步（红线 5：`docs/方案.md` 修改须维护者批准）

实现合入前在会话中请求批准，批准后一次改到位：§3.2 统计维度补消耗分布；§4 参数表 `granularity` 枚举与 API 说明；§7.1 页面结构改为并排布局描述；§7.2 图表类型表加「消耗分布 | 柱状图」行。`CHANGELOG.md` 未发布节加条目。`AGENTS.md` 文档职责表不变（`方案.md` 仍是唯一权威设计；OpenSpec 变更工件是过程资产）。

### D7: 按模型分段（维护者反馈追加，原为 Out of scope）

- **数据源**：复用 `/api/models/trend`（桶 × 模型序列，`granularity=hour` 已贯通）。全局直接调用；用户详情为其增加可选 `userId` 过滤——`buildTopModelsQuery` / `buildModelTrendQuotaQuery` / `buildModelTrendRequestQuery` 三个构建器追加可选 `user_id = $n` 条件，路由把 `params.userId` 传入执行层并加入缓存 key（`cacheKey` 本就支持 userId 段）。调用签名追加第 4 参，既有路由测试的 `toHaveBeenCalledWith` 断言同步更新（契约变化，非迁就用例）。
- **渲染**：`ConsumptionBar` 接收 `modelSeries`——每模型一条 `stack` 同名柱序列 + 图例（scroll）；「其他」段 = 该桶合计（主趋势序列）− Σ模型分段（`Math.max(0, …)`），按 `bucketStart` 对齐两条序列；未到小时整桶渲染 null；模型名来自库内 `model_name`，进 tooltip（HTML）必须 `escapeHtml`。
- **展示方式**：固定按模型堆叠（第二轮反馈：去掉「按模型 | 合计」切换，初版的 mode 参数已移除）；模型序列未到达时组件内部回落为合计单序列（`buildDistributionOption` 保留为回落路径）。
- **口径说明**：分桶单位/东八区/延迟/单位说明收进标题旁 `InfoHint`（悬浮展示），不平铺在图表上方（第二轮反馈）。
- **备选**：为用户详情新建 `/api/users/:id/models/trend` 端点——多一套路由/缓存/校验样板，且公共参数 `userId` 校验现成，弃。

### D8: 测试策略（反馈轮追加项见 tasks 5.x）

- `src/lib/time-range.test.ts`：`distributionGranularity` 阈值边界（1 日 / 2 日 / 3 日、92 日 / 93 日、自定义非整日起点）。
- `src/server/queries/__tests__/trend.test.ts`：`hour` 桶序列（首桶对齐自然小时、`end` 排他含 23:00 桶）、`bucketLabel`、`shiftBucket`、SQL 编译含 `DATE_TRUNC('hour',…)`、缓存 key 含 `hour` 段；**注意**：既有「granularity 非法 → 400」用例若以 `hour` 作非法样本，须换成其他非法值（该用例语义不变，样本值过时）。
- 新组件纯函数测试（`consumption-bar` 的 option 构建）：未来位 null、单日标签压缩、总计格式化随维度切换。
- 路由层：`granularity=hour` 正常返回（24 桶）；超 1000 桶 → 400 `invalid_query`。
- e2e 不新增（R1：新卡无可定位交互元素之外的 e2e 需求；维度切换按钮已有稳定 role/name，暂无 e2e 用例消费）。

## Risks / Trade-offs

- [两日区间 48 根小时柱在半宽卡内偏窄] → ECharts 自动柱宽 + 悬停 tooltip 保底可读；不引入 dataZoom（48 根尚可，加了反而增加交互成本）。
- [两页各多一次趋势请求] → 与趋势卡共享缓存规则（今日 60s / 历史 1h）；同区间同粒度时与趋势卡命中同一 key（`overview` scope + granularity 段），实际 SQL 不翻倍。
- [趋势卡改半宽后 30 天折线变挤] → 已在方案选择时确认接受；折线 `showSymbol: false` 自适应，可接受。
- [`hour × compare` 组合无 UI 但 API 可达] → 行为自洽（等长前移 n 小时）、零特判；design 注明即可，不为它写专门用例（随枚举贯通的单测自然覆盖 `shiftBucket`）。
- [URL 手输 `granularity=hour` 时趋势卡三钮无高亮] → 现有「自定义区间」同款表现（无高亮 = 非预设），可接受，不加处理。
- [`quota_data` 5 分钟延迟] → 今日末尾小时柱可能偏小；卡片副标题注明，与指标卡/趋势卡口径一致。

## Migration Plan

纯增量变更：枚举扩展向后兼容（不传 `hour` 的旧调用行为不变），无数据迁移。部署即生效；回滚 = revert 对应提交（无状态残留，进程内缓存随进程消亡）。

## Open Questions

（无）

# Tasks

## 1. 服务端 hour 粒度贯通

- [x] 1.1 扩展粒度枚举与桶工具：`src/server/http.ts` 的 `ApiGranularity`、`src/server/queries/common.ts` 的 `GRANULARITIES` / `bucketStart` / `prevRange`、`src/server/cache.ts` 的 `CacheGranularity` / `CACHE_GRANULARITIES` 各增加 `hour`（东八区自然小时起点、整体 ±3600 秒平移）。验证：`pnpm typecheck` 通过，缓存 key 单测断言 `hour` 段可生成（漏改 `cache.ts` 会抛 `CacheError` 的用例保留/新增）。
- [x] 1.2 `src/server/queries/trend.ts` 的 `shiftBucket` / `bucketLabel` 增加 `hour` 分支（± k × 3600 秒；标签 `MM-DD HH:00`）。验证：`trend.test.ts` 新增用例——hour 桶序列（首桶对齐自然小时、`end` 排他含 23:00 桶）、标签格式、平移、SQL 编译含 `DATE_TRUNC('hour',…)`，全部通过。
- [x] 1.3 修正受枚举扩展影响的既有测试样本（「granularity 非法 → 400」用例若以 `hour` 作非法样本，换成其他非法值；语义不变）。验证：`pnpm test` 全绿。
- [x] 1.4 路由层 hour 行为验证：`/api/trend` 与 `/api/users/:id/trend` 的 `granularity=hour` 正常返回小时桶（今日区间 24 桶）、超 1000 桶返回 400 `invalid_query`。验证：路由层单测通过。

## 2. 前端选桶工具与图表组件

- [x] 2.1 `src/lib/time-range.ts`：`Granularity` 类型扩展 `hour`、`parseGranularity` 接受 `hour`、新增 `distributionGranularity(range)` 纯函数（≤2 自然日 hour / ≤92 自然日 day / 更长 week；`GRANULARITIES` 展示列表不加 hour）。验证：`time-range.test.ts` 新增阈值边界用例（1/2/3 日、92/93 日、非整日起点）通过。
- [x] 2.2 `src/lib/use-api.ts` 的 `ApiMetaPayload.granularity` 类型扩展 `hour`。验证：`pnpm typecheck` 通过。
- [x] 2.3 新增 `src/components/charts/consumption-bar.tsx`：`buildDistributionOption` 纯函数（未来小时渲染 null + tooltip「未到」、单自然日区间 x 轴标签压缩 `HH:00`、总计/柱高随 消耗额度/请求数/Token 维度切换格式化）+ 卡片组件（复用 `EChart` / `MetricSwitch` / `ChartExportButton`）。验证：option 构建纯函数单测通过。

## 3. 页面集成

- [x] 3.1 `src/app/(console)/dashboard/overview-client.tsx`：接入消耗分布卡（`distributionGranularity` 派生 `useApi` 粒度、标题总计、维度切换），消耗趋势卡改半宽并排；不为新卡加 `data-testid`（无 e2e 消费，R1 不触发）。验证：`pnpm dev` 下目测 今日 / 自定义昨日 / 近 30 天 三种区间的分桶与留空行为正确。
- [x] 3.2 `src/app/(console)/users/[id]/user-client.tsx`：同样接入（走 `/api/users/:id/trend`），使用趋势改半宽并排；现有「模型消耗分布」饼图名称与行为不变。验证：`pnpm dev` 目测两页并排布局与昨日 24 桶展示。
- [x] 3.3 回归：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。

## 4. 文档同步

- [x] 4.1 `CHANGELOG.md` 未发布节登记消耗分布卡与 `hour` 粒度。验证：条目与实际行为一致。
- [x] 4.2 `docs/方案.md` §3.2 / §4 / §7.1 / §7.2 同步（统计维度、`granularity` 枚举、页面结构并排、图表类型表加行）——**实施前须维护者在会话中批准**（架构红线 5）。验证：批准后修改，与代码行为逐条对得上。

## Workflow follow-up

- 提交由维护者发起，按仓库规范分批小步提交（建议 `feat(server)`：hour 粒度贯通 + 单测；`feat(web)`：组件与两页集成 + 单测；`docs`：CHANGELOG 与 方案.md）。
- 实现完成并通过评审后归档本变更（`openspec archive add-consumption-distribution`）。

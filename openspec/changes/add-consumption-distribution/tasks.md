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

## 5. 反馈修正（整行布局 / 纵轴单位 / 按模型分段）

- [x] 5.1 两页消耗分布卡改整行独占（去掉与趋势卡的并排 grid）；`ConsumptionBar` 纵轴单位随维度统一（额度 → `formatQuota` 美元）。验证：组件单测断言纵轴格式化随维度变化。
- [x] 5.2 `/api/models/trend` 支持可选 `userId` 过滤：`buildTopModelsQuery` / `buildModelTrendQuotaQuery` / `buildModelTrendRequestQuery` 追加可选 `user_id` 条件，路由透传 `params.userId` 并入缓存 key。验证：`model.test.ts` 新增编译/路由断言，既有路由调用签名断言同步更新后全绿。
- [x] 5.3 `ConsumptionBar` 支持 `mode: "model" | "total"`：按模型堆叠（Top 模型 + 其他 = 合计 − Σ模型）、未到小时整桶 null、模型名 tooltip 转义、图例。验证：option 纯函数单测。
- [x] 5.4 两页接入「合计 | 按模型」切换（默认按模型）与模型序列获取（用户详情带 `userId`）。验证：`pnpm lint` / `typecheck` / `test` / `build` 全绿 + dev 冒烟。
- [x] 5.5 文档同步：CHANGELOG 未发布条目修订、`docs/方案.md` §3.2 / §7.2 补按模型展示。

## 6. 反馈修正第二轮（固定按模型 / 说明收进悬浮）

- [x] 6.1 去掉「按模型 | 合计」切换：固定按模型堆叠（组件删 `mode`/`DISTRIBUTION_MODES`，两页删切换按钮与 state；模型序列未到达时回落合计单序列）。验证：`pnpm typecheck` / `test` 通过，页面仅剩维度切换。
- [x] 6.2 卡片口径说明收进标题旁 `InfoHint`（悬浮展示），不再平铺。验证：两页卡头仅 标题 + i 图标 + 总计；悬停展示分桶/口径/单位说明。
- [x] 6.3 回归与文档：`pnpm lint` / `test` / `build` 全绿；CHANGELOG 与 `docs/方案.md` 去掉「合计切换」表述。

## 7. 反馈修正第三轮（悬浮遮挡 / CSV 导出）

- [x] 7.1 `InfoHint` 增加 `align` 参数（`left` = tooltip 左缘对齐图标向右展开），消耗分布两处传 `align="left"`，修复 tooltip 伸出卡片左缘被裁剪。验证：卡片内悬停 tooltip 完整可见。
- [x] 7.2 消耗分布卡接入 CSV 导出：新增 `modelsTrend` 导出数据集（桶 × 模型明细，与卡片同口径同缓存 key、可选 userId），两页 `ChartExportButton` 传 `csvHref` 合并为「一个下载按钮 + 菜单」。验证：导出单测 + dev 冒烟下载 CSV 表头与行正确。
- [x] 7.3 工件与文档同步（spec 增 CSV 场景、proposal 排除清单更新、CHANGELOG、方案.md §3.2）。验证：`pnpm lint` / `typecheck` / `test` / `build` 全绿。

## 8. 反馈修正第四轮（overlay 开合页面抖动）

- [x] 8.1 全局修复：`globals.css` 的 `html` 加 `scrollbar-gutter: stable`（Radix 菜单/弹窗锁定滚动移除滚动条时，经典滚动条占位消失导致整页横移；常驻预留槽位后开合不再改变页面宽度）。验证：生产构建下实测——菜单/弹窗 `scroll-locked` 转换全程 `html.clientWidth` 恒定。
- [x] 8.2 overlay 改非模态：`scrollbar-gutter: stable` 只保住宽度，Radix 锁滚动仍会让滚动条本体消失再出现。导出下拉菜单与四个 Dialog（排行弹窗、沉默用户弹窗、dashcam 详情/线程抽屉）改为 `modal={false}`（与 dashcam 日期选择器同款口径）——不锁定页面滚动，滚动条全程保留。验证：生产构建实测 open 态无 scroll-lock、宽度恒定、弹窗打开时背景仍可滚动。：`globals.css` 的 `html` 加 `scrollbar-gutter: stable`（Radix 菜单/弹窗锁定滚动移除滚动条时，经典滚动条占位消失导致整页横移；常驻预留槽位后开合不再改变页面宽度）。验证：生产构建下实测——菜单/弹窗 `scroll-locked` 转换全程 `html.clientWidth` 恒定。

- [x] 8.3 ~~沉默用户卡预览清单居中~~（已按维护者要求回退：默认靠左留白，代码与 CHANGELOG 条目均已还原）。

- [x] 8.4 排行图姓名可点击跳详情：y 轴 `triggerEvent` + 链接色（palette[0]，显式 axisLabel 穿透主题补全），点击解析抽为 `resolveRankingClickRow` 纯函数（柱体按 dataIndex、标签按类目文本回查）。验证：纯函数单测 5 例 + 生产实测点姓名跳 `/users/:id?username&name`、截图标签呈链接蓝。

- [x] 8.5 进入/切换用户详情时滚动置顶：流式导航会保留来源页滚动位置，`UserClient` 挂载/`userId` 变化时 `window.scrollTo(0, 0)`（覆盖图点击、弹窗链接、沉默用户链接等全部入口）。验证：生产实测总览滚至 1017px → 点弹窗用户链接 → 详情页 scrollY=0。

## Workflow follow-up

- 提交由维护者发起，按仓库规范分批小步提交（建议 `feat(server)`：hour 粒度贯通 + 单测；`feat(web)`：组件与两页集成 + 单测；`docs`：CHANGELOG 与 方案.md）。
- 实现完成并通过评审后归档本变更（`openspec archive add-consumption-distribution`）。

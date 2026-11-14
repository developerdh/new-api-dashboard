# 会话看板实施记录（已实施）

> **状态：已实现并部署。** 阶段 A（列表 / 详情 / 归一化）于 2026-11-13 实施；会话聚合、线程增量、翻页与独立列表页于 2026-11-13 追加；token 用量胶囊与采集端索引字段于 2026-11-14 落地。设计权威是 [02-design.md](02-design.md) §7 与 §5；本文记录实现契约、与上游设计的偏差（D1–D6）、聚合与翻页算法要点、界面形态与实测结果。
>
> 本文不改动上游文档（02-design / 03-deployment），只登记偏差；修正以勘误形式回流。

## 1. 总体结论

文件读取层独立于 `getDb()`（`src/server/dashcam/`），用户维度映射走只读查询层（`src/server/queries/dashcam-tokens.ts`），路由复用现有登录守卫，界面在用户详情页提供「会话」卡片与独立列表页。不写库、不加豁免。

| 组件 | 位置 | 职责 |
|---|---|---|
| 读取层 | `src/server/dashcam/` | 路径校验、索引扫描、blob 读取、归一化、线程增量、token 水合 |
| 查询层 | `src/server/queries/dashcam-tokens.ts` | 指纹 → token → user 只读反查 |
| 路由 | `src/app/api/dashcam/` | sessions（列表）、sessions/[traceId]（详情）、conversations/[sessionKey]（线程） |
| 界面 | `src/app/(console)/users/[id]/dashcam-*.tsx`、`sessions/`、`src/components/dashcam/` | 会话卡片、独立列表页、详情抽屉、线程抽屉、块渲染、日历、过滤条、胶囊 |

## 2. 与上游设计的偏差（D1–D6，已确认）

实测核验（测试机 10 条样本 + `tokens` 表）发现的偏差，登记如下；读取侧按修正后口径实现。

| # | 位置 | 偏差 | 处理 |
|---|---|---|---|
| D1 | 02-design §4.1 | trace 校验 `{8,64}`，但采集端冲突后缀 `trace + "-" + 6hex` 实际最长 71 | 读取侧放宽到 `{8,71}`，文档已更正 |
| D2 | 02-design §4.2 | 指纹拼接规则未写：`tokens.key` 不含 `sk-`，指纹对**完整 Authorization 头**哈希 | 前缀可配置（默认 `Bearer sk-`），实测 `sha256("Bearer sk-" + key)[:12] = dbbbf1891a47` 与索引一致 |
| D3 | 02-design §7.4 | 信封未覆盖 `{error:{…}}` 错误体与截断产生的半截 JSON | 信封增加 `response.error` 与 `parse_error` / `raw` 兜底 |
| D4 | 02-design §8 | 代理不落响应头，`trace ↔ logs.request_id` 关联拿不到数据 | 不实现；如需必须先改采集侧 |
| D5 | README 状态表 | 实现后需同步状态 | 已更新 |
| D6 | 02-design §7.1 | 列了可选 `DELETE` 路由 | 不做（看板对记录目录只读） |

数据事实：无效 key 的指纹（如 401 样本）反查不到任何 token，该类请求按用户维度不可见，界面以 `unmatched` 计数说明而非静默丢弃。

## 3. 路由契约

统一响应信封沿用 `src/server/http.ts` 的 `{ ok, data, meta }`；错误码由 dashcam 层自带 helper，不改全局 `ApiErrorCode`：

| code | HTTP | 场景 |
|---|---|---|
| `invalid_query` | 400 | 参数非法 |
| `not_found` | 404 | 越权与不存在同响应（不泄露存在性） |
| `ambiguous_trace` | 409 | 同日同名 trace 多条且未带 `fp` |
| `dashcam_read_failed` | 500 | 文件系统异常 |

`DASHCAM_DIR` 未配置或不可读时列表返回 **200 + `available:false`**（可选能力降级，不显示成错误态）。

### 3.1 `GET /api/dashcam/sessions`

| 参数 | 规则 |
|---|---|
| `userId` | 正整数（必填） |
| `start` / `end` | Unix 秒或 ISO，左闭右开；窗口 ≤ `DASHCAM_MAX_WINDOW_DAYS`（默认 31 天） |
| `model` / `status` / `stream` / `failed` | 索引字段过滤；`failed=true` 即 `status ≥ 400` |
| `group` | `request`（默认，一行一请求）/ `session`（一行一会话） |
| `page` / `limit` | 页码（1 基）/ 每页条数（1–100，默认 20） |
| `date` | `YYYY-MM-DD`，给了覆盖 `start` / `end`（单日查询更省：只读一个索引文件） |

响应含 `available` / `sessions` / `conversations?` / `page` / `pageSize` / `total` / `totalPages` / `scannedDates` / `fingerprintCount` / `unmatched?` / `partial?`。

- **cursor 分页已移除**：索引按天追加，请求级 cursor 会漂移，改为页码翻页；
- 请求模式不做全量扫描，`total` 返回 `null`。

### 3.2 `GET /api/dashcam/sessions/[traceId]`

| 参数 | 规则 |
|---|---|
| `traceId`（路径段） | `^[A-Za-z0-9._-]{8,71}$`（D1），先 `decodeURIComponent` 再校验 |
| `date` / `userId` | 必填；条目 `u` 必须属于该用户指纹集合，否则 404（不泄露存在性） |
| `fp` | 同日同名 trace 消歧；多条且未提供时 409 |
| `prev` / `prevDate` | 上一轮定位，提供时计算**相对上一轮的消息增量** |

安全双保险：三段正则白名单 + `path.resolve` 前缀断言；任一不满足直接 404。

### 3.3 `GET /api/dashcam/conversations/[sessionKey]`

会话键（16 位哈希）下的全部轮次，时间升序，`prev` 串联。只读索引不读 blob；轮次正文按需经详情接口加载。会话键由客户端自带，必须叠加「指纹 ⊆ 该用户指纹集合」过滤防越权。

## 4. 读取层要点

| 模块 | 要点 |
|---|---|
| `paths.ts` | 三段白名单、`assertInsideRoot` 只做字符串层判断（不做 `realpath`，避免 NFS/容器挂载新失败面）、东八区日期枚举 |
| `index.ts` | 逐行容错（坏行计数）、末尾半行丢弃、短 TTL 缓存解析结果（`DASHCAM_INDEX_CACHE_MAX_ENTRIES` 上限防 LRU 撑爆）、聚合模式先全量分组再 offset 切片 |
| `reader.ts` | 按 `qz`/`rz` 解压；标记与实际不符时回退另一后缀一次；`DASHCAM_MAX_BLOB_BYTES`（默认 16 MiB）硬顶防 zip bomb |
| `dashcam-tokens.ts` | 指纹公式 `sha256(DASHCAM_TOKEN_HEADER_PREFIX + tokens.key)[:12]`；软删除 token 保留；无权限降级不报错；`key` 不出函数作用域 |
| `normalize.ts` | 四协议 × JSON/SSE → 统一信封（见 §5） |
| `thread.ts` | 会话线程增量（见 §6） |
| `usage.ts` | token 读时水合（见 §7） |

## 5. 归一化规则要点

| 形态 | 解析 |
|---|---|
| 内容形态判定 | 代理不落响应头，按首字符：`{`/`[` → JSON；`data:`/`event:` → SSE；其余 raw |
| JSON 错误体（D3） | 顶层 `error` → `response.error`，`outputs: []`，不视为解析失败 |
| SSE | 空行切事件；`delta.content` 追加、`delta.tool_calls[i]` 按 `index` 聚合（arguments 字符串拼接）；`usage` 取最后一个带 usage 的块 |
| Anthropic SSE | `message_start` 取 input/cache 字段，`message_delta` 取 output —— 跨事件合并；`input_json_delta.partial_json` 拼接 |
| 图片 | 只留 `mime` / `bytes` / `sha256`，base64 不落正文；外部 URL 不入信封 |
| 截断/坏正文 | `parse_error` 标注原因，raw 兜底，不抛异常 |

工具定义只保留 `name` / `description`；`seq` 全局递增、`message_index` 保留原始序号。

## 6. 会话聚合与线程增量

**问题**：多轮客户端每轮重发完整历史 → 列表几十行同会话、详情前 90% 是重复上下文。

**聚合契约**（采集侧 `capture.go`，只存哈希不存原文）：

| 协议 | 会话键来源 |
|---|---|
| `openai-chat` / `openai-responses` | 请求体 `prompt_cache_key` |
| `anthropic-messages` | `metadata.user_id` 内的 `session_id` |
| 其他 | 无键，不聚合，各自成行 |

索引 `k = sha256(key)[:16]`。不串协议兜底：字段语义来源不同，混用会把同一用户的两个会话误并。

**增量算法**（`dashcam/thread.ts`）：

1. 逐条消息做内容签名 `sha1(role, kind, text, tool.*, image.sha256)`（不用 `seq`——那是信封内局部序号，跨轮不可比）；
2. 取最长公共前缀 `lcp`；
3. `lcp ≥ 上一轮条数` → 连续，新增 = 当前请求 `slice(lcp)`；否则不连续（历史被裁剪 / 并发分支 / 换键），整段按完整上下文展示并明确提示；
4. 上一轮正文不可读 → 降级展示全部上下文并标注原因。

不做「过滤开头 assistant 块」类启发式：工具循环里 assistant/tool 块就是本轮新增。展示侧把开头的 system / 上一轮回答归入「上下文回放」默认折叠。

**成本**：列表读索引 1–2 天；开线程 0 读；展开一轮 3 个文件（上一轮 req + 本轮 req/res）按需触发。线程上限 `MAX_THREAD_TURNS = 200`；聚合扫描预算 `MAX_GROUP_SCAN_REQUESTS = 10000`，超出置 `partial` 提示收窄。

**安全**：详情接口 `prev` 额外要求 `trace + 指纹 + 会话键` 三者同时相等，防止客户端复用 `X-Request-Id` 时差分串台。

## 7. token 用量链路（2026-11-14）

| 环节 | 机制 |
|---|---|
| 采集端 | `dashcam/usage.go` 落索引前提取 usage，索引行 `pt/ct/cc/cw`（见 [02-design.md](02-design.md) §5 契约） |
| 看板展示 | **索引字段是唯一权威来源**：请求行 / 线程轮次直接带 `usage`；详情接口用索引覆盖正文解析结果 |
| 旧数据兜底 | 索引无字段时对当前页可见行读时水合（`src/server/dashcam/usage.ts`，预算 `DASHCAM_USAGE_HYDRATE_MAX=100`，8 并发，30s 缓存含负缓存） |
| 会话聚合行 | **不显示 token**：累计需读全部正文（成本随轮次线性），线程/详情按需展示 |
| 防漂移 | 契约样例 `dashcam/testdata/usage/` 由 Go 与 TS 测试共用；契约测试发现并修复了 TS 丢失 Anthropic 流 `cache_creation_input_tokens` 的既有 bug |

展示形态：输入（蓝）/ 输出（绿）定宽胶囊 + 琥珀「缓存 N」标签（`cachedTokens > 0`）；字节保留在悬停 title 与详情页签。

## 8. 界面形态

| 位置 | 形态 |
|---|---|
| 用户详情 · 会话卡片 | 聚合（默认）/ 按请求切换；页码翻页 20/50/100；日期下拉（自实现轻量日历，零依赖）；右上「完整列表」新窗口打开独立页 |
| 独立列表页 `/users/[id]/sessions` | 仅标题 + 列表；无全局时间选择器与返回按钮；整页单滚动区（表格 sticky 表头），累加加载（上限 500） |
| 线程抽屉 | 轮次时间线，最后一轮默认展开；每轮「本轮输入 / 上下文回放 / 本轮响应」；角色 / 类型 chips + 关键词过滤条（与详情抽屉共用 `MessageFilterBar`）；全屏切换 |
| 详情抽屉 | 结构化 / 原始报文 / 事件流（流式才有）三页签；请求默认只展开最后 3 条上下文；角色 / 类型 / 关键词过滤；全屏切换 |

实现要点：

- sticky 表头需 `<table>` 用 `border-separate`（Preflight 的 `border-collapse` 会让 sticky 失效），且内层 `table-container` 的 `overflow-x-auto` 让位给外层滚动容器；
- 日期一律 `YYYY-MM-DD` 字符串比较，不碰本地时区；日历弹层的外点关闭需排除 Radix portal（`[data-radix-popper-content-wrapper]`），月 / 年下拉必须非模态（模态下拉把 body 设为 `pointer-events:none`，点相邻触发器会被外点关闭逻辑误杀）；
- 程序化点击前必须等 React 水合（DOM 挂 `__reactProps*`）；Radix 触发器用真实鼠标事件；
- 筛选条件变化时页码重置为 1。

## 9. 部署配置（看板侧新增）

```ini
DASHCAM_DIR=                          # 空 = 功能关闭，/api/dashcam/* 返回 available:false
DASHCAM_TOKEN_HEADER_PREFIX=Bearer sk-  # 指纹重构前缀，必须与实际 Authorization 形态一致
DASHCAM_MAX_WINDOW_DAYS=31            # 列表时间窗上限（天）
DASHCAM_MAX_BLOB_BYTES=16777216       # 单文件读取上限（解压后）
DASHCAM_RAW_PREVIEW_BYTES=262144      # 原始报文预览上限
DASHCAM_CACHE_TTL_MS=30000            # 索引解析缓存 TTL
DASHCAM_INDEX_CACHE_MAX_ENTRIES=20000 # 超过不缓存（防大日文件撑爆 LRU）
DASHCAM_USAGE_HYDRATE_MAX=100         # 单次请求读时水合的正文上限
```

无新依赖（`node:fs/promises`、`node:zlib`、`node:crypto`、现有 `lru-cache`）。数据库需一次授权：`GRANT SELECT ON tokens TO <dashboard_readonly>;`（代码不执行，缺权限降级不报错）。

## 10. 风险与处理

| # | 风险 | 处理 |
|---|---|---|
| R1 | 128 MiB 正文解压可达数 GB 内存 | `DASHCAM_MAX_BLOB_BYTES` 16 MiB 硬顶，超出截断标注 |
| R2 | 跨天窗口扫描成本（31 天 ≈ 34 MB） | 默认窗口 + 30s 按天缓存 + 聚合扫描预算 |
| R3 | 索引按天追加，请求级 cursor 翻页漂移 | 聚合改「全量分组 + offset 切片」；请求模式页码翻页 |
| R4 | 同日同名 trace（客户端复用 X-Request-Id） | 列表带 `fp`；详情多条 409 |
| R5 | 无效 / 匿名 key 不可归属 | `unmatched` 计数提示；不做全局会话视图 |
| R6 | `tokens.key` 需读权限且属敏感材料 | 前置授权；只留 sha256 前 12 位；降级时 UI 明示 |
| R7 | 指纹前缀漏配 | 表现为查不到（不会错配）；前缀 env 化 |
| R8 | `path.resolve` 不做 realpath | 三段正则已排除分隔符；软链需先能在记录目录内创建（采集侧不建） |
| R9 | 大正文 JSON 传输 | raw 默认截断到 `DASHCAM_RAW_PREVIEW_BYTES` |

明确不做：全文检索、跨用户浏览、导出、删除、`logs` 关联、写入任何文件。

## 11. 实测验证

| 用例 | 期望 | 结果 |
|---|---|---|
| 列表按用户过滤 / unmatched | user_id=5 命中，无效指纹被排除并计数 | ✅ |
| 非流式 / SSE / gzip / 截断 / 401/503 | 解析与渲染符合 §5 规则 | ✅ |
| 同指纹同会话键聚合 | 合并一行，`requestCount` 正确 | ✅ |
| 跨用户同会话键 | 各自只看自己的轮次 | ✅ |
| 增量：连续 / 裁剪 / 缺失 | `lcp` 与提示语符合 §6 规则 | ✅ |
| 聚合翻页 71 会话 4 页 | 页间无重复 key | ✅ |
| token：索引驱动 + 契约 | 行级 usage 来自索引；契约样例两侧一致 | ✅ |
| 日期过滤 / 非法日期 | 400 `invalid_query` | ✅ |

## 12. 已知限制

| 限制 | 说明 |
|---|---|
| 会话键依赖客户端透传 | 不带键的客户端永远不聚合（设计选择，宁少聚合） |
| 跨零点会话在窄区间只显示一半 | 看板只对所选区间负责 |
| 旧索引无 token 字段 | 显示 `—` 或走读时水合；存量回填未实现 |
| 会话累计 token 不展示 | 需读全部正文；采集端索引字段齐全后可免费求和，待 UI 评估 |
| 全文检索未实现 | 需遍历 blob；如成刚需另建 SQLite 索引 |
| 过期数据清理未实现 | 见 [06-performance-plan.md](06-performance-plan.md) D-P1 |

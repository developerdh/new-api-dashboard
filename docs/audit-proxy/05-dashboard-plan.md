# 看板读取侧实施方案（阶段 A · 已实施）

> **状态：已于 2026-11-13 实施。** 实现与差异以 [02-design.md](02-design.md) §7 为准；本文件保留阶段 A 的取舍依据（尤其是与上游文档的偏差 D1–D6），不再单独维护。

本文件是「用户提示词与返回结果」查看界面的实施设计，批准后才进入编码。权威设计仍是 [02-design.md](02-design.md) §7；本文件给出落地契约、与实现的偏差，以及实测依据。

**结论**：文件读取层独立于 `getDb()`（新增 `src/server/audit/`），用户维度映射走只读查询层（新增 `src/server/queries/audit-tokens.ts`），两个 Route Handler 复用现有登录守卫，界面在用户详情页新增「会话」卡片 + 右侧抽屉。不写库、不加豁免、不改采集侧。

---

## 0. 实测核验结果与文档偏差（需先确认）

在测试机实际核对（10 条样本 + 线上 `tokens` 表），发现 6 处需要记录或修正的地方。**本文件不改动上游文档**，仅登记。

| # | 位置 | 问题 | 处理建议 |
|---|---|---|---|
| D1 | `02-design.md` §4.1 | trace 校验写 `^[A-Za-z0-9._-]{8,64}$`，但 `capture.go` 的冲突后缀是 `trace + "-" + 6hex`，**实际最长 71**。读取侧若按 64 校验，客户端复用 `X-Request-Id` 重试产生的文件将永久无法打开 | 读取侧放宽到 `{8,71}`，文档同步更正 |
| D2 | `02-design.md` §4.2 | 只说「用指纹反查 `tokens.key`」，没写拼接规则。实测 `tokens.key` 不含 `sk-`，指纹是对**完整 Authorization 头**哈希 | 读取侧用可配置前缀（默认 `Bearer sk-`）+ key 重构，文档补一句 |
| D3 | `02-design.md` §7.4 | 信封只覆盖「正常 JSON」与「正常 SSE」。实测 10 条样本中 3 条是 `{error:{...}}`（401/503），1 条 `tr=1` 截断导致 JSON 不完整 | 信封增加 `response.error` 与 `parse_error`/`raw` 兜底 |
| D4 | `02-design.md` §8 | 关联 `logs.request_id` 的前提是「响应头回传 `X-Oneapi-Request-Id`」，但 `capture.go` **只落 body 与索引，不落任何响应头** → 该关联在本版本数据结构下不可能实现 | 本阶段不做关联；如需，必须先改采集侧（超出本任务范围） |
| D5 | `README.md` 实现状态表 / `02-design.md` §7 标题 | 实现后需从「未实现」改为已实现 | 已随实现更新 |
| D6 | `02-design.md` §7.1 | 列了可选 `DELETE` 路由 | 本阶段不做（不写文件）；实现后在文档标注「不计划」 |

另外确认两条数据事实：

- 指纹公式已验证：测试机 `tokens.id=1`（`user_id=1`，`key` 48 字符无 `sk-`），`sha256("Bearer sk-" + key)[:12] = dbbbf1891a47`，与索引 `u`、`blobs/<date>/dbbbf1891a47/` 完全一致。
- 另一指纹 `dfdb90cb0057`（401 样本）对应无效 key，**查不到任何 token**。这类会话按用户维度不可见，界面需给解释而不是静默丢弃。

---

## 1. 路由设计

统一响应信封沿用 `src/server/http.ts` 的 `{ ok, data, meta }` / `{ ok:false, error:{ code, message, issues? } }`。错误码由 audit 层自带 helper 生成（不改 `ApiErrorCode` 联合类型，避免动既有契约文件）：

| code | HTTP | 场景 |
|---|---|---|
| `invalid_query` | 400 | traceId/date/userId/limit/窗口非法 |
| `not_found` | 404 | 索引无此 trace，或 trace 不属于该用户（两者同一响应，防跨用户探测） |
| `ambiguous_trace` | 409 | 同一天同名 trace 命中多条（不同指纹）且未提供 `fp` |
| `audit_unavailable` | 200（`available:false`） | `AUDIT_DIR` 未配置或不可读；不报错，前端展示提示条 |
| `audit_read_failed` | 500 | 文件系统异常（不回显路径与 errno 细节） |

### 1.1 `GET /api/audit/sessions`

| 参数 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `userId` | int | 是 | 正整数（复用 `parseUserId` 口径） |
| `start` / `end` | Unix 秒或 ISO | 是 | 左闭右开；`end-start ≤ AUDIT_MAX_WINDOW_DAYS`（默认 31 天），否则 400 |
| `model` | string | 否 | `MODEL_NAME_PATTERN`（复用查询层常量） |
| `status` | int | 否 | 100–599 |
| `stream` | `true`/`false` | 否 | 按索引 `st` 过滤 |
| `limit` | int | 否 | 1–200，默认 50 |
| `cursor` | base64url | 否 | 日期 + 时间 + trace + 指纹编码，服务端不可解释时 400 |

> 与 `02-design.md` §7.1 的差异：参数名用 `start`/`end` 而非 `from`/`to`，与看板其余接口及 `TimeRangePicker` 一致（D-新，见 §7 决策点 1）。

响应 `data`：

```ts
{
  available: boolean;              // AUDIT_DIR 是否可用
  sessions: AuditSessionRow[];
  nextCursor: string | null;       // null = 无更多
  scannedDates: string[];          // 实际读过的索引日期（排障用）
  fingerprintCount: number;        // 该用户可用的 token 指纹数
  unmatched: number;               // 区间内命中但指纹不属于本用户而被过滤掉的条数（仅当 >0 返回）
}
```

`AuditSessionRow`：

```ts
{
  traceId: string; fp: string;         // fp 由列表返回，详情仅用于消歧
  startedAt: string;                   // 原样 RFC3339Nano（东八区），前端只做展示
  startedAtEpoch: number;              // Date.parse 后转秒，便于排序/格式化
  date: string;                        // 索引日期 YYYY-MM-DD（详情必传，避免客户端自己推）
  path: string; protocol: AuditProtocol; model: string;
  status: number; stream: boolean;
  durationMs: number; firstTokenMs: number;
  requestBytes: number; responseBytes: number;
  requestTruncated: boolean; responseTruncated: boolean;
  gzip: { request: boolean; response: boolean };
  error?: string;                      // 索引 e 字段
}
```

实现要点：只读 `index/<date>.ndjson`，不打开任何 blob；按日期**倒序**扫描，命中数达到 `limit+1` 即停（`limit+1` 用于判断 `nextCursor`）。

### 1.2 `GET /api/audit/sessions/[traceId]`

| 参数 | 必填 | 规则 |
|---|---|---|
| `traceId`（路径段） | 是 | `^[A-Za-z0-9._-]{8,71}$`（D1） |
| `date` | 是 | `^\d{4}-\d{2}-\d{2}$` |
| `userId` | 是 | 详情鉴权：条目 `u` 必须属于该用户的指纹集合，否则 404 |
| `fp` | 否 | 同日同名 trace 多条时消歧；提供时须与该条 `u` 相等 |
| `include` | 否 | `raw` = 额外返回原始报文（受 `AUDIT_RAW_PREVIEW_BYTES` 限制） |

响应 `data`：`02-design.md` §7.4 信封（实现见 §3）+ 可选 `raw`。

鉴权与防穿越双保险：

1. `traceId`/`date`/`fp` 三段正则白名单（`fp` 只允许 `^[0-9a-f]{12}$|^_anon$`）；
2. 拼接后用 `path.resolve` 得到绝对路径，断言以 `path.resolve(AUDIT_DIR)` + `path.sep` 为前缀；任一不满足直接 404（不回显期望路径）。

`traceId` 的解码：路径段可能被 URL 编码（`%2e%2e`），先 `decodeURIComponent` 再校验——与 `/api/snapshots/[file]` 现有范式一致。

### 1.3 不做的路由

- `DELETE /api/audit/sessions/[traceId]`：看板对审计目录只读（`:ro` 挂载），不实现（D6）。
- 任何 `/api/audit/search`：全文检索边界不变（`02-design.md` §7.3）。

---

## 2. 读取层设计（`src/server/audit/`）

四个文件，纯函数 + 显式依赖注入（便于 vitest 直测，不 mock `process.env` 全局）。

### 2.1 `paths.ts` — 根目录、白名单、路径拼接

```ts
auditDir(): string | null                 // AUDIT_DIR?.trim() || join(cwd,"data","audit")；空串视为未配置
isAuditAvailable(): Promise<boolean>      // 目录存在且可 readdir（失败即 false，不抛）
auditIndexPath(date): string              // <root>/index/<date>.ndjson
auditBlobPath({date,fp,trace,kind,gz}): string
assertInsideRoot(root, candidate): string // resolve + sep 前缀校验，失败抛 AuditPathError
isTraceId / isAuditDate / isFingerprint
listIndexDates(from,to,maxDays): string[] // 按东八区自然日枚举（复用 shanghaiDate/addShanghaiDays）
```

约束：

- 日期枚举上限 `AUDIT_MAX_WINDOW_DAYS`，超限抛 `invalid_query`（不是静默截断，避免"看不到数据"被误判为无数据）。
- `assertInsideRoot` 只做**字符串层**判断，不 `realpath`：目标是防穿越而非防软链；`realpath` 会在 NFS/容器挂载上引入额外失败面（取舍记录在 §6）。
- 不提供任何 `write`/`mkdir`/`rm` 能力，模块内也不 import 写 API。

### 2.2 `index.ts` — 索引扫描

```ts
interface AuditIndexEntry { t,u,d,p,m,s,st,ms,ft,rq,rs,qz,rz,tr,e?,ip? }  // 与 capture.go 一一对应，不重命名

readIndexDay(date): Promise<{ entries: AuditIndexEntry[]; badLines: number; partialTail: boolean }>
scanSessions(input): Promise<{ rows: AuditSessionRow[]; nextCursor: string | null; scannedDates: string[] }>
```

- **逐行解析 + 单行容错**：某行 `JSON.parse` 失败只计数 `badLines`，不影响其余行（索引由 `O_APPEND` 追加，进程崩溃可能留半行）。
- **末尾半行**：文件不以 `\n` 结尾时丢弃最后一段（正在写入中），不报错。
- **不做全量加载进缓存后长期持有**：单日索引约 1.1 MB / 5.6k 行，短 TTL（`AUDIT_CACHE_TTL_MS`，默认 30s）缓存**已解析条目**；条目数 > `AUDIT_INDEX_CACHE_MAX_ENTRIES`（默认 20000）时跳过缓存，避免大日文件把 LRU 撑爆。
- 排序：`d` 倒序（同 `d` 用 `t` 兜底），保证跨日翻页稳定；cursor 编码 `<date>\|<d>\|<t>\|<fp>`（base64url），下一页从该条之后继续，**不做 offset 分页**（索引按天追加，offset 会因新数据漂移）。
- 过滤顺序：日期 → 指纹集合 → `st`/`s`/`m` → limit。
- 只读文件不存在（`ENOENT`）视为「该日无数据」，不是错误；其余 errno 归 `audit_read_failed`。

### 2.3 `reader.ts` — blob 读取与解压

```ts
readAuditBlob({ date, fp, trace, kind, gzip }): Promise<{ text: string; bytes: number; gzip: boolean; capped: boolean }>
```

| 场景 | 行为 |
|---|---|
| `qz/rz = false` | 直接 `open` + 读 `min(size, MAX)` 字节 |
| `qz/rz = true` | 读整文件（上限 `AUDIT_MAX_BLOB_BYTES`）→ `gunzip(buf, { maxOutputLength })` |
| 索引标记与实际文件不符（`.gz` 缺失或反之） | 先按标记读；`ENOENT` 时按另一后缀重试一次，成功则记 `gzip` 实际值（兼容索引先于 rename 完成的极小窗口） |
| 解压后超过 `AUDIT_MAX_BLOB_BYTES` | `maxOutputLength` 抛 `ERR_BUFFER_TOO_LARGE` → 截断读取并 `capped: true`（防 zip bomb，也防 128 MiB 正文撑爆进程） |
| 文件仍为 `.tmp`（采集中断） | 索引里没有该条，详情不可达；不做特殊处理 |

默认上限：`AUDIT_MAX_BLOB_BYTES = 16 MiB`（单文件，解压后）。超过则返回截断文本 + `capped`，界面显式标注「正文超过读取上限，仅显示前 16 MiB」。

### 2.4 `tokens.ts`（位于 `src/server/queries/`，只读数据库）

> 放在查询层而不是 `src/server/audit/`：`audit/` 必须与 `getDb()` 完全隔离（硬约束），指纹反查是数据库职责。

```ts
loadTokenFingerprints(): Promise<{
  byFp: Map<string, { tokenId: number; userId: number }>;
  byUser: Map<number, string[]>;
  ok: boolean;                 // tokens 表不可读时为 false
  error?: "permission_denied" | "unavailable";
}>
```

- 用 `sql\`select id, user_id, key from tokens where key is not null\``（Kysely 原始模板，**不往 `schema.ts` 的 `Database` 里加 `tokens`**，保持「三表」声明面；也不写 `information_schema` 探测，首次失败即降级并缓存 5 分钟）。
- 指纹：`createHash("sha256").update(process.env.AUDIT_TOKEN_HEADER_PREFIX ?? "Bearer sk-" + key).digest("hex").slice(0,12)`。
- **软删除的 token 必须保留**（`deleted_at is not null` 也参与映射）：历史请求仍属于该用户。
- 进程内缓存 60s；`key` 只用于计算指纹，**不出函数作用域、不进日志、不进响应**。
- `ok=false` 时列表返回 `available:true` + `fingerprintCount:0`，界面提示「无法反查 token 指纹（缺少 tokens 表读权限）」。

权限前提（运维动作，需在部署文档说明）：`GRANT SELECT ON tokens TO <dashboard_readonly>;`。未授权时功能可用性下降但不报错——这是本方案对「只读账号可能无 tokens 权限」的兜底。

---

## 3. 归一化设计（`normalize.ts`）

目标结构按 `02-design.md` §7.4，本文件补齐 D3 的两个缺口。

### 3.1 信封

```ts
{
  schema: "newapi.audit.v1",
  trace_id: string,
  request: {
    path: string; protocol: AuditProtocol; model: string; stream: boolean;
    messages: AuditBlock[];                 // 展开后的块序列
    tools?: Array<{ name: string; description?: string }>;  // 工具定义只留名称/描述
    parse_error?: string; truncated: boolean; bytes: number;
  },
  response: {
    status: number; finish_reason?: string;
    outputs: AuditBlock[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { code?: string; type?: string; message?: string };
    stream?: { events: number; done: boolean };
    parse_error?: string; truncated: boolean; bytes: number;
  },
  meta: { truncated: number; latency_ms: number; first_token_ms: number;
          captured_at: string; request_bytes: number; response_bytes: number;
          gzip: { request: boolean; response: boolean }; ip?: string }
}
```

`AuditBlock`（每块一个 `kind`，`seq` 全局递增，`message_index` 保留原始消息序号）：

```ts
{ seq: number; message_index: number; role: "system"|"user"|"assistant"|"tool"|"unknown";
  kind: "text"|"tool_call"|"tool_result"|"image"|"other";
  text?: string;
  tool?: { name?: string; call_id?: string; arguments?: string };
  image?: { mime: string; bytes: number; sha256: string } }   // 不落 base64（02-design §7.4）
```

### 3.2 协议识别

| path | protocol | 请求体 | 响应体 |
|---|---|---|---|
| `/v1/chat/completions` | `openai-chat` | `messages[]` | `choices[0].message` / SSE `choices[0].delta` |
| `/v1/completions` | `openai-completions` | `prompt`（string 或 string[]）→ 转 `messages`（`role:user`） | `choices[0].text` / SSE `choices[0].text` |
| `/v1/messages` | `anthropic-messages` | `system` + `messages[]`（content 可为块数组） | `content[]` 块 / SSE `content_block_delta` |
| `/v1/responses` | `openai-responses` | `instructions` + `input` | `output[]` / SSE `response.output_text.delta` |
| 其他（含索引 `p` 异常） | `unknown` | 仅保留 `raw` 文本 | 同 |

### 3.3 请求侧规则

- `content` 为 string → 一个 `text` 块；为数组 → 逐 part 展开（`text` / `image_url` / `input_image` / `tool_result` 等）。
- `tool_calls[]` → 每个 `tool_call` 块（`name` + `arguments` 原样字符串，不解析）。
- `role: "tool"` → `tool_result` 块，带 `call_id`（`tool_call_id`）。
- 图片：`image_url.url` 以 `data:` 开头 → 解析 `mime`、base64 解码字节长度、`sha256`，**正文丢弃**；外部 URL 只留 `mime:"url"` 与 `bytes:0`，URL 本身不入信封（避免把第三方带签名的链接写进响应）。
- Anthropic `system` 为 string/数组 → 作为 `role:"system"` 块前置，`seq` 从 0 开始。
- `tools[]` 只保留 `name`/`description`，不保留 `parameters` schema（体积与展示价值不成正比）。

### 3.4 响应侧规则

| 形态 | 解析 |
|---|---|
| `content-type` 不可得（代理不落头） | 以**内容首字符**判定：`{`/`[` → JSON；`data:`/`event:` → SSE；其余 → raw |
| JSON 成功 | `choices[0].message`（含 `tool_calls`、`reasoning_content`）、`usage`、`finish_reason` |
| JSON 错误（D3） | 顶层有 `error` → `response.error = { code, type, message }`，`outputs: []`，不视为解析失败 |
| SSE | 按 `/\r?\n\r?\n/` 切事件块，收集 `data:` 多行（`join("\n")`），忽略 `event:`/`id:`/注释行 |
| SSE `[DONE]` | 置 `stream.done = true` 并停止 |
| SSE 增量合并 | `delta.content` 追加到当前 assistant `text` 块；`delta.tool_calls[i]` 按 `index` 聚合（`id`/`name` 取首见，`arguments` **字符串拼接**）；`finish_reason` 取最后非空；`usage` 取最后一个带 `usage` 的块（实测样本以 `choices: []` 的独立块下发） |
| Anthropic SSE | 额外按 `event:` 名分派（`content_block_start`/`delta`/`message_delta`），`input_json_delta.partial_json` 拼接 |
| Responses SSE | 按 `event:` 名分派（`response.output_text.delta` 等），`response.completed` 收尾 |
| 截断（`tr&1`/`tr&2` 或解析失败） | `parse_error` 记 `request_truncated` / `response_truncated` / `invalid_json` / `stream_incomplete`；`raw` 兜底（见 §3.5），**不抛异常** |

### 3.5 raw 兜底与体积

- 信封始终不内嵌全量 raw（除 `include=raw`）；`raw.request`/`raw.response` 各截断到 `AUDIT_RAW_PREVIEW_BYTES`（默认 256 KiB）并置 `raw_truncated`。
- 归一化函数为**纯函数**：`normalizeAudit({ entry, requestText, responseText }): AuditEnvelope`，不读文件、不碰 env，便于单测与 fixture 驱动。

---

## 4. 界面设计

### 4.1 位置与结构

用户详情页新增一张卡片，插在「最近使用记录」之后、「使用趋势」之前（同属"明细"语义，且不打断指标与图表的阅读顺序）。

```text
src/app/(console)/users/[id]/
├─ user-client.tsx                 # 仅新增一行 <AuditSessions .../>
├─ audit-sessions.tsx              # 列表卡片（"use client"）
└─ audit-detail-dialog.tsx         # 右侧抽屉
src/components/audit/
└─ message-block.tsx               # 块渲染（text / tool_call / tool_result / image）
```

时间范围继承 URL 的 `start`/`end`（与其它卡片一致，`TimeRangePicker` 切换即时生效）；卡片自身提供「流式/全部」「状态码」两个快捷筛选，不引入新的全局状态。

### 4.2 列表

| 列 | 内容 |
|---|---|
| 时间 | `formatDateTime(startedAtEpoch)` |
| 模型 | `model`（超长截断 + title） |
| 状态 | `status`，非 2xx 用 destructive 徽标 |
| 形态 | 流式 / 非流式；截断时追加「截断」徽标（`tr` 位） |
| 耗时 | `durationMs` / 首字 `firstTokenMs`（流式才有意义，非流式显示 `—`） |
| 大小 | `requestBytes → responseBytes`（紧凑格式，gzip 时加 `·gz`） |

- 分页：「加载更多」+ `nextCursor`；顶部显示「已加载 N 条（区间内可能更多）」。
- 状态：`available:false` → 灰底提示「审计正文未启用（未配置 AUDIT_DIR）」；`sessions:[]` → 「所选区间内无采集记录」；`fingerprintCount:0` → 「该用户没有可用 token 指纹，无法定位采集记录」；`unmatched>0` → 底部小字「另有 N 条记录无法归属到该用户（无效或已失效 key）」。
- 行点击 → 打开抽屉，请求 `?date=&userId=&fp=`。

### 4.3 抽屉（复用现有 `ui/dialog`，右侧满高，`w-full sm:max-w-3xl`）

```text
┌─ 头部：时间 · 模型 · 状态徽标 · 流式/截断徽标 · 关闭 ─┐
│ 元信息：trace / 路径 / 耗时 / 首字 / 大小 / gzip / ip │
├─ Tabs: 结构化 | 原始报文 ────────────────────────┤
│ 请求                                              │
│   system  「…」                                   │
│   user    「…」                                   │
│   tool_call  name(args)  ← 代码块，可折叠            │
│ 返回                                              │
│   assistant 「…」（SSE 已拼接为完整文本）             │
│   usage 12 / 9 / 21 · finish_reason=stop          │
│ 错误时：红色区块，展示 error.code/type/message       │
└──────────────────────────────────────────────┘
```

- 工具调用单独渲染：`name` 作标题、`arguments` 原样 JSON 字符串放 `pre`（不 `JSON.parse` 美化，避免参数被截断时二次失败），`tool_result` 按 `call_id` 与对应 `tool_call` 视觉成对。
- 原始报文页签：等宽字体、`whitespace-pre-wrap`、**虚拟化不做**，但超过 64 KiB 时默认折叠为前 8 KiB + 「展开全部（可能卡顿）」确认。SSE 原始报文额外提示「共 N 个事件、已拼接」。
- 图片块：只显示 `mime · bytes · sha256 前 8 位`，不渲染图片（正文未落 base64，见 §3.3）。
- `parse_error` 存在时顶部黄色提示条，说明「正文可能不完整（原因）」，不给"修复"入口。

### 4.4 数据获取

复用 `useApi`：

```ts
const list = useApi<AuditSessionList>(`/api/audit/sessions?userId=...&start=...&end=${range.end}&limit=50`);
const detail = useApi<AuditSessionDetail>(openTrace === null ? null : `/api/audit/sessions/${trace}?date=...&userId=...&include=raw`);
```

`useApi` 已处理 401 跳登录、`no-store`、loading/error；抽屉内「重试」调 `refresh()`。

---

## 5. 部署所需改动

### 5.1 `.env.example` 新增（含默认值与说明）

```ini
# 审计正文目录（audit-proxy 的 AUDIT_DIR，只读挂载）。
# 留空 = 该功能关闭：/api/audit/* 返回 available:false，页面显示提示条而不报错。
AUDIT_DIR=

# 指纹重构前缀：完整 Authorization 头的固定前缀（tokens.key 不含 sk-）。
# 代理对「完整 Authorization 字符串」做 sha256，故这里必须与实际调用方发送的头一致。
AUDIT_TOKEN_HEADER_PREFIX=Bearer sk-

# 列表时间窗上限（天）与单页上限；与采集侧建议保留 90 天无关，属查询保护。
AUDIT_MAX_WINDOW_DAYS=31
AUDIT_PAGE_SIZE_MAX=200

# 单文件读取上限（解压后，字节）；超出截断并标注。
AUDIT_MAX_BLOB_BYTES=16777216
# include=raw 时原始报文预览上限（字节）。
AUDIT_RAW_PREVIEW_BYTES=262144

# 进程内缓存：索引解析结果 TTL；条目数超过阈值不缓存（防大日文件撑爆 LRU）。
AUDIT_CACHE_TTL_MS=30000
AUDIT_INDEX_CACHE_MAX_ENTRIES=20000
```

不新增依赖：`node:fs/promises`、`node:zlib`、`node:crypto`、`node:path`、现有 `lru-cache`。

### 5.2 挂载与权限

`docker-compose.yml` 的 `dashboard.volumes` 增加 `./data/audit:/app/data/audit:ro`（与 `03-deployment.md` §4.2 已给出的片段一致）。裸机部署：看板运行用户加入 `audit` 组（`03-deployment.md` §4.1 已写）。

数据库侧需一次授权（**运维动作，代码不执行**）：

```sql
GRANT SELECT ON tokens TO dashboard_readonly;
```

### 5.3 不动的部分

`audit-proxy/`、`src/proxy.ts`（不加豁免）、`src/server/db.ts`、`src/server/schema.ts`、数据库结构、nginx。

---

## 6. 风险与取舍

| # | 风险 | 影响 | 处理 |
|---|---|---|---|
| R1 | 128 MiB 正文（上限内合法） | 解压 + JSON 解析可能数 GB 瞬时内存 | `AUDIT_MAX_BLOB_BYTES` 默认 16 MiB，`gunzip maxOutputLength` 硬顶；超出截断并标注 |
| R2 | 跨天窗口扫描成本 | 31 天 × 1.1 MB ≈ 34 MB/次，最坏秒级 | 默认窗口 31 天（页面通常 1–7 天）、按天缓存 30s、命中 `limit+1` 即停 |
| R3 | 索引按天追加，offset 分页会漂移 | 翻页重复/漏行 | cursor 用「日期 + 时间 + trace + 指纹」编码，不用 offset |
| R4 | 同日同名 trace 多条（客户端复用 `X-Request-Id`） | 详情歧义 | 列表带 `fp`；详情无 `fp` 且命中多条 → 409 提示重选 |
| R5 | 索引 `t` 因冲突带 `-` 后缀，长度可达 71 | 按 64 校验会永久打不开（D1） | 读取侧放宽到 71 |
| R6 | 无效/匿名 key 的采集（`_anon` 或查不到的指纹） | 无法归属用户，天然不可见 | 列表底部提示 `unmatched` 计数；不做"全局会话"视图（越权面更大） |
| R7 | `tokens.key` 需读权限，且属敏感材料 | 权限不足则功能降级；密钥进入进程内存 | 授权为前置条件；只保留 sha256 前 12 位，key 不出函数、不落日志；降级时 UI 明示 |
| R8 | 指纹前缀写死会全量对不上 | 换了 header 形态（如 `x-api-key`）后列表恒空 | 前缀做成 env；启动/首次查询时若 `fingerprintCount>0` 但区间内 `unmatched` 占比 100%，在 `meta` 里带回提示（不写日志正文） |
| R9 | 无响应头落盘 | 无法与 `logs.request_id` 关联（D4） | 本阶段不做关联；界面不展示"关联日志"入口，避免给假承诺 |
| R10 | 保留策略未实现 | 过期日目录缺失 → 列表空、详情 404 | 只读侧按"无数据"处理；清理脚本仍属采集侧待办 |
| R11 | `path.resolve` 不做 `realpath` | 理论上软链可指向目录外 | 三段正则已排除分隔符，穿越需先能在审计目录内建软链（采集侧不建）；`realpath` 在容器/NFS 上引入新失败面，暂不做 |
| R12 | `cacheComponents` 与 Route Handler | 误写 `dynamic` 会破坏构建 | 统一 `await connection()`，与 `/api/health` 一致 |
| R13 | 大正文经 JSON 响应传输（`include=raw`） | 单次响应可达数 MB | raw 默认不返回；启用时按 `AUDIT_RAW_PREVIEW_BYTES` 截断 |

明确不做：全文检索、跨用户浏览、导出、删除、`logs` 关联、写入任何文件。

---

## 7. 需要你确认的决策点

| # | 决策点 | 建议 |
|---|---|---|
| 1 | 列表参数名 `start`/`end`（偏离 `02-design.md` §7.1 的 `from`/`to`） | 采用 `start`/`end`，并同步更正文档 |
| 2 | 指纹反查需 `SELECT tokens` 权限 + 读 `key` | 接受；无权限时降级为「无法定位」而非报错 |
| 3 | 详情越权（trace 不属于该用户）返回 404 而非 403 | 采用 404（不泄露存在性） |
| 4 | 单文件读取上限默认 16 MiB、raw 预览 256 KiB | 采用默认值，可用 env 放宽（上限 128 MiB 与采集侧对齐） |
| 5 | 阶段 B 末尾同步 `README.md` 状态表、`02-design.md` §4.1/§4.2/§7、`AGENTS.md` 文档表 | 已获批并完成 |
| 6 | 是否改 `docker-compose.yml` 加 `:ro` 挂载 | 建议改（否则容器部署读不到数据） |

---

## 8. 阶段 B 实施顺序（批准后执行）

| 步骤 | 产出 | 验证 |
|---|---|---|
| 1 | `audit/types.ts` + `audit/paths.ts` | vitest：穿越、非法 trace/date/fp、日期枚举上限 |
| 2 | `audit/index.ts` | vitest：NDJSON 半行、坏行、过滤、cursor 翻页、跨日顺序 |
| 3 | `audit/reader.ts` | vitest：`qz/rz` 四种组合、`.gz` 缺失回退、`maxOutputLength` 截断 |
| 4 | `audit/normalize.ts` | vitest：chat JSON / chat SSE（含 `usage` 独立块与 `[DONE]`）/ Anthropic / Responses / 错误体 / 截断 JSON |
| 5 | `queries/audit-tokens.ts` | 单测：指纹公式（含前缀可配）、软删除保留、权限失败降级 |
| 6 | 两个 Route Handler | 手工：400/404/409/降级分支 |
| 7 | 界面（卡片 + 抽屉 + 块渲染） | 手工：列表筛选、抽屉、raw 页签、错误态 |
| 8 | `.env.example`（+ compose、文档，按决策点 5/6） | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` |

验收对照（用测试机的 10 条真实样本）：

| 验收项 | 样本 | 期望 |
|---|---|---|
| 列表按用户过滤 | `2026-11-13` 索引 10 条 | `user_id=1` 命中 9 条，`dfdb90cb0057` 被排除（`unmatched=1`） |
| 非流式解析 | `029c5571…` | 请求 2 条消息、返回「这是非流式返回内容」、`finish_reason=stop` |
| SSE 拼接 | `1d666d35…` | 文本拼接为「你好，这是流式响应。」，`usage=14/8/22`，`done=true` |
| gzip | `370d4d3b…`（`qz=true`，`rq=100089`） | 解压成功，`gzip.request=true` |
| 截断 | `b454e49f…`（`tr=1`） | `parse_error=request_truncated`，raw 兜底 + 徽标 |
| 401/503 错误体 | `a180873e…` / `94689017…` | `response.error.code` / `message` 正常渲染 |
| 非法 traceId | `../etc/passwd`、`%2e%2e` | 400，无文件访问 |
| 非白名单路径 | `/v1/models` | 采集侧不落盘（已由 `verify.sh` 覆盖），读取侧无需处理 |

---

## 9. 会话聚合与线程增量（0.1.2 追加，已实施）

### 9.1 问题

同一会话里客户端每轮都把**完整历史**重发一遍，于是：

1. 列表上一屏几十行，其实是同一个会话的几十轮，时间戳只差几秒；
2. 打开任意一行，前 90% 的内容都是重复的上下文，真正的「本轮输入」被埋在最后。

列表层解决不了第 2 个问题，必须在读取层做差分。

### 9.2 数据契约

采集侧（`audit-proxy`，**已改造**）按协议取会话键并**只存哈希**：

| 协议 | 会话键来源 | 说明 |
|---|---|---|
| `openai-chat` / `openai-responses` | 请求体 `prompt_cache_key` | 官方字段，客户端自己透传 |
| `anthropic-messages` | `metadata.user_id` 里的 `session_id`（正则 `[0-9a-f-]{16,64}`） | Claude Code 埋在这里 |
| `openai-completions` / 其他 | 无 | 不猜、不聚合，按请求逐条展示 |

索引新增字段 `k = sha256(key)[:16]`（16 位小写十六进制）。**不存原文**：会话键常带业务标识
（用户名、工单号），落盘即等于把标识写进审计目录；而看板只需要「相等性」判断，哈希足够。

> 为什么不串协议兜底（`prompt_cache_key` 缺失就用 `metadata.user_id`）：
> 两个字段的语义来源不同，混用会把「同一用户的两个会话」误并成一个。宁可少聚合。

### 9.3 接口

| 路由 | 作用 | 读 blob |
|---|---|---|
| `GET /api/audit/sessions?group=session` | 一行一会话（`group=request` 保持原样） | 否 |
| `GET /api/audit/conversations/[sessionKey]` | 会话内全部轮次（时间升序，`prev` 串联） | 否 |
| `GET /api/audit/sessions/[traceId]?prev=&prevDate=` | 单轮正文 + **相对上一轮的增量** | 是（prev 请求 + 本轮请求/响应） |

`group` 两个取值，默认 `request`。无会话键的请求在 `group=session` 下各自成行并标「未聚合」——
聚合是**加成**，不是替代，缺键时行为与改造前完全一致。

### 9.4 增量算法（`audit/thread.ts`）

1. 对两轮请求的消息逐条做**内容签名**：`sha1(role, kind, text, tool.name, tool.arguments, tool.callId, image.sha256)`。
   不用 `seq`/`messageIndex`——那是信封内的局部序号，跨轮不可比；
2. 取最长公共前缀 `lcp`；
3. `lcp >= 上一轮条数` → **连续**，新增 = `当前请求.slice(lcp)`；
   否则 → **不连续**（上下文超限被裁剪 / 并发分支 / 换了会话键），整段按新上下文展示并明确提示；
4. 上一轮 blob 已被清理或解析失败 → 降级为「展示全部上下文」并标注原因，不报错。

不做「去掉开头的 assistant 块」这类启发式：工具循环里 `assistant tool_call` / `tool` 结果
**就是**本轮新增的内容，过滤会把它们吞掉。展示侧的取舍交给界面（开头的 assistant/system
块归入「上下文回放」默认折叠）。

### 9.5 成本

| 操作 | 读文件数 | 说明 |
|---|---|---|
| 列表（20 个会话） | 索引 1–2 天 | 与改造前同阶；按 `limit × 40` 放大请求扫描预算，上限 2000 |
| 打开线程 | 0 | 只读索引 |
| 展开一轮 | 3 | 上一轮 req + 本轮 req + 本轮 res，按需触发 |

线程上限 `MAX_THREAD_TURNS = 200`，超出只保留最近一段并提示「共 N 轮，只展示最近 200 轮」。

### 9.6 安全

会话键由**客户端自带**，知道键就能指定分组，因此 `scanThread` 必须叠加
「指纹 ⊆ 该用户的 key 指纹集合」这一层；详情接口的 `prev` 还额外要求
`trace + 指纹 + 会话键` 三者同时相等，避免客户端复用 `X-Request-Id` 时差分串台。
只认索引里的条目：客户端传什么不算数。

### 9.7 界面

- 列表默认「按会话」：最近一次 / 轮次 / 模型 / 状态 / 起止跨度 / 请求→响应；可切「按请求」；
- 点会话 → 线程抽屉：轮次时间线，**最后一轮默认展开**，其余按需加载；
- 每轮展示「本轮输入」+「本轮响应」，开头的系统提示 / 上一轮回答收进「上下文回放」；
- 增量不可用时明确说明原因，而不是把整段历史当成「本轮新增」展示。

### 9.8 验证

| 用例 | 期望 | 结果 |
|---|---|---|
| 同指纹同会话键 | 合并成一行，`requestCount` 正确，`last` 为最新一轮 | ✅ |
| 跨用户同会话键 | `userId=5` 看 4 轮、`userId=2` 只看自己的 1 轮 | ✅ |
| 连续 3 轮 | `lcp=2 → 4`，`news` 分别为 2 项、2 项 | ✅ |
| 历史被裁剪 | `lcp=0`、`continuous=false`、界面出现「不连续」提示 | ✅ |
| 无会话键 | 独立成行 + 「未聚合」标记 | ✅ |
| 非法会话键 | 400 `invalid_query` | ✅ |

单测：`audit/__tests__/thread.test.ts`（签名、lcp、连续/不连续/上一轮缺失）、
`audit/__tests__/index.test.ts`（`k` 解析、`groupConversations`、`scanThread`）。

### 9.9 已知限制

1. 会话键依赖客户端透传；不带键的客户端（Gemini、老版 SDK）永远不聚合，这是设计选择；
2. 同一会话跨天时，`scanThread` 按查询区间扫描索引，跨零点的会话在窄区间里会只看到一半——
   界面按区间展示，符合「看板只对所选区间负责」的口径；
3. `MAX_GROUP_SCAN_REQUESTS = 2000` 是防御性上限：超长区间 + 高频调用时，聚合结果的
   `hasMore` 可能提前为真，需要缩小时间范围再翻。

---

## 10. 翻页、独立列表页与按日期过滤（0.1.2 追加，已实施）

### 10.1 为什么从「加载更多」改成「翻页」

会话条目会随使用不断增长，累加式列表越滚越长：翻到第 5 屏时既不知道自己看到哪儿，
也没法回到上一段。卡片空间有限，改成**页码翻页**：每页 20 条，可切 50 / 100。

保留累加式，但另开一页：用户详情卡片右上角「完整列表」→
`/users/[id]/sessions`，整页展示、每次追加 20 或 50 条（上限 500）。
两种节奏对应两个动作：卡片上「翻页找某条」，独立页上「往回看一段」。

### 10.2 分页参数与语义

| 参数 | 取值 | 说明 |
|---|---|---|
| `page` | ≥1，默认 1 | 页码，1 基 |
| `limit` | 1–100，默认 20 | 每页条数 |
| `date` | `YYYY-MM-DD` | 指定单个自然日，给了就覆盖 `start`/`end` |

响应新增 `page` / `pageSize` / `total` / `totalPages`，`nextCursor` 已移除。

**为什么聚合模式必须用 offset 而不是 cursor**：会话的排序键是「最后活动时间」，
而 cursor 只能定位单条请求的时间。同一会话的请求可能横跨很长的时间段，用请求级
cursor 翻页会让该会话以更早的最后活动时间在下一页重复出现（实测会重复）。
因此 `scanConversations` 改成「先全量分组、再按 `offset` 切片」，
顺带得到准确的 `total`；代价是每页都重扫索引（索引有 30s 进程内缓存，命中后是内存操作），
用 `MAX_GROUP_SCAN_REQUESTS = 10_000` 兜底，超出置 `partial` 并在界面提示收窄。

请求模式（`group=request`）不做全量扫描，`total` 返回 `null`，界面只显示「第 N 页」；
`下一页` 的可用性靠「本页是否满页」判断，翻到空页时给「回到第一页」。

### 10.3 按日期过滤

审计索引本身就是按天存的文件，所以「选某一天」比「缩小区间」更省：只读那一个
`index/<date>.ndjson`，聚合分组也从「整个区间」缩到「一天」，页码和会话数才准。

- 下拉选项来自当前全局区间内的自然日（东八区，倒序），少于 2 天时不显示该筛选；
- 选了日期后，卡片内的详情/线程抽屉也用当天窗口，不会串到别的日子；
- 日期只是**局部**状态，不进 URL；直接访问独立页时可由 `?date=` 带入一次初值，
  全局区间改动后若该日不在区间内，自动退回「全部日期」。

### 10.4 界面

| 位置 | 行为 |
|---|---|
| 用户详情 · 会话卡片 | 翻页：上一页 / 下一页 + 每页 20/50/100；页脚显示「共 N 个会话 · 第 x / y 页」 |
| 卡片右上「完整列表」 | 新页面 `/users/[id]/sessions`，保留区间/粒度/日期，累加加载 |
| 独立页 | 时间选择器 + 同一套筛选条 + 「每次 20/50」+ 加载更多（上限 500） |

筛选条件变化时页码一律重置为 1，否则会出现「筛得只剩 1 页却停在第 3 页」。

### 10.5 验证

| 用例 | 期望 | 结果 |
|---|---|---|
| 聚合翻页 | 71 个会话、4 页，页间无重复 key | ✅（4 页 key 去重后仍 71） |
| 每页 100 | 一页 71 条，翻页按钮双禁用 | ✅ |
| 日期过滤 | `11-13` 38 个会话、`11-12` 34 个，标签同步 | ✅ |
| 非法日期 | `2026-11-31` → 400 `invalid_query` | ✅ |
| 独立页累加 | 已加载 20 / 34 → 34 / 34 | ✅ |
| 请求模式翻页 | 第 1 页 20 条，越界页返回空并给「回到第一页」 | ✅ |

单测：`audit/__tests__/query.test.ts`（page/limit/date 校验）、
`audit/__tests__/index.test.ts`（offset 翻页、聚合 total 与 offset 切片）。

# 架构与存储设计

本文是 audit-proxy 的设计基线。部署与运维见 [03-deployment.md](03-deployment.md)，取舍理由见 [04-decisions.md](04-decisions.md)。

## 1. 总体架构

```text
client
  │
  ▼
nginx :443 ──── location /v1/ ────┬──► audit-proxy :8090 ──► new-api :3000
                                  │         │
                                  │         └── 写 data/audit/blobs、data/audit/index
                                  │
                                  └──►（backup，代理不可用时直连）

dashboard :3088 ── 读 data/audit（:ro 挂载）── 渲染会话
```

三个进程职责严格分离：

| 进程 | 职责 | 不做 |
|---|---|---|
| audit-proxy | 透传、按白名单落盘、写索引 | 不解析 JSON、不做归一化、不连数据库 |
| new-api | 鉴权、计费、路由 | 不感知采集存在 |
| dashboard | 读文件、归一化、展示 | 不写入采集目录（挂载为只读） |

## 2. 采集点为何必须在转发路径上

| 方案 | 能取请求 | 能取响应 | 原因 |
|---|---|---|---|
| `nginx mirror` 旁路 | 是 | **否** | mirror 复制请求；响应只有主请求那一份 |
| 前置代理 | 是 | 是 | 处于转发路径中，双向 body 都经过 |
| eBPF / 抓包 | 是 | 是 | 内核层复制，但无请求关联、运维复杂 |

“要返回内容”与“不进入关键路径”不可同时满足。本设计选择进入路径，并用 nginx failover 把可用性影响压到“只丢采集”。

## 3. 故障域与降级

代理是新增的可用性变量，因此必须显式定义失效行为。

| 场景 | 代理行为 | nginx 行为 | 业务影响 |
|---|---|---|---|
| 进程未启动 / 端口未监听 | — | `max_fails` 命中后切 `backup` 直连 | 无 |
| 审计目录不可写 | 启动成功，仅转发 | 正常转发 | 无 |
| 磁盘写失败 | 记录 `capture_write_failed`，继续转发 | 正常转发 | 无 |
| 上游不可达 | 返回 502 JSON | 按 `proxy_next_upstream` 重试 | 与直连一致 |
| 转发中途进程崩溃 | 请求中断 | 已发送部分响应，无法重试 | 该请求失败（唯一残余风险） |

支撑上述行为的三条实现约束，不可放松：

1. 写盘永远在客户端写入之后，磁盘慢只造成采集延迟。
2. 采集队列有界，满则丢弃并计数，绝不反压转发。
3. 任何采集异常只写日志，不改变响应状态码与内容。

## 4. 存储布局

```text
$AUDIT_DIR/
├─ blobs/
│  └─ 2026-11-13/                 # 按天分目录：便于整目录清理与按日期定位
│     └─ 6981744f7254/            # 调用方指纹：sha256(Authorization) 前 12 位
│        ├─ <trace>.req[.gz]
│        └─ <trace>.res[.gz]
└─ index/
   └─ 2026-11-13.ndjson           # 当天索引，追加写
```

### 4.1 命名规则

| 元素 | 规则 | 说明 |
|---|---|---|
| 日期目录 | 服务端本地时区 `YYYY-MM-DD` | 与运维习惯一致；跨时区部署需固定 `TZ` |
| 调用方目录 | `sha256(Authorization)[:12]`，无凭据时为 `_anon` | 不可逆，不泄露密钥 |
| 文件名 | `<trace>` | 优先取 `X-Trace-Id`，其次 `X-Request-Id`，均无则生成 32 位 hex |
| trace 校验 | `^[A-Za-z0-9._-]{8,71}$` | 同时防路径穿越；冲突后缀（`-` + 6 位随机）会把长度推到 71 |
| 冲突处理 | 追加 `-<6位随机>` 后缀 | 客户端复用同一 `X-Request-Id` 重试时 |
| 扩展名 | `.req` / `.res`，压缩后追加 `.gz` | **不要按后缀猜测**，以索引 `qz` / `rz` 为准 |

### 4.2 不使用 user_id 的原因

New API 不透传用户身份，请求中只有 `sk-...` 形式的密钥，代理无法获知 `user_id`。可选做法有三种，均已否决：

| 方案 | 否决理由 |
|---|---|
| 代理连数据库反查 | 破坏“零外部依赖”，数据库故障会牵连转发 |
| 代理定时拉取 New API 管理接口 | 引入凭据与额外接口依赖，失败路径复杂 |
| 请求头注入用户信息 | 需要在 New API 侧改造，违反“不改 New API” |

因此用调用方指纹代替。指纹与 token 一一对应，而 token 属于某个用户；看板读取时用指纹反查 `tokens.key` 得到 `user_id`，聚合维度不受影响。

拼接规则（看板实现细节，实测确认）：代理哈希的是**完整 Authorization 头字符串**（`strings.TrimSpace` 后的原值），而 `tokens.key` 是 **48 字符、不含 `sk-`** 的密钥本体。因此看板必须拼回前缀再哈希：

```text
fp = sha256("Bearer sk-" + tokens.key)[:12]
```

前缀由 `AUDIT_TOKEN_HEADER_PREFIX` 配置（默认 `Bearer sk-`）。实测：`tokens.id=1 / user_id=1` → `dbbbf1891a47`，与索引 `u`、目录名完全一致。前缀与实际发送形态不一致时表现为**查不到会话**（漏配），不会错配到其他用户。

### 4.3 原子性

写入流程：`<name>.req.tmp` → 关闭 → （可选 gzip）→ `rename` 到 `<name>.req`。
同目录 `rename` 在 POSIX 下原子，读取方不会看到半个文件。索引行在 `rename` 之后追加，避免索引指向不存在的文件。

## 5. 索引格式

每天一个 NDJSON，每行一条请求记录，单次 `write` 追加（`O_APPEND` 下小于 `PIPE_BUF` 的写是原子的，多协程并发安全）。字段名刻意缩短以控制体积。

| 字段 | 类型 | 含义 |
|---|---|---|
| `t` | string | trace id，等于文件名 |
| `u` | string | 调用方指纹，等于二级目录名 |
| `d` | string | 开始时间，RFC3339Nano |
| `p` | string | 请求路径 |
| `m` | string | 模型名，仅从请求体前 8 KB 提取，非完整解析 |
| `s` | int | HTTP 状态码 |
| `st` | bool | 是否流式请求 |
| `ms` | int | 总耗时（毫秒） |
| `ft` | int | 首字节耗时（毫秒）；无输出为 0 |
| `rq` / `rs` | int | 请求 / 响应落盘字节数（截断后的实际值） |
| `qz` / `rz` | bool | 对应文件是否 gzip |
| `tr` | int | 截断位掩码：`1`=请求截断，`2`=响应截断 |
| `e` | string | 上游错误信息，成功时省略 |
| `ip` | string | 客户端 IP |

示例：

```json
{"t":"0123456789abcdef0123456789abcdef","u":"6981744f7254","d":"2026-11-13T09:36:25.0621778+08:00","p":"/v1/chat/completions","m":"gpt-4o-mini","s":200,"st":true,"ms":51,"ft":14,"rq":87,"rs":117,"qz":false,"rz":false,"tr":0,"ip":"127.0.0.1"}
```

### 5.1 为什么索引里没有提示词

索引只存元数据，正文在 blob 文件。这样列表页可以只读一个文件完成分页，无需打开每个 blob；代价是列表无法直接做全文检索，检索需遍历 blob（见 §7.3）。

## 6. 截断、压缩与容量

### 6.1 上限

| 配置 | 默认 | 语义 |
|---|---|---|
| `MAX_REQUEST_BYTES` | 128 MiB | 落盘上限，超出截断并置 `tr` 位；**转发不截断** |
| `MAX_RESPONSE_BYTES` | 128 MiB | 同上 |
| `GZIP_THRESHOLD` | 64 KiB | 超过则压缩，`0` 关闭 |

128 MiB 用于覆盖 1M tokens 上下文（约 4–5 MB JSON）并给多模态留余量。实现为边转发边写盘（`io.TeeReader`），**内存占用与 body 大小无关**，常驻约每请求 64 KiB 缓冲，因此该值属于磁盘防御而非内存防御。

### 6.2 体积估算

以现有规模（约 5.6k 请求/天）推算：

| 项 | 估算 |
|---|---|
| 请求体 | 平均数 KB 至数百 KB，取决于多轮历史 |
| 响应体 | 非流式与最终文本相当；SSE 原始流约为最终文本的 30–40 倍 |
| 压缩 | JSON/SSE 结构重复度高，gzip 后约为原始 8%–15% |
| 索引 | 约 200 B/行，约 1.1 MB/天 |

SSE 必须压缩：不压缩时单日可达数百 MB，压缩后回到数十 MB 量级。

### 6.3 文件数与保留

| 项 | 数量 |
|---|---|
| 每请求文件 | 2（`.req` + `.res`） |
| 每天文件 | 约 1.1 万 |
| 每年文件 | 约 400 万 |

必须配置保留策略，否则 inode 与目录遍历都会劣化。建议按日期目录删除，保留 90 天（约 100 万文件），清理脚本尚未实现。

## 7. 看板读取侧（已实现）

读取层与数据库完全隔离：`src/server/audit/` 只碰文件系统，不 import `getDb()`；指纹反查走 `src/server/queries/audit-tokens.ts`（只读查询层）。

| 层 | 文件 | 职责 |
|---|---|---|
| 路径 | `src/server/audit/paths.ts` | `AUDIT_DIR`、三段白名单、`path.resolve` 前缀校验、东八区日期枚举 |
| 索引 | `src/server/audit/index.ts` | NDJSON 容错解析、跨日扫描、cursor 分页 |
| 正文 | `src/server/audit/reader.ts` | 按 `qz` / `rz` 解压、上限截断、后缀不符回退 |
| 归一化 | `src/server/audit/normalize.ts` | 四协议 × JSON/SSE → 统一信封 |
| 参数/错误 | `src/server/audit/query.ts`、`errors.ts` | 参数校验、错误码收敛（不改动全局 `ApiErrorCode`） |
| 路由 | `src/app/api/audit/sessions/route.ts`、`[traceId]/route.ts` | 列表与详情 |
| 界面 | `src/app/(console)/users/[id]/audit-*.tsx`、`src/components/audit/` | 会话卡片 + 详情抽屉 |

### 7.1 路由

| 路由 | 参数 | 说明 |
|---|---|---|
| `GET /api/audit/sessions` | `userId`（必填）、`start` / `end`（Unix 秒或 ISO，左闭右开）、`model`、`status`、`stream`、`failed`、`limit`（1–200，默认 50）、`cursor` | 读 `index/<date>.ndjson`，按指纹集合过滤，时间倒序 + cursor 翻页 |
| `GET /api/audit/sessions/[traceId]` | `date`（必填）、`userId`（必填）、`fp`（消歧） | 校验 trace/date/fp + 解析前缀，读两个 blob 并归一化；同一天同名 trace 多条返回 409 |

三个约束：

- 参数名用 `start` / `end`（与看板其余接口一致），早期草案的 `from` / `to` 未采用；
- `AUDIT_DIR` 未配置或不可读时列表返回 **200 + `available:false`**（可选能力，不显示成错误态），详情返回 404；
- 不实现 `DELETE /api/audit/sessions/[traceId]`：看板对审计目录只读（`:ro` 挂载），合规删除由运维按目录清理。

三个路由复用现有登录会话守卫（`src/proxy.ts`），不需要豁免。错误语义：`invalid_query`(400)、`not_found`(404，越权与不存在同响应)、`ambiguous_trace`(409)、`audit_read_failed`(500)。

### 7.2 读取路径

```text
用户选择 → 指纹目录 → index/<date>.ndjson 过滤 u → trace 列表（含 m/s/ms/ft）
        → 点击某条 → blobs/<date>/<u>/<trace>.req[.gz] + .res[.gz]
        → 归一化 → 渲染
```

列表页只读索引，不打开 blob；详情页才解压正文。按 `qz` / `rz` 决定是否 gunzip；标记与实际文件不符（索引先于 rename 完成的极小窗口）时回退试另一后缀。

### 7.3 检索边界

| 需求 | 可行性 |
|---|---|
| 某用户某天的会话列表 | 高，单文件顺序扫描（已实现，单日约 1.1 MB，短 TTL 缓存解析结果） |
| 某次请求的完整内容 | 高，直接读两个 blob（已实现） |
| 全库关键词搜索 | 低，需遍历全部 blob；如成为刚需，另建一层 SQLite 索引（仍不写 PostgreSQL） |
| 按模型/状态过滤 | 中，索引已含 `m` / `s`，先过滤再读正文（已实现，另支持 `stream` / `failed`） |

### 7.4 归一化信封（已实现）

代理存原始协议字节，归一化在看板侧完成，避免协议适配改动牵连代理。目标结构：

```json
{
  "schema": "newapi.audit.v1",
  "trace_id": "0123456789abcdef0123456789abcdef",
  "request": {
    "path": "/v1/chat/completions",
    "protocol": "openai-chat",
    "model": "gpt-4o-mini",
    "stream": true,
    "messages": [
      { "seq": 0, "message_index": 0, "role": "system", "kind": "text", "text": "..." },
      { "seq": 1, "message_index": 1, "role": "user", "kind": "text", "text": "..." }
    ],
    "tools": [{ "name": "get_weather", "description": "..." }],
    "truncated": false,
    "bytes": 87,
    "parse_error": "request_truncated"
  },
  "response": {
    "status": 200,
    "finish_reason": "stop",
    "outputs": [
      { "seq": 2, "message_index": 0, "role": "assistant", "kind": "text", "text": "..." }
    ],
    "usage": { "prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21 },
    "error": { "code": "model_not_found", "type": "new_api_error", "message": "..." },
    "stream": { "events": 6, "done": true },
    "truncated": false,
    "bytes": 280
  },
  "meta": { "truncated": 0, "latency_ms": 51, "first_token_ms": 14 }
}
```

设计要点：

- `kind` 区分 `text` / `tool_call` / `tool_result` / `image`，避免纯文本假设丢结构。
- `seq` 显式序号且在整份信封内**全局递增**（请求块在前，响应块续号）；`message_index` 保留原始消息序号。
- `schema` 版本号，协议演进时兼容旧数据。
- 图片 base64 不落正文，仅留 `mime`、`bytes`、`sha256`。
- 错误体（401/503 的 `{error:{…}}`）归入 `response.error`，不视为解析失败；截断或不可解析时给 `parse_error`，原始报文另行返回（受 `AUDIT_RAW_PREVIEW_BYTES` 限制），界面不尝试"修复"。
- 流式响应按 `data:` 行解析；`usage` 常由 `choices: []` 的独立块下发，按最后一个带 `usage` 的块取值。两种形态归一化后结构一致。

### 7.5 与早期规划的差异

| 项 | 规划 | 实现 |
|---|---|---|
| `AUDIT_DIR` 默认值 | 缺省指向 `<cwd>/data/audit` | 仅显式配置时启用（未配置 = 关闭），避免"忘挂载"伪装成"无数据" |
| `include=raw` | 可选返回原始报文 | 始终返回（截断后），界面需要原始报文页签 |
| 分页 cursor | 未定义 | `base64url(JSON)`，毫秒时间戳 + trace + 指纹；秒级会把同一秒的多条压成并列 |
| 仅错误筛选 | 未定义 | `failed=true`（`status >= 400`）；`status` 仍支持精确码 |
| 无法归属统计 | 未定义 | 已扫描日期内 `unmatched` 计数（无效/匿名 key），不受分页早停影响 |

## 8. 与 New API 日志的关联

**v1 不实现关联。** 原方案设想的 `trace ↔ logs.request_id` 依赖 New API 在响应头回传 `X-Oneapi-Request-Id`，但代理**只落 body 与索引，不落任何响应头**——该关联在当前数据结构下拿不到数据。错误响应体里的 `request id: …` 只是文案，不能作为可靠主键。

指纹反查（`tokens.key`）已足以把会话归属到用户，关联日志不是身份判定的一部分，也不应退化为时间窗匹配（那会把弱一致性带进身份判断）。如后续确需关联，前置条件是代理落响应头并写进索引，属采集侧改动。

| 优先级 | 方式 | 状态 |
|---|---|---|
| 1 | trace ↔ `logs.request_id` | 不实现：代理未落响应头 |
| 2 | 指纹 → `tokens.key` → `user_id` | 已实现（确定性相等，无时间窗） |
| 3 | 仅按时间窗近似 | 不使用：会引入错配风险 |

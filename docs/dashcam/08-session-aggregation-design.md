# 会话聚合：客户端识别与策略化会话键提取设计

| 项 | 值 |
|---|---|
| 状态 | **已实施**：2026-11-17 部署内网测试机，通过真实流量与 curl 模拟复验（见 §13） |
| 设计 / 实施 | 2026-11-16 / 2026-11-17 |
| 提交 | `9bde749`（dashcam 表驱动实现）· `056a2b5`（看板解码与展示）· `86d4332`（02-design 索引字段同步） |
| 制品 | dashcam `v0.1.0-dev.264712315` · 看板 `0.2.0-dev.264712315` |
| 关联 | [02-design.md](02-design.md) §5（索引字段）；07-loadtest §7 D6（修复后记录可见但不聚合，引出本设计） |
| 范围 | dashcam 采集代理 + 看板展示；聚合算法（按 `k` 分组）不变 |

本文是会话聚合从「仅请求体提取」升级为「识别客户端 → 按该客户端策略提取」的设计基线与实测记录：识别信号与证据见 §3，数据结构见 §5，请求格式对 dsh 聚合的影响见 §14，限制与已知问题集中列于 §15。部署命令见 [03-deployment.md](03-deployment.md)，本文不含代码变更之外的运维细节。

## 1. 背景与问题

会话聚合原实现只从**请求体**提取会话键：`prompt_cache_key`（OpenAI 系协议）与 `metadata.user_id` 内嵌 `session_id`（Claude Messages 协议，Claude Code 签名格式）。主流 harness 的会话标识不满足该假设，实测聚合缺口：

| 客户端与请求格式 | 会话标识位置 | 原体提取结果 |
|---|---|---|
| dsh · chat-completions 格式（`/v1/chat/completions`） | 无（键注入条件不满足，源码证据见 §3，实测见 §14） | 失效 |
| dsh · deepseek 栈（`/v1/messages`） | 请求头 `x-deepseek-harness-session-id`；body 无 `metadata` | 失效 |
| dsh · Responses 格式（`/v1/responses`） | body `prompt_cache_key`，默认携带（实测见 §14） | **可聚合** |
| Codex CLI | 请求头 `session_id` | 失效 |
| opencode | 请求头 `x-opencode-session` | 失效 |

结论：仅依赖 body 的提取不能覆盖主流 harness 生态，需要「识别客户端 → 按该客户端策略提取会话键」的机制；识别结果必须落盘可见，识别失效才可被发现。

## 2. 目标与非目标

**目标**

| # | 目标 |
|---|---|
| G1 | 内置 4 个有源码级证据的识别与提取策略：dsh、Codex CLI、Claude Code、opencode |
| G2 | 会话键来源从「仅 body」扩展到「body + 请求头」，白名单制（逐头审核语义） |
| G3 | 识别结果（索引 `h` 字段）写入索引并在看板展示——支持矩阵产品内可见 |
| G4 | 未识别客户端保持现状（body 标准字段回退，`h` 缺省），聚合口径零变化 |
| G5 | 演进路径明确：trae / workbuddy / zcode 待真实流量样本分析后内置（§10，**规划，未实现**） |

**非目标**

| 非目标 | 否决依据 |
|---|---|
| 基于内容相似度 / 时间窗的模糊聚合 | 维持「宁可漏，不可错」 |
| env 级配置扩展（`DASHCAM_SESSION_HEADERS`） | 否决记录见 §11.1 |
| 聚合算法改动 | `groupConversations` 按 `k` 分组不动 |
| trae / workbuddy / zcode 本轮内置 | 无可查证证据，否决记录见 §11.3 |

## 3. 识别信号与证据（内置四家）

| harness | 识别信号（任一命中） | 会话键来源（有序，首个非空生效） | 证据 |
|---|---|---|---|
| `dsh` | ① 存在头 `X-Deepseek-Harness-Session-Id`；② UA 前缀 `deepseek-harness/` | ① 该头（deepseek 栈）② body `prompt_cache_key`（chat-completions 格式需渠道配置；Responses 格式默认携带，实测见 §14） | 源码级：本地 asar 解包——adapter.ts 发送该头；APP_IDENTITY `product: "deepseek-harness"`（UA = `deepseek-harness/<ver> (+url)`） |
| `codex` | 头 `Originator` 值以 `codex` 开头 | 头 `Session-Id` | 源码级：公开抓包与源码分析多源一致（`originator: codex_cli_rs` + `session_id: <UUIDv7>`，见 §12） |
| `claude-code` | ① UA 前缀 `claude-cli/`；② 头 `X-App: cli`；③ body `metadata.user_id` 含内嵌 `session_id` JSON | ① body `metadata.session_id`（现有提取器）② body `prompt_cache_key` | 源码级：公开逆向 + 官方 issue（UA `claude-cli/*`、`x-app: cli`，见 §12） |
| `opencode` | 存在头 `X-Opencode-Session` | 该头 | 源码级：上游 `session/llm.ts:213-219` 发送 `x-opencode-session/-request/-project` |

**明确排除的头**

| 头 | 排除理由 |
|---|---|
| `X-Client-Request-Id`、`X-Opencode-Request` | 请求级标识，会把同一会话拆成多行 |
| `User`、`X-Opencode-Project`、`X-Deepseek-Harness-User-Id` | 用户 / 项目维度，会把不同会话错误合并 |

识别价值与聚合解耦，dsh 按请求格式分三种状态：

| dsh 请求格式 | 默认会话标识 | 记录形态 | 聚合承接 |
|---|---|---|---|
| chat-completions | 无（affinity 头 compat 默认关闭、`prompt_cache_key` 注入条件不满足） | `h=dsh`、`k` 缺省——不聚合但工具可见 | 渠道配置 `sendSessionAffinityHeaders`（`X-Session-Id` 头，dsh profile 扩展候选承接，§6.5）或 `cacheRetention`（body `prompt_cache_key`，通用回退直接命中）后即聚合 |
| Responses | body `prompt_cache_key` 默认携带（§14） | 聚合 | 开箱聚合，无需渠道配置 |
| deepseek 栈（`/v1/messages`） | 头 `X-Deepseek-Harness-Session-Id` | 聚合 | dsh profile 候选①直接命中 |

## 4. 总体设计

```text
请求进入 handler
   │
   ├─ begin()：从请求头拷贝「候选头集合」到 record（纯内存，零 I/O）
   │   候选集 = 内置表引用的全部头 + User-Agent（值截断见 §6.2）
   │
   └─ flush()（单点决策，替换原 extractSessionKey 直调）：
        1. 按 harnessProfiles 表序识别：第一个命中 detect 的 profile → h
        2. 命中：按该 profile 的 sessionKeys 候选序取第一个非空值 → k 输入
        3. 未命中：通用回退 = 原 body 提取（prompt_cache_key / metadata.session_id，
           按协议路径门控，行为与原状完全一致）→ h 缺省
        4. k = sha256(value)[:16]（口径不变）
```

要点：

- 识别与提取全部发生在 **flush worker**（peek 可用、worker 独占的既有纪律不变）；`begin` 只做头值拷贝（7 个短字符串，纳秒级）。
- 头提取**不按协议路径门控**（会话头语义与 API 形态无关；只有 `CAPTURE_PATHS` 命中的请求会到达此处）。
- body 提取仍按路径门控（保持原状）。
- `User-Agent` 检测用前缀匹配（`deepseek-harness/`、`claude-cli/`），规避版本号变化。

## 5. 数据结构（capture.go，表驱动）

```go
// harnessProfile：一个客户端工具的识别与提取策略（声明式表，§3 证据表即此表的文档化）。
type harnessProfile struct {
    name        string       // 索引 h 字段值；固定词表：dsh / codex / claude-code / opencode
    detect      []detectRule // 有序识别规则：任一命中即认定
    sessionKeys []keySource  // 有序会话键候选：首个非空生效
}

type detectRule struct {
    header    string                 // 头存在性 / 头值前缀检测（规范名）
    headerHas string                 // 非空则要求头值以该前缀开头（如 Originator: codex*）
    userAgent string                 // 非空则要求 UA 以该前缀开头
    bodyHas   func(peek []byte) bool // body 特征（peek），如 claude-code 的 metadata 签名
}

type keySource struct {
    header string           // 头名（规范名）；非空优先
    body   bodyKeyExtractor // 否则用 body 提取器（复用现有 pattern）
}
```

内置表（初版 4 条 + 通用回退，表序即识别优先级；规则互斥，表序仅定义确定性）：

```go
var harnessProfiles = []harnessProfile{
    {name: "dsh", detect: [头存在 X-Deepseek-Harness-Session-Id, UA 前缀 deepseek-harness/],
     sessionKeys: [头 X-Deepseek-Harness-Session-Id, body promptCacheKey]},
    {name: "codex", detect: [头 Originator 值前缀 codex],
     sessionKeys: [头 Session-Id]},
    {name: "claude-code", detect: [UA 前缀 claude-cli/, 头 X-App == cli, body metadata 签名],
     sessionKeys: [body metadataSessionId, body promptCacheKey]},
    {name: "opencode", detect: [头存在 X-Opencode-Session],
     sessionKeys: [头 X-Opencode-Session]},
}
```

`begin` 拷贝的头集合（as-built 共 7 个，全表引用 + 通用回退所需）：

| 头 | 用途 |
|---|---|
| `X-Deepseek-Harness-Session-Id` | dsh 检测① + 键候选① |
| `X-Session-Id` | 预留：dsh pi-ai 栈 compat 开启后的承接（§6.5） |
| `X-Opencode-Session` | opencode 检测 + 键候选 |
| `Session-Id` | codex 键候选 |
| `Originator` | codex 检测 |
| `X-App` | claude-code 检测②（实现期补入设计清单） |
| `User-Agent` | dsh / claude-code 前缀检测（截 256B） |

## 6. 细节规则

### 6.1 优先级与冲突

- 表序即识别优先级；表内规则不重叠（四家识别信号互斥），表序仅定义确定性。
- 同一请求同时命中 profile 候选中的头与 body（如 dsh 配置后两头/体并存）：**候选序首个非空生效**——值来自同一 `options.sessionId`，实际恒一致。
- profile 命中但全部候选为空 → `h` 写入、`k` 缺省（行不聚合但工具可见，§3 解耦场景）。

### 6.2 值约束

- 头值截断 128 字节、UA 截断 256 字节后参与哈希（会话 ID 实际为 UUID / 短 ID；截断防异常超长头撑大索引）。
- `k = sha256(value)[:16]` 口径**不变**——跨工具命名空间（`hash(h + value)`）已评估并否决（§11.2）。

### 6.3 通用回退（未识别客户端）

与原状完全一致：`prompt_cache_key`（`/v1/chat/completions`、`/v1/completions`、`/v1/responses`）→ `metadata.session_id`（`/v1/messages`），按路径门控；`h` 缺省。原 `extractSessionKey` 函数保留，作为回退与 profile 键源的共用实现。

### 6.4 演进承接（trae / workbuddy / zcode）

不设 env 配置（§11.1）。演进路径见 §10：真实流量 → nginx 抓包采样（mitmproxy / tcpdump，运维侧动作，不改 dashcam）→ 证据分析 → 加入内置表 → 重新部署。`h` 字段的可见性使「曾识别出的工具突然消失」可被察觉（供应商改头名的失效信号）。

### 6.5 dsh pi-ai 栈的 `X-Session-Id` 承接

`X-Session-Id` 列入 `begin` 拷贝集合但不属于任何内置 profile 的会话键候选——它是 OpenRouter 格式的通用 affinity 头，在 dsh 场景外语义不保证会话级。承接方式：dsh profile 候选保持 §5 所列；若实测确认需要，将 `X-Session-Id` 加入 dsh profile 候选（一行表变更），而非通用回退。

## 7. 索引与看板变更

| 变更 | 内容 |
|---|---|
| 索引字段 | 新增 `h`（string，omitempty）：harness 名，采集端固定词表 `dsh / codex / claude-code / opencode`（可随演进加词）；读取侧宽松校验 `[a-z0-9-]{1,32}` |
| 看板类型 | `DashcamSessionRow` / `DashcamThreadTurn` 新增 `harness?: string`；索引条目 `DashcamIndexEntry` 新增 `h?: string` |
| 看板展示 | 请求视图行中性 Tag（文本即 `h` 值）+ 详情对话框头部 Tag；聚合逻辑零改动 |
| 兼容性 | 旧行无 `h` 自然缺省；`k` 口径不变，聚合行为对历史数据零影响；读取方对未知 `h` 仅展示不报错 |

## 8. 测试

| 层 | 用例 |
|---|---|
| 单测（dashcam） | 每 profile 的 detect 命中 / 不命中 × 键候选序；识别与提取解耦（`h=dsh`、`k` 缺省）；通用回退语义与原状逐字节一致；排除头不进入候选集；头值 / UA 截断；`h` 落索引且 omitempty |
| 单测（看板） | `h` 解码 → `harness`；合法值 / 词表外新词 / 非法值 / 旧行缺省 |
| e2e（部署后） | ① curl 模拟 codex 头 → 聚合 + `h=codex`；② 模拟 opencode 头 → 同理；③ 真实 dsh 对话 → `h=dsh`（`k` 是否携带取决于请求格式，实测见 §14）；④ Claude Code 语义用既有 fixture 回归；⑤ 全量测试零回归。复验结果见 §13 |

## 9. 部署与重测

1. dev 版本命名（R3）：`<基础版本>-dev.<日期序号>`，禁止递增发布号。
2. 部署顺序：dashcam → 看板 → 清空采集数据（`index` / `blobs` / `meta.json`）→ healthz 与页面路由核验（含 `GET /login`，不止 healthz）。
3. 用户重测：真实工具对话验证 `h` 可见性 → curl 模拟验证识别矩阵 → 全量回归。

## 10. 演进路径（trae / workbuddy / zcode）

**规划，未实现**。三家当前状态一律「待实测」，不预设规则：

1. 用户以待测工具对内网测试机发真实对话；
2. nginx 抓包采样（mitmproxy / tcpdump），取得请求头 + body 特征样本；
3. 按 §3 证据标准分析识别信号与会话键来源（trae-agent 为开源项目，可离线查证请求构造）；
4. 证据充分 → 加入内置表 + 更新本文档矩阵 → 重新部署。

## 11. 被否决方案

### 11.1 env 白名单扩展（`DASHCAM_SESSION_HEADERS`）

**结论**：否决。
**依据**：新增运维配置面（维护者明确不要）；裸头名白名单绕过「识别 → 策略」框架，头语义无法随客户端演进校准。
**代价**：新客户端接入必须改代码发版，不能运维侧自助。

### 11.2 `k` 加入 harness 命名空间（`hash(h + value)`）

**结论**：否决。
**依据**：各工具会话 ID 均为 UUID 空间，跨工具碰撞不现实；命名空间会改变现有 `k` 口径，造成历史数据断代。
**代价**：保留纯 value 哈希，理论上存在跨工具同值聚合（评估为可忽略）。

### 11.3 七家强行内置

**结论**：否决。
**依据**：trae / workbuddy / zcode 无可查证证据，猜测性规则会导致错误聚合或永不命中。
**代价**：三家暂不聚合，走 §10 演进路径。

### 11.4 仅靠 dsh 配置层解决（不识别、不接头提取）

**结论**：否决。
**依据**：只解决 chat-completions 一条格式；deepseek 栈（`/v1/messages` 头）与 Codex / opencode 等工具的开箱聚合无解；且无 `h` 可见性，识别失效不可发现。
**代价**：实现「识别 → 策略」框架与索引 `h` 字段的开发量。

## 12. 来源

- dsh：本地安装包 asar 源码解包（`dsh-llm-deepseek/src/adapter.ts` 会话头；`APP_IDENTITY` UA；`@earendil-works/pi-ai` openai-completions.js:582 `prompt_cache_key` 注入条件、:548-557 affinity 头与排除项）
- Codex CLI：[抓包 payload（gist）](https://gist.github.com/sergei-rastrigin/082ed15d7348480bb84996cf4b26abb5)、[ChatGPT API 头契约](https://git.nexlab.net/nexlab/aisbf/blob/ce47577665584d21f6bd107a444e69756cd71929/chatgpt-api-implementation-guide.md)
- opencode：[上游源码头注入（issue #14281）](https://github.com/anomalyco/opencode/issues/14281)
- Claude Code：[UA 格式（官方 issue #72879）](https://github.com/anthropics/claude-code/issues/72879)、[请求头/metadata 讨论（HN）](https://news.ycombinator.com/item?id=46627296)

## 13. 实施记录与复验结果

部署形态：dashcam 与看板先后部署内网测试机（版本见头部表），部署后清空采集数据重测。e2e 复验结果（实测，2026-11-17）：

| 用例 | 结果 |
|---|---|
| curl 模拟 codex（`Originator: codex_cli_rs` + `Session-Id`） | 索引 `h=codex`；`k` = `sha256(Session-Id)[:16]` 逐字节吻合；同 Session-Id 两条聚合为 1 个会话 |
| curl 模拟 opencode（`x-opencode-session`） | `h=opencode`、两条聚合为 1 个会话；上游超时产生的 502 行同样识别并聚合 |
| 无识别头普通请求 | `h` 缺省、`k` 缺省、各自成行——与原状一致 |
| 无识别头 + body `prompt_cache_key` | `h` 缺省、`k` 哈希逐位吻合——回退口径与原状一致 |
| 看板三视图（请求 / 会话 / 线程） | `harness` 均正确解码；会话视图聚合数与索引一致 |
| 真实 dsh 对话（chat-completions 格式） | `h=dsh`、`k` 缺省（解耦场景，§3）；换 Responses 格式后聚合，见 §14 |

## 14. 实测补记：请求格式决定 dsh 是否携带会话键（2026-11-17）

评审阶段的聚合缺口结论源自 chat-completions 格式的源码证据外推。实施当日实测表明**该缺口仅限于此格式**，同一 dsh 客户端换用 OpenAI Responses 请求格式即可开箱聚合：

| dsh 请求格式 | 当日请求（glm-5.3-flash / deepseek-flash） | 带会话键 `k` | 聚合 |
|---|---|---|---|
| `/v1/chat/completions` | 16 条 | **0 条** | 否 |
| `/v1/responses` | 9 条 | **9 条** | 是 |

- **Responses 格式的键来源**：请求体 `prompt_cache_key`，值为 `session-<UUID>`——即 dsh 的 sessionId 本身（会话语义，不只是缓存语义）；哈希逐字节核验 `sha256(value)[:16]` = 索引 `k`，由 dsh profile 候选②直接命中，**无需任何渠道配置**。
- **chat-completions 格式的无标识行为另有抓包佐证**（2026-11-16，tcpdump 采集入口请求方向，4 条完整请求）：请求头仅含 OpenAI Node SDK 遥测头（`x-stainless-*`）、`Authorization` 与 UA，无任何会话头；body 全量扫描无 `prompt_cache_key` / `session_id` / `metadata` 等标识字段，亦无跨请求重复出现的 UUID——不存在可挖的隐藏标识。
- **结论**：旧格式不发键是 pi-ai chat-completions 适配器的行为（源码级 + 实测双重证实）；渠道配置（`cacheRetention` / affinity 头）只是该格式下的替代聚合路径。识别矩阵（`h`）不受请求格式影响，两种格式均正确命中 `h=dsh`。
- **证据等级**：Responses 适配器默认携带 `prompt_cache_key` 目前**仅有实测证据**（文档声称级别），pi-ai Responses 适配器的注入条件未做源码级核查——dsh 升级（pi-ai 随之升级）可能改变该行为。失效信号与处理见 §15 L2。

## 15. 限制与已知问题

| # | 限制 / 已知问题 | 影响 | 处理 |
|---|---|---|---|
| L1 | 会话头与 body 键均可被客户端伪造 | 跨工具 / 跨会话错误聚合 | 接受：内网审计场景下 body 字段同样可伪造，威胁模型一致；文档明示 |
| L2 | Responses 格式默认携带 `prompt_cache_key` 仅实测证实，注入条件未源码级核查 | dsh / pi-ai 升级可能使该行为消失 | 失效信号：`h=dsh` 行的 `k` 缺失率突增（看板请求视图可观察）；确认失效按 §10 演进路径补样本分析 |
| L3 | trae / workbuddy / zcode 未内置（**规划**） | 三家流量不聚合（`h` 缺省） | 走 §10 演进路径，样本分析后加入内置表 |
| L4 | UA 前缀识别依赖 `deepseek-harness/`、`claude-cli/` 专属前缀 | 供应商改 UA 即识别失效 | `h` 可见性使失效可发现（该工具的行不再带 `h`）；规则表可随时收紧 |
| L5 | `begin` 拷贝 7 个候选头增加每请求开销 | 纳秒级 map 查找 + 短串拷贝 | 接受：转发路径零影响（既有红线不变） |

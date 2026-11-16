# 会话聚合：客户端识别与策略化会话键提取设计

| 项 | 值 |
|---|---|
| 状态 | **待评审**（评审通过后实施；本文档不含代码变更） |
| 日期 | 2026-11-16 |
| 关联 | 02-design §索引字段（`k`）、07-loadtest §7 D6（修复后记录可见但不聚合引出本设计） |
| 范围 | dashcam 采集代理 + 看板展示；聚合算法（按 `k` 分组）不变 |

## 1. 背景与问题

会话聚合目前只从**请求体**提取会话键：`prompt_cache_key`（OpenAI 系协议）与 `metadata.user_id` 内嵌 `session_id`（Claude Messages 协议，Claude Code 签名格式）。D6 修复后采集记录恢复可见，但实测暴露出聚合缺口：

- **DeepSeek Harness（dsh）** 的 glm 渠道流量走 pi-ai 栈（OpenAI 兼容协议），其 `prompt_cache_key` 注入条件为「baseUrl 为 api.openai.com」或「cacheRetention=long 且 compat 支持」（`@earendil-works/pi-ai` openai-completions.js:582，源码实锤）——自建网关两条件均不满足，会话 ID 被丢弃，请求体无任何会话标识 → 无法聚合。
- dsh 的 deepseek 栈（Anthropic 协议 `/v1/messages`）把会话 ID 放在**请求头** `x-deepseek-harness-session-id`，body 同样没有 `metadata`（serialize.ts 返回字段实锤）——现有体提取同样失效。
- Codex CLI / opencode 等主流 agent 工具同样以**请求头**承载会话标识（见 §5 证据表），体提取方案对它们全部失效。

结论：仅依赖 body 的提取不能覆盖主流 harness 生态。需要「识别客户端 → 按该客户端的策略提取会话键」的机制。

## 2. 目标与非目标

**目标**

1. 内置 4 个有源码级证据的 harness 识别与提取策略：dsh、Codex CLI、Claude Code、opencode。
2. 会话键来源从「仅 body」扩展到「body + 请求头」，白名单制（逐头名审核语义）。
3. 识别结果（`h` 字段）写入索引并在看板展示——支持矩阵在产品里可见，失效可被发现。
4. 未识别客户端保持现状（body 标准字段回退，`h` 缺省），聚合口径零变化。
5. 明确的演进路径：trae / workbuddy / zcode 待真实流量样本分析后内置（见 §11）。

**非目标**

- 不做基于内容相似度/时间窗的模糊聚合（维持「宁可漏，不可错」）。
- 不做环境变量级配置扩展（否决理由见 §12.1：运维负担；演进走「样本分析 → 内置」）。
- 不改动聚合算法本身（`groupConversations` 按 `k` 分组不动）。
- trae / workbuddy / zcode 本轮不内置（无证据，见 §12.3）。

## 3. 识别信号与证据（内置四家）

| harness | 识别信号（任一命中） | 会话键来源（有序） | 证据 |
|---|---|---|---|
| `dsh` | ① 存在头 `X-Deepseek-Harness-Session-Id`；② UA 前缀 `deepseek-harness/` | ① 该头（deepseek 栈）② body `prompt_cache_key`（pi-ai 栈，渠道配置后出现） | 本地 asar 源码实锤：adapter.ts 发送该头；APP_IDENTITY `product: "deepseek-harness"`（UA = `deepseek-harness/<ver> (+url)`，即 attributionHeaders 的内容） |
| `codex` | 头 `Originator` 值以 `codex` 开头 | 头 `Session-Id` | 公开抓包与源码分析多源一致：`originator: codex_cli_rs` + `session_id: <UUIDv7>` 头（见 §13 来源） |
| `claude-code` | ① UA 前缀 `claude-cli/`；② 头 `X-App: cli`；③ body `metadata.user_id` 含内嵌 `session_id` JSON | ① body `metadata.session_id`（现有提取器）② body `prompt_cache_key` | 公开逆向 + 官方 issue（UA `claude-cli/*`、`x-app: cli`）；现有实现即为其设计 |
| `opencode` | 存在头 `X-Opencode-Session` | 该头 | 上游源码路径实锤（`session/llm.ts:213-219` 发送 `x-opencode-session/-request/-project`） |

**明确排除的头**（写入代码注释与本表）：`X-Client-Request-Id`、`X-Opencode-Request`（请求级，会拆散会话）；`User`、`X-Opencode-Project`、`X-Deepseek-Harness-User-Id`（用户/项目维度，会错误合并）。

识别价值与聚合解耦：dsh 的 pi-ai 栈默认**不发任何会话标识**（affinity 头 compat 默认关闭、`prompt_cache_key` 条件不满足），此时记录为 `h=dsh, k 空`——不聚合但工具可见。用户在 dsh 渠道配置 `sendSessionAffinityHeaders`（出现 `X-Session-Id` 头）或 `cacheRetention` 配置（出现 body `prompt_cache_key`）后即聚合；后者直接被现有通用回退命中，前者由 dsh profile 的扩展候选承接（见 §6.5）。

## 4. 总体设计

```text
请求进入 handler
   │
   ├─ begin()：从请求头拷贝「候选头集合」到 record（纯内存，零 I/O）
   │   候选集 = 四家 profile 声明的全部头名 + User-Agent（值截断见 §6.4）
   │
   └─ flush()（单点决策，替换现有 extractSessionKey 直调）：
        1. 按 harnessProfiles 表序识别：第一个命中 detect 的 profile → h
        2. 命中：按该 profile 的 sessionKeys 候选序取第一个非空值 → k 输入
        3. 未命中：通用回退 = 现有 body 提取（prompt_cache_key / metadata.session_id，
           按协议路径门控，行为与现状完全一致）→ h 缺省
        4. k = sha256(value)[:16]（口径不变）
```

要点：

- **识别与提取全部发生在 flush worker**（peek 可用、worker 独占的既有纪律不变）；`begin` 只做头值拷贝（几个短字符串，纳秒级）。
- 头提取**不按协议路径门控**（会话头语义与 API 形态无关；且只有 CAPTURE_PATHS 命中的请求才会走到这里）。
- body 提取仍是路径门控的（保持现状）。
- `User-Agent` 检测用前缀匹配（`deepseek-harness/`、`claude-cli/`），规避版本号变化。

## 5. 数据结构（capture.go，表驱动）

```go
// harnessProfile：一个客户端工具的识别与提取策略（声明式表，§5 证据表即此表的文档化）。
type harnessProfile struct {
    name        string       // 索引 h 字段值；固定词表：dsh / codex / claude-code / opencode
    detect      []detectRule // 有序识别规则：任一命中即认定
    sessionKeys []keySource  // 有序会话键候选：首个非空生效
}

type detectRule struct {
    header     string       // 头存在性 / 头值检测（规范名）
    headerHas  string       // 非空则要求头值含该前缀（如 originator: codex*）
    userAgent  string       // 非空则要求 UA 以该前缀开头
    bodyHas    func(peek []byte) bool  // body 特征（peek），如 claude-code 的 metadata 签名
}

type keySource struct {
    header string              // 头名（规范名）；非空优先
    body   bodyKeyExtractor    // 否则用 body 提取器（复用现有 pattern）
}
```

内置表（初版 4 条 + 通用回退，顺序即识别优先级）：

```go
var harnessProfiles = []harnessProfile{
    {name: "dsh",         detect: [头存在 X-Deepseek-Harness-Session-Id, UA 前缀 deepseek-harness/],
                           sessionKeys: [头 X-Deepseek-Harness-Session-Id, body promptCacheKey]},
    {name: "codex",       detect: [头 Originator 值前缀 codex],
                           sessionKeys: [头 Session-Id]},
    {name: "claude-code", detect: [UA 前缀 claude-cli/, 头 X-App == cli, body metadata 签名],
                           sessionKeys: [body metadataSessionId, body promptCacheKey]},
    {name: "opencode",    detect: [头存在 X-Opencode-Session],
                           sessionKeys: [头 X-Opencode-Session]},
}
```

begin 拷贝的头集合（全表 + 通用回退所需）：`X-Deepseek-Harness-Session-Id`、`X-Session-Id`（预留给 dsh pi-ai 栈 compat 开启后的承接，见 §6.5）、`X-Opencode-Session`、`Session-Id`、`Originator`、`User-Agent`。

## 6. 细节规则

### 6.1 优先级与冲突

- 表序即识别优先级（表内规则不重叠：四家的识别信号互斥，无顺序敏感问题；表序仅定义确定性）。
- 同一请求同时命中 profile 候选中的头与 body（如 dsh 配置后两头/体并存）：**候选序首个非空生效**——值来自同一 `options.sessionId`，实际恒一致，序仅保证确定性。
- profile 命中但全部候选为空 → `h` 写入、`k` 缺省（行不聚合但工具可见，§3 说明的场景）。

### 6.2 值约束

- 头值截断 128 字节、UA 截断 256 字节后参与哈希（会话 ID 实际为 UUID/短 ID；截断防异常超长头撑大索引）。
- `k = sha256(value)[:16]` 口径**不变**——跨工具命名空间（`hash(h + value)`）已评估并否决（§12.2）。

### 6.3 通用回退（未识别客户端）

与现状完全一致：`prompt_cache_key`（`/v1/chat/completions`、`/v1/completions`、`/v1/responses`）→ `metadata.session_id`（`/v1/messages`），按路径门控；`h` 缺省。现有 `extractSessionKey` 函数保留，作为回退与 profile 键源的共用实现。

### 6.4 演进承接（trae / workbuddy / zcode）

不设 env 配置（§12.1）。演进路径：用户以待测工具对测试机发真实流量 → 通过 nginx `:8088` 抓包样本（mitmproxy/tcpdump，运维侧动作，不改 dashcam）→ 分析识别信号与会话键来源 → 证据充分后加入内置表 → 重新部署。`h` 字段的可见性让「曾识别出的工具突然消失」可被察觉（供应商改头名的失效信号）。

### 6.5 dsh pi-ai 栈的承接说明

`X-Session-Id` 列入 begin 拷贝集合但不属于任何内置 profile 的会话键候选——它是 OpenRouter 格式的通用 affinity 头，在 dsh 场景外语义不保证会话级。承接方式：dsh profile 的候选保持 §5 所列；若未来实测确认需要，将 `X-Session-Id` 加入 dsh profile 候选（一行表变更），而非通用回退。

## 7. 索引与看板变更

| 变更 | 内容 |
|---|---|
| 索引字段 | 新增 `h`（string，omitempty）：harness 名，固定词表 `dsh / codex / claude-code / opencode`；读取侧宽松校验 `[a-z0-9-]{1,32}`（供应商演进可加词） |
| 看板类型 | `DashcamSessionRow` / `DashcamThreadTurn` 新增 `harness?: string` |
| 看板展示 | 请求视图行 Tag（中性色，文本即 `h` 值）+ 详情对话框头部 Tag；聚合逻辑零改动 |
| 兼容性 | 旧行无 `h` 自然缺省；`k` 口径不变故聚合行为对历史数据零影响；读取方对未知 `h` 仅展示不报错 |

## 8. 测试计划

| 层 | 用例 |
|---|---|
| 单测（dashcam） | 每 profile 的 detect 命中/不命中 × 键候选序；识别与提取解耦（dsh pi-ai 默认流：`h=dsh, k 空`）；通用回退语义与现状逐字节一致；排除头不进入候选集；头值/UA 截断；`h` 落索引且 omitempty |
| 单测（看板） | `h` 解码 → `harness`；Tag 渲染；未知 `h` 值不报错 |
| e2e（部署后） | ① curl 模拟 codex 头（`Originator: codex_cli_rs` + `Session-Id`）→ 聚合 + `h=codex`；② 模拟 opencode 头 → 同理；③ 真实 dsh glm 对话 → `h=dsh`（k 空，除非渠道已配 compat）；④ Claude Code 语义用既有 fixture 回归；⑤ 现有全量测试零回归 |

## 9. 部署与重测

1. worktree 隔离分支（主树重构进行中）→ 三提交：dashcam 表驱动 / 看板 `h` 解码展示 / 文档（本文档 + 02-design 更新）。
2. dev 版号（R3）：dashcam `v0.1.0-dev.<seq>` + 看板 `0.2.0-dev.<seq>`。
3. 部署顺序：dashcam → 看板 → 清空采集数据 → 页面/登录核验（含页面路由，不止 healthz）。
4. 用户重测：dsh glm 真实对话（验证 `h=dsh` 与可见性）→ dsh 渠道配置 compat 后复测（验证聚合）→ curl 模拟 codex/opencode（验证矩阵）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 会话头可被客户端伪造 → 跨工具/跨会话错误聚合 | 接受：内网审计场景下 body 字段同样可伪造，威胁模型一致；文档明示 |
| 供应商改头名/UA → 识别失效 | `h` 可见性使失效可发现（该工具的行不再带 `h`）；演进路径承接修复 |
| UA 前缀误报 | `deepseek-harness/`、`claude-cli/` 为强专属前缀，误报空间可忽略；规则表可随时收紧 |
| begin 拷头增加每请求开销 | 6 个头的 map 查找 + 短串拷贝，纳秒级；转发路径零影响（既有红线不变） |

## 11. 演进路径（trae / workbuddy / zcode）

1. 用户以待测工具经测试机发真实对话；
2. nginx `:8088` 抓包采样（mitmproxy/tcpdump），取得请求头 + body 特征样本；
3. 按 §3 证据标准分析识别信号与会话键来源（trae-agent 为开源项目，可离线查证其请求构造）；
4. 证据充分 → 加入内置表 + 更新本文档矩阵 → 部署。三家的当前状态一律「待实测」，不预设规则。

## 12. 备选方案记录（否决理由）

### 12.1 env 白名单扩展（`DASHCAM_SESSION_HEADERS`）

否决：新增运维配置面（维护者明确不要）；且裸头名白名单绕过「识别→策略」框架，头语义无法随客户端演进校准。改为「样本分析 → 内置表」的产品内演进。

### 12.2 `k` 加入 harness 命名空间（`hash(h + value)`）

否决：各工具会话 ID 均为 UUID 空间，跨工具碰撞不现实；命名空间会改变现有 `k` 口径，造成历史数据断代。保留纯 value 哈希。

### 12.3 七家强行内置

否决：trae / workbuddy / zcode 无可查证证据，猜测性规则会导致错误聚合或永不命中——违背「宁可漏，不可错」。

### 12.4 仅靠 dsh 配置层解决（不识别、不接头提取）

否决：只解决 glm 一条渠道；deepseek 栈（`/v1/messages` 头）与 Codex/opencode 等工具的开箱聚合无解；且无 `h` 可见性，识别失效不可发现。

## 13. 来源

- dsh：本地安装包 asar 源码解包（`dsh-llm-deepseek/src/adapter.ts` 会话头；`APP_IDENTITY` UA；`@earendil-works/pi-ai` openai-completions.js:582 prompt_cache_key 条件、:548-557 affinity 头与排除项）
- Codex CLI：[抓包 payload（gist）](https://gist.github.com/sergei-rastrigin/082ed15d7348480bb84996cf4b26abb5)、[ChatGPT API 头契约](https://git.nexlab.net/nexlab/aisbf/blob/ce47577665584d21f6bd107a444e69756cd71929/chatgpt-api-implementation-guide.md)
- opencode：[上游源码头注入（issue #14281）](https://github.com/anomalyco/opencode/issues/14281)
- Claude Code：[UA 格式（官方 issue #72879）](https://github.com/anthropics/claude-code/issues/72879)、[请求头/metadata 讨论（HN）](https://news.ycombinator.com/item?id=46627296)

## 14. 评审清单

- [ ] `k` 口径保持不变（§6.2）是否接受
- [ ] `h` 字段名 / 词表 / 宽松校验（§7）是否接受
- [ ] 四家识别规则的精确性（§3、§5）是否认可
- [ ] 排除项清单（§3）是否认可
- [ ] 无 env 配置 + 样本演进路径（§6.4）是否接受
- [ ] 看板展示形态（中性 Tag）是否接受

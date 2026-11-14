# 采集性能评估与改造方案（性能专项 · 已裁决待实施）

> **状态：评估与设计已全部裁决（2026-11-14），未实施。** 本文沉淀性能专项的全部内容：容量评估、风险证伪、决策记录（D-P1～D-P5，沿用 [04-decisions.md](04-decisions.md) 的记录风格，`D-P` 前缀表示性能专项）与实施设计。设计基线见 [02-design.md](02-design.md)，部署见 [03-deployment.md](03-deployment.md)，问题与约束见 [01-background.md](01-background.md)。
>
> 评估性质声明：全部数字来自源码逐行推导（行号基于 2026-11-13 的代码状态）与 35 条本地样本（`data/audit/index/2026-11-13.ndjson`）外推，**未经生产压测**。gzip 吞吐与单目录元数据 IOPS 随文件系统与负载特征浮动 2–3 倍；结论用于定级与排优先级，定界以 §9 的压测为准。
>
> **2026-11-14 更新**：采集端新增 token 用量提取（`audit-proxy/usage.go`，D11，见 [04-decisions.md](04-decisions.md)），`finish()` 增加一次尾部读 + 小 JSON 解析——不改变本文的四个同步阻塞点结论与 D-P3 设计；§3 的行号为 11-13 快照，实施 D-P3 时按当日代码重新定位。

## 1. 总原则（专项约束）

1. **任何采集改造不得增加对请求转发路径的影响**；对转发路径的影响只允许减少。
2. **对 LLM 响应时长的关注高于监控完备性**：宁可不加监控，宁丢采集不丢转发。
3. 保留期等运维参数**默认行为不变**，是否调整由运维决定。

## 2. 实测数据基线

来源：`data/audit/index/2026-11-13.ndjson`（35 条真实请求，多为多轮工具会话）+ 业务口径（约 5.6k 请求/天，见 [01-background.md](01-background.md) §4）。

| 指标 | min | p50 | p90 | max | avg |
|---|---|---|---|---|---|
| 请求体 `rq` | 50 B | 97 KB | 189 KB | 209 KB | 91 KB |
| 响应体 `rs` | 124 B | 210 KB | 493 KB | 729 KB | 235 KB |
| 总时长 `ms` | 5 ms | 2.8 s | 12.9 s | 14.6 s | 4.4 s |

- 原始落盘量 ≈ 326 KB/请求；gzip（≥64 KB 才压，样本中 49/70 文件已压）后 **≈ 63 KB/请求**；索引 250 B/行。
- 样本内 3 个调用方指纹、无 `_anon`，路径均为 OpenAI 协议（`/v1/chat/completions`、`/v1/responses`）。

## 3. 代码事实：四个同步阻塞点

| # | 位置 | 事实 | 对转发的含义 |
|---|---|---|---|
| 1 | `main.go:114-118`、`capture.go:193-219` | 请求体经 `io.TeeReader` 同步写盘（32 KB bufio） | 上游收齐 prompt 的时间 = 网络 + 磁盘写；大 prompt 直接拖慢首字延迟 |
| 2 | `main.go:194-199` | 响应先发客户端再写盘，但 copy loop 同步 | 当前 chunk 不受影响，**下一 chunk 被写盘推迟**，逐字输出变顿；`main.go:187` 注释"磁盘慢只是采集延迟"不准确 |
| 3 | `capture.go:247-307` | `finish()` 在 `proxy.ServeHTTP` 返回后同步执行：flush/close ×2、gzip（读 + 写整个 tmp 文件）、rename、4 个正则扫 ≤256 KB peek、JSON 序列化 | 占 CPU；客户端已收完 body，主要代价是延迟连接释放与同机 CPU 竞争 |
| 4 | `capture.go:176-190`、`capture.go:364-387` | `ensureDir` 每请求两次全局 `dirMu`（目录已存在也加锁）；`appendIndex` 全局 `idxMu` | 高 QPS 串行点 |

其他相关事实：

- `capture.go:62` `peekLimit = 256 KB`：每请求最多保留 256 KB peek 直到 `finish()`；实测平均请求体 91 KB，接近全额占用。
- `capture.go:163-164`：每请求 2 × 32 KB bufio。
- `main.go:151-161`：`Transport` 未设 `MaxConnsPerHost`（上游连接数无上限）；`main.go:52-58`：Server 仅 `ReadHeaderTimeout=15s`，无 `IdleTimeout`（keep-alive 空闲连接可无限滞留 fd）。
- `main.go:56` 不设 WriteTimeout 是流式必需，属正确设计。
- 所有 blob 落在 `blobs/<date>/<fp>/` 同一目录：单目录 inode 锁热点，QPS 高时文件创建被串行化。

**结论**：[02-design.md](02-design.md) §3 第 2 条承诺"采集队列有界、满则丢弃、绝不反压转发"，但代码中**没有队列**——落盘、压缩、索引全部在请求 goroutine 内同步完成。"磁盘慢只影响采集"在当前实现下不成立；D-P3（§11）实施后该承诺归真。

## 4. 单请求成本与容量模型

| 项 | 数值 | 推导 |
|---|---|---|
| CPU | 8–15 ms/请求 | gzip level 6 处理 ~326 KB（40–80 MB/s/核 → 4–8 ms）+ 4 个 RE2 正则扫 ≤256 KB peek（1–3 ms）+ 序列化/系统调用 |
| 文件元数据 | 8–10 次/请求 | 2× O_EXCL create + 2× close + 压缩时 2× create + 2× rename + 2× unlink，全部落在同一目录 |
| fd | 4/在途请求 | 2 文件 + 客户端 + 上游，持有整个请求周期 |
| 内存 | ~190 KB/在途请求 | peek（≤256 KB，实测均值 91 KB）+ 64 KB bufio + goroutine/网络缓冲 |
| 磁盘 | 63 KB 落盘 + 2 文件 + 250 B 索引 | 实测 |

推算上限（假设 new-api/PostgreSQL 同机，代理按 50% CPU 预算）：

| 资源 | 上限 |
|---|---|
| CPU（gzip） | 单核 70–125 QPS；4 核 140–250；8 核 280–500 —— **首要瓶颈** |
| 元数据（单目录热点） | NVMe 400–2000 QPS；SATA SSD 300–1000；HDD 50–200 |
| fd（`LimitNOFILE=65535`） | 65535/4 ≈ 1.6 万并发 → 按 avg 4.4 s ≈ 3600 QPS，按 p90 12.9 s ≈ 1250 QPS |
| 内存 | 4 GB 机器给代理 1–2 GB → 5000–10000 并发 ≈ 1100–2300 QPS（avg 4.4 s） |

分档结论（峰值 QPS 对数刻度）：

| 峰值 QPS | A 2C4G/共享 HDD | B 4C8G/独立 SSD | C 8C16G/独占 NVMe | 对 LLM 请求 |
|---|---|---|---|---|
| 1–3（当前规模） | 无感 | 无感 | 无感 | 首字延迟增量 < 几 ms |
| 5–10 | 偶发抖动 | 无感 | 无感 | gzip 与 new-api 抢核，p99 抖动 |
| 30 | 明显劣化 | 可观察 | 无感 | 首字 +10–50 ms，逐字变顿 |
| 100 | 失效 | 临界 | 可观察 | 进程被压垮（fd/内存）→ 连接被拒 → nginx 切 backup 直连，调用照常、采集静默丢失；若进程只是慢而不死，502/504 直接透传调用方（POST 不会自动兜底，见 §7.1） |
| 300+ | — | 失效 | 临界 | fd/内存/inode 同时吃紧，可能 OOM |

通俗版：当前规模下随便什么机器都够用；调用量涨 10 倍，低配机器开始"第一个字慢一点、字蹦得不太顺"；涨 100 倍，低配机器的采集进程会被压垮——压垮即连接被拒，nginx 自动切直连兜底（调用照常、只丢记录），压不垮但很慢时错误直接透给调用方。持续满负荷的天花板 ≈ 低配每秒 40 次、中配 150、高配 400。根因是**记录和转发在同一个 goroutine 里串行执行**——§11 的异步化把这一点移除。

## 5. 并发换算（Little's law）

100 QPS × avg 4.4 s = **440 个请求同时在途**。一人同一时刻一般只发一个请求，考虑思考/阅读间隔，100 QPS 对应数千人同时在线——即"规模扩大数百倍"才会触及 QPS 问题，短期不构成约束；**真正该管理的是存储与文件数（§8）**。

## 6. 看板读取侧拐点

- `src/server/audit/index.ts:157-188` `readIndexDay` **无条件** `readFile` 整份日索引 → `split("\n")` → 逐行 `JSON.parse`；解析发生在 `AUDIT_INDEX_CACHE_MAX_ENTRIES=20000` 判断**之前**；`src/server/cache.ts:161-168` `sizeOf` 还会对全量条目 `JSON.stringify`。
- 单日 > 2 万行后索引不再缓存：每次翻页重解析 5 MB+ 并全量 `map/filter/sort`（`scanConversations` 先全量分组），Node 事件循环阻塞 100–200 ms/次。`MAX_GROUP_SCAN_REQUESTS=10_000`（[05-dashboard-plan.md](05-dashboard-plan.md) §10.2）只保护分组，保护不了解析与排序。
- 影响定性：看板仅管理员使用，"并发打开页面致 OOM"不成立；实际影响为**调用量涨后打开页面变慢**，属体验问题。注意拐点取决于**被采集的 LLM 调用日总量**，与看板使用人数无关。
- 对应调用量：2 万行/天 ≈ 当前规模的 3.6 倍（≈ 0.7 QPS 持续 8 h，或当前峰值的数倍集中）。

## 7. 风险评估结论

### 7.1 重复 LLM 请求 —— 已证伪（重要修正）

早期假设：`proxy_next_upstream error timeout http_502 http_503 http_504` + `proxy_request_buffering on` + `backup` 直连会导致"上游一慢 → 代理超时返回 502 → nginx 把带 body 的 POST 重发到 backup → 重复计费/重复生成"。

**查证 nginx 官方文档后证伪**。`proxy_next_upstream` 的 `non_idempotent` 参数（1.9.13+）明确：

> normally, requests with a non-idempotent method (POST, LOCK, PATCH) are not passed to the next server if a request has been sent to an upstream server; enabling this option explicitly allows retrying such requests

当前配置（[03-deployment.md](03-deployment.md) §5.1）**未启用** `non_idempotent`，因此：

1. POST 请求一旦发出（哪怕部分 body），无论命中 `error` / `timeout` / `http_502/503/504` 哪个条件，nginx 都**不会**把它重发到 backup——重复计费链条不存在；
2. backup 兜底的真实覆盖面 = 连接阶段失败（代理进程挂掉、connection refused，此时请求尚未发出）；
3. 代理慢导致的 502/504 直接透传调用方，是否重试由调用方决定（与任何网关一致，非本项目引入）；
4. 流中途出错不可重试（nginx：passing to next server only possible if nothing has been sent to a client yet），双向安全。

**裁决**：nginx 配置保持现状。收窄为 `error` 只会改变 GET 的重试语义，实际收益趋近于零。

**随实施提交的文档勘误**：[03-deployment.md](03-deployment.md) §5.2 中 `proxy_request_buffering on` 的"保留请求体以便重试"表述需修正——该配置的真实作用是缓冲请求体以便代理完整读取，重试语义由 `non_idempotent` 缺省规则决定（请求已发出的 POST 不切换，502/504 直接透传）。

### 7.2 采集资源无上限 → 由 §11 的资源围栏解决

无队列、无背压、无并发上限、`Transport` 无 `MaxConnsPerHost`、无 `IdleTimeout`；故障模式是 OOM/fd 耗尽而非"只丢采集"。D-P3（§11）以**全局字节预算 + 有界队列**落地围栏，`MaxConnsPerHost` 与 `IdleTimeout` 作为转发侧背板一并处理。

### 7.3 清理缺失 → 由 §14 的清理脚本解决

见 §8：数据只增不减，文件数比容量更早出问题。

### 7.4 可观测性 → 最小两计数

`/healthz` 现有 captured/skipped/failed 三计数。加 `dropped`（队满丢弃 + 预算跳过累计）与 `buffered_bytes`（当前驻留内存字节 gauge）两个原子计数，不做直方图/p99。目的：让"采集正在降级"可被发现，而不是靠看板缺数据倒查。每请求开销 = 两次 atomic add（纳秒级）。

## 8. 存储与文件数

按实测 63 KB/请求、2 文件/请求、索引 250 B/行：

| 日调用量 | 每天 | 30 天 | 90 天 | 文件数/天 |
|---|---|---|---|---|
| 5.6k（当前规模） | 345 MB | 10 GB | 30 GB | 1.1 万 |
| 2 万 | 1.2 GB | 36 GB | 108 GB | 4 万 |
| 10 万 | 6 GB | 180 GB | 541 GB | 20 万 |
| 50 万 | 30 GB | 901 GB | 2.6 TB | 100 万 |
| 288 万（≈100 QPS × 8h） | 173 GB | 5.1 TB | 15.2 TB | 576 万 |

- 当前规模一年 ≈ 123 GB / 400 万文件。**比容量更早出问题的是文件数**：目录遍历、备份、清理卡顿，inode 可能先于空间耗尽。
- 压体积的两个空间（供未来参考，本轮不动正文存储，见 D-P3/D-P4）：
  1. SSE 原始流比最终文本大 30–40 倍（响应 avg 235 KB 的主因）；
  2. 多轮会话每轮请求体都带全量历史（avg 91 KB 中大半重复，看板 `computeThreadDelta` 的 LCP 差分即为证据）。

## 9. 压测验证方案

数字定界需 A/B 压测（假上游固定输出 SSE，模拟 LLM 时长 3–15 s）：

1. 工具：vegeta / hey；同一假上游，分别打 `:3090`（走代理）与直连 `:3000`。
2. 阶梯：1 / 5 / 10 / 30 / 50 / 100 / 200 QPS，各 ≥10 分钟。
3. 记录：TTFT、chunk 间隔 p99、总时长 p99；代理 `/healthz` 计数、CPU%、RSS、fd 数；`iostat` 磁盘 util；同机 new-api 的延迟对照。
4. 验收线建议：走代理 vs 直连的 TTFT p99 差 < 10 ms（页缓存命中）。
5. D-P3 实施后增测两组降级行为：`AUDIT_MEM_BUDGET` 调小验证预算截停（`dropped` 增长、转发无感）；慢盘注入验证队列积压与排空。
6. 原计划中"故意让代理慢/返回 502，验证 nginx 是否重发 POST"的专项**撤销**：§7.1 已由 nginx 文档查证证伪。

## 10. 决策记录（D-P1～D-P5）

沿用 [04-decisions.md](04-decisions.md) 的记录风格：只写结论、依据、代价，不保留讨论过程。总原则见 §1。

### D-P1 清理脚本 + 保留期可配置 —— 已裁决：做

**结论**：实现按日期目录的清理脚本；保留期通过 `AUDIT_RETENTION_DAYS` 配置（默认 90 天，与 [02-design.md](02-design.md) §6.3 建议一致）；不部署脚本则维持现状（无清理）。同时清理 `.tmp` 残留（采集中断产物）。脚本必须先 dry-run（打印待删清单，确认后执行）。实施设计见 §14。

**依据**：§8——当前规模一年 ≈ 123 GB / 400 万文件且无人清理；保留期是纯运维参数，写死或激进缩短都不可取。

**代价**：脚本需 dry-run 与日期目录双格式（§13 段化后）兼容；清理口径需与看板查询窗口（`AUDIT_MAX_WINDOW_DAYS=31`）保持余量。

### D-P2 按调用方指纹比例抽样 —— 已裁决：做，默认关闭

**结论**：按**调用方指纹**整体抽样——被抽中的指纹全量记录，未抽中的完全不落盘；不做按请求随机抽样、不做按模型/错误率等其他维度。机制：`sha256(指纹) % N < K → 记录`，无状态（同指纹恒定判定、重启不抖动），判断放在 begin 之前的 `shouldCapture` 处，未命中只进 `skipped` 计数，转发路径增加成本为一次哈希取模（纳秒级）。**默认 `N=0` 关闭 = 现状全量记录，行为不变**。代理启动时把抽样状态写入 `AUDIT_DIR/meta.json`，看板只读读取后展示统一提示。看板口径：抽样开启时**只有会话层面按被抽中的调用方筛选监听**（被抽中指纹的会话/线程视图完整），其他汇总统计不做用户维度口径（总量以 New API 主库为准）。实施设计见 §12。

**否决记录**：讨论中曾提出"固定选人白名单"（指定指纹/key 全量监听），否决——未采集的调用方在索引里没有指纹可查（名单无法从数据侧获得），按 key 原文配置则依赖 Authorization 头的确切形态（前缀、`x-api-key` 客户端无 Authorization → `_anon`），配置脆弱且与指纹前缀漏配同型。

**依据**：存储与文件数按比例直降（抽中 K/N ≈ 存储 K/N）；被抽中调用方的会话视图完整（不像按请求随机抽样那样碎片化）。

**代价**：未抽中调用方的历史不可回溯（只能等下个配置周期）；N/K 配置错 = 整体漏采或全采（与指纹前缀漏配同型）；小用户数下粒度是"抽中几个指纹"而非精确比例；抽样开启期间审计看板的请求量汇总只反映被抽中部分（已由统一提示声明口径）。

### D-P3 落盘异步化 + worker 压缩 —— 已裁决：做（a+b 组合）

**结论**：不碰协议解析、不存拼接文本，改两条并一次落地：**（a）压缩随流进行**——gzip 从 `finish()` 的"读 tmp + 压缩 + 写 gz + 删 tmp"三次 I/O，变为 worker 上"内存 → gz.tmp"一次直达（阈值逻辑与 `qz`/`rz` 语义不变）；**（b）落盘/压缩/索引/正则全部移入有界队列的后台 worker**——转发路径只剩内存拷贝 + 一次非阻塞入队，磁盘抖动完全不影响 LLM 请求，[02-design.md](02-design.md) §3 的队列承诺归真。配套**全局字节预算**（`AUDIT_MEM_BUDGET`，默认 256 MB）与三层降级（见 §11），预算归零即停采总开关；**不做同步/异步双路径**，回滚靠格式兼容换回旧二进制。`/healthz` 增加 `dropped`、`buffered_bytes`（§7.4）。实施设计见 §11。

**依据**：转发路径只剩 memcpy + 入队，转发影响不增反降（§3 的四个阻塞点全部移除）；容量天花板从"采集 CPU 锁死"（低配 ≈40 / 中配 ≈150 / 高配 ≈400 QPS）升到 fd/内存/机器总 CPU 边界（≈1100–3600 QPS 档）；磁盘格式零变化（文件布局、索引 schema、`qz`/`rz`/`tr` 不变），看板与清理脚本零改动、新旧二进制混跑与回滚安全；为 D-P5 方案 A 预留接入缝。

**代价**：采集侧最大一次并发改动（队列 + worker + 预算 + 优雅停机）；记录内存驻留从 0 变为"请求时长 + 队列等待"（均值 ≈417 KB/在途，100 QPS 档 ≈183 MB）；崩溃丢失窗口从"tmp 半文件"扩大为"整条记录"（看板可见性不变，均无索引行）；`capture_test.go` 按异步语义重写。

### D-P4 多轮对话只存新增 —— 已裁决：不做

**结论**：否决（含"重试轮 sha256 相同才去重"的安全折中，一并否决）。

**依据**：判"新增"需要会话归属 + 上一轮完整请求体对比——代理需有状态缓存（内存不可控、崩溃即丢、同会话并发与客户端重试使"上一轮"定义模糊）+ 完整 JSON 解析，违背 D8（代理不解析 JSON）与 §1 总原则；**判错的代价是数据永久丢失，不可降级**；展示层已有等价能力——看板 `computeThreadDelta`（[05-dashboard-plan.md](05-dashboard-plan.md) §9.4）在读取时按请求体 LCP 差分展示"本轮新增"，存储层全量是它的前提。

**代价**：无（维持现状）。省存储走 D-P2 抽样 + D-P3 压缩。

### D-P5 小文件合并：段式打包（方案 A）—— 已裁决：做，否决外部归档

**结论**：改代理写侧为**段式打包**——`blobs/<date>/<fp>/seg-<HH>-<seq>.pack`，段文件 = 多条记录顺序追加（定长二进制头 + payload），去掉 tmp 文件与 rename，文件数从 2N/天降到每天几十个。索引增加 `seg`/`off`/`ln` 三字段，无 `seg` 的旧行走旧的两文件路径，**新旧并存过渡**。实施排在 D-P3 之后（复用其 worker 接入缝）。实施设计见 §13。

**否决记录**：方案 B（cron 将 N 天前的 `blobs/<date>/` 打包为 tar 归档）否决——D-P1 清理脚本落地且运维启用保留期后，文件数已有界，B 的原始定位（止住文件数无限涨）不再成立；且无压缩 tar 体积是现有 gz 态的 5–8 倍（磁盘占用不降反升），tar.gz 则点读需整包顺序解压（每日数百 MB，秒级不可接受）；reader 还需引入 tar 依赖。

**依据**：文件数 2N/天 → 每天几十个段，inode、目录遍历、备份、清理、单目录元数据热点全部解除；元数据 8–10 次/请求 → ≈0；读侧 1 次 open + 1 次 pread（比现状 2 次 open 更快）；D-P3 之后只有 worker 写段，per-fp 段锁天然无竞争。

**代价**：写侧格式重设计（定长头/flags/滚动/段锁）+ 索引加字段 + 新旧并存双路径读；崩溃损失粒度变大（段尾半条，长度头可跳过）；清理脚本需同时处理旧目录布局与新段文件；代理 + 索引 + reader + 清理四方联动，工作量仅次于 D-P3。

## 11. 实施设计：落盘异步化 + worker 压缩（D-P3）

### 11.1 目标形态

| 阶段 | 现状 | 目标 |
|---|---|---|
| begin() | ensureDir（全局锁）+ O_EXCL 创建 2 个 tmp 文件（`capture.go:114-166`） | 仅分配 record 结构（纳秒级） |
| 请求体流 | TeeReader → bufio(32 KB) → 磁盘写 | 追加进内存 reqBuf |
| 响应体流 | 先发客户端，再 bufio → 磁盘写 | 先发客户端，再追加进内存 resBuf |
| 请求结束 finish() | flush×2 + close×2 + gzip 重读重压×2 + rename×2 + 正则×4 + 序列化 + 索引（全局锁） | 非阻塞入队，立即返回 |
| 磁盘/压缩/索引/正则 | 全在请求路径 | 后台 worker 独占 |

转发路径只剩：内存 append（memcpy）+ 一次 channel 非阻塞发送。磁盘抖动、gzip CPU、单目录元数据热点、正则扫描全部移出请求路径。

### 11.2 数据流

```text
请求 goroutine：
  writeRequest(p)  → peek 追加（≤256 KB，不变）+ reqBuf 追加（≤MAX_REQUEST_BYTES，截断位不变）
  writeResponse(p) → resBuf 追加（≤MAX_RESPONSE_BYTES，不变）；首字节时间戳不变
  finish(errMsg)   → 组装 record 快照 → select { queue <- rec / default: dropped++ }

worker（N 个，默认 2）：
  rec := <-queue
  ensureDir（dirMu 从请求路径移出）
  O_EXCL 候选循环定最终 trace（原 begin() 逻辑整体搬到 worker，覆盖跨重启同名复用）
  reqBuf →(reqN ≥ 64 KB ? gzip : 裸写)→ req.tmp → rename；res 同
  正则提取 model / stream / sessionKey（从请求路径移出）
  appendIndex（最后写索引——不变式：索引行存在 ⇒ blob 已 rename 就位）
  释放 buffer，captureBytes -= n
```

### 11.3 内存预算与三层降级

`MAX_REQUEST_BYTES` / `MAX_RESPONSE_BYTES` 默认各 128 MiB（[02-design.md](02-design.md) §6.1，覆盖 1M tokens 上下文）。数据驻内存后，逐条上限不能改（既有截断语义），因此用**全局字节预算**：

- 全局 `captureBytes`（atomic）：reqBuf + resBuf + peek 的实时总量，每 chunk 一次 atomic add；
- 预算 `AUDIT_MEM_BUDGET`（默认 256 MB）；**预算 = 0 即停采总开关**（运维可在不重新部署的情况下热停采集，代替"异步开关"——不保留同步/异步双路径，单一代码路径的测试面小一半，回滚靠格式兼容换旧二进制）；
- 三层降级，全部只作用于采集：

| 时机 | 动作 | 计数 |
|---|---|---|
| 预算超限 + 新请求到来 | 跳过采集，转发照常 | `skipped++` |
| 预算超限 + 在途流传输中 | 该记录停止缓冲、释放已缓冲内存，`tr` 位标记截断（复用现有截断语义），转发照常 | `tr` 位 |
| 队列满（入队失败） | 丢弃该记录（无索引行、无 blob），转发照常 | `dropped++` |

- 规模核算：实测均值 req 91 KB + res 235 KB + peek≈req（前缀复制）≈ 417 KB/在途；100 QPS × 4.4 s = 440 在途 ≈ 183 MB < 256 MB 预算；当前规模 ≈ 4 MB。极端全满载由预算截停，进程不 OOM。
- 设计的降级次序：磁盘慢 → 队列积压 → 预算上涨 → 在途停缓冲 → 新请求跳过；每一步只丢采集，转发零感知。

### 11.4 崩溃与失败语义（与现状对齐）

| 场景 | 现状 | 目标 |
|---|---|---|
| 进程崩溃（流中） | tmp 半文件残留，无索引行（看板不可见） | 无磁盘产物，记录消失，无索引行——可见性相同 |
| 进程崩溃（已入队未落盘） | （不存在此态：finish 同步完成） | 队列中记录全损，无索引行，可见性相同 |
| 磁盘写失败 | 保留 .tmp 由清理脚本回收 | 同：worker 失败保留 .tmp，`failed++`，不重试（磁盘持续故障时重试会阻塞 worker） |
| 索引与 blob 不变式 | rename 后才 appendIndex | 不变 |

### 11.5 关键细节

1. **trace 冲突处理搬到 worker**：begin() 不再碰磁盘；O_EXCL 候选循环（`capture.go:128-145`）移到 flush 时执行，顺带覆盖"跨重启后同名 trace 复用"（纯内存方案盖不住的场景）。
2. **压缩阈值逻辑保留**：worker 按 reqN/resN ≥ `GZIP_THRESHOLD`（64 KB）决定 gzip 或裸 rename，与现状逐字节同构，`qz`/`rz`/`tr` 语义零变化；压缩在 worker 是"内存 → gz.tmp"一次直达，结构上消灭 `finish()` 的三次额外 I/O——(a) 的目标在 (b) 中以此实现，不再是独立机制。
3. **计数语义**：captured 在 begin 受理时 +1；flush 失败计 failed；队满/预算计 dropped；`/healthz` 新增 `dropped` 与 `buffered_bytes`。
4. **shutdown**：SIGTERM → `srv.Shutdown`（15 s ctx）→ close(queue) → worker 清空队列（上限 queue 容量 × 预算，秒级）→ 退出。Docker 默认 10 s SIGKILL 丢队内记录，与"崩溃丢流中记录"同级，接受。
5. **worker 数**：gzip 326 KB ≈ 4–8 ms/条 → 单 worker 125–250 条/s；100 QPS 档位需 2 个。默认 `AUDIT_FLUSH_WORKERS=2`。
6. **队列容量**：`AUDIT_QUEUE_CAP=256` 条；队内字节受全局预算约束，不独立膨胀。
7. **转发侧背板**：`Transport.MaxConnsPerHost`（默认 2048）——唯一作用于转发的限制，超限时新请求排队等空闲连接而非新建，把"fd 耗尽/OOM 进程崩溃"转化为"排队延迟上升"；2048 并发 ≈ 465 QPS 持续（avg 4.4 s），只在故障时刻起作用。`Server.IdleTimeout`（默认 120 s）——只回收请求间空闲的 keep-alive 连接，对流式响应零影响（WriteTimeout 仍不设）；`main.go:56` 注释把两者混为一谈，一并修正。
8. **磁盘格式零变化**：文件布局、索引 schema、`qz`/`rz`/`tr` 完全不变——看板 reader（`reader.ts:128` 已 gz/非 gz 双候选回退）与清理脚本零改动；新旧二进制混跑、随时回滚均安全。
9. **与 D-P5 的衔接**：worker 的"持久化一步"就是段式打包的接入缝——方案 A 落地只改 worker 内部（tmp+rename → 段追加），转发路径与预算机制原封不动；A 的 per-fp 段锁在"只有 worker 写"前提下天然无竞争。
10. **测试**：`capture_test.go` 按异步语义重写（慢盘注入、队满、预算截停、优雅停机）；[02-design.md](02-design.md) §3"队列有界、满则丢弃"归真。

### 11.6 配置新增

| 变量 | 默认 | 语义 |
|---|---|---|
| `AUDIT_MEM_BUDGET` | 256 MB | 采集缓冲字节预算；`0` = 停采总开关 |
| `AUDIT_FLUSH_WORKERS` | 2 | 落盘 worker 数 |
| `AUDIT_QUEUE_CAP` | 256 | 待落盘队列容量（条） |
| `UPSTREAM_MAX_CONNS_PER_HOST` | 2048 | 上游每主机连接数上限（转发侧背板） |
| `IDLE_TIMEOUT` | 120 s | Server keep-alive 空闲连接回收 |

## 12. 实施设计：按调用方指纹比例抽样（D-P2）

### 12.1 机制

- 判定（begin 之前的 `shouldCapture` 处）：`sha256(指纹) % SAMPLE_MODULUS < SAMPLE_KEEP` → 采集，否则 `skipped++`。
- **默认关闭**：`SAMPLE_MODULUS=0`（关闭）= 现状全量记录，行为不变；启用时要求 `1 ≤ SAMPLE_KEEP ≤ SAMPLE_MODULUS`，否则启动报错（与 `CAPTURE_PATHS` 为空的同款校验风格）。
- 无状态：不维护"谁被抽中"的表，无并发/崩溃问题；同指纹恒定判定，重启不抖动。
- 成本：一次 sha256（12 位 hex 字符串）+ 取模，纳秒级。

### 12.2 配置与 meta.json

| 变量 | 默认 | 语义 |
|---|---|---|
| `SAMPLE_MODULUS` | 0（关闭） | 抽样模数 N；`0` = 全量记录 |
| `SAMPLE_KEEP` | 1 | 保留数 K；启用时须 `1 ≤ K ≤ N` |

代理启动时写 `AUDIT_DIR/meta.json`：

```json
{ "sampling_enabled": false, "sample_modulus": 0, "sample_keep": 1 }
```

看板只读读取（文件缺失 = 视为未开启，兼容旧代理），用于展示统一提示，避免看板/代理两处配置漂移。

### 12.3 看板口径

- 抽样开启时展示统一提示："抽样开启时，未抽中的调用方不产生任何记录"（驱动来自 meta.json）。
- **只有会话层面按被抽中的调用方筛选监听**：被抽中指纹的会话/线程视图是全量记录的，按用户筛选照常工作；未抽中指纹在索引中没有任何行，天然不出现在会话列表里。
- 其他汇总统计不做用户维度口径（抽样数据不能当全量统计）；总量口径以 New API 主库为准。

### 12.4 已知限制与代价

- 未抽中调用方的历史不可回溯；N/K 配置错 = 整体漏采或全采。
- 小调用方数量下，抽中的是"几个指纹"而非精确比例，参数按调用方数量尺度理解。
- `_anon`（无 Authorization 头的 x-api-key 客户端）作为一个指纹整体参与抽样——要么全抽中要么全不抽中；当前样本无此类流量，登记为已知限制。

## 13. 实施设计：段式打包（D-P5 方案 A）

> 排在 D-P3 之后实施：只改 worker 内部的持久化一步，转发路径与预算机制不再动。

- **布局**：`blobs/<date>/<fp>/seg-<HH>-<seq>.pack`，段文件 = 多条记录顺序追加。
- **记录格式**：定长二进制头（如 `[magic 4B][len 4B][flags 2B]`，flags 含 gzip/截断位）+ payload；头部带长度即可跳过损坏记录，崩溃只丢段尾半条（与 NDJSON 半行同思路）。
- **写入**：record 流式追加进当日段文件（per-fp 段锁；D-P3 后只有 worker 写，锁退化为 worker 内互斥）；**去掉 tmp 文件与 rename**；段达 32 MB 或跨小时滚动。
- **压缩**：每条 payload 独立 gzip（阈值沿用 `GZIP_THRESHOLD`，与现状同构，读侧零新逻辑）；段文件本身不压缩。
- **索引**：增加 `seg` / `off` / `ln` 三字段；无 `seg` 的旧行走旧的两文件路径，**新旧并存过渡**。
- **读侧**：段模式 = 1 次 open + 1 次 pread + 按 flags gunzip，比现状 2 次 open 更快。
- **转发影响**：与 D-P3 后形态同构（worker 追加 + 缓冲），元数据操作 ≈0。
- **风险**：段内坏记录影响同段（长度头可跳过）；清理脚本需同时处理旧目录与新段；reader 双路径长期共存（新字段缺省回退）。

## 14. 实施设计：清理脚本（D-P1）

- **对象**：`blobs/<date>/` 整目录 + `index/<date>.ndjson` 同寿命删除；同时清理 `.tmp` 残留（采集中断产物；段化后含半包残留）。
- **保留期**：`AUDIT_RETENTION_DAYS`（默认 90，与 [02-design.md](02-design.md) §6.3 一致）；`0` = 禁用清理。**不部署脚本 / 不配 cron 则维持现状（无清理），默认行为不变**。
- **安全**：默认 dry-run（只打印待删清单）；实际删除需显式确认参数；删除动作限定在 `AUDIT_DIR` 内（防止参数注入路径）。
- **口径**：保留期必须大于看板查询窗口上限（`AUDIT_MAX_WINDOW_DAYS=31`），90 天留有余量；清理只按"日期目录整体"进行，不做按指纹/文件的部分删除（与"看板不删除、合规删除走运维"的边界一致）。
- **实现形态**：随 audit-proxy 发布包提供脚本（shell），由 systemd timer 或 cron 调度；调度由运维决定，组件不内置常驻清理 goroutine（避免采集进程自己删自己的活跃数据引入新失败面）。

## 15. 实施顺序与文档联动

| 步骤 | 内容 | 依赖 | 涉及文档更新 |
|---|---|---|---|
| ⓪ | nginx 文档勘误（§7.1）：03-deployment §5.2 的 backup/重试表述修正 | 无（纯文档） | 03-deployment §5.2 |
| ① | D-P1 清理脚本 | 无（独立零风险） | 03-deployment §7/§9（脚本实现后）、02-design §6.3 状态 |
| ② | D-P2 比例抽样 + meta.json + 看板提示 | 无 | 03-deployment §3 配置表、02-design §4（meta.json）、audit-proxy env.example、看板 `.env.example` |
| ③ | D-P3 a+b + §7.2 围栏 + §7.4 计数（同一实现） | 无 | 02-design §3（队列承诺归真）与 §6.1 配置表、03-deployment §3、audit-proxy README/env.example |
| ④ | D-P5 方案 A 段式打包 | ③ 的 worker 接入缝 | 02-design §4 布局与 §5 索引字段、reader 文档、03-deployment §7 |
| ⑤ | §9 压测验证（③ 后执行） | ③ | 视结果修订本文 §4 的分档表 |

每步完成后按 [05-dashboard-plan.md](05-dashboard-plan.md) 的惯例更新 README 实现状态表。

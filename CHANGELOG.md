# 更新日志

本项目的所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- **采集数据清理脚本（clean-dashcam.sh，D-P1）**：随 dashcam 发布包提供，按日期目录整体删除
  早于保留期（`DASHCAM_RETENTION_DAYS`，默认 90 天、`0` 禁用）的 blobs 与同寿命日索引，并回收
  `.tmp` 残留；默认 dry-run，显式 `--confirm` 才删除。调度示例（systemd timer / cron）见
  `docs/dashcam/03-deployment.md` §7。
- **按调用方指纹比例抽样（D-P2）**：代理新增 `SAMPLE_MODULUS` / `SAMPLE_KEEP`
  （`sha256(指纹) % N < K` 判定，默认关闭 = 全量记录），被抽中指纹全量记录、未抽中不落盘；
  启动时把抽样状态写入 `DASHCAM_DIR/meta.json`，看板会话列表据此展示统一口径提示
  （未抽中的调用方不产生任何记录，总量以 New API 主库为准）。
- **落盘异步化 + 资源围栏（D-P3）**：转发 goroutine 只做内存缓冲与非阻塞入队，
  落盘/压缩/索引/正则全部移入后台 worker（`DASHCAM_FLUSH_WORKERS=2`、队列
  `DASHCAM_QUEUE_CAP=256` 有界满则丢弃），磁盘抖动不再影响 LLM 请求；
  全局内存预算 `DASHCAM_MEM_BUDGET`（默认 256 MB，`0` = 停采总开关）三层降级
  （拒收新请求 → 在途停缓冲 → 丢记录），`/healthz` 新增 `dropped` 与
  `buffered_bytes`；新增转发侧背板 `UPSTREAM_MAX_CONNS_PER_HOST` 与
  `IDLE_TIMEOUT`；磁盘格式零变化，新旧二进制可随时互换回滚。
- **段式打包（D-P5）**：blob 写侧改为 `blobs/<date>/<fp>/seg-<HH>-<seq>.pack`
  顺序追加（定长二进制头 + req/res payload，req/res 各自独立 gzip），去掉 tmp
  文件与 rename，文件数从 2N/天降到每天几十个段；索引新增 `seg`/`off`/`ln`
  定位字段，无 `seg` 的旧行走旧两文件路径，**新旧并存、不做数据迁移**；
  崩溃只丢段尾半条（长度头可跳过，无索引行、不可见）；看板读取侧 1 次 open +
  按需 pread。
- **提示词与响应采集（new-api-dashcam）**：独立 Go 前置代理，把白名单对话接口的请求与响应原样落盘
  （按天 NDJSON 索引 + blob 文件），转发零第三方依赖，仅丢采集不丢调用。
  - 索引含模型、状态、耗时、截断位、会话键哈希（`k`）与 token 用量（`pt`/`ct`/`cc`/`cw`，
    落索引前从响应尾部提取）；
  - 支持 gzip、128 MiB 截断、systemd / Docker 部署与独立发布流水线；
  - nginx `backup` failover 兜底：代理不可用时回落直连，只丢采集不丢调用；
  - token 提取口径由共享契约样例 + Go / TS 双侧测试锁定。
- **会话查看**：用户详情新增「会话」卡片与右侧抽屉，展示采集到的提示词与模型返回。
  - 抽屉分结构化 / 原始报文 / 事件流三页签，覆盖四种协议、错误体与截断标记；
  - 角色界定：代理只存指纹，看板按 `tokens.key` 重算指纹做确定性归属；
  - 会话键只存哈希，知道键也读不到别人的会话。
- **会话聚合与线程增量**：同一会话的几十轮压成一行，线程抽屉每轮只展示相对上一轮新增的消息。
  - 会话键按协议取自 `prompt_cache_key` 或 Claude `metadata.user_id`，无键请求各自成行；
  - 消息签名 + 最长公共前缀计算增量，上下文被裁剪时明确提示；
  - 最后一轮默认展开，开头的系统提示 / 上一轮回答收进「上下文回放」。
- **会话独立列表页**：`/users/[id]/sessions` 新窗口打开，页码翻页 + 日期过滤，仅表格区滚动。
- **抽屉过滤条与全屏**：详情抽屉与线程抽屉支持角色 / 类型 / 关键词过滤（线程按轮显示命中数）与全屏切换。
- **token 用量展示**：请求 / 响应改为输入（蓝）/ 输出（绿）token 定宽胶囊，缓存命中追加「缓存 N」标签，
  覆盖「按请求」表格、线程卡与详情抽屉。

### 变更

- **导出入口合并**：排行卡片的两个导出图标合并为一个下载下拉菜单（图表 HTML / 明细 CSV）。

### 说明

- 监控记录只读挂载（`DASHCAM_DIR`），不写数据库；记录目录不可用时看板降级提示，不报错。
- 索引 token 字段可选：旧数据显示 —，或按 `DASHCAM_USAGE_HYDRATE_MAX`（默认 100）读时水合兜底。
- `MAX_REQUEST_BYTES` / `MAX_RESPONSE_BYTES` 默认 128 MiB（覆盖 1M tokens 上下文）。

## [0.1.1] - 2026-11-12

### 修复

- **经反向代理、域名或 IP 访问时无法登录（403 `invalid_origin`）**：登录接口的同源校验用
  `new URL(request.url).origin` 与浏览器 `Origin` 比较，而 Next.js 在 Route Handler 中把
  `request.url` 解析为服务端自身的监听地址（`http://localhost:<PORT>`），忽略 `Host`。
  因此除「本地 localhost 直连」外，两者恒不相等。现改为按 `X-Forwarded-Host` → `Host`
  与 `X-Forwarded-Proto` 解析对外 origin 后再判定，同时保留跨站拦截。

## [0.1.0] - 2026-11-12

首次公开发布。

### 新增

- **全局总览**：消耗、请求数、Token、活跃用户、模型数；用户消耗排行、每日消耗热力图、消耗趋势（环比 / 同比）。
- **沉默用户**：按「上期活跃 − 本期活跃」给出用户清单，含最后活跃时间、上期请求数与详情入口。
- **模型分析**：模型排行（按额度 / 请求数 / Token 切换）、多模型趋势、用户 × 模型交叉分布、单次请求平均成本。
- **用户详情**：个人总览、使用趋势、模型分布、Token 输入/输出占比、活跃热力图、最近使用记录。
- **导出**：图表导出为自包含 HTML、四类数据集 CSV 导出、服务端整页快照。
- **访问控制**：独立登录页 + HttpOnly 会话 Cookie（HMAC-SHA256，12h）；页面未登录重定向、接口返回 401。
- **工程**：Next.js 16（App Router / Turbopack / standalone）、Kysely 只读查询层、进程内 `lru-cache`、`/api/health` 连通与 schema 自检。
- **交付**：多阶段 Dockerfile（含 Playwright 快照变体）、docker compose、演示数据库 profile、`pnpm release:pack` 生成 tar.gz 安装包。

### 说明

- 所有统计排除管理员账号 `admin`。
- 用户展示以昵称优先，账号作为次要信息保留。
- 时间区间左闭右开，边界按 `Asia/Shanghai` 计算。

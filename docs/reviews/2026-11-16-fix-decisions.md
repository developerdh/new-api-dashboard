# 全量代码审查修复 — 决策记录(2026-11-16)

对应审查:本日全量 OCR range 审查(根提交 `c199374` → HEAD,149 文件,5 High / 26 Medium / ~40 Low)。
执行方式:维护者授权立即执行(原定 23:10 定时任务已撤销),决策采用推荐方案并在此落账。
**修改全部留在工作区未提交**(`git status` / `git diff` 可复核),提交权保留给维护者。

## 总纪律(全程遵守)

- 不写数据库、不修改 `docs/方案.md`(红线 5)、不运行 e2e(R2)、不 commit/push(AGENTS.md:提交由维护者发起)。
- untracked 的 `docs/article/` 与 `dashcam/new-api-dashcam` 二进制未动、未删(后者已加入 .gitignore)。

## 预定决策 D1–D15(执行前已向维护者报备收益/损失,按原案执行)

| # | 决策 | 采用方案 | 收益 | 损失 | 执行结果 |
|---|---|---|---|---|---|
| D1 | 图表 tooltip XSS | 复用 export-html 的 escapeHtml | 零新文件、已有测试、改动最小 | 图表层对导出模块轻微依赖方向瑕疵 | ✅ 三处 tooltip 全部转义 |
| D2 | 限流取 IP | request-origin 共享 clientIp,优先 x-real-ip | 反代场景不可伪造、单一实现 | 直连部署仍可伪造(与现状同级) | ✅ login/export/csv 统一 + 4 个新用例 |
| D3 | 开放重定向 | 两处拒绝含 `\` 的 next | 消除解析差异类 | 含反斜杠合法路径被拒(不存在) | ✅ login-form + proxy |
| D4 | CSV 公式注入 | `= + @ Tab` 与非纯数字 `-` 前置 `'`,纯数字负数保留 | 阻断注入且不破坏负数 | `-` 开头文本多前导 `'` | ✅ escapeCsvField + 用例 |
| D5 | 查询区间上限 | queryParamsSchema 共享 ≤366 天 | 一处防护覆盖全部端点 | >366 天查询被拒 | ✅ QUERY_MAX_RANGE_SECONDS |
| D6 | other 列 | schema-check + demo 库补列 | 自检真实覆盖、demo 可联调 | 无 | ✅(demo logs 另造 1/3 行 anthropic 样例) |
| D7 | 主题切换丢交互态 | 主题路径 merge、数据路径保持 notMerge | 保留图例/缩放态 | optionRef 外临时配置残留 | ✅ |
| D8 | signOut 失败 | catch + !ok 判定,失败不导航 | 行为诚实可重试 | 失败仅按钮复位无文案 | ✅ |
| D9 | playwright 动态导入 | turbopackIgnore/webpackIgnore 双注释 + build 验证,失败回退 | 符合规范、可追踪 | 构建验证耗时 | ✅(build 通过,未回退) |
| D10 | index.ts cursor 死代码 | 删除 + 注释改页码语义 | 消除死代码与误导 | 内部 API 面收缩 | ✅(grep 确认无生产调用方;off 非法丢 seg 同步修复) |
| D11 | Token 口径 | 排行弹窗改 formatCompactNumber | 跨页统一 | M 精确量级变近似 | ✅(formatMillions 保留为 util,仍有单测) |
| D12 | workflow 加固 | 版本输入 env 中转+收紧 `v[0-9]*.[0-9]*.[0-9]*`;action 固定 SHA;timeout(ci 20/release 30);concurrency | 供应链与可靠性硬化 | SHA 固定后升级需手动 | ✅(SHA 经 GitHub API 查询:pnpm b906aff、softprops 3bb1273) |
| D13 | Go 修复集 | trace {8,71}、closed 标志防 send-on-closed、env 解析 fail-fast、MAX_*_BYTES ≤1GiB + 防御断言、停机超时日志 | 消除 panic 与静默失效 | 配置错误变启动失败(设计意图) | ✅(go vet + go test 全绿,gofmt 干净) |
| D14 | 限流时钟 | 窗口默认 performance.now(),resetAt 同时间线 | 免疫时钟回拨 | resetAt 不再是 epoch(消费方已同步) | ✅(注入式 now 契约不变,单测零改动) |
| D15 | 交付方式 | 不提交,git diff 交付 | 维护者保留提交权 | 提交前无版本保护 | ✅ |

## 执行中新出现的决策 D16–D25(收益/损失即时落账)

| # | 背景 | 采用方案 | 收益 | 损失 |
|---|---|---|---|---|
| D16 | D14 落地时发现双时钟参数会破坏现有注入式单测 | 保持单一 `now` 契约,默认值换 performance.now,消费方用 `resetAt - performance.now()` 换算 Retry-After | 现有限流单测零改动;实现最小 | resetAt 语义变化需读文档(已同步注释) |
| D17 | D5 生效后 inactive.service 的 366 天校验成为不可达死代码 | 删除服务层重复校验,统一由公共 schema 执行 | 单一执行点,无口径漂移 | 错误 path 从 `range` 变 `end`,定制文案消失(测试已同步) |
| D18 | 366 天上限生效后桶数上限(1000)经公共参数不可达(day ≤366 桶、hour 非法粒度) | MAX_TREND_BUCKETS 保留为服务端纵深防御;路由级测试改为验证共享上限 | 纵深防御保留 | 桶数触发路径无公共路由专测 |
| D19 | snapshot 503 用例依赖「环境未装 playwright」,本机实测已安装(动态导入会成功) | 用例改 `vi.mock("playwright")` 工厂抛错,确定性模拟未安装 | 任何环境可跑,不再环境依赖 | 不再验证真实 import 失败路径(等价模拟) |
| D20 | seg 水合需要把段定位传到 usage 层 | DashcamSegRef 进 DashcamSessionRow/ThreadTurn 类型并透传,UsageSource 增可选 seg | 类型安全、改动最小(列表路由零改动) | API 响应多一个可选 seg 字段(无敏感语义,fp 本就暴露) |
| D21 | 状态重置的 effect 写法触发仓库 `react-hooks/set-state-in-effect` 红线 | 改用 keyed-state(按 traceId/sessionKey 存状态,key 不匹配即默认),对齐 thread-dialog overrideState 既有模式 | 符合仓库 lint 纪律、无 effect 竞态 | 单对象状态略复杂(过滤/展开态打包) |
| D22 | user.ts jsonb 数值守卫需要字段名进 SQL | 字段名参数化(`->> $n`)+ 整数正则守卫 + `::numeric` 取整 | 与参数化红线一致;防脏值 500 | 编译 SQL 断言改结构断言(参数顺序随片段展开) |
| D23 | users-inactive 测试文件的 vi.mock 拦截了集成用例需要的真实实现 | `vi.importActual` 取真实 runInactiveUsersQuery,缓存用例继续用 mock | 真实水合链路获得集成覆盖 | 无 |
| D24 | normalize completions 修复点选择 | 并入第一分支(openai-chat/unknown 共用路径),legacy choices[0].text 回退如期触达 | 与注释意图一致、改动 1 行 | 无 |
| D25 | release-dashcam 版本校验收紧的尺度 | `v[0-9]*.[0-9]*.[0-9]*` 前缀(接受 v0.1.0-beta.1 等) | 阻断畸形输入经 GITHUB_OUTPUT 传播 | `v1.0` 这类非完整三段版本被拒(语义化版本实践可接受) |
| D26 | handleQueryError 存放位置:http.ts 会与 queries/common 形成循环导入(common 已依赖 http) | 放 queries/common.ts 导出,12 个查询路由统一替换 | 无循环依赖;新增路由不再遗漏 redactCredentials | 错误日志文案统一为 `[scope] query failed`(export/snapshot 原为 failed,语义不变) |
| D27 | XSS 复核时发现 chart 层共 3 处注入点(审查报告 2 处 + model-cross-stack seriesName 由 H 批补报) | 三处统一修复,同一 escapeHtml | 一次根治 | 无 |

## 验证结果(Phase 5)

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过 |
| `pnpm lint` | ✅ 通过(0 warning) |
| `pnpm test` | ✅ 450 passed / 7 skipped(基线 443 + 新增 7 用例;修复过程同步更新 4 个受行为变更影响的测试文件) |
| `pnpm build` | ✅ 通过(standalone 产物完整;D9 的 turbopackIgnore 动态导入经构建验证,未回退) |
| `go vet ./...`(dashcam) | ✅ 通过 |
| `go test ./...`(dashcam) | ✅ 全绿(含优雅停机排空与幂等用例) |
| `gofmt -l` | ✅ 干净 |
| e2e | 未运行(R2;需 DB + 浏览器环境,留待维护者) |

## 覆盖对照表

### High(5/5 已修复)

| 发现 | 结果 |
|---|---|
| ECharts tooltip 存储型 XSS(user-ranking-bar / models-client / model-cross-stack) | ✅ 已修复(D1/D27,escapeHtml 转义全部用户可控拼接) |
| models/cross 缓存 key 缺 limit | ✅ 已修复(key 追加 `:cross:limit=N`) |
| normalize 非 JSON 路径遗漏 openai-completions | ✅ 已修复(D24)+ 新增 /v1/completions 非流式用例 |
| 登录/导出限流可被伪造 XFF 绕过 | ✅ 已修复(D2) |
| 登录开放重定向(`/\evil.com`) | ✅ 已修复(D3,双处) |

### Medium(26/26 已修复)

| 发现 | 结果 |
|---|---|
| CSV 公式注入 | ✅ D4 |
| release-dashcam 版本输入命令注入 | ✅ D12(env 中转 + 收紧校验) |
| usage 水合不支持 D-P5 段式记录 | ✅ D20 |
| echarts runtime 失败 Promise 永久缓存 | ✅(catch 复位) |
| snapshots decodeURIComponent 未捕获 | ✅(try/catch → 400) |
| sessions-client 手动刷新错误空态 | ✅(switching 并入 rows.length===0) |
| 主题切换丢图例/dataZoom 状态 | ✅ D7 |
| signOut 无错误处理 | ✅ D8 |
| use-api 非 JSON 错误体丢状态码 | ✅(text-first + `http_<status>` 回退) |
| schema-check 缺 other 列 | ✅ D6 |
| 查询无区间上限 | ✅ D5/D17 |
| seed-demo 缺 other 列 | ✅ D6 |
| ErrorBox/SectionBody 三页重复 | ✅(src/components/section-body.tsx) |
| R1:dashcam-sessions 翻页/条数/重试无 testid | ✅(5 个 testid) |
| R1:sessions-client 步长/重试无 testid | ✅(2 个) |
| R1:message-filters 无 testid、搜索框无 aria-label | ✅(4 组 + aria-label,Chip 组件扩展 rest props) |
| .gitignore 遗漏 dashcam 二进制 | ✅(实测 6.7MB 文件现已被忽略) |
| 第三方 action 未固定 SHA(release/release-dashcam/ci) | ✅ D12 |
| 三个 workflow job 缺 timeout-minutes | ✅ |
| 两个 release workflow 缺 concurrency | ✅ |

### Low(~40/40 已修复;无跳过、无误报)

| 发现 | 结果 |
|---|---|
| capture.go trace 上限 {8,64} 与文档/看板 {8,71} 不一致 | ✅(对齐 71,注释互指) |
| main.go 停机 send-on-closed panic + 超时强杀无日志 | ✅ D13(closed 标志 + 队列不 close + shutdown_timeout 日志;幂等 stopOnce) |
| config.go env 解析失败静默回退、HeaderTimeout 无非负校验 | ✅(fail-fast) |
| pack.go uint32 长度截断 | ✅(config ≤1GiB 上界 + appendPack 防御断言) |
| reader.ts gunzip 损坏外溢 500(两处) | ✅(统一降级 DashcamBlobMissingError) |
| index.ts off 非法归零致记录串台 | ✅(off 存在但非法 → 丢 seg 回退旧布局) |
| index.ts cursor 过时注释 + 死代码 | ✅ D10 |
| traceId 详情 409 先于归属校验 | ✅(归属过滤先行,越权恒 404) |
| model.ts 未过滤 model_name IS NULL(4 个 builder) | ✅(对齐 user.ts) |
| user.ts jsonb ::bigint 对脏数据 500 | ✅ D22 |
| model.ts 死分支 + 失实注释 | ✅(恒写 displayName,注释修正) |
| 注释笔误 8 处(user.ts/model.ts/trend.ts/stat-card/console-shell/echart-inner/users-trend-route/snapshot.service) | ✅(含「复用 trend.ts」缺词补齐) |
| toInteger 查询层 6 份重复 | ✅(下沉 common.ts) |
| inactive.ts 与 user-directory 重复实现 | ✅(复用 loadUserIdentities;D23 集成测试) |
| 路由 catch 兜底同构 ~12 处 | ✅ D26 |
| snapshot 文件名写读白名单不一致 | ✅(写侧收敛;测试断言更新) |
| snapshot.service new Function 规避打包 | ✅ D9(构建验证) |
| health 免鉴权端点泄漏内网 host:port | ✅(redactNetworkEndpoints,仅对外响应;日志保留主机便于排障)+ 3 个新用例 |
| token-pair 缺失字段渲染 0 | ✅(「—」+ title 注明未知;导出 tokenDisplay 供表格 title 复用) |
| session-table title 未千分位 | ✅ |
| dashcam-detail-dialog 状态跨记录串 | ✅ D21(含 expandEarly/showMeta/openGroups) |
| thread-dialog filter 跨会话串 | ✅ D21 |
| thread-dialog 嵌套三元 | ✅(inputSectionTitle 显式化) |
| 两入口六层渲染三元链 | ✅(平铺 if 链 body 变量) |
| `window` 局部变量遮蔽全局(两文件) | ✅(dateWindow) |
| dashboard 骨架与实载列数不一致 | ✅(lg:grid-cols-4 ×4) |
| Token 量纲跨页三种单位 | ✅ D11 |
| chart-export-button 失败静默 | ✅(2.5s 警示色 + title 反馈) |
| rate-limit 时钟回拨 | ✅ D16 |
| use-api 轮询在途去重 | ✅(inFlight 守卫) |
| chart-theme tooltip 合并顺序 | ✅(textStyle 展开后再合成) |
| release-notes 版本子串匹配 | ✅(行首 `## [target]` 精确匹配) |
| loadgen 超时分类恒 0 | ✅(按 abort reason message 识别) |
| seed-demo 头部行数声明过时 | ✅(59 天口径) |

## 遗留说明(非缺陷)

- `formatMillions` 在消费者统一为 formatCompactNumber 后成为无消费导出:保留(含单测),供后续需要 M 单位的场景;如确认弃用可在下次清理。
- `MAX_TREND_BUCKETS` 见 D18:保留为纵深防御,公共路径不可触达。
- 本文件与全部代码修改均未提交;建议维护者按子系统分批 commit(feed: XSS/安全、dashcam 读取层、查询层、workflow、Go 采集器)。

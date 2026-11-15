# 压测工具与运行手册（tests/load）

采集代理（new-api-dashcam）的性能容量压测工具集。本文写：工具用途、指标口径、执行步骤、残留清理与已知限制；不写：采集代理的设计与实现（见 [docs/dashcam/](../../docs/dashcam/)）。压测结论见 [07-loadtest-capacity.md](../../docs/dashcam/07-loadtest-capacity.md)。

关联文档：性能方案与推导值见 [06-performance-plan.md](../../docs/dashcam/06-performance-plan.md)；压测执行纪律见 [docs/dev-rules.md](../../docs/dev-rules.md)。

约束：容量天花板测量必须使用哑上游。真实 LLM 渠道有上游并发限制且真实计费（实测并发 1 即触发 429），高 QPS 阶梯只能打哑上游；真实渠道仅允许 ≤2 QPS 的顺序请求（对照/冒烟）。

## 1. 工具清单

| 文件 | 形态 | 用途 | 运行位置 |
|---|---|---|---|
| loadgen.mjs | Node.js ≥22，零第三方依赖 | 开环定速 / 闭环并发负载生成，逐请求测量 TTFT 与总时长 | 任一可达目标的机器 |
| sample-proxy.sh | POSIX sh | 采集代理进程每秒采样 CPU%、RSS、fd，输出 CSV 与汇总行 | 被测机 |
| dummy-upstream.go | Go 源码 | 哑上游：读全请求体后立即返回最小 OpenAI 兼容响应 | 被测机 |

哑上游构建命令（构建产物不入库）：

```bash
GOOS=linux GOARCH=amd64 go build -o tests/load/dummy-upstream-linux tests/load/dummy-upstream.go
```

## 2. 指标定义

| 指标 | 含义 |
|---|---|
| TTFT | 流式响应首字节到达时间，对应 LLM「第一个字」的等待体验；客户端实测口径 |
| 总时长 | 完整接收响应（含流式结束标记）的耗时 |
| 实测 QPS（achieved） | 配置定速下实际成功完成的请求速率；与配置 QPS 之比即到达率 |
| 代理 CPU% | 采集代理进程 utime+stime 增量折算的每秒占用 |
| RSS / fd | 进程常驻内存（MB）与打开文件描述符数 |
| dropped / skipped | healthz 降级计数：队满丢弃 / 采集开关或预算原因整体跳过 |
| buffered_bytes | healthz 内存 gauge：未核销的采集缓冲字节数 |

## 3. 前置条件

- 被测机可经 SSH 访问；采集代理健康：`GET /healthz` 返回版本号与采集计数。
- `LOAD_TOKEN` / `E2E_TOKEN`：打真实渠道须为真实 token（每请求一行写网关 logs 表）；打哑上游任意非空值。
- 打真实渠道时闭环并发必须为 1（见篇首约束）。
- 结果文件写 `tests/load/results/`（本地留存，不入库，已配置 .gitignore）。

## 4. loadgen 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| LOAD_TARGET_URL | http://127.0.0.1:3090 | 负载目标（代理、直连网关或哑上游） |
| LOAD_QPS | 10 | 定速到达率（开环） |
| LOAD_DURATION | 120 | 每档持续秒数 |
| LOAD_MODE | stream | stream 测 TTFT / nonstream |
| LOAD_BODY_BYTES | 0 | 请求正文填充字节数（模拟长 prompt） |
| LOAD_MODEL | GLM-5.3-Flash | 请求的模型名（须为 token 分组可用模型） |
| LOAD_TOKEN / E2E_TOKEN | — | 完整 Authorization 头值 |
| LOAD_LABEL | run-<时间> | 结果文件与 trace 标识 |
| LOAD_TRACE_PREFIX | load-<runid> | 负载记录 trace 前缀 |
| LOAD_REQUEST_TIMEOUT | 30000 | 单请求超时 ms，超过计 client_timeout |
| LOAD_CONCURRENCY | 0（开环） | >0 进入闭环（槽位释放才发下一发） |

## 5. 执行步骤

### 5.1 每档执行序列

```bash
# 1. 被测机启动采样器（nohup 方式；时长 = 负载时长 + ≥15s 余量）
ssh root@<被测机> "nohup sh tests/load/sample-proxy.sh 75 > /tmp/sample-<label>.csv 2>&1 < /dev/null &"

# 2. healthz 基线 → 负载 → 档后与静置 healthz
curl -s http://127.0.0.1:3090/healthz > hz-before.json
LOAD_TARGET_URL=http://127.0.0.1:3090 LOAD_QPS=100 LOAD_DURATION=60 \
LOAD_LABEL=a100 LOAD_TRACE_PREFIX=perf-a100 node tests/load/loadgen.mjs
curl -s http://127.0.0.1:3090/healthz > hz-after.json
sleep 10 && curl -s http://127.0.0.1:3090/healthz > hz-settle10s.json
```

计数差值口径：Δcaptured / Δdropped = 档后 − 档前。静置复读用于甄别 buffered_bytes 是瞬时在途还是缺陷残留。

### 5.2 阶梯设计与注入路径

- 小 body（≈112B）与大 body（≈91KB）两套阶梯，每档 60s 开环，自低向高执行。
- SSH 隧道实测吞吐上限约 27MB/s：请求体 × QPS 超限的档位改在被测机本机发起（容器内 node 或同机直连），避免隧道带宽污染实测值。
- 上限判据触发后回退半档复确认，不再加压。判据：采集降级 = dropped 持续 >0（此刻转发应无感，单独标注）；转发劣化 = achieved <99% 或 TTFT p99 >100ms 且随 QPS 恶化。

### 5.3 降级语义观测（可选）

临时调小 `DASHCAM_QUEUE_CAP`（如 1）使队满丢弃在低 QPS 可见，观测三层降级：队满丢弃 → 预算超限停缓冲 → 停采跳过。改前 `cp /etc/dashcam.env /tmp/dashcam.env.bak`，结束用 `mv` 回原位并重启采集代理。

## 6. 报告模板

```text
| 阶段 | 配置 QPS | 实测 QPS | TTFT p50/p99 | 总时长 p99 | 代理 CPU% 均值 | RSS 峰值 | fd | dropped Δ | 错误 |
|---|---|---|---|---|---|---|---|---|---|
```

结论需给出：上限判据是否触发、触发档位与复确认结果、资源占用是否符合「内存换转发」预期。

## 7. 残留与清理

- 负载记录按 trace 前缀留存于 DASHCAM_DIR（每档 ≈ QPS × 时长条）与网关 logs 表（仅真实 token 请求）；随保留期清理或人工删除。
- 压测期对被测机配置的修改一律「改前备份、恢复用 mv 回原位 + 重启」，避免副本残留。
- 压测结束清理被测机临时文件（哑上游二进制、采样 CSV、抓包输出）并关闭本地隧道。

## 8. 已知问题与限制

| 问题 | 触发条件 | 处理 |
|---|---|---|
| loadgen GC 饿死：pacing 崩塌、TTFT 失真 | 容器内单实例 ≥300 QPS × 91KB（每请求分配 ≈273KB） | 容器实例加 NODE_OPTIONS 大堆与大年轻代，或双实例分摊速率；TTFT 判读以工作站实例为准 |
| SSH 隧道带宽上限约 27MB/s | 大 body × ≥300 QPS 经隧道 | 超带宽档位改被测机本机发起 |
| buffered_bytes 每档残留不归零 | 被测代理无请求体读超时，黑洞连接的缓冲记账不释放 | 实测泄漏约 270B/连接，受 256MB 预算封顶；残留单独记录，不计入容量结论 |

# new-api-dashcam 采集代理吞吐画像与承载上限压测报告

| 项 | 值 |
|---|---|
| 报告编号 | LOADTEST-2026-11-15-002 |
| 测试日期 | 2026-11-15 |
| 测试类型 | 性能容量压测（吞吐画像 + 承载上限判定） |

本文记录被测系统 new-api-dashcam 采集代理的吞吐实测结果与承载上限判定。本文写：实测事实、上限结论、差异与缺陷清单、复现步骤；不写：采集代理的设计与实现（见仓库 `docs/dashcam/`）。压测工具与运行手册见仓库 `tests/load/`。

## 1. 测试状态

| 项 | 值 |
|---|---|
| 被测版本 | 采集代理 `v0.1.0-dev.264671329`（sha256 `c37df624…`），healthz 测前测后均核验 |
| 环境 | 被测机（IP 从略）4 vCPU / 16GB / Ubuntu 24.04.3；哑上游剥离真实 LLM 约束；工具见 `tests/load/` |
| 档位覆盖 | 小 body（≈112B）8 档 10–1000 QPS；大 body（91112B）5 档 50–400 QPS；每档 60s 开环 |

结论：采集降级起点为大 body 400 QPS（约 36.4MB/s 采集流入；300 QPS 复确认干净，边界锁定 300–400）与小 body >1000 QPS（阶梯顶未触发）；转发劣化起点在全部已测档位未触发（大 body TTFT p99 48→66→87ms 缓升，均低于 100ms）。差异与缺陷共 5 项，见 §7。

## 2. 被测系统与测试环境

### 2.1 组件与版本

| 组件 | 版本 / 指纹 | 部署形态 |
|---|---|---|
| new-api-dashcam 采集代理（被测） | `v0.1.0-dev.264671329`（sha256 `c37df624…`） | systemd 服务 `new-api-dashcam`，监听 `127.0.0.1:3090` |
| new-api 网关（真实上游） | `calciumion/new-api:v1.0.0-rc.23`（`/api/status` 核验一致） | Docker 容器，`127.0.0.1:3300` → 容器 3000 |
| 哑上游 dummy-upstream | Go 构建，sha256 `b02275d6…` | 压测期临时进程 `127.0.0.1:3311`，测后清理 |
| 审计看板 | `new-api-dashboard:0.1.2-dev.264670612` | Docker 容器（host 网络），兼作容器内负载执行环境 |
| PostgreSQL | 宿主机进程 `:5432` | 测试库（网关 logs / tokens 表） |

### 2.2 部署拓扑

```text
负载生成器（工作站，Windows / Node.js v22.22.2）
   │ SSH 隧道（本地 3090 → 被测机 3090）
   ▼
采集代理 new-api-dashcam   127.0.0.1:3090
  systemd: new-api-dashcam.service
  二进制: /opt/dashcam/new-api-dashcam    配置: /etc/dashcam.env
   │ 转发（UPSTREAM）
   ├─ 正常态 → new-api 网关 127.0.0.1:3300（容器，真实 LLM 渠道）
   └─ 压测期 → 哑上游 127.0.0.1:3311（同机临时进程）
   │ 旁路采集（gzip 压缩 → 段式打包 → 异步落盘）
   ▼
落盘目录 DASHCAM_DIR = /opt/audit-test/data/audit
   │ 只读挂载
   ▼
审计看板容器（/app/data/dashcam，ro）
```

网关、采集代理、哑上游、看板容器同机部署（4 vCPU 测试机），实测吞吐为该整机部署口径。

### 2.3 采集代理运行配置（/etc/dashcam.env）

| 参数 | 值 | 说明 |
|---|---|---|
| LISTEN | 127.0.0.1:3090 | 监听地址 |
| UPSTREAM | http://127.0.0.1:3300 | 压测期临时改为 `:3311`（哑上游），测后已恢复 |
| DASHCAM_DIR | /opt/audit-test/data/audit | 落盘目录 |
| CAPTURE_PATHS | /v1/chat/completions, /v1/completions, /v1/messages, /v1/responses | 采集路径匹配 |
| MAX_REQUEST_BYTES / MAX_RESPONSE_BYTES | 134217728 / 134217728 | 单请求/响应采集上限（128MB） |
| GZIP_THRESHOLD | 65536 | 压缩触发阈值（64KB） |
| DASHCAM_MEM_BUDGET | 268435456 | 采集缓冲内存预算（256MB），超限进入降级 |
| DASHCAM_QUEUE_CAP | 256 | 待落盘队列容量（条），队满丢弃计 dropped |
| DASHCAM_FLUSH_WORKERS | 2 | 落盘 worker 数（gzip/索引/写盘） |
| UPSTREAM_MAX_CONNS_PER_HOST | 2048 | 上游每主机连接上限 |
| IDLE_TIMEOUT | 120s | keep-alive 空闲连接回收 |
| SAMPLE_MODULUS / SAMPLE_KEEP | 0 / 1 | 按调用方指纹抽样；0 = 关闭（全量采集） |

### 2.4 硬件与系统

| 项 | 值 |
|---|---|
| vCPU | 4（Intel Xeon E5-2678 v3 @ 2.50GHz，1 线程/核） |
| 内存 | 16GB（压测期间可用约 11GB） |
| 磁盘 | 100G 虚拟磁盘（VMware 虚拟机） |
| 操作系统 | Ubuntu 24.04.3 LTS（内核 6.8.0-136-generic） |

### 2.5 负载注入路径

- 小 body 全档与大 body 50–300 档：负载自工作站发起，经 SSH 隧道注入，隧道实测吞吐上限约 27MB/s。
- 大 body 400 档（36.4MB/s）超隧道吞吐上限，双实例注入：工作站隧道实例 200 QPS + 被测机容器实例 200 QPS（host 网络直连本机 3090），负载窗口重叠，合计开环 400 QPS。容器实例配置 `NODE_OPTIONS='--max-old-space-size=10240 --max-semi-space-size=256'`（见 §7 D4）。

## 3. 测试方法

### 3.1 工具

| 工具 | 形态 | 用途 |
|---|---|---|
| loadgen.mjs | 零第三方依赖 Node.js（≥22）脚本 | 开环定速负载生成：按 1000/QPS 节拍发起 `/v1/chat/completions` 流式请求，逐请求测量 TTFT 与总时长，输出分位数汇总 JSON |
| sample-proxy.sh | POSIX sh 脚本（被测机运行） | 对采集代理进程每秒采样 CPU% / RSS / fd，输出 CSV 与汇总行 |
| dummy-upstream | Go 静态二进制 | 哑上游：读全请求体后立即返回最小化 OpenAI 兼容流式/非流式响应（与真实上游同口径） |

工具随仓库管理（`tests/load/`），本次执行零脚本改动。

### 3.2 阶梯设计

| 阶梯 | 请求体 | 档位（配置 QPS） | 注入路径 | 考察点 |
|---|---|---|---|---|
| A | ≈112B | 10 → 50 → 100 → 200 → 300 → 500 → 800 → 1000 | SSH 隧道 | 元数据/请求路径 |
| B | 91112B | 50 → 100 → 200 → 300（复确认档） | SSH 隧道 | 磁盘写入/压缩 |
| B-400 | 91112B | 400 | 双实例（隧道 200 + 容器 200） | 磁盘写入/压缩 |

### 3.3 判据与纪律

- 承载上限判据：采集降级起点 = dropped 首次持续 >0 的配置 QPS（此刻转发应无感，单独标注）；转发劣化起点 = 实测/配置 QPS < 99%，或 TTFT p99 > 100ms 且随 QPS 恶化。
- 判据触发后回退半档复确认，不再加压（本测试在 400 档触发采集降级判据后回退 300 档复确认）。
- 每档结束后静置 10s 复读 healthz，甄别 buffered_bytes 为瞬时在途还是缺陷残留。
- 测试过程中发现的缺陷（被测系统与测试工具均包括）只记录、不修复；执行方案的调整在 §7 如实记录。

### 3.4 每档执行序列

1. 被测机启动采样器（时长 = 60s 负载 + ≥15s 余量）；
2. 读取 healthz 基线；
3. 运行 loadgen 60s（开环）；
4. 读取 healthz（档后）；
5. 静置 10s 复读 healthz；
6. 计数差值口径：Δcaptured / Δdropped / Δskipped / Δfailed = 档后 − 档前。

## 4. 术语与指标定义

| 术语 | 含义 |
|---|---|
| 采集代理（new-api-dashcam） | 被测组件。部署在客户端与 new-api 网关之间的反向代理，转发 LLM API 流量的同时旁路采集请求/响应正文，压缩后异步落盘 |
| 哑上游（dummy upstream） | 被测机本地运行的假上游服务，收到请求立即返回最小化 OpenAI 兼容流式响应，用于剥离真实 LLM 的延迟、并发限制与计费约束 |
| healthz | 采集代理的只读状态端点（`GET /healthz`），返回版本号与采集计数器 |
| TTFT（Time To First Token） | 流式请求从发出到收到第一个响应字节的耗时，对应「第一个字」的等待体验；客户端实测口径，哑上游即时响应，该值主要反映代理转发链路延迟 |
| 总时长 | 从发出请求到完整接收响应（含流式结束标记）的耗时 |
| p50 / p90 / p99 / max | 耗时升序排列后取第 50 / 90 / 99 百分位与最大值，单位 ms；p99 表示 99% 的请求快于该值 |
| QPS（配置 / 实测） | 每秒请求数。配置 QPS＝负载生成器目标速率；实测 QPS（achieved）＝实际成功完成速率；%配置＝实测 ÷ 配置 |
| 开环定速 | 按固定节拍发起请求、不等待前序请求完成；相对概念为闭环（有空闲并发槽位才发下一发） |
| 小 body / 大 body | 请求体约 112B / 91112B（后者模拟真实会话中 ≈91KB 的长 prompt） |
| captured / dropped / skipped / failed | healthz 计数器。captured＝完整受理并落盘的记录数；dropped＝待落盘队列满而丢弃；skipped＝采集开关或预算原因整体跳过；failed＝转发或采集处理失败 |
| buffered_bytes | healthz 内存 gauge——尚未核销的采集缓冲字节数；含 §7 D1 / D2 所述缺陷残留与段尾口径分量，不随负载停止即时归零 |
| flush worker | 采集代理内执行「gzip 压缩 + 写盘」的后台协程，本环境 2 个 |
| 段式打包（pack） | 多条会话记录合并写入同一数据段文件（`seg-*.pack`），按大小阈值轮转，轮转前处于打开状态 |
| RSS / fd / CPU% | 进程常驻内存（MB）、打开文件描述符数、CPU 占用率；采样器每秒采样，取均值与峰值 |
| network_error | 负载生成器侧的非 HTTP 错误（连接失败、连接重置、读写错误），本轮主要来自 SSH 隧道 |
| GC | Garbage Collection，运行时垃圾回收；负载生成器为 Node.js 脚本，高分配速率下 GC 停顿会拖延请求体写出（见 §7 D4） |
| 回退半档复确认 | 触发承载上限判据后，回落到更低档位重测以确认边界，不再继续加压 |

## 5. 测试结果

### 5.1 阶梯 A：小 body ≈112B（元数据/请求路径）

| 配置 QPS | 实测 QPS | %配置 | TTFT p50/p90/p99/max (ms) | 总时长 p99 (ms) | network_error | dropped Δ | captured Δ | 代理 CPU% | RSS 峰值 MB | fd |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 10.0 | 100% | 5 / 47 / 61 / 63 | 62 | 3 | 0 | 600 | 1.6 | 12.0 | 10–11 |
| 50 | 49.9 | 99.8 | 18 / 33 / 36 / 51 | 36 | 9 | 0 | 3000 | 6.7 | 12.1 | 10–14 |
| 100 | 99.8 | 99.8 | 17 / 18 / 21 / 50 | 21 | 11 | 0 | 6000 | 12.2 | 12.4 | 11–16 |
| 200 | 199.3 | 99.7 | 15 / 18 / 21 / 60 | 21 | 34 | 0 | 11999 | 20.7 | 12.6 | 12–28 |
| 300 | 298.8 | 99.6 | 7 / 17 / 21 / 68 | 21 | 54 | 0 | 17999 | 28.7 | 12.6 | 14–35 |
| 500 | 497.6 | 99.5 | 5 / 14 / 20 / 77 | 20 | 109 | 0 | 29998 | 45.4 | 12.8 | 16–55 |
| 800 | 795.4 | 99.4 | 6 / 16 / 29 / 105 | 29 | 197 | 0 | 48000 | 70.4 | 14.8 | 21–111 |
| 1000 | 993.2 | 99.3 | 5 / 19 / 64 / 147 | 64 | 271 | 0 | 60000 | 82.9 | 16.7 | 21–171 |

观察：

- TTFT p50 随 QPS 反而下降（18→5ms，连接池预热/调度效应），p99 在 800–1000 档现上行（29→64ms）但未越 100ms 判据线。
- CPU 随 QPS 线性 ≈0.083%/QPS，1000 QPS 时 82.9%。
- achieved 与 100% 的差值 ≈ network_error 率（0.18%→0.45%），来自 SSH 隧道（§7 D3），非代理转发损失。

### 5.2 阶梯 B：大 body 91112B（磁盘写入/压缩）

| 配置 QPS | 注入路径 | 实测 QPS | %配置 | TTFT p50/p99 (ms) | network_error | dropped Δ | captured Δ | 代理 CPU% | RSS 峰值 MB | fd |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | 隧道 | 49.8 | 99.6 | 18 / 41 | 11 | 0 | 3000 | 43.2 | 14.1 | 11–14 |
| 100 | 隧道 | 99.4 | 99.4 | 17 / 34 | 33 | 0 | 6000 | 82.9 | 16.3 | 11–19 |
| 200 | 隧道 | 199.3 | 99.7 | 19 / 48 | 35 | 0 | 11999 | 129.8 | 23.4 | 17–60 |
| 300（复确认档） | 隧道 | 299.7 | 99.9 | 18 / 66 | 9 | **0** | 18000 | 122.8 | 91.5 | 29–97 |
| 400 | 双实例 | 399.2（199.7+199.5） | 99.8 | **隧道实例**: 19 / **87**；**容器实例**: 13 / 863（客户端 GC 伪影，见 §7 D4） | 11+25 | **+87**（0.36%） | 24000 | 109.2 | 189.6 | 28–496 |

观察：

- 300 QPS（27.3MB/s）dropped=0、captured 100%；400 QPS（36.4MB/s）dropped +87 且 captured 仍 100% 覆盖——队满丢弃开始发生但比例 0.36%，转发无感。瓶颈为 2 个 flush worker 的 gzip+写盘吞吐。
- TTFT p99 随大 body QPS 缓升（48→66→87ms），无悬崖；400 档转发全部成功。
- RSS 在 300/400 档跳升（91.5→189.6MB）：采集缓冲随流入速率增长，256MB 预算内但余量收窄。
- CPU 非单调（129.8@200 → 122.8@300 → 109.2@400）：高档位部分记录走丢弃路径（少了 gzip+写盘），且采样窗内轮转相位不同，量级 1.1–1.3 核，属正常波动。

## 6. 上限判定

| 维度 | 采集降级起点 | 转发劣化起点 |
|---|---|---|
| 小 body ≈112B | >1000 QPS（阶梯顶未触发） | >1000 QPS（阶梯顶未触发） |
| 大 body 91112B | **400 QPS**（300 复确认干净） | >400 QPS（阶梯顶未触发） |

- 采集降级语义验证：400 档大 body dropped +87（0.36%）的同时转发完全无感（隧道实例 TTFT p99=87ms、achieved 99.85%，captured 100% 覆盖）。
- 内存预算：全程 RSS 峰值 189.6MB < 256MB 预算，未触顶。
- CPU 饱和天花板：推断——按小 body CPU 线性外推约 1200–1400 QPS（1000 QPS 时单核占用 82.9%，外推值未经实测）。

## 7. 差异与缺陷清单

| 编号 | 差异 / 缺陷 | 实测 | 口径处理 / 建议 |
|---|---|---|---|
| D1 | 黑洞连接的 buffered_bytes 永不归零（被测缺陷） | 每档结束 10s 静置零衰减；泄漏 ≈270B/network_error，阶梯 A 全程 688 × 270B ≈ 186KB，与实测残留 186096B 精确吻合。机理：客户端静默断开时 handler 阻塞在请求体 Read（无 ReadTimeout） | 不计入容量结论；修复建议：请求体读增加 ReadTimeout / 空闲连接回收 |
| D2 | buffered_bytes 含「未关闭 pack 尾段」分量（观测口径） | 大 body 档结束残留冻结（8.2MB / 14.6MB），等待下次轮转核销后回落 | gauge 语义为「未核销缓冲」；「每档归零」在段式布局下不可达，读数按 D1 泄漏 + 本分量解读，均远小于预算 |
| D3 | SSH 隧道 network_error 噪声 | 率随 QPS 上升：小 body 0.18%→0.45%，大 body 0.05%→0.37%；achieved 损失与误差率一一对应 | 环境噪声，非代理转发损失；achieved 判读按此口径修正 |
| D4 | 容器内负载生成器高 QPS 伪影（工具限制） | 三次失败：默认 4GB 堆 OOM；10GB 堆 pacing 崩塌至 30/s 且全部请求悬挂 80–140s（代理零到达）；短冲恢复但 TTFT 均一 6–21s ≈ 负载时长（计数冻结、结束后一次性补账 captured+6562 / dropped+7810 / skipped+594）。根因：每请求分配 ≈273KB，V8 GC 饿死事件循环（垃圾回收一度占 CPU 87%）→ 请求体写出延迟 → 代理 handler 全部阻塞在 D1 的 body Read 上 | 正式 400 档改双实例方案（容器实例加大堆与大年轻代），获得干净数据；TTFT 判读以隧道实例为准；失败尝试原始 JSON 已随数据留存 |
| D5 | 采样 CPU 非单调、fd 尖峰 | 400 档 fd 峰值 496；CPU 129.8@200 → 109.2@400 | 与在途连接数/轮转相位相关，量级正常 |

## 8. 复验规则

1. 被测代理修复请求体读超时（D1）后：复跑大 body 阶梯 200/400 档，复核 buffered_bytes 归零行为与泄漏清零。
2. 部署形态或硬件变更（网关与代理分机、磁盘类型变更）后：重跑全部阶梯。
3. 采集配置调整（DASHCAM_FLUSH_WORKERS / DASHCAM_QUEUE_CAP / DASHCAM_MEM_BUDGET）后：重跑大 body 阶梯，更新采集降级起点。

## 9. 限制

| 限制 | 影响 |
|---|---|
| 网关、代理、哑上游、看板同机部署（4 vCPU） | 实测吞吐为整机部署口径，非代理独占资源口径 |
| TTFT 为客户端口径（含负载生成器与隧道） | 哑上游即时响应，该值主要反映代理链路；容器实例的 TTFT 受 GC 伪影污染（D4），仅采用其吞吐计数 |
| achieved 含隧道噪声 | 99.3–100% 区间的损失可由 network_error 率解释，代理转发自身无损失（D3） |
| 大 body 上限判定止步 400 QPS | 隧道带宽约束下双实例方案的已测顶；>400 QPS 未测 |
| buffered_bytes 含两类残留分量（D1/D2） | 不随负载停止归零；容量结论不含该指标 |

## 附录 A. 复现步骤

工具随仓库管理（`tests/load/`）；`<被测机>` 为被测机地址。

```bash
# 1. 构建并部署哑上游
GOOS=linux GOARCH=amd64 go build -o tests/load/dummy-upstream-linux tests/load/dummy-upstream.go
scp tests/load/dummy-upstream-linux root@<被测机>:/tmp/
ssh root@<被测机> 'chmod +x /tmp/dummy-upstream-linux && nohup /tmp/dummy-upstream-linux --port 3311 >/tmp/dummy.log 2>&1 < /dev/null &'

# 2. 切换采集代理 UPSTREAM 至哑上游（压测期临时配置）
ssh root@<被测机> 'cp /etc/dashcam.env /tmp/dashcam.env.bak \
  && sed -i "s|^UPSTREAM=.*|UPSTREAM=http://127.0.0.1:3311|" /etc/dashcam.env \
  && systemctl restart new-api-dashcam'

# 3. 建立负载隧道（工作站）
ssh -N -L 3090:127.0.0.1:3090 root@<被测机>

# 4. 每档执行（示例：阶梯 A 100 QPS 档）
ssh root@<被测机> "nohup sh tests/load/sample-proxy.sh 75 > /tmp/sample-A-qps100.csv 2>&1 < /dev/null &"
curl -s http://127.0.0.1:3090/healthz > hz-before.json
LOAD_TARGET_URL=http://127.0.0.1:3090 LOAD_QPS=100 LOAD_DURATION=60 LOAD_MODE=stream \
LOAD_BODY_BYTES=0 LOAD_TOKEN="Bearer perf-dummy" LOAD_LABEL=A-qps100 LOAD_TRACE_PREFIX=perf-a100 \
node tests/load/loadgen.mjs
curl -s http://127.0.0.1:3090/healthz > hz-after.json
sleep 10 && curl -s http://127.0.0.1:3090/healthz > hz-settle10s.json

# 5. 400 档大 body（双实例，负载窗口重叠）
# ① 隧道实例：LOAD_QPS=200 LOAD_BODY_BYTES=91000 LOAD_LABEL=B-qps400-win200
# ② 被测机容器实例（需先 docker cp loadgen 与 e2e/load-env.mjs 进容器 /tmp/load、/tmp/e2e）：
ssh root@<被测机> "docker exec -e NODE_OPTIONS='--max-old-space-size=10240 --max-semi-space-size=256' \
  -e LOAD_TARGET_URL=http://127.0.0.1:3090 -e LOAD_QPS=200 -e LOAD_DURATION=60 \
  -e LOAD_BODY_BYTES=91000 -e 'LOAD_TOKEN=Bearer perf-dummy' \
  -e LOAD_LABEL=B-qps400-ctr200 new-api-dashboard-test node /tmp/load/loadgen.mjs"

# 6. 恢复环境
ssh root@<被测机> 'mv /tmp/dashcam.env.bak /etc/dashcam.env && systemctl restart new-api-dashcam \
  && curl -s http://127.0.0.1:3090/healthz'
```

## 附录 B. 原始数据清单

结果文件按以下命名规范写入 `tests/load/results/`（本地留存）：

| 内容 | 命名规范 | 说明 |
|---|---|---|
| 各档负载结果 | `run-<LOAD_LABEL>.json` | 配置/实测 QPS、TTFT 与总时长分位数、错误计数 |
| 代理资源采样 | `sample-<LOAD_LABEL>.csv` | 每秒 CPU%/RSS/fd，末行汇总 |
| healthz 快照 | `hz-<LOAD_LABEL>-{before,after,settle10s}.json` | 档前 / 档后 / 静置 10s |
| 容器内诊断数据 | `container-diagnostics/run-*.json` | 400 档三次失败尝试与探测的原始结果 |

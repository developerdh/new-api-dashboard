package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// config 全部来自环境变量，不读配置文件：容器与 systemd 都能直接注入。
type config struct {
	Listen       string
	Upstream     *url.URL
	DashcamDir   string
	CapturePaths map[string]struct{}

	MaxRequest  int64
	MaxResponse int64
	GzipOver    int64

	// 按调用方指纹整体抽样（D-P2）：sha256(指纹) % SampleModulus < SampleKeep 才采集，
	// 被抽中的指纹全量记录，未抽中的完全不落盘。SampleModulus=0（默认）= 全量记录。
	SampleModulus int64
	SampleKeep    int64

	// 资源围栏（D-P3）：采集缓冲字节预算与后台 worker 配置。
	// MemBudget=0 是停采总开关；QueueCap 有界，满则丢弃；FlushWorkers 独占落盘。
	MemBudget       int64
	FlushWorkers    int
	QueueCap        int
	MaxConnsPerHost int

	// 上游响应头等待上限。不含 body 读取：流式响应可能持续十分钟。
	HeaderTimeout time.Duration
	// Server keep-alive 空闲连接回收（D-P3 背板）：只影响请求间空闲连接，
	// 对流式响应零影响（WriteTimeout 仍不设）。
	IdleTimeout time.Duration
}

const (
	defaultMaxBytes = 128 << 20 // 128 MiB：覆盖 1M tokens 上下文并留出多模态余量
	defaultGzipOver = 64 << 10

	defaultMemBudget  = 256 << 20 // 256 MB：100 QPS × avg 4.4s ≈ 183 MB，留余量
	defaultWorkers    = 2         // gzip 326 KB ≈ 4-8 ms/条 → 单 worker 125-250 条/s
	defaultQueueCap   = 256
	defaultConnsHost  = 2048 // 转发侧背板：超限排队而非新建连接，≈465 QPS 持续
	defaultIdleBackup = 120 * time.Second

	// MAX_*_BYTES 上界：段头长度字段为 uint32（pack.go），须 < 4 GiB；1 GiB 为实用上限
	maxBytesUpperBound = 1 << 30
)

func loadConfig() (config, error) {
	cfg := config{
		Listen:     env("LISTEN", "127.0.0.1:3090"),
		DashcamDir: env("DASHCAM_DIR", "./data/dashcam"),
	}

	var err error
	if cfg.MaxRequest, err = envInt64("MAX_REQUEST_BYTES", defaultMaxBytes); err != nil {
		return cfg, err
	}
	if cfg.MaxResponse, err = envInt64("MAX_RESPONSE_BYTES", defaultMaxBytes); err != nil {
		return cfg, err
	}
	if cfg.GzipOver, err = envInt64("GZIP_THRESHOLD", defaultGzipOver); err != nil {
		return cfg, err
	}
	if cfg.HeaderTimeout, err = envDuration("UPSTREAM_HEADER_TIMEOUT", 300*time.Second); err != nil {
		return cfg, err
	}
	if cfg.MemBudget, err = envInt64("DASHCAM_MEM_BUDGET", defaultMemBudget); err != nil {
		return cfg, err
	}
	var workers int64
	if workers, err = envInt64("DASHCAM_FLUSH_WORKERS", defaultWorkers); err != nil {
		return cfg, err
	}
	cfg.FlushWorkers = int(workers)
	var queueCap int64
	if queueCap, err = envInt64("DASHCAM_QUEUE_CAP", defaultQueueCap); err != nil {
		return cfg, err
	}
	cfg.QueueCap = int(queueCap)
	var conns int64
	if conns, err = envInt64("UPSTREAM_MAX_CONNS_PER_HOST", defaultConnsHost); err != nil {
		return cfg, err
	}
	cfg.MaxConnsPerHost = int(conns)
	if cfg.IdleTimeout, err = envDuration("IDLE_TIMEOUT", defaultIdleBackup); err != nil {
		return cfg, err
	}

	rawUpstream := env("UPSTREAM", "http://127.0.0.1:3000")
	upstream, err := url.Parse(rawUpstream)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return cfg, fmt.Errorf("UPSTREAM 必须是完整 URL（当前 %q）", rawUpstream)
	}
	cfg.Upstream = upstream

	cfg.CapturePaths = parsePaths(env("CAPTURE_PATHS",
		"/v1/chat/completions,/v1/completions,/v1/messages,/v1/responses"))
	if len(cfg.CapturePaths) == 0 {
		return cfg, fmt.Errorf("CAPTURE_PATHS 为空：至少配置一个采集路径，或设为 * 采集全部")
	}
	if cfg.MaxRequest <= 0 || cfg.MaxResponse <= 0 {
		return cfg, fmt.Errorf("MAX_REQUEST_BYTES / MAX_RESPONSE_BYTES 必须为正数")
	}
	// 段头长度字段是 uint32（>4GiB 会回绕致段损坏），实用上界压到 1 GiB 防误配
	if cfg.MaxRequest > maxBytesUpperBound || cfg.MaxResponse > maxBytesUpperBound {
		return cfg, fmt.Errorf(
			"MAX_REQUEST_BYTES / MAX_RESPONSE_BYTES 上限 %d 字节（当前 R=%d S=%d）",
			maxBytesUpperBound, cfg.MaxRequest, cfg.MaxResponse)
	}
	if cfg.HeaderTimeout < 0 {
		return cfg, fmt.Errorf("UPSTREAM_HEADER_TIMEOUT 必须为非负时长")
	}

	if cfg.SampleModulus, err = envInt64("SAMPLE_MODULUS", 0); err != nil {
		return cfg, err
	}
	if cfg.SampleKeep, err = envInt64("SAMPLE_KEEP", 1); err != nil {
		return cfg, err
	}
	// 与 CAPTURE_PATHS 为空同款校验风格：启用时参数错 = 整体漏采，宁可启动失败。
	if cfg.SampleModulus < 0 {
		return cfg, fmt.Errorf("SAMPLE_MODULUS 必须为非负整数（0 = 关闭抽样）")
	}
	if cfg.SampleModulus > 0 && (cfg.SampleKeep < 1 || cfg.SampleKeep > cfg.SampleModulus) {
		return cfg, fmt.Errorf("SAMPLE_KEEP 必须在 1–SAMPLE_MODULUS 之间（当前 K=%d N=%d）",
			cfg.SampleKeep, cfg.SampleModulus)
	}

	// 资源围栏参数：0 预算 = 停采总开关（合法），其余必须为正。
	if cfg.MemBudget < 0 {
		return cfg, fmt.Errorf("DASHCAM_MEM_BUDGET 必须为非负整数（0 = 停止采集）")
	}
	if cfg.FlushWorkers < 1 || cfg.FlushWorkers > 64 {
		return cfg, fmt.Errorf("DASHCAM_FLUSH_WORKERS 必须在 1–64 之间（当前 %d）", cfg.FlushWorkers)
	}
	if cfg.QueueCap < 1 || cfg.QueueCap > 65536 {
		return cfg, fmt.Errorf("DASHCAM_QUEUE_CAP 必须在 1–65536 之间（当前 %d）", cfg.QueueCap)
	}
	if cfg.MaxConnsPerHost < 1 || cfg.MaxConnsPerHost > 1_000_000 {
		return cfg, fmt.Errorf("UPSTREAM_MAX_CONNS_PER_HOST 必须为正整数（当前 %d）", cfg.MaxConnsPerHost)
	}
	if cfg.IdleTimeout < 0 {
		return cfg, fmt.Errorf("IDLE_TIMEOUT 必须为非负时长")
	}
	return cfg, nil
}

// shouldCapture 精确匹配路径；`*` 表示全部采集（不推荐，图片/音频会撑爆磁盘）。
func (c config) shouldCapture(path string) bool {
	if _, ok := c.CapturePaths["*"]; ok {
		return true
	}
	_, ok := c.CapturePaths[path]
	return ok
}

func parsePaths(raw string) map[string]struct{} {
	out := make(map[string]struct{})
	for _, part := range strings.Split(raw, ",") {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		if !strings.HasPrefix(p, "/") && p != "*" {
			p = "/" + p
		}
		out[strings.TrimSuffix(p, "/")] = struct{}{}
	}
	return out
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt64(key string, fallback int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		// 解析失败必须启动失败（与取值范围校验同一 fail-fast 风格）：
		// 静默回退默认值会让运维以为生效的配置从未生效（如 SAMPLE_MODULUS=1o → 全量落盘）
		return 0, fmt.Errorf("%s 必须是整数（当前 %q）", key, raw)
	}
	return v, nil
}

func envDuration(key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s 必须是时长（如 30s / 5m，当前 %q）", key, raw)
	}
	return d, nil
}

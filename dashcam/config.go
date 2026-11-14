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

	// 上游响应头等待上限。不含 body 读取：流式响应可能持续十分钟。
	HeaderTimeout time.Duration
	// 单次落盘写入的缓冲区大小，决定内存上界（与 body 大小无关）。
	WriteBuffer int
}

const (
	defaultMaxBytes = 128 << 20 // 128 MiB：覆盖 1M tokens 上下文并留出多模态余量
	defaultGzipOver = 64 << 10
)

func loadConfig() (config, error) {
	cfg := config{
		Listen:        env("LISTEN", "127.0.0.1:3090"),
		DashcamDir:    env("DASHCAM_DIR", "./data/dashcam"),
		MaxRequest:    envInt64("MAX_REQUEST_BYTES", defaultMaxBytes),
		MaxResponse:   envInt64("MAX_RESPONSE_BYTES", defaultMaxBytes),
		GzipOver:      envInt64("GZIP_THRESHOLD", defaultGzipOver),
		HeaderTimeout: envDuration("UPSTREAM_HEADER_TIMEOUT", 300*time.Second),
		WriteBuffer:   32 << 10,
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

func envInt64(key string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback
	}
	return v
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}
	return d
}

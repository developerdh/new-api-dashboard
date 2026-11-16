package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "探测本机 /healthz 后退出（供容器 HEALTHCHECK 使用）")
	showVersion := flag.Bool("version", false, "打印版本后退出")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		logEvent("error", "config_invalid", map[string]any{"error": err.Error()})
		os.Exit(2)
	}

	if *healthcheck {
		os.Exit(probe(cfg.Listen))
	}

	counters := &captureCounters{}
	sink, err := newSink(cfg, counters)
	if err != nil {
		// 记录目录不可用时仍然启动：宁可丢采集，也不能丢转发。
		logEvent("error", "dashcam_dir_unavailable", map[string]any{"dir": cfg.DashcamDir, "error": err.Error()})
		sink = nil
	} else if err := writeSamplingMeta(cfg); err != nil {
		// 抽样状态供看板展示统一口径提示；写失败只影响提示，不影响转发与采集。
		logEvent("warn", "sampling_meta_failed", map[string]any{"error": err.Error()})
	}

	h := &handler{cfg: cfg, sink: sink, proxy: newProxy(cfg), counters: counters}
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           h,
		ReadHeaderTimeout: 15 * time.Second,
		// IdleTimeout 只回收请求间空闲的 keep-alive 连接，对流式响应零影响；
		// WriteTimeout 仍不设——流式响应可能持续十分钟以上。
		IdleTimeout: cfg.IdleTimeout,
		ErrorLog:    log.New(os.Stderr, "http ", log.LstdFlags),
	}

	logEvent("info", "started", map[string]any{
		"version":     version,
		"listen":      cfg.Listen,
		"upstream":    cfg.Upstream.String(),
		"dashcam_dir": cfg.DashcamDir,
		"capture":     strings.Join(sortedKeys(cfg.CapturePaths), ","),
	})

	idle := make(chan struct{})
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		logEvent("info", "shutdown_begin", nil)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		// Shutdown 超时 ≠ 优雅完成：SSE 可长达 10 分钟（nginx proxy_read_timeout 600s），
		// 有活跃流式请求时 15s 必超时、在途请求被硬切断。必须记日志区分两种终态，
		// 否则运维无法排障（客户端表现为请求中途失败，而服务端"看起来"正常退出）
		if err := srv.Shutdown(ctx); err != nil {
			// http.Server 不暴露在途计数，仅记录超时事实供运维区分两种终态
			logEvent("warn", "shutdown_timeout", map[string]any{"error": err.Error()})
		}
		if sink != nil {
			// 停机排空：closed 标志置位 → 在途 finish 走 dropped，worker 排空队内残余（capture.go）
			sink.closeAndWait()
		}
		close(idle)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logEvent("error", "listen_failed", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	<-idle
	logEvent("info", "shutdown_done", nil)
}

type handler struct {
	cfg      config
	sink     *sink
	proxy    *httputil.ReverseProxy
	counters *captureCounters
}

type ctxKey string

const errorBoxKey ctxKey = "dashcam-error-box"

type errorBox struct{ msg string }

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		h.serveHealth(w)
		return
	}

	var rec *record
	switch {
	case h.sink == nil || !h.cfg.shouldCapture(r.URL.Path):
		h.counters.skipped.Add(1)
	default:
		// 抽样判定（D-P2）在 begin 之前：未抽中的指纹完全不落盘，只进 skipped 计数。
		fp := tokenFingerprint(r.Header.Get("Authorization"))
		switch {
		case !h.cfg.sampled(fp):
			h.counters.skipped.Add(1)
		case h.cfg.MemBudget == 0 || h.sink.buffered.Load() >= h.cfg.MemBudget:
			// 预算超限 + 新请求 = 三层降级第 1 层；预算 0 = 停采总开关。跳过采集，转发照常。
			h.counters.skipped.Add(1)
		default:
			rec = h.sink.begin(r, fp)
			body := r.Body
			r.Body = struct {
				io.Reader
				io.Closer
			}{io.TeeReader(body, writerFunc(rec.writeRequest)), body}
			h.counters.captured.Add(1)
		}
	}

	box := &errorBox{}
	r = r.WithContext(context.WithValue(r.Context(), errorBoxKey, box))

	tw := &teeWriter{ResponseWriter: w, rec: rec}
	// D6：客户端在流式响应中途断开时，ReverseProxy 按设计 panic(http.ErrAbortHandler)，
	// net/http 对该值静默恢复不写日志——finish 若留在 ServeHTTP 返回后的普通调用处，
	// panic 展开会跳过它：记录既不入队也不释放预算（buffered_bytes 永久虚高）。
	// 因此 finish 挂在 defer 里补记；recover 后原样上抛，连接收尾语义零变化
	// （ErrAbortHandler 仍被静默恢复，其余 panic 照常由 net/http 记录）。
	defer func() {
		p := recover()
		if rec != nil {
			// ErrAbortHandler = ReverseProxy 拷贝响应到客户端失败（客户端中途断开）：
			// 置 tr bit4 把"部分响应"与尺寸截断区分开，其余 panic 不带此位。
			if p == http.ErrAbortHandler {
				rec.aborted = true
			}
			rec.finish(box.msg)
		}
		if p != nil {
			panic(p)
		}
	}()
	h.proxy.ServeHTTP(tw, r)
}

// serveHealth 输出存活与采集计数。dropped = 队满丢弃 + 在途预算停缓冲累计，
// buffered_bytes = 当前驻留内存字节数（gauge）——两者让"采集正在降级"可被发现
// （06-performance-plan §7.4），不做直方图/p99。
func (h *handler) serveHealth(w http.ResponseWriter) {
	buffered := int64(0)
	if h.sink != nil {
		buffered = h.sink.buffered.Load()
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":             true,
		"version":        version,
		"captured":       h.counters.captured.Load(),
		"skipped":        h.counters.skipped.Load(),
		"failed":         h.counters.failed.Load(),
		"dropped":        h.counters.dropped.Load(),
		"buffered_bytes": buffered,
	})
}

func newProxy(cfg config) *httputil.ReverseProxy {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        512,
		MaxIdleConnsPerHost: 256,
		// 唯一作用于转发的限制（D-P3 背板）：超限时新请求排队等空闲连接而非新建，
		// 把"fd 耗尽/OOM 进程崩溃"转化为"排队延迟上升"。
		MaxConnsPerHost:       cfg.MaxConnsPerHost,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: cfg.HeaderTimeout,
		ExpectContinueTimeout: time.Second,
	}

	return &httputil.ReverseProxy{
		Transport: transport,
		// -1：每收到一块就 flush，SSE 首字延迟不受代理影响。
		FlushInterval: -1,
		Director: func(req *http.Request) {
			req.URL.Scheme = cfg.Upstream.Scheme
			req.URL.Host = cfg.Upstream.Host
			// 保留原始 Host：与 nginx 直连 new-api 时的行为一致。
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if box, ok := r.Context().Value(errorBoxKey).(*errorBox); ok {
				box.msg = err.Error()
			}
			logEvent("warn", "upstream_failed", map[string]any{
				"path":  r.URL.Path,
				"error": err.Error(),
			})
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"type":"upstream_unavailable","message":"dashcam cannot reach upstream"}}`))
		},
	}
}

// teeWriter 把响应同时交给客户端与落盘。顺序是先客户端后磁盘：
// 转发永远优先，磁盘慢只是采集延迟。
type teeWriter struct {
	http.ResponseWriter
	rec *record
}

func (t *teeWriter) Write(p []byte) (int, error) {
	n, err := t.ResponseWriter.Write(p)
	if t.rec != nil && n > 0 {
		t.rec.writeResponse(p[:n])
	}
	return n, err
}

func (t *teeWriter) WriteHeader(code int) {
	if t.rec != nil {
		t.rec.setStatus(code)
	}
	t.ResponseWriter.WriteHeader(code)
}

func (t *teeWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap 让 http.ResponseController 能继续向下找到 Hijacker 等能力。
func (t *teeWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

type writerFunc func([]byte)

func (f writerFunc) Write(p []byte) (int, error) {
	f(p)
	return len(p), nil
}

func probe(listen string) int {
	_, port, err := net.SplitHostPort(listen)
	if err != nil || port == "" {
		port = "3090"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func logEvent(level, event string, fields map[string]any) {
	payload := map[string]any{
		"ts":    time.Now().Format(time.RFC3339Nano),
		"level": level,
		"event": event,
	}
	for k, v := range fields {
		payload[k] = v
	}
	line, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = os.Stdout.Write(append(line, '\n'))
}

func sortedKeys(m map[string]struct{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

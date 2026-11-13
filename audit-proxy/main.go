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
	"sync/atomic"
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

	sink, err := newSink(cfg)
	if err != nil {
		// 审计目录不可用时仍然启动：宁可丢采集，也不能丢转发。
		logEvent("error", "audit_dir_unavailable", map[string]any{"dir": cfg.AuditDir, "error": err.Error()})
		sink = nil
	}

	h := &handler{cfg: cfg, sink: sink, proxy: newProxy(cfg)}
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           h,
		ReadHeaderTimeout: 15 * time.Second,
		// 不设 WriteTimeout / IdleTimeout：流式响应可能持续十分钟以上。
		ErrorLog: log.New(os.Stderr, "http ", log.LstdFlags),
	}

	logEvent("info", "started", map[string]any{
		"version":   version,
		"listen":    cfg.Listen,
		"upstream":  cfg.Upstream.String(),
		"audit_dir": cfg.AuditDir,
		"capture":   strings.Join(sortedKeys(cfg.CapturePaths), ","),
	})

	idle := make(chan struct{})
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		logEvent("info", "shutdown_begin", nil)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
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
	cfg   config
	sink  *sink
	proxy *httputil.ReverseProxy

	captured atomic.Int64
	skipped  atomic.Int64
	failed   atomic.Int64
}

type ctxKey string

const errorBoxKey ctxKey = "audit-error-box"

type errorBox struct{ msg string }

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		h.serveHealth(w)
		return
	}

	var rec *record
	if h.sink != nil && h.cfg.shouldCapture(r.URL.Path) {
		rec = h.sink.begin(r)
		if rec != nil {
			body := r.Body
			r.Body = struct {
				io.Reader
				io.Closer
			}{io.TeeReader(body, writerFunc(rec.writeRequest)), body}
			h.captured.Add(1)
		} else {
			h.failed.Add(1)
		}
	} else {
		h.skipped.Add(1)
	}

	box := &errorBox{}
	r = r.WithContext(context.WithValue(r.Context(), errorBoxKey, box))

	tw := &teeWriter{ResponseWriter: w, rec: rec}
	h.proxy.ServeHTTP(tw, r)

	if rec != nil {
		rec.finish(box.msg)
	}
}

func (h *handler) serveHealth(w http.ResponseWriter) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":       true,
		"version":  version,
		"captured": h.captured.Load(),
		"skipped":  h.skipped.Load(),
		"failed":   h.failed.Load(),
	})
}

func newProxy(cfg config) *httputil.ReverseProxy {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   256,
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
			_, _ = w.Write([]byte(`{"error":{"type":"upstream_unavailable","message":"audit proxy cannot reach upstream"}}`))
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
		port = "8090"
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

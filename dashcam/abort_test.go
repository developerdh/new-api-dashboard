package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

/* ------------------------------------------------------------------ */
/* D6 回归：客户端在流式响应中途断开，成功请求的采集记录不得整条丢失      */
/* ------------------------------------------------------------------ */

// slowSSEUpstream 慢速流式上游：20 块 × 20ms，给客户端留出"读到一半就断开"的窗口。
func slowSSEUpstream() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "no flusher", http.StatusInternalServerError)
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl.Flush()
		for i := 0; i < 20; i++ {
			fmt.Fprintf(w, "data: chunk-%02d\n\n", i)
			fl.Flush()
			time.Sleep(20 * time.Millisecond)
		}
	}))
}

func newTestHandler(t *testing.T, upstreamURL *url.URL) (*handler, *sink) {
	t.Helper()
	s := newTestSink(t, func(c *config) {
		if upstreamURL != nil {
			c.Upstream = upstreamURL
		}
		c.CapturePaths = parsePaths("/v1/chat/completions")
	})
	h := &handler{cfg: s.cfg, sink: s, proxy: newProxy(s.cfg), counters: s.counters}
	return h, s
}

// readIndexLines 宽松读取当日索引（文件缺失/为空返回 nil）。
func readIndexLines(t *testing.T, dir string) []string {
	t.Helper()
	path := filepath.Join(dir, "index", time.Now().Format("2006-01-02")+".ndjson")
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return nil
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

// waitStableIndexLines 等索引达到 want 行且在稳定窗口内不再增长：
// 断言"恰好 N 条、无重复"必须排除重复行尚未写入的窗口。
func waitStableIndexLines(t *testing.T, dir string, want int, stable time.Duration) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var lines []string
	for {
		lines = readIndexLines(t, dir)
		if len(lines) >= want {
			time.Sleep(stable)
			final := readIndexLines(t, dir)
			if len(final) == len(lines) {
				return final
			}
			lines = final
		}
		if time.Now().After(deadline) {
			t.Fatalf("索引未在期限内稳定到 %d 行（当前 %d 行）", want, len(lines))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestClientAbortMidStreamStillCaptured(t *testing.T) {
	upstream := slowSSEUpstream()
	defer upstream.Close()
	upURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	h, s := newTestHandler(t, upURL)

	var flushed atomic.Int64
	s.flushHook = func(*record) { flushed.Add(1) }

	dashcam := httptest.NewServer(h)
	defer dashcam.Close()

	// 客户端读到 64 字节（约 4 块）即取消：断开落在拷贝中途，
	// ReverseProxy 将 panic(http.ErrAbortHandler)。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		dashcam.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"m","stream":true,"messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer sk-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("发起流式请求失败: %v", err)
	}
	buf := make([]byte, 64)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("读取流式块失败: %v", err)
	}
	cancel()
	_ = resp.Body.Close()

	// 修复点：finish 挂在 defer 里补记，panic 展开不再跳过——
	// 记录恰好落盘一次（200 + 部分响应），预算归零，dropped 无增长。
	lines := waitStableIndexLines(t, s.cfg.DashcamDir, 1, 400*time.Millisecond)
	if len(lines) != 1 {
		t.Fatalf("断开请求应恰好落盘 1 条，得到 %d 条:\n%s", len(lines), strings.Join(lines, "\n"))
	}
	entry := parseIndexEntry(t, lines[0])
	if entry.S != http.StatusOK {
		t.Fatalf("断开前响应头已是 200，索引状态应为 200: %+v", entry)
	}
	if entry.RS <= 0 {
		t.Fatalf("部分响应应已缓冲落盘: %+v", entry)
	}
	if !entry.ST {
		t.Fatalf("流式标记应被提取: %+v", entry)
	}
	if entry.TR != truncClientAbort {
		t.Fatalf("客户端中断应置 tr bit4（部分响应，非尺寸截断）: tr=%d", entry.TR)
	}
	if got := flushed.Load(); got != 1 {
		t.Fatalf("flush worker 应收到恰好 1 条，得到 %d", got)
	}
	if got := s.counters.dropped.Load(); got != 0 {
		t.Fatalf("断开不应产生丢弃: %d", got)
	}
	if got := s.buffered.Load(); got != 0 {
		t.Fatalf("断开记录落盘后预算应归零，得到 %d", got)
	}

	// 段记录内容应从首块开始（部分响应）
	fp := tokenFingerprint("Bearer sk-test")
	_, resData, _ := readPackRecord(t, s.cfg.DashcamDir, fp, entry.D[:10], entry)
	if !strings.HasPrefix(string(resData), "data: chunk-00") {
		t.Fatalf("部分响应应从首块开始: %q", resData)
	}
}

func TestCompleteStreamUnaffected(t *testing.T) {
	// 正常完整流式请求：恰好一条记录、全量落盘、无重复。
	upstream := slowSSEUpstream()
	defer upstream.Close()
	upURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	h, s := newTestHandler(t, upURL)

	dashcam := httptest.NewServer(h)
	defer dashcam.Close()

	req, err := http.NewRequest(http.MethodPost, dashcam.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"m","stream":true,"messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer sk-test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("发起流式请求失败: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("完整读取流式响应失败: %v", err)
	}
	resp.Body.Close()

	lines := waitStableIndexLines(t, s.cfg.DashcamDir, 1, 200*time.Millisecond)
	if len(lines) != 1 {
		t.Fatalf("完整请求应恰好落盘 1 条，得到 %d 条:\n%s", len(lines), strings.Join(lines, "\n"))
	}
	entry := parseIndexEntry(t, lines[0])
	if entry.S != http.StatusOK || !entry.ST {
		t.Fatalf("完整请求索引不符: %+v", entry)
	}
	if entry.TR != 0 {
		t.Fatalf("完整请求不应带任何 tr 位: tr=%d", entry.TR)
	}
	// 客户端读到的字节数与落盘响应字节数一致 = 全量采集，无重复
	if int64(len(body)) != entry.RS {
		t.Fatalf("响应应全量落盘: 客户端读到 %d，索引 RS=%d", len(body), entry.RS)
	}
	if got := s.counters.dropped.Load(); got != 0 {
		t.Fatalf("完整请求不应产生丢弃: %d", got)
	}
	if got := s.buffered.Load(); got != 0 {
		t.Fatalf("落盘后预算应归零，得到 %d", got)
	}
}

func TestClientAbortClassification(t *testing.T) {
	// D6 断开分类：aborted 记录按响应缓冲是否含应用层流结束标记分位——
	// 含 [DONE]/message_stop/response.completed = 收尾断开（bit8，记录完整）；
	// 不含 = 真中断（bit4，响应缺失）；两者互斥，完整非中断请求不带位。
	s := newTestSink(t, nil)

	eos := s.begin(testCaptureRequest(t, ""), testFP)
	eos.writeResponse([]byte(`data: {"choices":[{"delta":{"content":"完整回复"}}]}` + "\n\n"))
	eos.writeResponse([]byte("data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n"))
	eos.aborted = true
	eos.finish("")

	mid := s.begin(testCaptureRequest(t, ""), testFP)
	mid.writeResponse([]byte(`data: {"choices":[{"delta":{"content":"半截"}}]}` + "\n\n"))
	mid.aborted = true
	mid.finish("")

	clean := s.begin(testCaptureRequest(t, ""), testFP)
	clean.writeResponse([]byte("data: ok\n\ndata: [DONE]\n\n"))
	clean.finish("") // aborted=false：正常完成，不带任何客户端断开位

	nonStream := s.begin(testCaptureRequest(t, ""), testFP)
	nonStream.writeResponse([]byte(`{"choices":[{"message":{"content":"完整 JSON"}}]}`))
	nonStream.aborted = true // 非流式无终止标记：维持真中断口径
	nonStream.finish("")

	lines := waitStableIndexLines(t, s.cfg.DashcamDir, 4, 200*time.Millisecond)
	trs := map[string]int{}
	for _, line := range lines {
		e := parseIndexEntry(t, line)
		trs[e.T] = e.TR
	}
	if got := trs[eos.trace]; got != truncClientEOS {
		t.Fatalf("含 [DONE] 的断开应为收尾断开 bit8: tr=%d", got)
	}
	if got := trs[mid.trace]; got != truncClientAbort {
		t.Fatalf("无终止标记的断开应为真中断 bit4: tr=%d", got)
	}
	if got := trs[clean.trace]; got != 0 {
		t.Fatalf("正常完成不应带断开位: tr=%d", got)
	}
	if got := trs[nonStream.trace]; got != truncClientAbort {
		t.Fatalf("非流式断开应维持真中断口径: tr=%d", got)
	}
}

func TestFinishIdempotent(t *testing.T) {
	// 幂等保护（D6）：重复 finish 不得双入队/产生索引重复行。
	s := newTestSink(t, nil)
	rec := s.begin(testCaptureRequest(t, ""), testFP)
	rec.writeRequest([]byte("payload"))
	rec.finish("")
	rec.finish("")

	lines := waitStableIndexLines(t, s.cfg.DashcamDir, 1, 100*time.Millisecond)
	if len(lines) != 1 {
		t.Fatalf("重复 finish 不应产生第二条索引行，得到 %d 条", len(lines))
	}
	if got := s.counters.dropped.Load(); got != 0 {
		t.Fatalf("幂等吞掉不应计 dropped: %d", got)
	}
}

func TestNonAbortPanicRepanicsAfterFinish(t *testing.T) {
	// 非 ErrAbortHandler 的 panic：finish 先补记，再原样上抛（不得吞掉，
	// net/http 对其余 panic 照常记录）。
	h, s := newTestHandler(t, nil)
	px := newProxy(s.cfg)
	px.Director = func(*http.Request) { panic("boom") }
	h.proxy = px

	var caught any
	func() {
		defer func() { caught = recover() }()
		h.ServeHTTP(httptest.NewRecorder(), testCaptureRequest(t, ""))
	}()
	if caught == nil {
		t.Fatal("非 ErrAbortHandler panic 必须原样上抛，不得吞掉")
	}
	if caught != "boom" {
		t.Fatalf("上抛的 panic 值应原样保留，得到 %v", caught)
	}
	entry := parseIndexEntry(t, waitIndexLines(t, s.cfg.DashcamDir, 1)[0]) // finish 在 panic 展开中已补记
	if entry.TR != 0 {
		t.Fatalf("非 ErrAbortHandler 的 panic 不应置 tr bit4: tr=%d", entry.TR)
	}
}

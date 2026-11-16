package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestExtractSessionKey(t *testing.T) {
	cases := []struct {
		name string
		path string
		body string
		want string
	}{
		{
			name: "responses 取 prompt_cache_key",
			path: "/v1/responses",
			body: `{"model":"m","input":[],"prompt_cache_key":"session-8ee57ca2"}`,
			want: "session-8ee57ca2",
		},
		{
			name: "chat completions 同样支持",
			path: "/v1/chat/completions",
			body: `{"model":"m","messages":[],"prompt_cache_key":"tenant:acme:kb-v1"}`,
			want: "tenant:acme:kb-v1",
		},
		{
			name: "缺失时不猜",
			path: "/v1/responses",
			body: `{"model":"m","input":[]}`,
			want: "",
		},
		{
			name: "Claude 从 metadata.user_id 的 session_id 取",
			path: "/v1/messages",
			body: `{"model":"claude","metadata":{"user_id":"{\"device_id\":\"d\",\"session_id\":\"sess-123\"}"},"messages":[]}`,
			want: "sess-123",
		},
		{
			name: "Claude 只有 user_id 时不聚合",
			path: "/v1/messages",
			body: `{"metadata":{"user_id":"user-1"}}`,
			want: "",
		},
		{
			name: "非白名单路径忽略同名字段",
			path: "/v1beta/models/x:generateContent",
			body: `{"prompt_cache_key":"should-not-be-used"}`,
			want: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractSessionKey(c.path, []byte(c.body)); got != c.want {
				t.Fatalf("extractSessionKey(%q) = %q, want %q", c.path, got, c.want)
			}
		})
	}
}

func TestSessionKeyHash(t *testing.T) {
	if got := sessionKeyHash(""); got != "" {
		t.Fatalf("空键应返回空串，得到 %q", got)
	}
	first := sessionKeyHash("session-abc")
	second := sessionKeyHash("session-abc")
	if first != second {
		t.Fatal("同一键的哈希必须稳定")
	}
	if len(first) != 16 {
		t.Fatalf("哈希应为 16 位十六进制，得到 %q", first)
	}
	if sessionKeyHash("session-abd") == first {
		t.Fatal("不同键不应产生相同哈希")
	}
}

/* ------------------------------------------------------------------ */
/* 会话聚合：harness 识别与策略化会话键提取（08-design §8 测试矩阵）     */
/* ------------------------------------------------------------------ */

// resolveFor 构造候选头快照后跑 flush 的单点决策，返回 (h, 原始会话键)。
func resolveFor(t *testing.T, headers http.Header, path, body string) (string, string) {
	t.Helper()
	return resolveSessionKey(copyCandidateHeaders(headers), path, []byte(body))
}

func TestHarnessDetectAndKeyMatrix(t *testing.T) {
	cases := []struct {
		name    string
		headers http.Header
		path    string
		body    string
		wantH   string
		wantKey string
	}{
		{
			name:    "dsh：会话头命中，头键生效",
			headers: http.Header{"X-Deepseek-Harness-Session-Id": {"dsh-sess-1"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m","messages":[]}`,
			wantH:   "dsh",
			wantKey: "dsh-sess-1",
		},
		{
			name:    "dsh：UA 前缀命中，体 prompt_cache_key 生效",
			headers: http.Header{"User-Agent": {"deepseek-harness/1.2.3"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m","prompt_cache_key":"pi-ai-sess"}`,
			wantH:   "dsh",
			wantKey: "pi-ai-sess",
		},
		{
			name:    "dsh：头与体并存，候选序首个（头）生效",
			headers: http.Header{"X-Deepseek-Harness-Session-Id": {"head-sess"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m","prompt_cache_key":"body-sess"}`,
			wantH:   "dsh",
			wantKey: "head-sess",
		},
		{
			name:    "dsh：识别与提取解耦，无任何键时 h=dsh、k 缺省",
			headers: http.Header{"User-Agent": {"deepseek-harness/1.2.3"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m","messages":[]}`,
			wantH:   "dsh",
			wantKey: "",
		},
		{
			name:    "dsh：deepseek 栈体里没有 metadata 也不影响头键",
			headers: http.Header{"X-Deepseek-Harness-Session-Id": {"dsh-sess-2"}},
			path:    "/v1/messages",
			body:    `{"model":"deepseek-chat","messages":[]}`,
			wantH:   "dsh",
			wantKey: "dsh-sess-2",
		},
		{
			name:    "codex：Originator 前缀命中 + Session-Id",
			headers: http.Header{"Originator": {"codex_cli_rs"}, "Session-Id": {"0198f39a-1111-7777-8000-000000000001"}},
			path:    "/v1/responses",
			body:    `{"model":"m","input":[]}`,
			wantH:   "codex",
			wantKey: "0198f39a-1111-7777-8000-000000000001",
		},
		{
			name:    "codex：Originator 非 codex 前缀不命中",
			headers: http.Header{"Originator": {"vscode"}, "Session-Id": {"not-used"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m"}`,
			wantH:   "",
			wantKey: "",
		},
		{
			name:    "codex：命中但无 Session-Id → h=codex、k 缺省",
			headers: http.Header{"Originator": {"codex_cli_rs"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m"}`,
			wantH:   "codex",
			wantKey: "",
		},
		{
			name:    "claude-code：UA 前缀命中，metadata.session_id 生效",
			headers: http.Header{"User-Agent": {"claude-cli/2.0.0"}},
			path:    "/v1/messages",
			body:    `{"model":"claude","metadata":{"user_id":"{\"device_id\":\"d\",\"session_id\":\"cc-sess\"}"},"messages":[]}`,
			wantH:   "claude-code",
			wantKey: "cc-sess",
		},
		{
			name:    "claude-code：X-App: cli 命中",
			headers: http.Header{"X-App": {"cli"}},
			path:    "/v1/messages",
			body:    `{"model":"claude","metadata":{"user_id":"{\"session_id\":\"cc-sess\"}"}}`,
			wantH:   "claude-code",
			wantKey: "cc-sess",
		},
		{
			name:    "claude-code：body metadata 签名命中（无头无 UA）",
			headers: http.Header{},
			path:    "/v1/messages",
			body:    `{"model":"claude","metadata":{"user_id":"{\"session_id\":\"cc-sess\"}"}}`,
			wantH:   "claude-code",
			wantKey: "cc-sess",
		},
		{
			name:    "claude-code：metadata 与 prompt_cache_key 并存，候选序首个（metadata）生效",
			headers: http.Header{"User-Agent": {"claude-cli/2.0.0"}},
			path:    "/v1/messages",
			body:    `{"model":"claude","metadata":{"user_id":"{\"session_id\":\"cc-sess\"}"},"prompt_cache_key":"cache-sess"}`,
			wantH:   "claude-code",
			wantKey: "cc-sess",
		},
		{
			name:    "claude-code：无 metadata 会话时回退候选序第二（prompt_cache_key）",
			headers: http.Header{"User-Agent": {"claude-cli/2.0.0"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m","prompt_cache_key":"cache-sess"}`,
			wantH:   "claude-code",
			wantKey: "cache-sess",
		},
		{
			name:    "opencode：会话头命中",
			headers: http.Header{"X-Opencode-Session": {"oc-sess-1"}},
			path:    "/v1/chat/completions",
			body:    `{"model":"m"}`,
			wantH:   "opencode",
			wantKey: "oc-sess-1",
		},
		{
			name: "排除头不触发识别也不供键",
			headers: http.Header{
				"X-Client-Request-Id":        {"req-1"},
				"X-Opencode-Request":         {"req-2"},
				"User":                       {"u1"},
				"X-Opencode-Project":         {"p1"},
				"X-Deepseek-Harness-User-Id": {"u2"},
			},
			path:    "/v1/chat/completions",
			body:    `{"model":"m"}`,
			wantH:   "",
			wantKey: "",
		},
		{
			name:    "未识别：回退取 body prompt_cache_key（h 缺省）",
			headers: http.Header{},
			path:    "/v1/chat/completions",
			body:    `{"model":"m","prompt_cache_key":"plain-sess"}`,
			wantH:   "",
			wantKey: "plain-sess",
		},
		{
			name:    "未识别：非白名单路径不提取（路径门控保留）",
			headers: http.Header{},
			path:    "/v1beta/models/x:generateContent",
			body:    `{"prompt_cache_key":"should-not-be-used"}`,
			wantH:   "",
			wantKey: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, key := resolveFor(t, c.headers, c.path, c.body)
			if h != c.wantH {
				t.Fatalf("h = %q, want %q", h, c.wantH)
			}
			if key != c.wantKey {
				t.Fatalf("会话键 = %q, want %q", key, c.wantKey)
			}
		})
	}
}

func TestHarnessFallbackByteIdentical(t *testing.T) {
	// §8：未识别客户端的回退语义与现状逐字节一致——resolveSessionKey 空
	// 候选头的结果必须等于直接调 extractSessionKey。
	cases := []struct{ path, body string }{
		{"/v1/responses", `{"model":"m","input":[],"prompt_cache_key":"s1"}`},
		{"/v1/chat/completions", `{"model":"m","messages":[],"prompt_cache_key":"s2"}`},
		{"/v1/completions", `{"model":"m","prompt":"x","prompt_cache_key":"s3"}`},
		{"/v1/messages", `{"model":"c","metadata":{"user_id":"user-1"}}`},
		{"/v1/messages", `{"model":"c","messages":[]}`},
		{"/v1beta/models/x:generateContent", `{"prompt_cache_key":"s5"}`},
	}
	for _, c := range cases {
		h, key := resolveFor(t, http.Header{}, c.path, c.body)
		if h != "" {
			t.Fatalf("空候选头不应识别出 harness: %q", h)
		}
		if want := extractSessionKey(c.path, []byte(c.body)); key != want {
			t.Fatalf("回退应与 extractSessionKey 逐字节一致: path=%s got=%q want=%q", c.path, key, want)
		}
	}
}

func TestHarnessHeaderValueTruncation(t *testing.T) {
	// §6.2：头值截 128B 后参与哈希；UA 截 256B，前缀在窗口内不受影响。
	long := strings.Repeat("a", 200)
	h, key := resolveFor(t, http.Header{"X-Opencode-Session": {long}}, "/v1/chat/completions", `{}`)
	if h != "opencode" {
		t.Fatalf("超长头仍应识别 opencode: h=%q", h)
	}
	if key != strings.Repeat("a", 128) {
		t.Fatalf("头值应截断到 128B，得到 len=%d", len(key))
	}
	if got, want := sessionKeyHash(key), sessionKeyHash(strings.Repeat("a", 128)); got != want {
		t.Fatalf("哈希应基于截断后的值: got=%s", got)
	}

	uaLive := "deepseek-harness/1.0.0 " + strings.Repeat("x", 300)
	if h, _ := resolveFor(t, http.Header{"User-Agent": {uaLive}}, "/v1/chat/completions", `{}`); h != "dsh" {
		t.Fatalf("UA 截断不应影响 256B 内的前缀检测: h=%q", h)
	}
	// 前缀落在 256B 窗口之外：截断生效，不应命中
	uaLate := strings.Repeat("x", 260) + " deepseek-harness/1.0.0"
	if h, _ := resolveFor(t, http.Header{"User-Agent": {uaLate}}, "/v1/chat/completions", `{}`); h != "" {
		t.Fatalf("256B 截断之后的前缀不应参与检测: h=%q", h)
	}
}

func TestHarnessIndexEntry(t *testing.T) {
	// §8：h 落索引；未识别行 omitempty（JSON 中无 h 字段），聚合口径零变化。
	s := newTestSink(t, nil)

	codexReq := testCaptureRequest(t, "0123456789abcdef0123456789abcdef")
	codexReq.Header.Set("Originator", "codex_cli_rs")
	codexReq.Header.Set("Session-Id", "codex-sess-42")
	codex := s.begin(codexReq, testFP)
	codex.writeRequest([]byte(`{"model":"m","messages":[]}`))
	codex.finish("")

	plain := s.begin(testCaptureRequest(t, ""), testFP)
	plain.writeRequest([]byte(`{"model":"m","prompt_cache_key":"plain-sess"}`))
	plain.finish("")

	lines := waitIndexLines(t, s.cfg.DashcamDir, 2)
	codexEntry := parseIndexEntry(t, lines[0])
	if codexEntry.H != "codex" {
		t.Fatalf("识别结果应落索引 h 字段: %+v", codexEntry)
	}
	if codexEntry.K != sessionKeyHash("codex-sess-42") {
		t.Fatalf("k 应为头键哈希: %+v", codexEntry)
	}
	if strings.Contains(lines[1], `"h":`) {
		t.Fatalf("未识别行不应带 h 字段（omitempty）: %s", lines[1])
	}
	plainEntry := parseIndexEntry(t, lines[1])
	if plainEntry.H != "" || plainEntry.K != sessionKeyHash("plain-sess") {
		t.Fatalf("未识别行应走回退且无 h: %+v", plainEntry)
	}
}

/* ------------------------------------------------------------------ */
/* D-P3 异步落盘语义：慢盘注入、队满、预算截停、优雅停机                  */
/* ------------------------------------------------------------------ */

const testFP = "6981744f7254"

// newTestSink 构造异步落盘的 sink；mutate 调整配置（队列容量 / 预算 / worker 数等）。
func newTestSink(t *testing.T, mutate func(*config)) *sink {
	t.Helper()
	cfg := config{
		DashcamDir:      t.TempDir(),
		MaxRequest:      defaultMaxBytes,
		MaxResponse:     defaultMaxBytes,
		GzipOver:        defaultGzipOver,
		MemBudget:       defaultMemBudget,
		FlushWorkers:    1,
		QueueCap:        256,
		MaxConnsPerHost: defaultConnsHost,
		IdleTimeout:     defaultIdleBackup,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	s, err := newSink(cfg, &captureCounters{})
	if err != nil {
		t.Fatalf("newSink: %v", err)
	}
	t.Cleanup(s.closeAndWait)
	return s
}

func testCaptureRequest(t *testing.T, trace string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	if trace != "" {
		req.Header.Set("X-Trace-Id", trace)
	}
	req.Header.Set("Authorization", "Bearer sk-test")
	return req
}

// waitIndexLines 轮询等待当日索引达到 want 行：finish 返回只代表入队，
// 落盘完成以索引行出现为准（异步语义下测试必须等 worker）。
func waitIndexLines(t *testing.T, dir string, want int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	path := filepath.Join(dir, "index", time.Now().Format("2006-01-02")+".ndjson")
	for {
		data, err := os.ReadFile(path)
		if err == nil && len(data) > 0 {
			lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
			if len(lines) >= want {
				return lines
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("索引 %s 在 2s 内未达到 %d 行", path, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func parseIndexEntry(t *testing.T, line string) indexEntry {
	t.Helper()
	var entry indexEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatalf("索引行不是合法 JSON: %v\n%s", err, line)
	}
	return entry
}

func TestFlushAsyncLifecycle(t *testing.T) {
	s := newTestSink(t, nil)

	rec := s.begin(testCaptureRequest(t, "0123456789abcdef0123456789abcdef"), testFP)
	reqBody := `{"model":"gpt-4o-mini","stream":true,"prompt_cache_key":"sess-1","messages":[]}`
	rec.writeRequest([]byte(reqBody))
	rec.setStatus(http.StatusOK)
	rec.writeResponse([]byte("data: hello\n\n"))
	resTail := "data: {\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3}}\n\n"
	rec.writeResponse([]byte(resTail))
	rec.finish("")

	entry := parseIndexEntry(t, waitIndexLines(t, s.cfg.DashcamDir, 1)[0])
	if entry.T != "0123456789abcdef0123456789abcdef" || entry.U != testFP {
		t.Fatalf("索引 trace/指纹不符: %+v", entry)
	}
	if entry.M != "gpt-4o-mini" || !entry.ST || entry.S != http.StatusOK {
		t.Fatalf("正则提取（worker 侧）结果不符: %+v", entry)
	}
	if entry.RQ != int64(len(reqBody)) || entry.RS != int64(len("data: hello\n\n"))+int64(len(resTail)) {
		t.Fatalf("落盘字节数不符: rq=%d rs=%d", entry.RQ, entry.RS)
	}
	if entry.PT != 12 || entry.CT != 3 {
		t.Fatalf("usage 应从内存缓冲尾部提取: %+v", entry)
	}
	if entry.K == "" || entry.QZ || entry.RZ {
		t.Fatalf("小体积不压缩、会话键应存在: %+v", entry)
	}

	// D-P5 段式打包：正文在 seg/off/ln 指向的段记录里，payload 未压缩
	if entry.SEG == "" || entry.OFF != 0 || entry.LN <= packHeaderLen {
		t.Fatalf("索引应携带段定位字段: %+v", entry)
	}
	reqData, resData, flags := readPackRecord(t, s.cfg.DashcamDir, testFP, rec.start.Format("2006-01-02"), entry)
	if string(reqData) != reqBody {
		t.Fatalf("请求 payload 内容不符: %q", reqData)
	}
	if string(resData) != "data: hello\n\n"+resTail {
		t.Fatalf("响应 payload 内容不符: %q", resData)
	}
	if flags != 0 {
		t.Fatalf("小体积不应压缩: flags=%d", flags)
	}
	if s.buffered.Load() != 0 {
		t.Fatalf("flush 完成后预算应归零，得到 %d", s.buffered.Load())
	}
}

func TestFlushGzipThreshold(t *testing.T) {
	s := newTestSink(t, nil)

	big := bytes.Repeat([]byte("x"), int(defaultGzipOver)+1024) // 高重复度，压缩有效
	rec := s.begin(testCaptureRequest(t, ""), testFP)
	rec.writeRequest(big)
	rec.writeResponse([]byte("tiny"))
	rec.finish("")

	entry := parseIndexEntry(t, waitIndexLines(t, s.cfg.DashcamDir, 1)[0])
	if !entry.QZ || entry.RZ {
		t.Fatalf("阈值判定不符（req 应压缩、res 不应）: %+v", entry)
	}
	if entry.RQ != int64(len(big)) {
		t.Fatalf("rq 应为截断前缓冲长度: %d", entry.RQ)
	}

	// D-P5：gzip 的 payload 在段记录里，每条独立压缩（gzip 往返校验）
	reqData, resData, flags := readPackRecord(t, s.cfg.DashcamDir, testFP, rec.start.Format("2006-01-02"), entry)
	if flags&packFlagReqGz == 0 || flags&packFlagResGz != 0 {
		t.Fatalf("flags 应只标记 req gzip: %d", flags)
	}
	zr, err := gzip.NewReader(bytes.NewReader(reqData))
	if err != nil {
		t.Fatalf("不是合法 gzip: %v", err)
	}
	roundtrip, err := io.ReadAll(zr)
	if err != nil || !bytes.Equal(roundtrip, big) {
		t.Fatalf("gzip 往返不一致: err=%v len=%d", err, len(roundtrip))
	}
	if string(resData) != "tiny" {
		t.Fatalf("未压缩 payload 应原样保存: %q", resData)
	}
}

func TestQueueFullDrops(t *testing.T) {
	// 慢盘注入：flushHook 阻塞唯一 worker，队列容量 1 → 第三条入队失败被丢弃。
	// entered 先确认 worker 已阻塞在第一条上，时序才确定。
	s := newTestSink(t, func(c *config) { c.QueueCap = 1 })
	release := make(chan struct{})
	entered := make(chan struct{}, 3)
	s.flushHook = func(*record) {
		entered <- struct{}{}
		<-release
	}
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()

	rec1 := s.begin(testCaptureRequest(t, ""), testFP)
	rec1.writeRequest([]byte("first"))
	rec1.finish("")
	<-entered // worker 已取出 rec1 并阻塞：队列空出

	rec2 := s.begin(testCaptureRequest(t, ""), testFP)
	rec2.writeRequest([]byte("second"))
	rec2.finish("") // 占住队列
	rec3 := s.begin(testCaptureRequest(t, ""), testFP)
	rec3.writeRequest([]byte("third"))
	rec3.finish("") // 队满 → 丢弃

	if got := s.counters.dropped.Load(); got != 1 {
		t.Fatalf("队满应丢弃 1 条，得到 %d", got)
	}

	unblock() // 放行 worker，让已入队记录落盘后再断言索引
	lines := waitIndexLines(t, s.cfg.DashcamDir, 2)
	if e1, e2 := parseIndexEntry(t, lines[0]), parseIndexEntry(t, lines[1]); e1.RQ != 5 || e2.RQ != 6 {
		t.Fatalf("前两条都应落盘: rq=%d/%d", e1.RQ, e2.RQ)
	}

	// 被丢弃记录的预算在 finish 即归还；两条已落盘的由 flush 完成归还
	deadline := time.Now().Add(2 * time.Second)
	for s.buffered.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if s.buffered.Load() != 0 {
		t.Fatalf("全部记录处理后预算应归零，得到 %d", s.buffered.Load())
	}
}

func TestBudgetStarvesInFlight(t *testing.T) {
	// 预算截停（三层降级第 2 层）：在途流传输中预算超限 → 停止缓冲、释放内存、tr 位。
	// 预算 6144 = peek(2048) + req(2048) + res(2048) 恰好放满，下一块触发截停。
	s := newTestSink(t, func(c *config) { c.MemBudget = 6144 })
	release := make(chan struct{})
	s.flushHook = func(*record) { <-release }
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()

	rec := s.begin(testCaptureRequest(t, ""), testFP)
	rec.writeRequest(bytes.Repeat([]byte("a"), 2048))
	rec.writeResponse(bytes.Repeat([]byte("b"), 2048))
	if s.buffered.Load() != 6144 {
		t.Fatalf("预算内的缓冲应全部驻留，得到 %d", s.buffered.Load())
	}

	rec.writeResponse(bytes.Repeat([]byte("c"), 1024)) // 超预算 → 停缓冲
	if !rec.starved {
		t.Fatal("预算超限后记录应进入停缓冲态")
	}
	if rec.trunc != truncRequest|truncResponse {
		t.Fatalf("停缓冲应置两侧 tr 位: %d", rec.trunc)
	}
	if got := s.buffered.Load(); got != int64(len(rec.peek)) {
		t.Fatalf("正文缓冲应已释放（仅保留 peek），得到 %d", got)
	}
	if got := s.counters.dropped.Load(); got != 1 {
		t.Fatalf("在途停缓冲应计 dropped，得到 %d", got)
	}

	rec.finish("") // 队列未满，仍入队：索引可见、正文为空
	unblock()      // 放行 worker 落盘后再断言索引
	entry := parseIndexEntry(t, waitIndexLines(t, s.cfg.DashcamDir, 1)[0])
	if entry.RQ != 0 || entry.RS != 0 || entry.TR != truncRequest|truncResponse {
		t.Fatalf("停缓冲记录的索引应为空正文 + tr 位: %+v", entry)
	}
}

func TestGracefulShutdownDrains(t *testing.T) {
	// 优雅停机：closeAndWait 排空队列后返回，队内记录不丢
	s := newTestSink(t, nil)
	for i := 0; i < 50; i++ {
		rec := s.begin(testCaptureRequest(t, ""), testFP)
		rec.writeRequest([]byte("payload"))
		rec.finish("")
	}
	s.closeAndWait()

	entry := parseIndexEntry(t, waitIndexLines(t, s.cfg.DashcamDir, 50)[49])
	if entry.RQ != 7 {
		t.Fatalf("排空后索引应完整: %+v", entry)
	}
	if s.buffered.Load() != 0 {
		t.Fatalf("停机后预算应归零，得到 %d", s.buffered.Load())
	}
	// 幂等：重复 closeAndWait 不 panic（主流程与测试 cleanup 双重调用）
	s.closeAndWait()
}

func TestServeHealthReportsDroppedAndBuffered(t *testing.T) {
	s := newTestSink(t, nil)
	h := &handler{cfg: s.cfg, sink: s, counters: s.counters}

	w := httptest.NewRecorder()
	h.serveHealth(w)
	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("healthz 不是合法 JSON: %v", err)
	}
	for _, key := range []string{"dropped", "buffered_bytes", "captured", "skipped", "failed"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("healthz 缺少字段 %q: %v", key, payload)
		}
	}

	s.counters.dropped.Add(3)
	s.buffered.Store(4096)
	w2 := httptest.NewRecorder()
	h.serveHealth(w2)
	var payload2 map[string]any
	_ = json.Unmarshal(w2.Body.Bytes(), &payload2)
	if payload2["dropped"].(float64) != 3 || payload2["buffered_bytes"].(float64) != 4096 {
		t.Fatalf("healthz 计数不符: %v", payload2)
	}
}

func TestHandlerForwardingUnaffectedByBudget(t *testing.T) {
	// 红线验证：采集降级绝不影响转发。预算被占满后，新请求被跳过但转发 200。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	s := newTestSink(t, func(c *config) {
		c.MemBudget = 4096
		c.Upstream = upstreamURL
	})
	release := make(chan struct{})
	s.flushHook = func(*record) { <-release }
	defer close(release)

	// 占满预算：预算内整块缓冲（worker 被阻塞，buffered 保持高位）
	blocker := s.begin(testCaptureRequest(t, ""), testFP)
	blocker.writeRequest(make([]byte, 4096))
	if s.buffered.Load() < 4096 {
		t.Fatalf("预算应被占满，得到 %d", s.buffered.Load())
	}

	h := &handler{cfg: s.cfg, sink: s, proxy: newProxy(s.cfg), counters: s.counters}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m","messages":[]}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != "ok" {
		t.Fatalf("预算超限时转发必须无感: code=%d body=%q", w.Code, w.Body.String())
	}
	if h.counters.skipped.Load() != 1 {
		t.Fatalf("预算超限的新请求应计 skipped，得到 %d", h.counters.skipped.Load())
	}
	if h.counters.captured.Load() != 0 {
		t.Fatalf("预算超限不应受理新记录，得到 %d", h.counters.captured.Load())
	}
}

func TestHandlerBudgetZeroStopsCapture(t *testing.T) {
	// 停采总开关：预算 0 = 完全跳过采集，转发照常
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	s := newTestSink(t, func(c *config) {
		c.MemBudget = 0
		c.Upstream = upstreamURL
	})
	h := &handler{cfg: s.cfg, sink: s, proxy: newProxy(s.cfg), counters: s.counters}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"m"}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != "ok" {
		t.Fatalf("停采开关下转发必须无感: code=%d", w.Code)
	}
	if h.counters.skipped.Load() != 1 || h.counters.captured.Load() != 0 {
		t.Fatalf("停采开关应只计 skipped: %+v", h.counters)
	}
}

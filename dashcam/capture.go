package main

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 索引行字段刻意用短名：一天几千行，体积比可读性更重要。
// 看板侧按 t（trace）读详情，按 u（token 指纹）聚合到用户维度。
type indexEntry struct {
	T  string `json:"t"`
	U  string `json:"u"`
	D  string `json:"d"`
	P  string `json:"p"`
	M  string `json:"m"`
	S  int    `json:"s"`
	ST bool   `json:"st"`
	MS int64  `json:"ms"`
	FT int64  `json:"ft"`
	RQ int64  `json:"rq"`
	RS int64  `json:"rs"`
	QZ bool   `json:"qz"`
	RZ bool   `json:"rz"`
	TR int    `json:"tr"`
	E  string `json:"e,omitempty"`
	IP string `json:"ip,omitempty"`
	// K 会话键哈希（sha256(key) 前 16 位十六进制），缺失表示该协议/客户端未提供会话标识。
	// 只存哈希：键可能含租户、项目等业务标识，且分组只需要可比较的稳定值。
	K string `json:"k,omitempty"`
	// token 用量（pt=输入 / ct=输出 / cc=缓存命中输入 / cw=缓存写入），采集时从响应
	// 正文 best-effort 提取（见 usage.go）；解析失败或旧版采集缺省，看板显示 —。
	PT int64 `json:"pt,omitempty"`
	CT int64 `json:"ct,omitempty"`
	CC int64 `json:"cc,omitempty"`
	CW int64 `json:"cw,omitempty"`
}

const (
	truncRequest  = 1 << 0
	truncResponse = 1 << 1
)

var (
	tracePattern  = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)
	modelPattern  = regexp.MustCompile(`"model"\s*:\s*"([^"\\]{1,128})"`)
	streamPattern = regexp.MustCompile(`"stream"\s*:\s*true`)

	// prompt_cache_key 在请求体中位置不固定（实测 34–160 KB），因此 peek 放大到 256 KB。
	// 代价是每请求最多多占 256 KB 内存，转发路径与落盘上限不受影响。
	promptCacheKeyPattern = regexp.MustCompile(`"prompt_cache_key"\s*:\s*"([^"\\]{1,256})"`)
	// Claude Code 把 session_id 塞在 metadata.user_id 的 JSON 字符串里（引号被转义）。
	claudeSessionPattern = regexp.MustCompile(`\\?"session_id\\?"\s*:\s*\\?"([A-Za-z0-9._:-]{1,128})\\?"`)

	peekLimit = 256 << 10
)

// captureCounters 是采集侧四个计数的共享存储：handler 与 flush worker 各自递增，
// /healthz 汇总输出。dropped 与 buffered_bytes 为 D-P3 新增（06-performance-plan §7.4）。
type captureCounters struct {
	captured atomic.Int64
	skipped  atomic.Int64
	failed   atomic.Int64
	dropped  atomic.Int64
}

// sink 是采集后台：请求 goroutine 只做内存缓冲与非阻塞入队，落盘/压缩/索引/正则
// 全部由 flush worker 独占——磁盘抖动不影响转发，02-design §3"队列有界、满则丢弃"
// 自此归真（D-P3）。
type sink struct {
	cfg      config
	counters *captureCounters

	// buffered 是 reqBuf + resBuf + peek 的实时字节总量，预算 DASHCAM_MEM_BUDGET 的依据；
	// 每个 chunk 一次 atomic add，预算超限触发三层降级（见 record.appendBuf/starve）。
	buffered atomic.Int64

	queue     chan *record
	workers   sync.WaitGroup
	closeOnce sync.Once

	idxMu    sync.Mutex
	idxFiles map[string]*os.File

	dirMu    sync.Mutex
	knownDir map[string]struct{}

	// flushHook 仅供测试注入（慢盘模拟）：worker 在每条 flush 开始前同步调用，生产为 nil。
	flushHook func(*record)
}

func newSink(cfg config, counters *captureCounters) (*sink, error) {
	for _, sub := range []string{"blobs", "index"} {
		if err := os.MkdirAll(filepath.Join(cfg.DashcamDir, sub), 0o750); err != nil {
			return nil, err
		}
	}
	s := &sink{
		cfg:      cfg,
		counters: counters,
		queue:    make(chan *record, cfg.QueueCap),
		idxFiles: make(map[string]*os.File),
		knownDir: make(map[string]struct{}),
	}
	for range cfg.FlushWorkers {
		s.workers.Add(1)
		go func() {
			defer s.workers.Done()
			for rec := range s.queue {
				s.flush(rec)
			}
		}()
	}
	return s, nil
}

// closeAndWait 关闭队列并等待 worker 排空（优雅停机）：队内记录全部落盘后才返回。
// 队列容量 × 预算给定驻留上界，排空是秒级；进程被 SIGKILL 时队内记录全损，
// 无索引行、无 blob，与"崩溃丢流中记录"同级可见性。幂等，可重复调用；
// 排空后顺带关闭日索引句柄（干净停机释放 fd）。
func (s *sink) closeAndWait() {
	s.closeOnce.Do(func() { close(s.queue) })
	s.workers.Wait()
	s.idxMu.Lock()
	defer s.idxMu.Unlock()
	for name, f := range s.idxFiles {
		f.Close()
		delete(s.idxFiles, name)
	}
}

// record 是一次请求的采集快照。缓冲只发生在转发 goroutine（纯内存 append），
// 磁盘操作全部延迟到 flush worker——写入失败只降级采集，绝不影响转发。
type record struct {
	sink  *sink
	trace string
	token string
	path  string
	start time.Time
	ip    string

	reqBuf  []byte
	resBuf  []byte
	trunc   int
	starved bool // 预算超限后停止缓冲本记录（三层降级第 2 层）

	peek       []byte
	model      string
	isStream   bool
	sessionKey string
	firstByte  time.Time
	status     int
	errMsg     string
	// ms 在 finish 入队时刻定格：总耗时指转发耗时，不含队列等待。
	ms int64
}

// begin 只分配快照结构（纳秒级）：目录创建、文件命名与 trace 冲突处理全部搬到 flush。
// 预算判定（三层降级第 1 层）在 handler 完成，这里不再检查。
func (s *sink) begin(r *http.Request, token string) *record {
	return &record{
		sink:   s,
		trace:  pickTrace(r),
		token:  token,
		path:   r.URL.Path,
		start:  time.Now(),
		ip:     clientIP(r),
		status: http.StatusOK,
	}
}

func (s *sink) ensureDir(dir string) error {
	s.dirMu.Lock()
	_, ok := s.knownDir[dir]
	s.dirMu.Unlock()
	if ok {
		return nil
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	s.dirMu.Lock()
	s.knownDir[dir] = struct{}{}
	s.dirMu.Unlock()
	return nil
}

// writeRequest 由 io.TeeReader 调用：永远返回 len(p)，保证转发不中断。
func (r *record) writeRequest(p []byte) {
	if r.starved {
		return
	}
	if len(r.peek) < peekLimit {
		need := peekLimit - len(r.peek)
		if need > len(p) {
			need = len(p)
		}
		r.peek = append(r.peek, p[:need]...)
		r.sink.buffered.Add(int64(need))
	}
	if int64(len(r.reqBuf)) >= r.sink.cfg.MaxRequest {
		r.trunc |= truncRequest
		return
	}
	remain := r.sink.cfg.MaxRequest - int64(len(r.reqBuf))
	chunk := p
	if int64(len(chunk)) > remain {
		chunk = chunk[:remain]
		r.trunc |= truncRequest
	}
	r.appendBuf(&r.reqBuf, chunk)
}

func (r *record) writeResponse(p []byte) {
	// 首字节时间照常记录：预算停缓冲只丢采集数据，不丢转发耗时口径。
	if r.firstByte.IsZero() {
		r.firstByte = time.Now()
	}
	if r.starved {
		return
	}
	if int64(len(r.resBuf)) >= r.sink.cfg.MaxResponse {
		r.trunc |= truncResponse
		return
	}
	remain := r.sink.cfg.MaxResponse - int64(len(r.resBuf))
	chunk := p
	if int64(len(chunk)) > remain {
		chunk = chunk[:remain]
		r.trunc |= truncResponse
	}
	r.appendBuf(&r.resBuf, chunk)
}

// appendBuf 追加正文缓冲并计入全局预算。预算超限触发三层降级第 2 层（在途停缓冲）：
// 释放本记录已缓冲正文、tr 位标记截断、dropped 累计，转发照常。
func (r *record) appendBuf(buf *[]byte, chunk []byte) {
	s := r.sink
	if s.cfg.MemBudget > 0 && s.buffered.Load()+int64(len(chunk)) > s.cfg.MemBudget {
		r.starve()
		return
	}
	*buf = append(*buf, chunk...)
	s.buffered.Add(int64(len(chunk)))
}

// starve 停止缓冲本记录：释放 reqBuf/resBuf（大块），保留 peek（有界，供元数据提取）。
// tr 位是数据侧标记（索引行可见）；dropped 是资源侧累计（/healthz 可见）——
// 分别对应 06-performance-plan §11.3 的"tr 位"与 §11.5.3 的"预算计 dropped"。
func (r *record) starve() {
	if r.starved {
		return
	}
	r.starved = true
	r.trunc |= truncRequest | truncResponse
	r.sink.counters.dropped.Add(1)
	released := int64(len(r.reqBuf)) + int64(len(r.resBuf))
	r.reqBuf = nil
	r.resBuf = nil
	r.sink.buffered.Add(-released)
}

// release 归还本记录占用的全部预算字节；队满丢弃与 flush 完成后都要调用。
func (r *record) release() {
	n := int64(len(r.reqBuf)) + int64(len(r.resBuf)) + int64(len(r.peek))
	r.reqBuf = nil
	r.resBuf = nil
	r.peek = nil
	if n > 0 {
		r.sink.buffered.Add(-n)
	}
}

func (r *record) setStatus(code int) { r.status = code }

// finish 非阻塞入队后立即返回：转发路径到此为止，磁盘交给 worker。
// 队满（三层降级第 3 层）丢弃整条记录——无索引行、无 blob，dropped 累计。
func (r *record) finish(errMsg string) {
	r.errMsg = errMsg
	r.ms = time.Since(r.start).Milliseconds()
	select {
	case r.sink.queue <- r:
	default:
		r.sink.counters.dropped.Add(1)
		r.release()
	}
}

// flush 把一条记录持久化：ensureDir → O_EXCL 定名 → 缓冲写盘（含 gzip 阈值判定）→
// 正则提取 → usage 提取 → 追加索引。失败保留 .tmp 由清理脚本回收，failed++，不重试
// （磁盘持续故障时重试会阻塞 worker）。不变式：索引行存在 ⇒ blob 已 rename 就位。
func (s *sink) flush(rec *record) {
	if s.flushHook != nil {
		s.flushHook(rec)
	}
	defer rec.release()

	day := rec.start.Format("2006-01-02")
	dir := filepath.Join(s.cfg.DashcamDir, "blobs", day, rec.token)
	if err := s.ensureDir(dir); err != nil {
		s.counters.failed.Add(1)
		logEvent("warn", "capture_dir_failed", map[string]any{"trace": rec.trace, "error": err.Error()})
		return
	}

	// trace 可能被客户端复用（同一个 X-Request-Id 重试）：冲突时换后缀，保证
	// 文件名与最终路径始终一致——否则 rename 会落到另一个名字上。
	// O_EXCL 候选循环从请求路径搬到 worker：跨重启的 .tmp 残留（崩溃产物）同样在此覆盖。
	var base string
	for attempt := 0; attempt < 3 && base == ""; attempt++ {
		candidate := rec.trace
		if attempt > 0 {
			candidate = rec.trace + "-" + randomHex(3)
		}
		candidateBase := filepath.Join(dir, candidate)
		rf, ok := createExclusive(candidateBase + ".req.tmp")
		if !ok {
			continue
		}
		sf, ok := createExclusive(candidateBase + ".res.tmp")
		if !ok {
			rf.Close()
			os.Remove(candidateBase + ".req.tmp")
			continue
		}
		rf.Close()
		sf.Close()
		base = candidateBase
		rec.trace = candidate
	}
	if base == "" {
		s.counters.failed.Add(1)
		logEvent("warn", "capture_name_failed", map[string]any{"trace": rec.trace})
		return
	}

	reqGz, ok := s.flushBlob(base, ".req", rec.reqBuf)
	if !ok {
		s.counters.failed.Add(1)
		logEvent("warn", "capture_write_failed", map[string]any{"trace": rec.trace})
		return
	}
	resGz, ok := s.flushBlob(base, ".res", rec.resBuf)
	if !ok {
		s.counters.failed.Add(1)
		logEvent("warn", "capture_write_failed", map[string]any{"trace": rec.trace})
		return
	}

	// 正则提取从请求路径移入 worker：模型名 / 流式标记 / 会话键。
	if m := modelPattern.FindSubmatch(rec.peek); len(m) == 2 {
		rec.model = string(m[1])
	}
	rec.isStream = streamPattern.Match(rec.peek)
	rec.sessionKey = extractSessionKey(rec.path, rec.peek)

	// token 用量：响应缓冲尾部窗口扫描（与旧"读 .tmp 尾部"同口径，数据源换成内存）。
	usage := usageTail(rec.resBuf)

	entry := indexEntry{
		T:  rec.trace,
		U:  rec.token,
		D:  rec.start.Format(time.RFC3339Nano),
		P:  rec.path,
		M:  rec.model,
		S:  rec.status,
		ST: rec.isStream,
		MS: rec.ms,
		RQ: int64(len(rec.reqBuf)),
		RS: int64(len(rec.resBuf)),
		QZ: reqGz,
		RZ: resGz,
		TR: rec.trunc,
		E:  rec.errMsg,
		IP: rec.ip,
		K:  sessionKeyHash(rec.sessionKey),
	}
	if !rec.firstByte.IsZero() {
		entry.FT = rec.firstByte.Sub(rec.start).Milliseconds()
	}
	if !usage.empty() {
		entry.PT = usage.prompt
		entry.CT = usage.completion
		entry.CC = usage.cached
		entry.CW = usage.cacheWrite
	}
	s.appendIndex(rec.start, entry)
}

// flushBlob 把一个正文缓冲写到最终 blob：≥GZIP_THRESHOLD 走 gzip（内存 → gz.tmp
// 一次直达，结构上消灭旧 finish() 的"读 tmp + 压缩 + 删 tmp"三次 I/O），否则裸写。
// 返回（是否 gzip，是否成功）。gzip 失败降级为裸写——qz/rz 只在真正压缩时为 true，
// 与旧 compressIfNeeded 语义一致。
func (s *sink) flushBlob(base, ext string, buf []byte) (bool, bool) {
	finalPath := base + ext
	if s.cfg.GzipOver > 0 && int64(len(buf)) >= s.cfg.GzipOver {
		gzTmp := finalPath + ".gz.tmp"
		if err := writeGzipFile(gzTmp, buf); err == nil {
			if err := os.Rename(gzTmp, finalPath+".gz"); err == nil {
				os.Remove(finalPath + ".tmp") // O_EXCL 预留的裸 tmp 不再需要
				return true, true
			}
			os.Remove(gzTmp)
		} else {
			os.Remove(gzTmp)
		}
	}
	tmpPath := finalPath + ".tmp"
	if err := os.WriteFile(tmpPath, buf, 0o640); err != nil {
		return false, false
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return false, false
	}
	return false, true
}

func writeGzipFile(path string, buf []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	zw := gzip.NewWriter(f)
	if _, err := zw.Write(buf); err != nil {
		f.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func createExclusive(path string) (*os.File, bool) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, false
	}
	return f, true
}

// appendIndex 单次 write 追加整行：O_APPEND 下写 < PIPE_BUF 是原子的，
// 多 goroutine 并发写同一文件不会互相撕裂。只有 flush worker 调用。
func (s *sink) appendIndex(day time.Time, entry indexEntry) {
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')
	name := day.Format("2006-01-02")

	s.idxMu.Lock()
	defer s.idxMu.Unlock()
	f, ok := s.idxFiles[name]
	if !ok {
		path := filepath.Join(s.cfg.DashcamDir, "index", name+".ndjson")
		f, err = os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
		if err != nil {
			logEvent("warn", "index_open_failed", map[string]any{"date": name, "error": err.Error()})
			return
		}
		s.idxFiles[name] = f
	}
	if _, err := f.Write(line); err != nil {
		logEvent("warn", "index_write_failed", map[string]any{"date": name, "error": err.Error()})
	}
}

// extractSessionKey 按协议取会话标识；取不到就返回空串（看板按请求级展示）。
//
// 只认“会话级”字段：
// - OpenAI Responses / Chat Completions / Completions：prompt_cache_key
// - Claude Messages：metadata.user_id 内的 session_id（Claude Code 会自动带）
//
// 刻意不用 `user` / 纯 user_id：那是用户维度，会把同一用户的多个会话错误合并。
func extractSessionKey(path string, peek []byte) string {
	switch path {
	case "/v1/responses", "/v1/chat/completions", "/v1/completions":
		if m := promptCacheKeyPattern.FindSubmatch(peek); len(m) == 2 {
			return string(m[1])
		}
	case "/v1/messages":
		scope := peek
		if i := bytes.Index(peek, []byte(`"metadata"`)); i >= 0 {
			scope = peek[i:]
		}
		if m := claudeSessionPattern.FindSubmatch(scope); len(m) == 2 {
			return string(m[1])
		}
	}
	return ""
}

// sessionKeyHash 只留可比较的哈希：原始键可能含业务标识，且看板只需要稳定分组。
func sessionKeyHash(key string) string {
	if key == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:8])
}

func pickTrace(r *http.Request) string {
	for _, key := range []string{"X-Trace-Id", "X-Request-Id"} {
		if v := strings.TrimSpace(r.Header.Get(key)); tracePattern.MatchString(v) {
			return v
		}
	}
	return randomHex(16)
}

// tokenFingerprint 只留不可逆指纹：既不泄露密钥，也足以把请求归到同一调用方。
func tokenFingerprint(auth string) string {
	auth = strings.TrimSpace(auth)
	if auth == "" {
		return "_anon"
	}
	sum := sha256.Sum256([]byte(auth))
	return hex.EncodeToString(sum[:])[:12]
}

// sampled 按调用方指纹判定是否采集（D-P2）：sha256(指纹) % N < K。
// 无状态判定——同指纹恒定、重启不抖动；成本为一次哈希取模，纳秒级。
// N=0（关闭）恒为 true，等于未开启抽样时的全量记录行为。
// 指纹取哈希前 8 字节按大端序取模：截断不破坏均匀性，避免引入大数运算；
// 全程无符号——有符号转换会把高位哈希变负数，而 Go 的负数取模恒小于 K，会误抽中一半指纹。
func (c config) sampled(fp string) bool {
	if c.SampleModulus <= 0 {
		return true
	}
	sum := sha256.Sum256([]byte(fp))
	return binary.BigEndian.Uint64(sum[:8])%uint64(c.SampleModulus) < uint64(c.SampleKeep)
}

// samplingMeta 是 DASHCAM_DIR/meta.json 的内容：代理启动时写入当前抽样状态，
// 看板只读展示统一口径提示，避免看板/代理两处配置漂移。
type samplingMeta struct {
	SamplingEnabled bool  `json:"sampling_enabled"`
	SampleModulus   int64 `json:"sample_modulus"`
	SampleKeep      int64 `json:"sample_keep"`
}

// writeSamplingMeta 每次启动覆盖写；失败只记日志——文件缺失时看板视为未开启
// （兼容旧代理），不影响转发与采集。
func writeSamplingMeta(cfg config) error {
	meta := samplingMeta{
		SamplingEnabled: cfg.SampleModulus > 0,
		SampleModulus:   cfg.SampleModulus,
		SampleKeep:      cfg.SampleKeep,
	}
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	path := filepath.Join(cfg.DashcamDir, "meta.json")
	return os.WriteFile(path, append(data, '\n'), 0o640)
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return strings.ReplaceAll(time.Now().Format("150405.000000"), ".", "")
	}
	return hex.EncodeToString(buf)
}

func clientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
		return v
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

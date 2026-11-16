package main

import (
	"bytes"
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
	// H 客户端 harness 名（08-session-aggregation-design §7）：固定词表
	// dsh / codex / claude-code / opencode，未识别客户端缺省。
	// 只作识别标签，不参与聚合（k 口径不变）。
	H string `json:"h,omitempty"`
	// token 用量（pt=输入 / ct=输出 / cc=缓存命中输入 / cw=缓存写入），采集时从响应
	// 正文 best-effort 提取（见 usage.go）；解析失败或旧版采集缺省，看板显示 —。
	PT int64 `json:"pt,omitempty"`
	CT int64 `json:"ct,omitempty"`
	CC int64 `json:"cc,omitempty"`
	CW int64 `json:"cw,omitempty"`
	// 段式打包（D-P5）：seg/off/ln 定位 blobs/<date>/<fp>/<seg> 段内记录。
	// seg 缺失 = 旧的两文件布局（新旧并存，读取方按 seg 是否存在选路径）；
	// off=0（段内首条）被 omitempty 略去，读取方缺省视为 0。
	SEG string `json:"seg,omitempty"`
	OFF int64  `json:"off,omitempty"`
	LN  int64  `json:"ln,omitempty"`
}

const (
	truncRequest  = 1 << 0
	truncResponse = 1 << 1
	// truncClientAbort（D6）：客户端在响应流拷贝中途断开且响应不完整，记录为部分响应。
	// 与尺寸截断（1/2）区分："流提前结束"不丢已收数据，"尺寸截断"是缓冲被裁剪。
	truncClientAbort = 1 << 2
	// truncClientEOS：客户端断开时响应缓冲已含应用层流结束标记（如 [DONE]）——
	// 典型如客户端读完整个回复立即关连接（harness 模式），代理收尾帧写失败但记录完整。
	// 与 bit4 互斥：有结束标记 = 收尾断开（数据完整），无 = 真中断（数据缺失）。
	truncClientEOS = 1 << 3
)

var (
	// 与看板侧（src/server/dashcam/paths.ts TRACE_PATTERN）及 02-design §4.1 对齐：8–71。
	// 上限收窄到 64 会让 65–71 位的 X-Trace-Id 被静默替换为随机 id，trace 关联失效。
	tracePattern  = regexp.MustCompile(`^[A-Za-z0-9._-]{8,71}$`)
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

	queue chan *record
	// closed：停机标志。置位后 finish 一律走丢弃（dropped++），不再向队列发送——
	// 队列永不 close，从根本上消除"优雅停机超时后仍在途的 handler 向已关闭
	// channel 发送"的 panic（SSE 可长达 10 分钟，15s Shutdown 超时后必然出现）。
	closed atomic.Bool
	// done：worker 退出信号。置位（closed 之后）worker 先排空队列残余再退出。
	// stopOnce 保证 closeAndWait 幂等（测试 cleanup 与主流程会双重调用）。
	done     chan struct{}
	stopOnce sync.Once
	workers  sync.WaitGroup

	idxMu    sync.Mutex
	idxFiles map[string]*os.File

	// 段式打包（D-P5）：packs 是 (day/fp) → 当前打开段；packSeq 记录每键的下一个序号。
	// 只有 flush worker 触碰，packMu 互斥（见 pack.go）。
	packMu  sync.Mutex
	packs   map[string]*packSeg
	packSeq map[string]int

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
		done:     make(chan struct{}),
		idxFiles: make(map[string]*os.File),
		packs:    make(map[string]*packSeg),
		packSeq:  make(map[string]int),
		knownDir: make(map[string]struct{}),
	}
	for range cfg.FlushWorkers {
		s.workers.Add(1)
		go func() {
			defer s.workers.Done()
			for {
				select {
				case rec := <-s.queue:
					s.flush(rec)
				case <-s.done:
					// 已停机：非阻塞排空队列残余后退出
					for {
						select {
						case rec := <-s.queue:
							s.flush(rec)
						default:
							return
						}
					}
				}
			}
		}()
	}
	return s, nil
}

// closeAndWait 进入停机并等待 worker 排空：先置 closed（在途 finish 改走 dropped，
// 队列从此不再有新发送），再发 worker 退出信号并等待队列残余全部落盘。
// 幂等，可重复调用；排空后顺带关闭日索引句柄与段文件（干净停机释放 fd）。
func (s *sink) closeAndWait() {
	s.stopOnce.Do(func() {
		s.closed.Store(true)
		close(s.done)
	})
	s.workers.Wait()
	s.idxMu.Lock()
	for name, f := range s.idxFiles {
		f.Close()
		delete(s.idxFiles, name)
	}
	s.idxMu.Unlock()
	// 段文件随 worker 排空自然收尾；这里兜底关闭（幂等：packSeg.close 可重复调用）
	s.packMu.Lock()
	for key, seg := range s.packs {
		seg.close()
		delete(s.packs, key)
	}
	s.packMu.Unlock()
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
	aborted bool // 客户端在响应拷贝中途断开（D6）：finish 时置 truncClientAbort 位

	peek       []byte
	model      string
	isStream   bool
	headers    candidateHeaders // begin 拷贝的候选头快照（harness 识别与头键提取的输入）
	harness    string           // flush 识别出的客户端名（索引 h），未识别缺省
	sessionKey string
	firstByte  time.Time
	status     int
	errMsg     string
	// ms 在 finish 入队时刻定格：总耗时指转发耗时，不含队列等待。
	ms int64

	// finished 幂等保护（D6）：finish 现挂在 ServeHTTP 的 defer 里，panic 展开路径
	// 与未来任何第二调用点都不得造成双入队/索引重复行。只在请求 goroutine 触碰，无需原子。
	finished bool
}

// begin 只分配快照结构并拷贝候选头（纯内存，纳秒级）：目录创建、文件命名与
// trace 冲突处理全部搬到 flush。预算判定（三层降级第 1 层）在 handler 完成，
// 这里不再检查；harness 识别与提取只发生在 flush worker（peek 可用、worker
// 独占的既有纪律不变）。
func (s *sink) begin(r *http.Request, token string) *record {
	return &record{
		sink:    s,
		trace:   pickTrace(r),
		token:   token,
		path:    r.URL.Path,
		start:   time.Now(),
		ip:      clientIP(r),
		status:  http.StatusOK,
		headers: copyCandidateHeaders(r.Header),
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

// responseStreamComplete 判定响应缓冲是否已含应用层流结束标记（truncClientEOS 依据）。
// 三种流协议的终止事件：chat/completions 与 completions 以 "data: [DONE]" 收尾，
// messages 以 message_stop 事件收尾，responses 以 response.completed 事件收尾。
// 只在尾部 1KB 窗口扫描：终止标记必然临近流末尾，也避免大缓冲的全量扫描。
// 非流式响应不适用（无终止标记），此类断开维持 truncClientAbort 口径。
func (r *record) responseStreamComplete() bool {
	tail := r.resBuf
	if len(tail) > 1024 {
		tail = tail[len(tail)-1024:]
	}
	for _, marker := range [][]byte{
		[]byte("data: [DONE]"),
		[]byte("event: message_stop"),
		[]byte("response.completed"),
	} {
		if bytes.Contains(tail, marker) {
			return true
		}
	}
	return false
}

// finish 非阻塞入队后立即返回：转发路径到此为止，磁盘交给 worker。
// 队满（三层降级第 3 层）丢弃整条记录——无索引行、无 blob，dropped 累计。
// 幂等（D6）：重复调用直接返回，防止双入队/索引重复行。
func (r *record) finish(errMsg string) {
	if r.finished {
		return
	}
	r.finished = true
	r.errMsg = errMsg
	if r.aborted {
		if r.responseStreamComplete() {
			r.trunc |= truncClientEOS
		} else {
			r.trunc |= truncClientAbort
		}
	}
	r.ms = time.Since(r.start).Milliseconds()
	// 停机窗口（closed 已置位）：不再入队，按队满丢弃语义处理——
	// 此时队列可能正被 worker 排空，向其发送虽不 panic（队列不 close），
	// 但 stop 后台已不再保证落盘时序，统一计入 dropped
	if r.sink.closed.Load() {
		r.sink.counters.dropped.Add(1)
		r.release()
		return
	}
	select {
	case r.sink.queue <- r:
	default:
		r.sink.counters.dropped.Add(1)
		r.release()
	}
}

// flush 把一条记录持久化：ensureDir → 段式追加（D-P5，定长头 + req||res payload，
// gzip 阈值判定在 payload 层）→ 正则提取 → usage 提取 → 追加索引。
// 失败保留残段（无索引行，读取方不可见），failed++，不重试（磁盘持续故障时重试会
// 阻塞 worker）。不变式：索引行存在 ⇒ 整条记录已写完落盘。
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

	segName, off, ln, reqGz, resGz, ok := s.appendPack(rec, dir, day)
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
	// 会话键单点决策（08-design §4）：识别 harness → profile 候选序取键 →
	// 未识别走通用回退（body 提取，路径门控）。
	rec.harness, rec.sessionKey = resolveSessionKey(rec.headers, rec.path, rec.peek)

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
		TR: rec.trunc,
		E:  rec.errMsg,
		IP: rec.ip,
		K:  sessionKeyHash(rec.sessionKey),
		H:  rec.harness,
		// 段式打包（D-P5）：索引行带 seg/off/ln；qz/rz 由 packPayload 的独立判定给出
		QZ:  reqGz,
		RZ:  resGz,
		SEG: segName,
		OFF: off,
		LN:  ln,
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

// ------------------------------------------------------------------
// 会话聚合：客户端识别与策略化会话键提取（08-session-aggregation-design）
// ------------------------------------------------------------------

// 头值参与哈希前的截断上限（§6.2）：会话 ID 实际为 UUID/短 ID，
// 截断防异常超长头撑大索引。
const (
	headerValueLimit = 128
	userAgentLimit   = 256
)

// bodyKeyExtractor 从请求体提取会话键（复用现有 pattern）。
type bodyKeyExtractor func(peek []byte) string

// detectRule 是一条 harness 识别规则，非零字段即生效。
type detectRule struct {
	header    string                 // 头存在性 / 头值检测（规范名）
	headerHas string                 // 非空则要求头值以该前缀开头（如 Originator: codex*）
	userAgent string                 // 非空则要求 UA 以该前缀开头（规避版本号变化）
	bodyHas   func(peek []byte) bool // body 特征（peek），如 claude-code 的 metadata 签名
}

// keySource 是会话键的一个候选来源：头名非空优先，否则用 body 提取器。
type keySource struct {
	header string
	body   bodyKeyExtractor
}

// harnessProfile 是一个客户端工具的识别与提取策略（声明式表，
// 08-design §3 的证据表即此表的文档化）。
type harnessProfile struct {
	name        string       // 索引 h 字段值；固定词表：dsh / codex / claude-code / opencode
	detect      []detectRule // 有序识别规则：任一命中即认定
	sessionKeys []keySource  // 有序会话键候选：首个非空生效
}

// promptCacheKeyOf 提取 OpenAI 系协议的 prompt_cache_key。
func promptCacheKeyOf(peek []byte) string {
	if m := promptCacheKeyPattern.FindSubmatch(peek); len(m) == 2 {
		return string(m[1])
	}
	return ""
}

// metadataSessionIdOf 提取 Claude Messages 协议 metadata.user_id 内嵌的 session_id。
func metadataSessionIdOf(peek []byte) string {
	scope := peek
	if i := bytes.Index(peek, []byte(`"metadata"`)); i >= 0 {
		scope = peek[i:]
	}
	if m := claudeSessionPattern.FindSubmatch(scope); len(m) == 2 {
		return string(m[1])
	}
	return ""
}

// harnessProfiles 内置识别表（初版 4 条，顺序即识别优先级）。
//
// 明确排除的头（不进候选头集、不做检测）：X-Client-Request-Id、X-Opencode-Request
// （请求级，会拆散会话）；User、X-Opencode-Project、X-Deepseek-Harness-User-Id
// （用户/项目维度，会错误合并）。
var harnessProfiles = []harnessProfile{
	{
		name: "dsh",
		detect: []detectRule{
			{header: "X-Deepseek-Harness-Session-Id"},
			{userAgent: "deepseek-harness/"},
		},
		// pi-ai 栈默认不发任何会话标识（§3 识别与聚合解耦）：此时 h=dsh、k 缺省，
		// 不聚合但工具可见；渠道配置后两头/体并存，候选序首个非空生效。
		sessionKeys: []keySource{
			{header: "X-Deepseek-Harness-Session-Id"},
			{body: promptCacheKeyOf},
		},
	},
	{
		name: "codex",
		detect: []detectRule{
			{header: "Originator", headerHas: "codex"},
		},
		sessionKeys: []keySource{
			{header: "Session-Id"},
		},
	},
	{
		name: "claude-code",
		detect: []detectRule{
			{userAgent: "claude-cli/"},
			{header: "X-App", headerHas: "cli"},
			// metadata.user_id 内嵌 session_id 的签名（现有提取器即为其设计）
			{bodyHas: func(peek []byte) bool {
				i := bytes.Index(peek, []byte(`"metadata"`))
				return i >= 0 && metadataSessionIdOf(peek[i:]) != ""
			}},
		},
		sessionKeys: []keySource{
			{body: metadataSessionIdOf},
			{body: promptCacheKeyOf},
		},
	},
	{
		name: "opencode",
		detect: []detectRule{
			{header: "X-Opencode-Session"},
		},
		sessionKeys: []keySource{
			{header: "X-Opencode-Session"},
		},
	},
}

// candidateHeaders 是 begin 阶段拷贝的候选头快照：表内全部引用的头 + User-Agent
// （X-Session-Id 为 dsh pi-ai 栈 compat 开启后的预留承接，§6.5）。检测与提取
// 只读这份快照，不碰 http.Request。
type candidateHeaders struct {
	deepseekSession string // X-Deepseek-Harness-Session-Id
	xSessionId      string // X-Session-Id（预留）
	sessionId       string // Session-Id
	opencodeSession string // X-Opencode-Session
	originator      string // Originator
	xApp            string // X-App（claude-code 检测）
	userAgent       string // User-Agent（截 256B）
}

// get 按规范头名取拷贝值：detectRule.header / keySource.header 的唯一查表面，
// 与 copyCandidateHeaders 的字段一一对应，新增候选头时两处同步。
func (c candidateHeaders) get(name string) string {
	switch name {
	case "X-Deepseek-Harness-Session-Id":
		return c.deepseekSession
	case "X-Session-Id":
		return c.xSessionId
	case "Session-Id":
		return c.sessionId
	case "X-Opencode-Session":
		return c.opencodeSession
	case "Originator":
		return c.originator
	case "X-App":
		return c.xApp
	case "User-Agent":
		return c.userAgent
	}
	return ""
}

func truncateHeader(v string) string {
	if len(v) > headerValueLimit {
		return v[:headerValueLimit]
	}
	return v
}

func truncateUserAgent(v string) string {
	if len(v) > userAgentLimit {
		return v[:userAgentLimit]
	}
	return v
}

// copyCandidateHeaders 拷贝 harnessProfiles 声明的全部候选头（值截断见 §6.2）。
func copyCandidateHeaders(h http.Header) candidateHeaders {
	return candidateHeaders{
		deepseekSession: truncateHeader(h.Get("X-Deepseek-Harness-Session-Id")),
		xSessionId:      truncateHeader(h.Get("X-Session-Id")),
		sessionId:       truncateHeader(h.Get("Session-Id")),
		opencodeSession: truncateHeader(h.Get("X-Opencode-Session")),
		originator:      truncateHeader(h.Get("Originator")),
		xApp:            truncateHeader(h.Get("X-App")),
		userAgent:       truncateUserAgent(h.Get("User-Agent")),
	}
}

// ruleMatches 判定单条识别规则。
func ruleMatches(rule detectRule, h candidateHeaders, peek []byte) bool {
	if rule.header != "" {
		v := h.get(rule.header)
		if rule.headerHas != "" {
			return strings.HasPrefix(v, rule.headerHas)
		}
		return v != ""
	}
	if rule.userAgent != "" {
		return strings.HasPrefix(h.userAgent, rule.userAgent)
	}
	if rule.bodyHas != nil {
		return rule.bodyHas(peek)
	}
	return false
}

// detectHarness 按表序识别客户端：第一个 detect 命中的 profile（表内规则互斥，
// 表序仅定义确定性，§6.1）；未命中返回 nil。
func detectHarness(h candidateHeaders, peek []byte) *harnessProfile {
	for i := range harnessProfiles {
		p := &harnessProfiles[i]
		for _, rule := range p.detect {
			if ruleMatches(rule, h, peek) {
				return p
			}
		}
	}
	return nil
}

// sessionKeyOf 按 profile 候选序取首个非空值（§6.1）；全部候选为空返回空串。
func (p *harnessProfile) sessionKeyOf(h candidateHeaders, peek []byte) string {
	for _, src := range p.sessionKeys {
		if src.header != "" {
			if v := h.get(src.header); v != "" {
				return v
			}
			continue
		}
		if src.body != nil {
			if v := src.body(peek); v != "" {
				return v
			}
		}
	}
	return ""
}

// resolveSessionKey 是 flush 的单点决策（§4）：识别 → profile 候选序取键 →
// 未识别走通用回退（现有 body 提取，路径门控，行为与现状完全一致，h 缺省）。
// profile 命中但全部候选为空 → h 写入、k 缺省（行不聚合但工具可见）。
func resolveSessionKey(h candidateHeaders, path string, peek []byte) (harness, key string) {
	p := detectHarness(h, peek)
	if p == nil {
		return "", extractSessionKey(path, peek)
	}
	return p.name, p.sessionKeyOf(h, peek)
}

// extractSessionKey 按协议取会话标识；取不到就返回空串（看板按请求级展示）。
//
// 只认“会话级”字段：
// - OpenAI Responses / Chat Completions / Completions：prompt_cache_key
// - Claude Messages：metadata.user_id 内的 session_id（Claude Code 会自动带）
//
// 刻意不用 `user` / 纯 user_id：那是用户维度，会把同一用户的多个会话错误合并。
// 也是未识别客户端的通用回退入口（08-design §6.3），语义与体提取时代一致。
func extractSessionKey(path string, peek []byte) string {
	switch path {
	case "/v1/responses", "/v1/chat/completions", "/v1/completions":
		return promptCacheKeyOf(peek)
	case "/v1/messages":
		return metadataSessionIdOf(peek)
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

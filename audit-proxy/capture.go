package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
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

type sink struct {
	cfg config

	idxMu    sync.Mutex
	idxFiles map[string]*os.File

	dirMu    sync.Mutex
	knownDir map[string]struct{}
}

func newSink(cfg config) (*sink, error) {
	for _, sub := range []string{"blobs", "index"} {
		if err := os.MkdirAll(filepath.Join(cfg.AuditDir, sub), 0o750); err != nil {
			return nil, err
		}
	}
	return &sink{cfg: cfg, idxFiles: make(map[string]*os.File), knownDir: make(map[string]struct{})}, nil
}

// record 是一次请求的落盘句柄。写入失败只降级采集，绝不影响转发。
type record struct {
	sink  *sink
	trace string
	token string
	path  string
	start time.Time
	ip    string

	reqPath string
	resPath string
	reqFile *os.File
	resFile *os.File
	reqBuf  *bufio.Writer
	resBuf  *bufio.Writer

	reqN   int64
	resN   int64
	trunc  int
	failed bool

	peek       []byte
	model      string
	isStream   bool
	sessionKey string
	firstByte  time.Time
	status     int
	errMsg     string
}

func (s *sink) begin(r *http.Request) *record {
	now := time.Now()
	trace := pickTrace(r)
	token := tokenFingerprint(r.Header.Get("Authorization"))
	dir := filepath.Join(s.cfg.AuditDir, "blobs", now.Format("2006-01-02"), token)
	if err := s.ensureDir(dir); err != nil {
		logEvent("warn", "capture_dir_failed", map[string]any{"trace": trace, "error": err.Error()})
		return nil
	}

	var reqFile, resFile *os.File
	var base string
	// trace 可能被客户端复用（同一个 X-Request-Id 重试）：冲突时换后缀，保证
	// 文件名与最终路径始终一致——否则 rename 会落到另一个名字上。
	for attempt := 0; attempt < 3 && reqFile == nil; attempt++ {
		candidate := trace
		if attempt > 0 {
			candidate = trace + "-" + randomHex(3)
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
		base, reqFile, resFile, trace = candidateBase, rf, sf, candidate
	}
	if reqFile == nil {
		return nil
	}

	rec := &record{
		sink:    s,
		trace:   trace,
		token:   token,
		path:    r.URL.Path,
		start:   now,
		ip:      clientIP(r),
		status:  http.StatusOK,
		reqPath: base + ".req",
		resPath: base + ".res",
		reqFile: reqFile,
		resFile: resFile,
	}
	rec.reqBuf = bufio.NewWriterSize(rec.reqFile, s.cfg.WriteBuffer)
	rec.resBuf = bufio.NewWriterSize(rec.resFile, s.cfg.WriteBuffer)
	return rec
}

func createExclusive(path string) (*os.File, bool) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, false
	}
	return f, true
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
	if r.failed {
		return
	}
	if len(r.peek) < peekLimit {
		need := peekLimit - len(r.peek)
		if need > len(p) {
			need = len(p)
		}
		r.peek = append(r.peek, p[:need]...)
	}
	if r.reqN >= r.sink.cfg.MaxRequest {
		r.trunc |= truncRequest
		return
	}
	remain := r.sink.cfg.MaxRequest - r.reqN
	chunk := p
	if int64(len(chunk)) > remain {
		chunk = chunk[:remain]
		r.trunc |= truncRequest
	}
	n, err := r.reqBuf.Write(chunk)
	r.reqN += int64(n)
	if err != nil {
		r.failed = true
	}
}

func (r *record) writeResponse(p []byte) {
	if r.failed {
		return
	}
	if r.firstByte.IsZero() {
		r.firstByte = time.Now()
	}
	if r.resN >= r.sink.cfg.MaxResponse {
		r.trunc |= truncResponse
		return
	}
	remain := r.sink.cfg.MaxResponse - r.resN
	chunk := p
	if int64(len(chunk)) > remain {
		chunk = chunk[:remain]
		r.trunc |= truncResponse
	}
	n, err := r.resBuf.Write(chunk)
	r.resN += int64(n)
	if err != nil {
		r.failed = true
	}
}

func (r *record) setStatus(code int) { r.status = code }

func (r *record) finish(errMsg string) {
	defer func() {
		if r.reqFile != nil {
			r.reqFile.Close()
		}
		if r.resFile != nil {
			r.resFile.Close()
		}
	}()

	r.errMsg = errMsg
	if r.reqBuf != nil {
		if err := r.reqBuf.Flush(); err != nil {
			r.failed = true
		}
	}
	if r.resBuf != nil {
		if err := r.resBuf.Flush(); err != nil {
			r.failed = true
		}
	}
	r.reqFile.Close()
	r.resFile.Close()

	// 任何一步失败都保留原文件（.tmp 后缀），由清理脚本回收，不阻断主链路。
	if r.failed {
		logEvent("warn", "capture_write_failed", map[string]any{"trace": r.trace})
		return
	}

	reqGz := r.sink.compressIfNeeded(r.reqPath+".tmp", r.reqPath, r.reqN)
	resGz := r.sink.compressIfNeeded(r.resPath+".tmp", r.resPath, r.resN)

	if m := modelPattern.FindSubmatch(r.peek); len(m) == 2 {
		r.model = string(m[1])
	}
	r.isStream = streamPattern.Match(r.peek)
	r.sessionKey = extractSessionKey(r.path, r.peek)

	entry := indexEntry{
		T:  r.trace,
		U:  r.token,
		D:  r.start.Format(time.RFC3339Nano),
		P:  r.path,
		M:  r.model,
		S:  r.status,
		ST: r.isStream,
		MS: time.Since(r.start).Milliseconds(),
		RQ: r.reqN,
		RS: r.resN,
		QZ: reqGz,
		RZ: resGz,
		TR: r.trunc,
		E:  r.errMsg,
		IP: r.ip,
		K:  sessionKeyHash(r.sessionKey),
	}
	if !r.firstByte.IsZero() {
		entry.FT = r.firstByte.Sub(r.start).Milliseconds()
	}
	r.sink.appendIndex(r.start, entry)
}

// compressIfNeeded 返回是否压缩成功。源文件用流式 Copy，内存不随体积增长。
func (s *sink) compressIfNeeded(tmpPath, finalPath string, size int64) bool {
	if s.cfg.GzipOver <= 0 || size < s.cfg.GzipOver {
		if err := os.Rename(tmpPath, finalPath); err != nil {
			logEvent("warn", "capture_rename_failed", map[string]any{"path": finalPath, "error": err.Error()})
			return false
		}
		return false
	}

	src, err := os.Open(tmpPath)
	if err != nil {
		return false
	}
	defer src.Close()

	dstPath := finalPath + ".gz.tmp"
	dst, err := os.Create(dstPath)
	if err != nil {
		os.Rename(tmpPath, finalPath)
		return false
	}
	zw := gzip.NewWriter(dst)
	if _, err := io.Copy(zw, src); err != nil {
		zw.Close()
		dst.Close()
		os.Remove(dstPath)
		os.Rename(tmpPath, finalPath)
		return false
	}
	if err := zw.Close(); err != nil {
		zw.Close()
		dst.Close()
		os.Remove(dstPath)
		os.Rename(tmpPath, finalPath)
		return false
	}
	if err := dst.Close(); err != nil {
		os.Remove(dstPath)
		os.Rename(tmpPath, finalPath)
		return false
	}
	src.Close()
	if err := os.Rename(dstPath, finalPath+".gz"); err != nil {
		os.Remove(dstPath)
		os.Rename(tmpPath, finalPath)
		return false
	}
	os.Remove(tmpPath)
	return true
}

// appendIndex 单次 write 追加整行：O_APPEND 下写 < PIPE_BUF 是原子的，
// 多 goroutine 并发写同一文件不会互相撕裂。
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
		path := filepath.Join(s.cfg.AuditDir, "index", name+".ndjson")
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

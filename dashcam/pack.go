package main

// 段式打包（D-P5 方案 A）：blobs/<date>/<fp>/seg-<HH>-<seq>.pack，多条记录顺序追加，
// 文件数从 2N/天降到每天几十个段，去掉 tmp 文件与 rename。
//
// 记录格式（定长二进制头 + payload）：
//
//	[magic 4B "DCPK"][reqLen 4B LE][resLen 4B LE][flags 2B LE][req payload][res payload]
//	flags: bit0=req gzip(qz)  bit1=res gzip(rz)  bit2=req 截断  bit3=res 截断
//
// reqLen/resLen 是 payload 落盘字节数（gzip 后），整条字节数 = 14 + reqLen + resLen——
// 段尾崩溃半条靠长度头即可跳过；索引行只在整条写完后追加，读取方永远看不到半条。
// 压缩：req/res 各自独立判定（阈值沿用 GZIP_THRESHOLD，qz/rz 只在真正压缩时为 true），
// 段文件本身不压缩。索引增加 seg/off/ln（off 指向记录头起点，ln = 整条字节数）；
// 无 seg 的旧行走旧的两文件路径，新旧并存过渡。

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

const (
	packMagic     = "DCPK"
	packHeaderLen = 4 + 4 + 4 + 2 // magic + reqLen + resLen + flags

	packFlagReqGz    = 1 << 0
	packFlagResGz    = 1 << 1
	packFlagReqTrunc = 1 << 2
	packFlagResTrunc = 1 << 3
)

// packRollBytes 段滚动阈值（达 32 MB 或跨小时换新段）。var 仅为测试可调小。
var packRollBytes = int64(32 << 20)

var (
	packSegNamePattern = regexp.MustCompile(`^seg-\d{2}-\d{2,}\.pack$`)
	packSegSeqPattern  = regexp.MustCompile(`^seg-\d{2}-(\d+)\.pack$`)
)

// packSeg 是一个打开中的段文件；size 是当前字节数（含头），追加按它计算偏移。
type packSeg struct {
	file *os.File
	name string
	hour string
	day  string
	size int64
}

func (s *packSeg) close() {
	if s.file != nil {
		s.file.Close()
		s.file = nil
	}
}

// appendPack 把一条记录追加进 (day, fp) 的当前段，返回（段名，记录头偏移，整条字节数，
// req/res 是否 gzip）。只有 flush worker 调用；packMu 在多 worker 间互斥——per-fp 段锁
// 在"只有 worker 写"前提下退化为这把进程内互斥（06-performance-plan §13）。
func (s *sink) appendPack(rec *record, dir, day string) (string, int64, int64, bool, bool, bool) {
	reqPayload, reqGz := packPayload(rec.reqBuf, s.cfg.GzipOver)
	resPayload, resGz := packPayload(rec.resBuf, s.cfg.GzipOver)

	var flags uint16
	if reqGz {
		flags |= packFlagReqGz
	}
	if resGz {
		flags |= packFlagResGz
	}
	if rec.trunc&truncRequest != 0 {
		flags |= packFlagReqTrunc
	}
	if rec.trunc&truncResponse != 0 {
		flags |= packFlagResTrunc
	}

	header := make([]byte, 0, packHeaderLen)
	header = append(header, packMagic...)
	header = binary.LittleEndian.AppendUint32(header, uint32(len(reqPayload)))
	header = binary.LittleEndian.AppendUint32(header, uint32(len(resPayload)))
	header = binary.LittleEndian.AppendUint16(header, flags)

	s.packMu.Lock()
	defer s.packMu.Unlock()

	seg, err := s.currentSegLocked(dir, day, rec.token, rec.start,
		int64(packHeaderLen)+int64(len(reqPayload))+int64(len(resPayload)))
	if err != nil {
		logEvent("warn", "pack_open_failed", map[string]any{"fp": rec.token, "error": err.Error()})
		return "", 0, 0, false, false, false
	}

	off := seg.size
	total := int64(0)
	for _, part := range [][]byte{header, reqPayload, resPayload} {
		n, err := seg.file.Write(part)
		total += int64(n)
		if err != nil || n != len(part) {
			// 写失败（含磁盘满的半条）：段尾可能残留部分字节——无索引行，读取方不可见。
			// 本段作废换新段，不向损坏的尾部继续追加；failed++ 由调用方处理，不重试。
			seg.close()
			delete(s.packs, day+"/"+rec.token)
			return "", 0, 0, false, false, false
		}
	}
	seg.size += total
	return seg.name, off, total, reqGz, resGz, true
}

// currentSegLocked 返回 (day, fp) 的当前段；达 32 MB 或跨小时滚动。
// 进程重启后从新段开始（不向崩溃残留的段尾追加），seq 取目录现有段的最大序号 +1。
func (s *sink) currentSegLocked(dir, day, fp string, start time.Time, incoming int64) (*packSeg, error) {
	key := day + "/" + fp
	hour := start.Format("15")

	seg := s.packs[key]
	if seg != nil && (seg.hour != hour || seg.size+incoming > packRollBytes) {
		seg.close()
		delete(s.packs, key)
		seg = nil
	}
	// 换天回收旧日的段句柄（迟到的旧日记录会重新开段，正确性不受影响）
	for k, old := range s.packs {
		if old.day != day {
			old.close()
			delete(s.packs, k)
		}
	}

	if seg == nil {
		seq, seen := s.packSeq[key]
		if !seen {
			seq = scanMaxSegSeq(dir)
		}
		var f *os.File
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			name := fmt.Sprintf("seg-%s-%02d.pack", hour, seq)
			f, err = os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
			if err == nil {
				// 存"下一个可用序号"：hour 滚动 / 阈值滚动 / 重启扫描都全局递增，段名永不重合
				s.packSeq[key] = seq + 1
				seg = &packSeg{file: f, name: name, hour: hour, day: day}
				s.packs[key] = seg
				break
			}
			seq++
		}
		if seg == nil {
			return nil, err
		}
	}
	return seg, nil
}

// scanMaxSegSeq 扫描目录里现有段的最大序号（进程重启后接续编号，不与旧段重名）。
func scanMaxSegSeq(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	max := 0
	for _, entry := range entries {
		m := packSegSeqPattern.FindStringSubmatch(entry.Name())
		if m == nil {
			continue
		}
		if v, err := strconv.Atoi(m[1]); err == nil && v > max {
			max = v
		}
	}
	return max
}

// packPayload 生成单侧 payload：≥ 阈值时内存 gzip（每条独立判定，与逐文件语义同构）。
// gzip 失败降级为原样写入——qz/rz 只在真正压缩时为 true，与旧 compressIfNeeded 一致。
func packPayload(buf []byte, threshold int64) ([]byte, bool) {
	if threshold <= 0 || int64(len(buf)) < threshold {
		return buf, false
	}
	// 单条记录级瞬态拷贝，worker 逐条处理，内存上界与单条记录同阶
	var out bytes.Buffer
	out.Grow(len(buf) / 4)
	zw := gzip.NewWriter(&out)
	if _, err := zw.Write(buf); err != nil {
		zw.Close()
		return buf, false
	}
	if err := zw.Close(); err != nil {
		return buf, false
	}
	return out.Bytes(), true
}

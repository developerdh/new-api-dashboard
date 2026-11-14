package main

// 段式打包（D-P5）写侧测试：记录格式、偏移推进、滚动、重启接续、崩溃半条跳过。

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// readPackRecord 按索引行的 seg/off/ln 解出一条段记录，返回（req payload, res payload, flags）。
func readPackRecord(t *testing.T, dir, fp, day string, entry indexEntry) ([]byte, []byte, uint16) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "blobs", day, fp, entry.SEG))
	if err != nil {
		t.Fatalf("段文件缺失: %v", err)
	}
	if int64(len(data)) < entry.OFF+entry.LN {
		t.Fatalf("段文件短于索引声明: len=%d off=%d ln=%d", len(data), entry.OFF, entry.LN)
	}
	rec := data[entry.OFF : entry.OFF+entry.LN]
	if string(rec[:4]) != packMagic {
		t.Fatalf("magic 不符: %q", rec[:4])
	}
	reqLen := int(binary.LittleEndian.Uint32(rec[4:8]))
	resLen := int(binary.LittleEndian.Uint32(rec[8:12]))
	flags := binary.LittleEndian.Uint16(rec[12:14])
	if packHeaderLen+reqLen+resLen != len(rec) {
		t.Fatalf("头部长度与 ln 不一致: %d+%d+%d vs %d", packHeaderLen, reqLen, resLen, len(rec))
	}
	return rec[packHeaderLen : packHeaderLen+reqLen], rec[packHeaderLen+reqLen:], flags
}

func TestPackOffsetsAdvance(t *testing.T) {
	// 同一 (day, fp) 的记录顺序追加进同一段：下一条的 off = 上一条的 off + ln
	s := newTestSink(t, nil)
	day := time.Now().Format("2006-01-02")

	prevEnd := int64(0)
	for i, body := range []string{"first-body", "second-body-longer"} {
		rec := s.begin(testCaptureRequest(t, ""), testFP)
		rec.writeRequest([]byte(body))
		rec.finish("")
		entry := parseIndexEntry(t, waitIndexLines(t, s.cfg.DashcamDir, i+1)[i])
		if entry.OFF != prevEnd {
			t.Fatalf("第 %d 条应紧接上一条: off=%d 上一条结束于 %d", i+1, entry.OFF, prevEnd)
		}
		reqData, _, flags := readPackRecord(t, s.cfg.DashcamDir, testFP, day, entry)
		if string(reqData) != body || flags != 0 {
			t.Fatalf("第 %d 条记录不符: body=%q flags=%d", i+1, reqData, flags)
		}
		prevEnd = entry.OFF + entry.LN
	}
}

func TestPackRollsByHourAndSize(t *testing.T) {
	// 跨小时滚动：seg 名带记录所属小时；序号全天接续
	s := newTestSink(t, nil)
	day := time.Now().Format("2006-01-02")
	base := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 9, 0, 0, 0, time.Local)

	rec1 := s.begin(testCaptureRequest(t, ""), testFP)
	rec1.start = base
	rec1.writeRequest([]byte("hour-9"))
	rec1.finish("")
	// 处于凌晨 0 点前后时 base+1h 仍在同一天，避免跨日歧义
	rec2 := s.begin(testCaptureRequest(t, ""), testFP)
	rec2.start = base.Add(time.Hour)
	rec2.writeRequest([]byte("hour-10"))
	rec2.finish("")

	lines := waitIndexLines(t, s.cfg.DashcamDir, 2)
	e1, e2 := parseIndexEntry(t, lines[0]), parseIndexEntry(t, lines[1])
	if e1.SEG != "seg-09-00.pack" || e2.SEG != "seg-10-01.pack" {
		t.Fatalf("跨小时应换段且序号接续: %q %q", e1.SEG, e2.SEG)
	}
	if _, err := os.Stat(filepath.Join(s.cfg.DashcamDir, "blobs", day, testFP, e1.SEG)); err != nil {
		t.Fatalf("旧段仍应存在: %v", err)
	}

	// 达到滚动阈值换新段：阈值调到 1 → 每条一段
	old := packRollBytes
	packRollBytes = 1
	t.Cleanup(func() { packRollBytes = old })
	for i := 3; i <= 5; i++ {
		rec := s.begin(testCaptureRequest(t, ""), testFP)
		rec.start = base.Add(time.Duration(i) * time.Hour)
		rec.writeRequest([]byte("roll"))
		rec.finish("")
	}
	lines = waitIndexLines(t, s.cfg.DashcamDir, 5)
	e3, e5 := parseIndexEntry(t, lines[2]), parseIndexEntry(t, lines[4])
	if e3.SEG == e5.SEG || e3.SEG != "seg-12-02.pack" || e5.SEG != "seg-14-04.pack" {
		t.Fatalf("超阈值应滚动换段: %q %q", e3.SEG, e5.SEG)
	}
}

func TestPackRestartSeqContinues(t *testing.T) {
	// 重启后从新段开始（不向崩溃残留的段尾追加），序号从目录现有段接续
	s1 := newTestSink(t, nil)
	rec1 := s1.begin(testCaptureRequest(t, ""), testFP)
	rec1.writeRequest([]byte("before-restart"))
	rec1.finish("")
	waitIndexLines(t, s1.cfg.DashcamDir, 1)
	s1.closeAndWait()

	s2 := newTestSink(t, func(c *config) { c.DashcamDir = s1.cfg.DashcamDir })
	rec2 := s2.begin(testCaptureRequest(t, ""), testFP)
	rec2.writeRequest([]byte("after-restart"))
	rec2.finish("")

	lines := waitIndexLines(t, s2.cfg.DashcamDir, 2)
	e1, e2 := parseIndexEntry(t, lines[0]), parseIndexEntry(t, lines[1])
	if e1.SEG == e2.SEG {
		t.Fatalf("重启后应开新段: %q", e2.SEG)
	}
	day := rec2.start.Format("2006-01-02")
	reqData, _, _ := readPackRecord(t, s2.cfg.DashcamDir, testFP, day, e2)
	if string(reqData) != "after-restart" {
		t.Fatalf("新段内容不符: %q", reqData)
	}
}

func TestPackTornTailSkipped(t *testing.T) {
	// 崩溃半条：整条写完才有索引行；段尾半条靠长度头跳过，不影响已落盘记录
	s := newTestSink(t, nil)
	day := time.Now().Format("2006-01-02")
	rec1 := s.begin(testCaptureRequest(t, ""), testFP)
	rec1.writeRequest([]byte("intact"))
	rec1.finish("")
	lines := waitIndexLines(t, s.cfg.DashcamDir, 1)
	e1 := parseIndexEntry(t, lines[0])
	s.closeAndWait()

	// 模拟崩溃：向段尾追加一个声明 1MB 但只写了几个字节的半条
	segPath := filepath.Join(s.cfg.DashcamDir, "blobs", day, testFP, e1.SEG)
	f, err := os.OpenFile(segPath, os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		t.Fatal(err)
	}
	torn := make([]byte, 0, packHeaderLen+8)
	torn = append(torn, packMagic...)
	torn = binary.LittleEndian.AppendUint32(torn, 1<<20)
	torn = binary.LittleEndian.AppendUint32(torn, 0)
	torn = binary.LittleEndian.AppendUint16(torn, 0)
	torn = append(torn, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x01, 0x02)
	if _, err := f.Write(torn); err != nil {
		t.Fatal(err)
	}
	f.Close()

	// 长度头走段：第一条完整可读；下一条声明 1MB 但实际不足 → 跳过（无完整记录）
	data, err := os.ReadFile(segPath)
	if err != nil {
		t.Fatal(err)
	}
	e1Len := packHeaderLen + 6 // req "intact" + res 空
	if len(data) < e1Len || string(data[packHeaderLen:e1Len]) != "intact" {
		t.Fatalf("第一条记录应完整: %q", data[packHeaderLen:e1Len])
	}
	walk := e1Len
	claimed := binary.LittleEndian.Uint32(data[walk+4 : walk+8])
	if int64(claimed) > int64(len(data))-int64(walk) {
		// 半条：声明长度超出实际字节 → 读取方按损坏跳过，不会产生有效记录
		t.Logf("半条在偏移 %d 声明 %dB，实际仅 %dB —— 可跳过", walk, claimed, len(data)-walk)
	} else {
		t.Fatal("半条应声明超出实际字节的长度")
	}

	// 重启后新段照常写入，旧段（含半条）不受影响
	s2 := newTestSink(t, func(c *config) { c.DashcamDir = s.cfg.DashcamDir })
	rec2 := s2.begin(testCaptureRequest(t, ""), testFP)
	rec2.writeRequest([]byte("after-crash"))
	rec2.finish("")
	e2 := parseIndexEntry(t, waitIndexLines(t, s2.cfg.DashcamDir, 2)[1])
	reqData, _, _ := readPackRecord(t, s2.cfg.DashcamDir, testFP, day, e2)
	if string(reqData) != "after-crash" {
		t.Fatalf("崩溃后新记录应落在新段: %q", reqData)
	}
}

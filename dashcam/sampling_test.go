package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSampledDisabled(t *testing.T) {
	// N=0 = 关闭抽样 = 全量记录：任何指纹都必须命中（与现状行为完全一致）
	cfg := config{SampleModulus: 0, SampleKeep: 1}
	for _, fp := range []string{"6981744f7254", "dbbbf1891a47", "_anon", ""} {
		if !cfg.sampled(fp) {
			t.Fatalf("N=0 时指纹 %q 必须全量采集", fp)
		}
	}
}

func TestSampledDeterministic(t *testing.T) {
	cfg := config{SampleModulus: 10, SampleKeep: 3}
	first := cfg.sampled("6981744f7254")
	for i := 0; i < 100; i++ {
		if cfg.sampled("6981744f7254") != first {
			t.Fatal("同一指纹的判定必须稳定（无状态、重启不抖动）")
		}
	}
}

func TestSampledBoundaries(t *testing.T) {
	// N=1：取模恒为 0 < K=1，全采
	all := config{SampleModulus: 1, SampleKeep: 1}
	// K=N：同样全采
	full := config{SampleModulus: 97, SampleKeep: 97}
	// K=1/N=4096：绝大多数指纹不命中
	sparse := config{SampleModulus: 4096, SampleKeep: 1}
	fps := []string{"6981744f7254", "dbbbf1891a47", "_anon", "0123456789ab", "ffffffffffff"}
	for _, fp := range fps {
		if !all.sampled(fp) || !full.sampled(fp) {
			t.Fatalf("N=1 或 K=N 时指纹 %q 必须全采", fp)
		}
	}

	kept := 0
	for _, fp := range fps {
		if sparse.sampled(fp) {
			kept++
		}
	}
	if kept == len(fps) {
		t.Fatal("K=1/N=4096 不应命中所有指纹")
	}
	if kept == 0 {
		t.Skip("样本恰好全部未命中，不影响结论")
	}
}

func TestSampledUniformity(t *testing.T) {
	// 大样本粗校验命中率接近 K/N（fp 为 12 位 hex，覆盖真实取值空间）
	cfg := config{SampleModulus: 100, SampleKeep: 10}
	total, kept := 0, 0
	for i := 0; i < 20000; i++ {
		fp := randomHex(6)
		total++
		if cfg.sampled(fp) {
			kept++
		}
	}
	ratio := float64(kept) / float64(total)
	if ratio < 0.08 || ratio > 0.12 {
		t.Fatalf("命中率 %.3f 偏离 K/N=0.10 过多（kept=%d/%d）", ratio, kept, total)
	}
}

func TestConfigSamplingValidation(t *testing.T) {
	cases := []struct {
		name    string
		modulus string
		keep    string
		wantErr bool
	}{
		{name: "默认关闭", modulus: "", keep: "", wantErr: false},
		{name: "关闭时忽略 K", modulus: "0", keep: "5", wantErr: false},
		{name: "合法组合", modulus: "10", keep: "3", wantErr: false},
		{name: "K=N", modulus: "10", keep: "10", wantErr: false},
		{name: "K=0", modulus: "10", keep: "0", wantErr: true},
		{name: "K>N", modulus: "10", keep: "11", wantErr: true},
		{name: "N 为负", modulus: "-1", keep: "1", wantErr: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("DASHCAM_DIR", t.TempDir())
			t.Setenv("SAMPLE_MODULUS", c.modulus)
			t.Setenv("SAMPLE_KEEP", c.keep)
			_, err := loadConfig()
			if c.wantErr != (err != nil) {
				t.Fatalf("loadConfig() error = %v, wantErr %v", err, c.wantErr)
			}
		})
	}
}

func TestWriteSamplingMeta(t *testing.T) {
	dir := t.TempDir()
	cfg := config{DashcamDir: dir, SampleModulus: 10, SampleKeep: 3}
	if err := writeSamplingMeta(cfg); err != nil {
		t.Fatalf("writeSamplingMeta: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatalf("meta.json 缺失: %v", err)
	}
	var meta struct {
		SamplingEnabled bool  `json:"sampling_enabled"`
		SampleModulus   int64 `json:"sample_modulus"`
		SampleKeep      int64 `json:"sample_keep"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatalf("meta.json 不是合法 JSON: %v", err)
	}
	if !meta.SamplingEnabled || meta.SampleModulus != 10 || meta.SampleKeep != 3 {
		t.Fatalf("meta.json 内容不符: %+v", meta)
	}

	// 默认配置（关闭，K 默认 1）：enabled=false。生产路径经 loadConfig 填默认值，这里按同值构造
	cfg2 := config{DashcamDir: dir, SampleKeep: 1}
	if err := writeSamplingMeta(cfg2); err != nil {
		t.Fatalf("writeSamplingMeta: %v", err)
	}
	raw, _ = os.ReadFile(filepath.Join(dir, "meta.json"))
	if string(raw) != "{\"sampling_enabled\":false,\"sample_modulus\":0,\"sample_keep\":1}\n" {
		t.Fatalf("关闭态 meta.json 内容不符: %q", string(raw))
	}
}

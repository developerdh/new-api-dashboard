package main

// token 提取的契约测试：testdata/usage/ 里的样例与看板侧 TS 测试共用，
// 两侧对同一段正文必须给出相同结果（pt/ct/cc/cw）——谁改了行为谁红。

import (
	"os"
	"path/filepath"
	"testing"
)

func mustSample(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "usage", name))
	if err != nil {
		t.Fatalf("read sample %s: %v", name, err)
	}
	return data
}

// contractCase 是与 TS 侧 usage.test.ts 的「契约样例」表格保持一致的用例。
type contractCase struct {
	name string
	file string
	want tokenUsage
}

func contractCases() []contractCase {
	return []contractCase{
		{"chat json + cached", "chat.json", tokenUsage{prompt: 1200, completion: 48, cached: 900}},
		{"chat sse last usage wins", "chat-stream.sse", tokenUsage{prompt: 800, completion: 40}},
		{"anthropic json cache read/write", "anthropic.json", tokenUsage{prompt: 500, completion: 30, cached: 400, cacheWrite: 60}},
		{"anthropic sse merges start/delta", "anthropic-stream.sse", tokenUsage{prompt: 500, completion: 30, cached: 400, cacheWrite: 60}},
		{"responses json", "responses.json", tokenUsage{prompt: 300, completion: 20, cached: 250}},
		{"responses sse nested usage", "responses-stream.sse", tokenUsage{prompt: 300, completion: 20, cached: 250}},
	}
}

func TestExtractUsageContract(t *testing.T) {
	for _, tc := range contractCases() {
		t.Run(tc.name, func(t *testing.T) {
			got := extractUsage(mustSample(t, tc.file))
			if got != tc.want {
				t.Fatalf("usage mismatch: got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestExtractUsageEdgeCases(t *testing.T) {
	cases := []struct {
		name string
		text string
		want tokenUsage
	}{
		{
			name: "字符串值里的 usage（JSON 转义）不命中",
			text: `{"choices":[{"message":{"content":"请输出 {\"usage\":{\"prompt_tokens\":999}}"}}],"usage":{"prompt_tokens":100,"completion_tokens":5}}`,
			want: tokenUsage{prompt: 100, completion: 5},
		},
		{
			name: "usage 为数字值（形态不符）跳过",
			text: `{"usage":123,"choices":[{"message":{"content":"x"}}]}`,
			want: tokenUsage{},
		},
		{
			name: "无 usage",
			text: `{"choices":[{"message":{"content":"no usage here"}}]}`,
			want: tokenUsage{},
		},
		{
			name: "坏 JSON 对象静默跳过",
			text: `{"usage":{prompt_tokens:oops},"usage":{"prompt_tokens":42}}`,
			want: tokenUsage{prompt: 42},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractUsage([]byte(tc.text))
			if got != tc.want {
				t.Fatalf("usage mismatch: got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestUsageTail(t *testing.T) {
	// D-P3：usage 数据源从磁盘 .tmp 尾部换成内存缓冲尾部，窗口口径不变。
	full := []byte(`{"usage":{"prompt_tokens":7,"completion_tokens":3}}`)
	if got := usageTail(full); got != (tokenUsage{prompt: 7, completion: 3}) {
		t.Fatalf("small buffer: got %+v", got)
	}

	// 尾部窗口之外的 usage 会缺失（超长响应的刻意取舍）
	long := append([]byte(`{"usage":{"prompt_tokens":1}},`), make([]byte, usageScanWindow)...)
	long = append(long, full...)
	if got := usageTail(long); got != (tokenUsage{prompt: 7, completion: 3}) {
		t.Fatalf("windowed buffer: got %+v", got)
	}

	// 空缓冲：空 usage（预算停缓冲的记录没有响应体，索引省略字段）
	if got := usageTail(nil); !got.empty() {
		t.Fatalf("empty buffer should give empty usage, got %+v", got)
	}
}

package main

// 响应正文 token 用量提取（best-effort）：索引的 pt/ct/cc/cw 在采集落盘时生成，
// 看板的列表 / 线程 / 会话累计因此零读成本。任何失败都静默省略字段，绝不影响采集主链路。
//
// 口径与看板侧 src/server/audit/normalize.ts 的 usage 解析一致；样例契约放在
// testdata/usage/，Go（usage_test.go）与 TS（src/server/audit/__tests__/usage.test.ts）
// 共用同一份样例文件——两侧任一行为变更，测试就会红。

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
)

// usageScanWindow 只扫响应尾部：usage 出现在 JSON 末尾对象或 SSE 末尾的块里。
// 8MB 覆盖绝大多数响应；超长响应里更早出现的 usage（如 Anthropic message_start
// 的 input 字段）会缺失 —— 刻意接受，换取采集路径固定的内存上界。
const usageScanWindow = 8 << 20

// tokenUsage 索引 token 字段的中间态（对应索引 pt/ct/cc/cw）。
type tokenUsage struct {
	prompt     int64
	completion int64
	cached     int64
	cacheWrite int64
}

func (u tokenUsage) empty() bool {
	return u.prompt == 0 && u.completion == 0 && u.cached == 0 && u.cacheWrite == 0
}

// extractUsageFromFile 读响应正文尾部并提取 usage；任何错误都返回空值（索引省略字段）。
func extractUsageFromFile(path string) tokenUsage {
	text, err := readFileTail(path, usageScanWindow)
	if err != nil || len(text) == 0 {
		return tokenUsage{}
	}
	return extractUsage(text)
}

func readFileTail(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() <= max {
		return io.ReadAll(f)
	}
	buf := make([]byte, max)
	if _, err := f.ReadAt(buf, st.Size()-max); err != nil {
		return nil, err
	}
	return buf, nil
}

// extractUsage 扫描正文里所有 `"usage":{...}` 对象并按字段合并（每字段取最后一个非零值）：
// - OpenAI chat / completions：usage 在最后一个 chunk，或 JSON 一次性给出；
// - OpenAI responses：嵌在 response.completed 事件的 response 对象里，子串扫描同样命中；
// - Anthropic 流：input/cache 在 message_start、output 在 message_delta —— 必须跨事件合并。
//
// 正文「字符串值」里的 `"usage"`（如助手复述的文本）在 JSON 序列化时引号会被转义为
// \"usage\"，不会命中本扫描 —— 这是跳过完整 JSON.parse 也能安全定位的原因。
func extractUsage(text []byte) tokenUsage {
	var merged tokenUsage
	needle := []byte(`"usage"`)
	searchFrom := 0
	for {
		at := bytes.Index(text[searchFrom:], needle)
		if at < 0 {
			return merged
		}
		objStart := searchFrom + at + len(needle)
		obj := matchBraces(text, objStart)
		if obj == nil {
			// 不是 `"usage":{` 的形态（如数字值、异常截断）：跳过这个命中点
			searchFrom = objStart
			continue
		}
		u := parseUsageObject(obj)
		if u.prompt != 0 {
			merged.prompt = u.prompt
		}
		if u.completion != 0 {
			merged.completion = u.completion
		}
		if u.cached != 0 {
			merged.cached = u.cached
		}
		if u.cacheWrite != 0 {
			merged.cacheWrite = u.cacheWrite
		}
		searchFrom = objStart + len(obj)
	}
}

// matchBraces 从 `"usage"` 之后开始找 `{`，返回配对的完整对象字节；形态不符返回 nil。
func matchBraces(text []byte, from int) []byte {
	i := from
	for i < len(text) && text[i] != '{' {
		switch text[i] {
		case ':', ' ', '\t', '\r', '\n':
		default:
			return nil
		}
		i++
	}
	if i >= len(text) {
		return nil
	}
	depth := 0
	inString := false
	escaped := false
	for j := i; j < len(text); j++ {
		c := text[j]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[i : j+1]
			}
		}
	}
	return nil
}

// usagePayload 兼容四种协议的 usage 字段名：
// - OpenAI chat / completions：prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
// - OpenAI responses：input_tokens / output_tokens / input_tokens_details.cached_tokens
// - Anthropic：input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
type usagePayload struct {
	PromptTokens     *int64 `json:"prompt_tokens"`
	CompletionTokens *int64 `json:"completion_tokens"`
	InputTokens      *int64 `json:"input_tokens"`
	OutputTokens     *int64 `json:"output_tokens"`
	PromptDetails    *struct {
		CachedTokens *int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	InputDetails *struct {
		CachedTokens *int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	CacheRead     *int64 `json:"cache_read_input_tokens"`
	CacheCreation *int64 `json:"cache_creation_input_tokens"`
}

func parseUsageObject(obj []byte) tokenUsage {
	var raw usagePayload
	if err := json.Unmarshal(obj, &raw); err != nil {
		return tokenUsage{}
	}
	var u tokenUsage
	switch {
	case raw.PromptTokens != nil:
		u.prompt = *raw.PromptTokens
	case raw.InputTokens != nil:
		u.prompt = *raw.InputTokens
	}
	switch {
	case raw.CompletionTokens != nil:
		u.completion = *raw.CompletionTokens
	case raw.OutputTokens != nil:
		u.completion = *raw.OutputTokens
	}
	switch {
	case raw.PromptDetails != nil && raw.PromptDetails.CachedTokens != nil:
		u.cached = *raw.PromptDetails.CachedTokens
	case raw.InputDetails != nil && raw.InputDetails.CachedTokens != nil:
		u.cached = *raw.InputDetails.CachedTokens
	case raw.CacheRead != nil:
		u.cached = *raw.CacheRead
	}
	if raw.CacheCreation != nil {
		u.cacheWrite = *raw.CacheCreation
	}
	return u
}

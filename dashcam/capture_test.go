package main

import "testing"

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

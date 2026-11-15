// 哑上游（Go 版）：即时返回最小 OpenAI 兼容响应，用于代理天花板压测。
// python http.server 在大 body 高 QPS 下 accept backlog 溢出会污染对比，
// Go net/http 可稳定承载数千 QPS。零第三方依赖。
//
// 构建：go build -o tests/load/dummy-upstream-linux tests/load/dummy-upstream.go
// 运行：./dummy-upstream-linux --port 3311
package main

import (
	"bytes"
	"flag"
	"io"
	"net/http"
	"strconv"
)

func handler(w http.ResponseWriter, r *http.Request) {
	// 与真实上游同口径：读完请求体（91KB body 时两侧代理 A/B 的负载相同）
	body, _ := io.ReadAll(r.Body)

	// 流式标记在 body 里（loadgen 的请求形如 "stream":true）；
	// bytes.Contains 比 json.Unmarshal 便宜一个量级，A/B 两侧负载相同
	stream := bytes.Contains(body, []byte(`"stream":true`))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	if !stream {
		_, _ = w.Write([]byte(`{"id":"dummy","object":"chat.completion","model":"dummy","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))
		return
	}

	// Go 对无 Content-Length 的 HTTP/1.1 响应自动使用 chunked，body 终结正确
	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"}}]}\n\n"))
	if flusher != nil {
		flusher.Flush()
	}
	_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\ndata: [DONE]\n\n"))
	if flusher != nil {
		flusher.Flush()
	}
}

func main() {
	port := flag.Int("port", 3311, "哑上游监听端口")
	flag.Parse()
	_ = http.ListenAndServe("127.0.0.1:"+strconv.Itoa(*port), http.HandlerFunc(handler))
}

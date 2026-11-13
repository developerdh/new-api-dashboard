# syntax=docker/dockerfile:1
#
# audit-proxy —— 仅供自建镜像使用。
# 官方发布产物是不含容器的二进制 tar.gz（见 .github/workflows/release-audit-proxy.yml），
# 本文件用于需要容器化自部署的场景。
#
# 构建（上下文必须是 audit-proxy/ 目录）：
#   docker build --build-arg VERSION=$(git describe --tags --always) -t new-api-audit-proxy:local .
#
# 注意：不要用仓库根目录作为上下文，根 .dockerignore 会把本目录排除。

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
# 无第三方依赖，保留该指令只为将来引入依赖时不改变结构
RUN go mod download
COPY *.go ./
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/audit-proxy .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 1001 -h /app audit \
 && mkdir -p /app/data/audit \
 && chown -R audit:audit /app

COPY --from=build /out/audit-proxy /usr/local/bin/audit-proxy

USER audit
WORKDIR /app
ENV LISTEN=0.0.0.0:8090 \
    AUDIT_DIR=/app/data/audit \
    TZ=Asia/Shanghai

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/audit-proxy", "-healthcheck"]

ENTRYPOINT ["/usr/local/bin/audit-proxy"]

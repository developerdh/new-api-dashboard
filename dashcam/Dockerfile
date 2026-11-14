# syntax=docker/dockerfile:1
#
# new-api-dashcam —— 仅供自建镜像使用。
# 官方发布产物是不含容器的二进制 tar.gz（见 .github/workflows/release-dashcam.yml），
# 本文件用于需要容器化自部署的场景。
#
# 构建（上下文必须是 dashcam/ 目录）：
#   docker build --build-arg VERSION=$(git describe --tags --always) -t new-api-dashcam:local .
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
      -o /out/new-api-dashcam .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 1001 -h /app new-api-dashcam \
 && mkdir -p /app/data/dashcam \
 && chown -R new-api-dashcam:new-api-dashcam /app

COPY --from=build /out/new-api-dashcam /usr/local/bin/new-api-dashcam

USER new-api-dashcam
WORKDIR /app
ENV LISTEN=0.0.0.0:3090 \
    DASHCAM_DIR=/app/data/dashcam \
    TZ=Asia/Shanghai

EXPOSE 3090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/new-api-dashcam", "-healthcheck"]

ENTRYPOINT ["/usr/local/bin/new-api-dashcam"]

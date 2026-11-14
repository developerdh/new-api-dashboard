# new-api-dashcam 构建入口（Linux / CI 使用；Windows 直接参考 README 的 go build 命令）
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build linux image vet clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/new-api-dashcam .

linux:
	mkdir -p dist
	for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath \
			-ldflags="$(LDFLAGS)" -o dist/new-api-dashcam-linux-$$arch . || exit 1; \
	done
	@ls -lh dist/

image:
	docker build --build-arg VERSION=$(VERSION) -t new-api-dashcam:$(VERSION) .

vet:
	go vet ./...
	@test -z "$$(gofmt -l .)" || { echo "存在未格式化文件"; gofmt -l .; exit 1; }

clean:
	rm -rf bin dist

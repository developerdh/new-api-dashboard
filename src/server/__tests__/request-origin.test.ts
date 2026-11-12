/** 单测：对外 origin 解析与同源判定（Next 的 request.url 不反映 Host）。 */
import { describe, expect, it } from "vitest";

import { externalOrigin, isSameOrigin } from "@/server/request-origin";

const URL_LOCAL = "http://localhost:3088/api/auth/login";

function req(headers: Record<string, string>): Request {
  return new Request(URL_LOCAL, { method: "POST", headers });
}

describe("externalOrigin", () => {
  it("优先使用 Host（含端口）", () => {
    expect(externalOrigin(req({ host: "10.0.0.5:13088" }))).toBe("http://10.0.0.5:13088");
  });

  it("X-Forwarded-Proto 为 https 时协议随之切换", () => {
    expect(
      externalOrigin(req({ host: "dashboard.example.com", "x-forwarded-proto": "https" })),
    ).toBe("https://dashboard.example.com");
  });

  it("X-Forwarded-Host 优先于 Host", () => {
    expect(
      externalOrigin(req({ host: "internal:3088", "x-forwarded-host": "dashboard.example.com" })),
    ).toBe("http://dashboard.example.com");
  });

  it("多级代理取第一个值", () => {
    expect(
      externalOrigin(
        req({ "x-forwarded-host": "outer.example.com, inner:3088", "x-forwarded-proto": "https, http" }),
      ),
    ).toBe("https://outer.example.com");
  });

  it("无 Host 时回退到 request.url（本地开发/无代理场景）", () => {
    expect(externalOrigin(req({}))).toBe("http://localhost:3088");
  });
});

describe("isSameOrigin", () => {
  it("经代理访问：Host 与 Origin 一致即通过", () => {
    expect(isSameOrigin(req({ host: "10.0.0.5:13088" }), "http://10.0.0.5:13088")).toBe(true);
  });

  it("端口缺失视为不同源", () => {
    expect(isSameOrigin(req({ host: "10.0.0.5" }), "http://10.0.0.5:13088")).toBe(false);
    expect(isSameOrigin(req({ host: "10.0.0.5:13088" }), "http://10.0.0.5")).toBe(false);
  });

  it("默认端口归一化后相等", () => {
    expect(isSameOrigin(req({ host: "example.com:80" }), "http://example.com")).toBe(true);
    expect(
      isSameOrigin(req({ host: "example.com:443", "x-forwarded-proto": "https" }), "https://example.com"),
    ).toBe(true);
  });

  it("协议不同视为不同源", () => {
    expect(
      isSameOrigin(req({ host: "example.com", "x-forwarded-proto": "https" }), "http://example.com"),
    ).toBe(false);
  });

  it("跨站来源被拒", () => {
    expect(isSameOrigin(req({ host: "dashboard.example.com" }), "https://evil.example.net")).toBe(
      false,
    );
  });

  it("非法 Origin 被拒", () => {
    expect(isSameOrigin(req({ host: "dashboard.example.com" }), "null")).toBe(false);
    expect(isSameOrigin(req({ host: "dashboard.example.com" }), "%%%")).toBe(false);
  });
});

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 发布包产物（含编译后的服务端 chunk，非源码）
    "dist/**",
    // 独立 Go 工具链，不参与前端 lint
    "audit-proxy/**",
    // 本地验证/截图/浏览器 profile 等临时产物，不属于源码
    ".workbuddy/**",
  ]),
]);

export default eslintConfig;

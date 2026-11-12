import type { NextConfig } from "next";

import pkg from "./package.json";

const nextConfig: NextConfig = {
  // 版本号构建期内联：运行期无需读取 package.json，供 /api/health 输出，便于报障时对齐版本
  env: { APP_VERSION: pkg.version },
  cacheComponents: true,
  partialPrefetching: true,
  // 关闭开发模式左下角的 Next.js 标识浮标
  devIndicators: false,
  // Docker 部署：输出自包含 standalone 产物，运行镜像仅需 server.js + static/public
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

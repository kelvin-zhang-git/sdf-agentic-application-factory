import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // 开发进程需要连库。动态读取 process.env，不会把密钥打进浏览器包。
  for (const [key, value] of Object.entries(env)) {
    if (key === "SDF_DISABLE_SCHEDULER") continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return {
    plugins: [
      tsconfigPaths(),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
    ssr: { external: ["postgres", "bcryptjs"] },
    // 只注入测试进程。空前缀不会把密钥打进浏览器包。
    test: { env },
  };
});
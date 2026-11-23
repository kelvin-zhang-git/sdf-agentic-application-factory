#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { api } from "./sdf-client.mjs";

const [command, action, ...rest] = process.argv.slice(2);
const app = flag("--app");

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function needApp() {
  if (!app) throw new Error("请用 --app 指定应用编号");
  return app;
}

async function main() {
  if (command === "spec" && action === "analyze") {
    const data = await api(`/api/apps/${needApp()}/requirements`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (command === "task" && action === "context") {
    const code = rest.find((item) => item.startsWith("T-"));
    if (!code) throw new Error("请给出任务编号，例如 T-0001");
    console.log(JSON.stringify(await api(`/api/apps/${needApp()}/tasks/${code}/context`), null, 2));
    return;
  }
  if (command === "report" && action === "import") {
    const file = flag("--file");
    if (!file) throw new Error("请用 --file 指定 JUnit 或 SARIF 文件");
    const text = await readFile(file, "utf8");
    const body = file.toLowerCase().endsWith(".sarif") || file.toLowerCase().endsWith(".json") ? { sarif: text } : { junit: text };
    console.log(JSON.stringify(await api(`/api/apps/${needApp()}/reports`, { method: "POST", body }), null, 2));
    return;
  }
  if (command === "gate" && action === "check") {
    const data = await api(`/api/apps/${needApp()}/gates/run`, { method: "POST" });
    console.log(JSON.stringify(data, null, 2));
    if (data.met === false) process.exitCode = 2;
    return;
  }
  throw new Error("用法：sdf spec analyze | task context T-0001 | report import --file 报告 | gate check，都要加 --app");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = error.code === "NO_TOKEN" || !process.exitCode ? 1 : process.exitCode;
});

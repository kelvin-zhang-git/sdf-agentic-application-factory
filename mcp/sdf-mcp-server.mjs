#!/usr/bin/env node
/** SDF 的 MCP 服务。通过标准输入输出收发 JSON-RPC，业务都转发到门户接口。 */
import { api } from "../bin/sdf-client.mjs";

export const TOOLS = [
  { name: "list_apps", description: "列出当前用户能看到的应用", inputSchema: { type: "object", properties: {} } },
  { name: "spec_get", description: "读取一个应用的需求", inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
  { name: "task_context", description: "读取 T-xxxx 任务上下文", inputSchema: { type: "object", properties: { app: { type: "string" }, code: { type: "string" } }, required: ["app", "code"] } },
  { name: "constitution_get", description: "读取工程规范", inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
  { name: "task_set_status", description: "把任务改成指定状态", inputSchema: { type: "object", properties: { app: { type: "string" }, code: { type: "string" }, status: { type: "string" } }, required: ["app", "code", "status"] } },
  { name: "gate_check", description: "执行交付检查", inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
];

export async function callTool(name, args) {
  if (name === "list_apps") return api("/api/apps");
  if (name === "spec_get") return api(`/api/apps/${args.app}/requirements`);
  if (name === "task_context") return api(`/api/apps/${args.app}/tasks/${args.code}/context`);
  if (name === "constitution_get") return api(`/api/apps/${args.app}/constitution`);
  if (name === "gate_check") return api(`/api/apps/${args.app}/gates/run`, { method: "POST" });
  if (name === "task_set_status") {
    const tasks = await api(`/api/apps/${args.app}/tasks`);
    const task = (tasks.items ?? tasks).find((item) => item.code === args.code);
    if (!task) throw new Error("找不到这个任务");
    return api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: args.status } });
  }
  throw new Error("没有这个工具");
}

function reply(id, result) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sdf", version: "0.12.0" } };
  if (message.method === "tools/list") return { tools: TOOLS };
  if (message.method === "tools/call") {
    try {
      const data = await callTool(message.params?.name, message.params?.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  }
  return {};
}

let buffer = Buffer.alloc(0);
if (process.argv[1] && process.argv[1].endsWith("sdf-mcp-server.mjs")) {
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { buffer = Buffer.alloc(0); return; }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const message = JSON.parse(buffer.slice(start, start + length).toString("utf8"));
      buffer = buffer.slice(start + length);
      handle(message).then((result) => { if (message.id !== undefined) reply(message.id, result); }).catch((error) => reply(message.id, { content: [{ type: "text", text: error.message }], isError: true }));
    }
  });
}

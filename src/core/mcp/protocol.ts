// MCP JSON-RPC。工具只读任务、需求和路径；澄清问题是唯一会写入的动作。

export interface McpTask {
  app_id: string; app_name: string; code: string; title: string; status: string;
  allowed_paths: string[]; forbidden_paths: string[];
}
export interface McpContext { code: string; title: string; content: string; allowed_paths: string[]; forbidden_paths: string[] }
export interface McpRequirement { code: string; title: string; story: string; status: string; criteria: { code: string; text: string }[] }
export interface McpHit { kind: string; code: string; excerpt: string }
export interface McpScope { task_code: string; outside: string[] }

export interface McpStore {
  listTasks(userId: string, app?: string): Promise<McpTask[]>;
  getTask(userId: string, app: string, code: string): Promise<McpContext | null>;
  getRequirement(userId: string, app: string, code: string): Promise<McpRequirement | null>;
  lookupTerm(userId: string, app: string, term: string): Promise<McpHit[]>;
  checkScope(userId: string, app: string, code: string, files: string[]): Promise<McpScope | null>;
  submitClarification(userId: string, app: string, question: string, requirementCode: string): Promise<{ code: string } | null>;
}

interface Rpc { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

const TOOLS = [
  { name: "list_tasks", description: "列出当前账号能看到的开发任务。可按应用名称筛选。", input: { app: { type: "string" } } },
  { name: "get_task_context", description: "读取一个任务的上下文包、允许路径和禁止路径。", input: { app: { type: "string" }, code: { type: "string" } }, required: ["app", "code"] },
  { name: "get_requirement", description: "按需求编号读取标题、描述和验收标准。", input: { app: { type: "string" }, code: { type: "string" } }, required: ["app", "code"] },
  { name: "lookup_term", description: "在需求、验收标准和领域词典里查找一个词。", input: { app: { type: "string" }, term: { type: "string" } }, required: ["app", "term"] },
  { name: "check_scope", description: "检查文件是否超出该任务允许修改的路径。", input: { app: { type: "string" }, code: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["app", "code", "files"] },
  { name: "submit_clarification", description: "把一个尚未写清的问题记到已有需求上，供业务分析师处理。", input: { app: { type: "string" }, question: { type: "string" }, requirement_code: { type: "string" } }, required: ["app", "question", "requirement_code"] },
];

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function handleMcp(store: McpStore, userId: string, body: unknown): Promise<{ status: number; body: unknown | null }> {
  const rpc = body as Rpc;
  if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "请求格式不正确" } } };
  }
  if (rpc.id === undefined) return { status: 202, body: null };
  const id = rpc.id;
  try {
    const result = await dispatch(store, userId, rpc.method, rpc.params ?? {});
    return { status: 200, body: { jsonrpc: "2.0", id, result } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "工具执行失败";
    return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32000, message } } };
  }
}

async function dispatch(store: McpStore, userId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "enterprise-sdf", version: "1.0.0" },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") {
    return {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: "object", properties: tool.input, ...(tool.required ? { required: tool.required } : {}) },
      })),
    };
  }
  if (method !== "tools/call") throw new Error("不支持的方法");
  const name = str(params["name"]);
  const args = (params["arguments"] ?? {}) as Record<string, unknown>;
  if (name === "list_tasks") return text(await store.listTasks(userId, str(args["app"]) || undefined));
  if (name === "get_task_context") {
    const found = await store.getTask(userId, str(args["app"]), str(args["code"]));
    if (!found) throw new Error("没有找到这个任务，或当前账号看不到该应用");
    return text(found);
  }
  if (name === "get_requirement") {
    const found = await store.getRequirement(userId, str(args["app"]), str(args["code"]));
    if (!found) throw new Error("没有找到这条需求，或当前账号看不到该应用");
    return text(found);
  }
  if (name === "lookup_term") return text(await store.lookupTerm(userId, str(args["app"]), str(args["term"])));
  if (name === "check_scope") {
    const files = Array.isArray(args["files"]) ? args["files"].filter((item): item is string => typeof item === "string").slice(0, 200) : [];
    const found = await store.checkScope(userId, str(args["app"]), str(args["code"]), files);
    if (!found) throw new Error("没有找到这个任务，或当前账号看不到该应用");
    return text(found.outside.length ? found : { ...found, outside: [], note: "这些文件都在允许范围内" });
  }
  if (name === "submit_clarification") {
    const saved = await store.submitClarification(userId, str(args["app"]), str(args["question"]), str(args["requirement_code"]));
    if (!saved) throw new Error("不能写入澄清问题。请确认应用名称，以及当前账号不是仅业务方");
    return text(saved);
  }
  throw new Error("没有这个工具");
}

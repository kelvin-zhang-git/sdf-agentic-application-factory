import { stringify } from "yaml";

export interface ApiEndpoint {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  requirement_codes: string[];
  path_params?: string[];
  request_fields?: { name: string; type: string; required?: boolean }[];
  responses: { status: string; description: string }[];
}

export function renderOpenApi(title: string, endpoints: ApiEndpoint[]): { yaml: string; errors: string[] } {
  const errors: string[] = [];
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ep of endpoints) {
    if (!ep.path.startsWith("/")) errors.push(`${ep.method} ${ep.path} 必须以 / 开头`);
    const names = Array.from(ep.path.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)).map((m) => m[1]!);
    const declared = new Set(ep.path_params ?? []);
    for (const name of names) if (!declared.has(name)) errors.push(`${ep.path} 的路径参数 ${name} 没有声明`);
    for (const name of declared) if (!names.includes(name)) errors.push(`${ep.path} 声明了不存在的路径参数 ${name}`);
    const operation: Record<string, unknown> = {
      summary: ep.summary,
      tags: ep.requirement_codes,
      responses: Object.fromEntries(ep.responses.map((r) => [r.status, { description: r.description }])),
    };
    if (names.length) operation["parameters"] = names.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
    if (ep.request_fields?.length && ep.method !== "get") {
      operation["requestBody"] = {
        required: true,
        content: { "application/json": { schema: {
          type: "object",
          required: ep.request_fields.filter((f) => f.required !== false).map((f) => f.name),
          properties: Object.fromEntries(ep.request_fields.map((f) => [f.name, { type: f.type }])),
        } } },
      };
    }
    paths[ep.path] ??= {};
    paths[ep.path]![ep.method] = operation;
  }
  const doc = { openapi: "3.1.0", info: { title, version: "1.0.0" }, paths };
  return { yaml: stringify(doc), errors };
}

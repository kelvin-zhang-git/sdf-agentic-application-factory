/** 命令行和 MCP 共用的接口客户端。令牌只从环境读取，不写入文件。 */
export function baseUrl() {
  return (process.env.SDF_API ?? "http://127.0.0.1:3000").replace(/\/$/, "");
}

export async function api(path, { method = "GET", body } = {}) {
  const token = process.env.SDF_TOKEN;
  if (!token) {
    const error = new Error("缺少 SDF_TOKEN");
    error.code = "NO_TOKEN";
    throw error;
  }
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.message ?? `接口返回 ${response.status}`);
    error.code = data.code ?? "HTTP";
    error.status = response.status;
    throw error;
  }
  return data;
}

/** 任务允许路径和禁止路径的匹配。支持 * 和 **，目录前缀以 / 结尾。 */
export function matchPath(pattern: string, file: string): boolean {
  const path = file.replace(/\\/g, "/");
  const raw = pattern.replace(/\\/g, "/");
  if (raw.endsWith("/")) return path === raw.slice(0, -1) || path.startsWith(raw);
  const body = raw.split("**").map((part) => part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${body}$`).test(path);
}

export function outOfScope(files: string[], allowed: string[], forbidden: string[]): string[] {
  return files.filter((file) => {
    const path = file.replace(/\\/g, "/");
    if (forbidden.some((pattern) => matchPath(pattern, path))) return true;
    if (!allowed.length) return false;
    return !allowed.some((pattern) => matchPath(pattern, path));
  });
}

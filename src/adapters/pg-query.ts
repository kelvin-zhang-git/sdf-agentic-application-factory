// 兼容现有路由里的链式查询，全部值走参数绑定，表名和列名只允许普通标识符。
import { RELATIONS, type Relation } from "./relations";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const TABLE_FNS = new Set(["claim_step", "get_step_chunks"]);

export interface DbError { message: string; code?: string }
// 查询构造器只拿到字段名字符串，列类型在调用处收窄。这里用 any，避免结果被收成 {} 后连锁报错。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryRow = any;
export interface DbResult<T = QueryRow> { data: T; error: DbError | null }
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

type Field =
  | { kind: "star" }
  | { kind: "col"; name: string }
  | { kind: "rel"; name: string; inner: boolean; count: boolean; fields: Field[] };

type Filter = { col: string; op: "eq" | "neq" | "in" | "ilike" | "notnull" | "gte" | "lte"; value?: unknown };

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`非法标识符：${name}`);
  return `"${name}"`;
}

function parseFields(input: string): Field[] {
  const s = input.trim();
  if (!s || s === "*") return [{ kind: "star" }];
  const fields: Field[] = [];
  let i = 0;
  const skip = () => { while (s[i] === " " || s[i] === ",") i++; };
  while (i < s.length) {
    skip();
    if (i >= s.length) break;
    if (s[i] === "*") { fields.push({ kind: "star" }); i++; continue; }
    const start = i;
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i] ?? "")) i++;
    const name = s.slice(start, i);
    if (!IDENT.test(name)) throw new Error(`非法字段：${name || s.slice(start, start + 12)}`);
    while (s[i] === " ") i++;
    let innerJoin = false;
    if (s.startsWith("!inner", i)) { innerJoin = true; i += 6; while (s[i] === " ") i++; }
    if (s[i] === "(") {
      const end = closeParen(s, i);
      const inner = s.slice(i + 1, end);
      i = end + 1;
      const count = inner.trim() === "count";
      fields.push({ kind: "rel", name, inner: innerJoin, count, fields: count ? [] : parseFields(inner) });
    } else fields.push({ kind: "col", name });
  }
  return fields;
}

function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return i; }
  }
  throw new Error("字段列表括号不匹配");
}

function jsonOf(table: string, alias: string, fields: Field[], params: unknown[], filters: Filter[], depth: number): string {
  const cols = fields.filter((f): f is Extract<Field, { kind: "col" }> => f.kind === "col");
  const rels = fields.filter((f): f is Extract<Field, { kind: "rel" }> => f.kind === "rel");
  const star = fields.some((f) => f.kind === "star");
  const base = star || (cols.length === 0 && rels.length === 0)
    ? `to_jsonb(${alias})`
    : cols.length === 0
      ? `'{}'::jsonb`
      : `jsonb_build_object(${cols.map((c) => `'${c.name}', ${alias}.${ident(c.name)}`).join(", ")})`;
  if (!rels.length) return base;
  const extra = rels.map((rel) => `'${rel.name}', ${embed(table, alias, rel, params, filters, depth)}`).join(", ");
  return `(${base} || jsonb_build_object(${extra}))`;
}

function embed(table: string, parentAlias: string, rel: Extract<Field, { kind: "rel" }>, params: unknown[], filters: Filter[], depth: number): string {
  const edge = RELATIONS[`${table}.${rel.name}`];
  if (!edge) throw new Error(`未登记的关联：${table}.${rel.name}`);
  const child = `c${depth}_${rel.name}`;
  const childFilters = filters.filter((f) => f.col.startsWith(`${rel.name}.`)).map((f) => ({ ...f, col: f.col.slice(rel.name.length + 1) }));
  const where = [`${child}.${ident(edge.foreign)} = ${parentAlias}.${ident(edge.local)}`, ...childFilters.map((f) => andFilter(child, f, params))].join(" AND ");
  if (rel.count) {
    return `jsonb_build_array(jsonb_build_object('count', (SELECT count(*)::int FROM public.${ident(edge.to)} AS ${child} WHERE ${where})))`;
  }
  const projected = jsonOf(edge.to, child, rel.fields, params, childFilters, depth + 1);
  if (edge.card === "many") {
    return `COALESCE((SELECT jsonb_agg(x.j) FROM (SELECT ${projected} AS j FROM public.${ident(edge.to)} AS ${child} WHERE ${where}) x), '[]'::jsonb)`;
  }
  return `(SELECT ${projected} FROM public.${ident(edge.to)} AS ${child} WHERE ${where})`;
}

function andFilter(alias: string, filter: Filter, params: unknown[]): string {
  const col = filter.col.includes(".") ? null : `${alias}.${ident(filter.col)}`;
  if (!col) throw new Error(`过滤列非法：${filter.col}`);
  if (filter.op === "notnull") return `${col} IS NOT NULL`;
  if (filter.op === "in") {
    const list = Array.isArray(filter.value) ? filter.value : [];
    if (!list.length) return "FALSE";
    params.push(list);
    return `${col} = ANY($${params.length})`;
  }
  params.push(filter.value ?? null);
  const n = `$${params.length}`;
  if (filter.op === "eq") return `${col} = ${n}`;
  if (filter.op === "neq") return `${col} <> ${n}`;
  if (filter.op === "gte") return `${col} >= ${n}`;
  if (filter.op === "lte") return `${col} <= ${n}`;
  return `${col} ILIKE ${n}`;
}

function existsInner(table: string, parent: string, relName: string, filters: Filter[], params: unknown[]): string | null {
  const edge: Relation | undefined = RELATIONS[`${table}.${relName}`];
  if (!edge) return null;
  const dotted = filters.filter((f) => f.col.startsWith(`${relName}.`));
  const child = `e_${relName}`;
  const where = [`${child}.${ident(edge.foreign)} = ${parent}.${ident(edge.local)}`, ...dotted.map((f) => andFilter(child, { ...f, col: f.col.slice(relName.length + 1) }, params))];
  return `EXISTS (SELECT 1 FROM public.${ident(edge.to)} AS ${child} WHERE ${where.join(" AND ")})`;
}

interface Built { sql: string; params: unknown[] }

function selectSql(table: string, spec: string, filters: Filter[], orders: { col: string; asc: boolean }[], limit?: number): Built {
  const params: unknown[] = [];
  const fields = parseFields(spec);
  const parent = "parent";
  const rels = fields.filter((f): f is Extract<Field, { kind: "rel" }> => f.kind === "rel");
  const projected = jsonOf(table, parent, fields, params, filters, 1);
  const where = [
    ...filters.filter((f) => !f.col.includes(".")).map((f) => andFilter(parent, f, params)),
    ...rels.filter((r) => r.inner).map((r) => existsInner(table, parent, r.name, filters, params)).filter((x): x is string => !!x),
  ];
  const order = orders.map((o) => `${parent}.${ident(o.col)} ${o.asc ? "ASC" : "DESC"}`).join(", ");
  const sql = `SELECT ${projected} AS row FROM public.${ident(table)} AS ${parent}`
    + (where.length ? ` WHERE ${where.join(" AND ")}` : "")
    + (order ? ` ORDER BY ${order}` : "")
    + (limit ? ` LIMIT ${Math.trunc(limit)}` : "");
  return { sql, params };
}

function jsonLiteral(value: unknown): string {
  const tag = `js${Math.random().toString(16).slice(2)}`;
  return `$${tag}$${JSON.stringify(value)}$${tag}$::jsonb`;
}

function valueSql(value: unknown, params: unknown[]): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return jsonLiteral(value);
  params.push(value);
  return `$${params.length}`;
}

class Builder implements PromiseLike<DbResult<QueryRow[] | null>> {
  private filters: Filter[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private lim?: number;
  private one: "many" | "single" | "maybe" = "many";
  private spec = "*";
  private wrote: "select" | "insert" | "update" | "delete" = "select";
  private values: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private returning = false;
  private pending?: Promise<DbResult<QueryRow[] | null>>;

  constructor(private readonly table: string, private readonly query: QueryFn) {
    ident(table);
  }

  select(spec?: string) { this.spec = spec && spec.trim() ? spec : "*"; this.returning = this.wrote !== "select" || this.returning; if (this.wrote === "select") this.returning = false; else this.returning = true; return this; }
  eq(col: string, value: unknown) { this.filters.push({ col, op: "eq", value }); return this; }
  neq(col: string, value: unknown) { this.filters.push({ col, op: "neq", value }); return this; }
  in(col: string, value: unknown[]) { this.filters.push({ col, op: "in", value }); return this; }
  ilike(col: string, value: string) { this.filters.push({ col, op: "ilike", value }); return this; }
  gte(col: string, value: unknown) { this.filters.push({ col, op: "gte", value }); return this; }
  lte(col: string, value: unknown) { this.filters.push({ col, op: "lte", value }); return this; }
  not(col: string, op: string, value: unknown) {
    if (op === "is" && value === null) this.filters.push({ col, op: "notnull" });
    else throw new Error(`不支持的过滤：${op}`);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  single(): Promise<DbResult<QueryRow>> { this.one = "single"; return this.run(); }
  maybeSingle(): Promise<DbResult<QueryRow>> { this.one = "maybe"; return this.run(); }
  insert(values: Record<string, unknown> | Record<string, unknown>[]) { this.wrote = "insert"; this.values = values; return this; }
  update(values: Record<string, unknown>) { this.wrote = "update"; this.values = values; return this; }
  delete() { this.wrote = "delete"; return this; }

  then<T1 = DbResult<QueryRow[] | null>, T2 = never>(
    onfulfilled?: ((value: DbResult<QueryRow[] | null>) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private run(): Promise<DbResult<QueryRow[] | null>> {
    this.pending ??= this.exec();
    return this.pending;
  }

  private async exec(): Promise<DbResult<QueryRow[] | null>> {
    try {
      const built = this.sql();
      const rows = await this.query(built.sql, built.params);
      return shape(rows.map((r) => r["row"]), this.one, this.wrote === "select" || this.returning);
    } catch (error) {
      const e = error as { message?: string; code?: string };
      return { data: null, error: { message: e.message ?? "数据库操作失败", ...(e.code ? { code: e.code } : {}) } };
    }
  }

  private sql(): Built {
    if (this.wrote === "select") return selectSql(this.table, this.spec, this.filters, this.orders, this.lim);
    const params: unknown[] = [];
    const where = this.filters.map((f) => andFilter("parent", f, params));
    const ret = this.returning ? " RETURNING to_jsonb(parent) AS row" : "";
    if (this.wrote === "delete") {
      return { sql: `DELETE FROM public.${ident(this.table)} AS parent${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${ret}`, params };
    }
    if (this.wrote === "update") {
      const values = (this.values ?? {}) as Record<string, unknown>;
      const sets = Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${ident(k)} = ${valueSql(v, params)}`);
      if (!sets.length) throw new Error("没有要更新的字段");
      return { sql: `UPDATE public.${ident(this.table)} AS parent SET ${sets.join(", ")}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${ret}`, params };
    }
    const rows = Array.isArray(this.values) ? this.values : [this.values ?? {}];
    const keys = Object.keys(rows[0] ?? {}).filter((k) => rows.some((r) => r[k] !== undefined));
    if (!keys.length) throw new Error("没有要写入的字段");
    const valuesSql = rows.map((row) => `(${keys.map((k) => valueSql(row[k], params)).join(", ")})`).join(", ");
    return { sql: `INSERT INTO public.${ident(this.table)} AS parent (${keys.map(ident).join(", ")}) VALUES ${valuesSql}${ret}`, params };
  }
}

function shape(rows: QueryRow[], one: "many" | "single" | "maybe", hasRows: boolean): DbResult<QueryRow> {
  if (!hasRows) return { data: null, error: null };
  if (one === "many") return { data: rows, error: null };
  if (rows.length === 1) return { data: rows[0], error: null };
  if (one === "maybe" && rows.length === 0) return { data: null, error: null };
  return { data: null, error: { message: "期望返回一行", code: "PGRST116" } };
}

export interface UserDb {
  from(table: string): Builder;
  rpc(fn: string, args?: Record<string, unknown>): Promise<DbResult<QueryRow>>;
}

export function createDb(query: QueryFn): UserDb {
  return {
    from(table: string) { return new Builder(table, query); },
    async rpc(fn, args = {}) {
      if (!IDENT.test(fn)) return { data: null, error: { message: "非法函数名" } };
      const params: unknown[] = [];
      const assigns = Object.entries(args).map(([name, value]) => {
        if (!IDENT.test(name)) throw new Error("非法参数名");
        if (value !== null && typeof value === "object") return `${ident(name)} := ${jsonLiteral(value)}`;
        params.push(value);
        return `${ident(name)} := $${params.length}`;
      });
      const call = `public.${ident(fn)}(${assigns.join(", ")})`;
      const sql = TABLE_FNS.has(fn) ? `SELECT * FROM ${call}` : `SELECT ${call} AS data`;
      try {
        const rows = await query(sql, params);
        if (TABLE_FNS.has(fn)) return { data: rows, error: null };
        return { data: rows[0]?.["data"] ?? null, error: null };
      } catch (error) {
        const e = error as { message?: string; code?: string };
        return { data: null, error: { message: e.message ?? "数据库函数调用失败", ...(e.code ? { code: e.code } : {}) } };
      }
    },
  };
}

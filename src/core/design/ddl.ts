// 数据模型 JSON 由模型给出，DDL 由这里拼装，避免模型写出无法执行的 SQL。

export interface ModelField {
  name: string;
  type: string;
  nullable?: boolean | undefined;
  default?: string | null | undefined;
  comment?: string | undefined;
  primary_key?: boolean | undefined;
}
export interface ModelEntity {
  name: string;
  comment?: string;
  fields: ModelField[];
  foreign_keys?: { columns: string[]; ref_table: string; ref_columns: string[] }[];
  indexes?: { name: string; columns: string[]; unique?: boolean }[];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const TYPE_ALIAS: Record<string, string> = {
  uuid: "uuid", text: "text", string: "text", varchar: "text", char: "text", character: "text",
  int: "integer", integer: "integer", int4: "integer", serial: "integer",
  bigint: "bigint", int8: "bigint", bigserial: "bigint",
  bool: "boolean", boolean: "boolean",
  numeric: "numeric", decimal: "numeric", float: "numeric", double: "numeric", number: "numeric", real: "numeric",
  timestamptz: "timestamptz", timestamp: "timestamptz", datetime: "timestamptz",
  date: "date", jsonb: "jsonb", json: "jsonb",
};

function slug(raw: string, fallback: string): string {
  let name = raw.normalize("NFKC").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
  if (!name) return IDENT.test(fallback) ? fallback : "item";
  if (!/^[a-z_]/.test(name)) name = `c_${name}`;
  name = name.slice(0, 40).replace(/_+$/g, "");
  return IDENT.test(name) ? name : (IDENT.test(fallback) ? fallback : "item");
}

/** 把模型给出的松散结构收成可执行的数据模型。无法识别的类型降为 text，中文名改成编号。 */
export function normalizeModel(raw: { name?: string | undefined; comment?: string | undefined; fields?: { name?: string | undefined; type?: string | undefined; nullable?: boolean | undefined; primary_key?: boolean | undefined; comment?: string | undefined }[] | undefined; foreign_keys?: { columns?: string[] | undefined; ref_table?: string | undefined; ref_columns?: string[] | undefined }[] | undefined; indexes?: { name?: string | undefined; columns?: string[] | undefined; unique?: boolean | undefined }[] | undefined }[]): ModelEntity[] {
  const used = new Set<string>();
  const entities: ModelEntity[] = [];
  raw.slice(0, 20).forEach((entity, index) => {
    let name = slug(entity.name ?? "", `entity_${index + 1}`);
    while (used.has(name)) name = `${name}_${entities.length + 1}`.slice(0, 40);
    used.add(name);
    const fields: ModelField[] = [];
    const fieldNames = new Set<string>();
    for (const [fieldIndex, field] of (entity.fields ?? []).slice(0, 20).entries()) {
      let fieldName = slug(field.name ?? "", `field_${fieldIndex + 1}`);
      if (fieldNames.has(fieldName)) continue;
      fieldNames.add(fieldName);
      const token = (field.type ?? "text").toLowerCase().replace(/\(.*\)/g, "").trim().split(/\s+/)[0] ?? "text";
      fields.push({ name: fieldName, type: TYPE_ALIAS[token] ?? "text", nullable: field.nullable, primary_key: field.primary_key, ...(field.comment ? { comment: field.comment.slice(0, 200) } : {}) });
    }
    if (!fields.length) fields.push({ name: "id", type: "uuid", primary_key: true, nullable: false, default: "gen_random_uuid()" });
    if (!fields.some((field) => field.primary_key)) fields[0] = { ...fields[0]!, primary_key: true, nullable: false };
    entities.push({
      name, ...(entity.comment ? { comment: entity.comment.slice(0, 200) } : {}), fields,
      foreign_keys: (entity.foreign_keys ?? []).slice(0, 8).flatMap((fk) => {
        const columns = (fk.columns ?? []).map((column, i) => slug(column, "")).filter((column) => fieldNames.has(column));
        const refTable = slug(fk.ref_table ?? "", "");
        const refColumns = (fk.ref_columns ?? []).map((column) => slug(column, "")).filter(Boolean);
        return columns.length && refTable && refColumns.length === columns.length ? [{ columns, ref_table: refTable, ref_columns: refColumns }] : [];
      }),
      indexes: (entity.indexes ?? []).slice(0, 8).flatMap((idx, i) => {
        const columns = (idx.columns ?? []).map((column) => slug(column, "")).filter((column) => fieldNames.has(column));
        return columns.length ? [{ name: slug(`${name}_${idx.name ?? i + 1}`, `${name}_idx_${i + 1}`), columns, ...(idx.unique ? { unique: true } : {}) }] : [];
      }),
    });
  });
  return entities.map((entity) => ({ ...entity, foreign_keys: (entity.foreign_keys ?? []).filter((fk) => used.has(fk.ref_table)) }));
}
const TYPES = new Set(["uuid", "text", "integer", "bigint", "boolean", "numeric", "timestamptz", "date", "jsonb"]);

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) throw new Error(`${what}「${name}」不是合法的数据库标识符`);
  return `"${name}"`;
}

function literal(value: string): string {
  if (/^(true|false|null|now\(\)|gen_random_uuid\(\)|'\{\}'::jsonb)$/.test(value) || /^-?\d+(\.\d+)?$/.test(value)) return value;
  if (!/^[-a-zA-Z0-9_ .:@]+$/.test(value) || value.length > 80) throw new Error(`默认值「${value}」不在允许范围内`);
  return `'${value.replace(/'/g, "''")}'`;
}

function ordered(entities: ModelEntity[]): ModelEntity[] {
  const names = new Set(entities.map((entity) => entity.name));
  if (names.size !== entities.length) throw new Error("实体名称重复");
  const pending = [...entities];
  const done: ModelEntity[] = [];
  const ready = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex((entity) => (entity.foreign_keys ?? []).every((fk) => !names.has(fk.ref_table) || ready.has(fk.ref_table) || fk.ref_table === entity.name));
    if (index < 0) throw new Error("外键存在循环，无法排出建表顺序");
    const next = pending.splice(index, 1)[0]!;
    done.push(next);
    ready.add(next.name);
  }
  return done;
}

export function renderDdl(entities: ModelEntity[]): string {
  if (!entities.length) throw new Error("至少要有一个实体");
  const parts: string[] = ["-- 由数据模型确定性生成，不要手改后当作源"];
  entities = ordered(entities);
  for (const entity of entities) {
    const table = ident(entity.name, "表名");
    if (!entity.fields.length) throw new Error(`表 ${entity.name} 没有字段`);
    const cols = entity.fields.map((field) => {
      const type = field.type.trim().toLowerCase();
      if (!TYPES.has(type)) throw new Error(`字段 ${entity.name}.${field.name} 的类型 ${field.type} 不在允许列表`);
      const pk = field.primary_key ? " PRIMARY KEY" : "";
      const nullable = field.primary_key || field.nullable === false ? " NOT NULL" : "";
      const def = field.default ? ` DEFAULT ${literal(field.default)}` : "";
      return `  ${ident(field.name, "字段名")} ${type}${pk}${nullable}${def}`;
    });
    for (const fk of entity.foreign_keys ?? []) {
      const colsSql = fk.columns.map((c) => ident(c, "外键列")).join(", ");
      const refs = fk.ref_columns.map((c) => ident(c, "引用列")).join(", ");
      cols.push(`  FOREIGN KEY (${colsSql}) REFERENCES ${ident(fk.ref_table, "引用表")} (${refs})`);
    }
    parts.push(`CREATE TABLE ${table} (\n${cols.join(",\n")}\n);`);
    if (entity.comment) parts.push(`COMMENT ON TABLE ${table} IS '${entity.comment.replace(/'/g, "''")}';`);
    for (const field of entity.fields) {
      if (field.comment) parts.push(`COMMENT ON COLUMN ${table}.${ident(field.name, "字段名")} IS '${field.comment.replace(/'/g, "''")}';`);
    }
    for (const index of entity.indexes ?? []) {
      const unique = index.unique ? "UNIQUE " : "";
      const columns = index.columns.map((c) => ident(c, "索引列")).join(", ");
      parts.push(`CREATE ${unique}INDEX ${ident(index.name, "索引名")} ON ${table} (${columns});`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}

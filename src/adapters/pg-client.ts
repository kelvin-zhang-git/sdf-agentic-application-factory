import postgres, { type Sql } from "postgres";
import { createDb, type QueryFn, type UserDb } from "./pg-query";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function makePool(user: string, password: string): Sql {
  return postgres({
    host: process.env["SDF_PG_HOST"] ?? "127.0.0.1",
    port: Number(process.env["SDF_PG_PORT"] ?? 5432),
    database: process.env["SDF_PG_DATABASE"] ?? "sdf",
    username: user,
    password,
    max: 8,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

let userPool: Sql | undefined;
let servicePool: Sql | undefined;

function users(): Sql {
  userPool ??= makePool(process.env["SDF_PG_USER"] ?? "sdf_authenticator", required("SDF_PG_PASSWORD"));
  return userPool;
}
function service(): Sql {
  servicePool ??= makePool(process.env["SDF_PG_SERVICE_USER"] ?? "sdf_service", required("SDF_PG_SERVICE_PASSWORD"));
  return servicePool;
}

async function inTx(pool: Sql, prepare: (tx: Sql) => Promise<void>, text: string, params: unknown[] = []) {
  return await pool.begin(async (tx) => {
    await prepare(tx as unknown as Sql);
    return await tx.unsafe(text, params as never[]);
  }) as Record<string, unknown>[];
}

/** 用户池没有继承权限，每条语句都在事务里切换到 authenticated，让 RLS 使用 auth.uid()。 */
export function userQuery(userId: string): QueryFn {
  return (text, params) => inTx(users(), async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx.unsafe("SELECT set_config('search_path', 'public', true)");
    await tx.unsafe("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
  }, text, params);
}

export function serviceQuery(): QueryFn {
  return (text, params) => inTx(service(), async (tx) => {
    await tx.unsafe("SELECT set_config('search_path', 'public', true)");
  }, text, params);
}

export function createUserDb(userId: string): UserDb {
  return createDb(userQuery(userId));
}

export function createServiceDb(): UserDb {
  return createDb(serviceQuery());
}

/**
 * 单测：连接层配置/会话加固/单例/探活降级。
 * 约束：不依赖真库——只断言配置与协议行为，涉及实例的用例不发起任何连接。
 */
import { types, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { GET } from "@/app/api/health/route";
import {
  APPLICATION_NAME,
  DatabaseConfigError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MAX_POOL_MAX,
  MIN_POOL_MAX,
  READ_ONLY_SESSION_OPTIONS,
  READ_ONLY_SESSION_STATEMENTS,
  applyReadOnlySession,
  checkDbHealth,
  createPoolConfig,
  destroyDb,
  getDb,
  getKysely,
  redactCredentials,
  resolveDbConnectionConfig,
  type DbConnectionConfig,
  type ReadOnlyDatabase,
} from "@/server/db";

const VALID_URL = "postgres://dashboard_readonly:pw@db-host:5432/new_api";

const BASE_CONFIG: DbConnectionConfig = {
  connectionString: VALID_URL,
  poolMax: DEFAULT_POOL_MAX,
  connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
};

/** 记录下发 SQL 的假 pg 客户端（不连库）。 */
function createFakePoolClient(onQuery?: (text: string) => void): {
  client: PoolClient;
  issued: string[];
} {
  const issued: string[] = [];
  const client = {
    query: async (text: string) => {
      issued.push(text);
      onQuery?.(text);
      return { command: "", rowCount: 0, oid: 0, fields: [], rows: [] };
    },
  } as unknown as PoolClient;
  return { client, issued };
}

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPoolMax = process.env.DB_POOL_MAX;
const originalConnectTimeout = process.env.DB_CONNECT_TIMEOUT_MS;

function restoreEnv(
  name: "DATABASE_URL" | "DB_POOL_MAX" | "DB_CONNECT_TIMEOUT_MS",
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const UNSET_MSG = "缺少环境变量 DATABASE_URL";

beforeEach(async () => {
  await destroyDb();
  delete process.env.DATABASE_URL;
  delete process.env.DB_POOL_MAX;
  delete process.env.DB_CONNECT_TIMEOUT_MS;
});

afterEach(async () => {
  await destroyDb();
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("DB_POOL_MAX", originalPoolMax);
  restoreEnv("DB_CONNECT_TIMEOUT_MS", originalConnectTimeout);
});

describe("resolveDbConnectionConfig：连接串与池参数", () => {
  it("缺少 DATABASE_URL 时抛配置错误且不建池", () => {
    expect(() => resolveDbConnectionConfig({})).toThrow(DatabaseConfigError);
    expect(() => resolveDbConnectionConfig({})).toThrow(UNSET_MSG);
    try {
      resolveDbConnectionConfig({ DATABASE_URL: "   " });
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as DatabaseConfigError).code).toBe("DB_CONFIG_INVALID");
    }
  });

  it("非 postgres 协议直接拒绝（不猜数据源）", () => {
    expect(() =>
      resolveDbConnectionConfig({ DATABASE_URL: "mysql://user:pw@host:3306/new_api" }),
    ).toThrow(/协议必须是 postgres/);
    expect(() =>
      resolveDbConnectionConfig({ DATABASE_URL: "not-a-url" }),
    ).toThrow(/不是合法 URL/);
  });

  it("只读连接串：只接受 DATABASE_URL，池上限默认 10", () => {
    const config = resolveDbConnectionConfig({ DATABASE_URL: VALID_URL });
    expect(config.connectionString).toBe(VALID_URL);
    expect(config.poolMax).toBe(DEFAULT_POOL_MAX);
    expect(config.poolMax).toBe(10);
    expect(config.connectTimeoutMs).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it("DB_POOL_MAX 接受区间端点 10 与 20", () => {
    expect(
      resolveDbConnectionConfig({ DATABASE_URL: VALID_URL, DB_POOL_MAX: "10" }).poolMax,
    ).toBe(MIN_POOL_MAX);
    expect(
      resolveDbConnectionConfig({ DATABASE_URL: VALID_URL, DB_POOL_MAX: "20" }).poolMax,
    ).toBe(MAX_POOL_MAX);
    expect(MAX_POOL_MAX).toBe(20);
  });

  it("DB_POOL_MAX 超上限/低于下限/非整数一律拒绝（池上限 ≤20 红线）", () => {
    for (const raw of ["21", "100", "9", "0", "-1", "10.5", "abc", "1e3"]) {
      expect(() =>
        resolveDbConnectionConfig({ DATABASE_URL: VALID_URL, DB_POOL_MAX: raw }),
      ).toThrow(DatabaseConfigError);
    }
  });

  it("DB_CONNECT_TIMEOUT_MS 非法时拒绝，空串回落默认值", () => {
    expect(
      resolveDbConnectionConfig({ DATABASE_URL: VALID_URL, DB_CONNECT_TIMEOUT_MS: "" })
        .connectTimeoutMs,
    ).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    for (const raw of ["0", "99", "60001", "abc"]) {
      expect(() =>
        resolveDbConnectionConfig({ DATABASE_URL: VALID_URL, DB_CONNECT_TIMEOUT_MS: raw }),
      ).toThrow(DatabaseConfigError);
    }
  });
});

describe("createPoolConfig：池与红线参数", () => {
  it("池上限/建连超时/连接标识按口径下发", () => {
    const poolConfig = createPoolConfig(BASE_CONFIG);
    expect(poolConfig.max).toBe(DEFAULT_POOL_MAX);
    expect(poolConfig.max).toBeLessThanOrEqual(MAX_POOL_MAX);
    expect(poolConfig.connectionTimeoutMillis).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    expect(poolConfig.application_name).toBe(APPLICATION_NAME);
    expect(poolConfig.connectionString).toBe(VALID_URL);
  });

  it("启动参数下发 30s 语句超时 + 默认只读事务（方案 §9.2 / §2.1）", () => {
    const options = createPoolConfig(BASE_CONFIG).options;
    expect(options).toContain(`statement_timeout=${DEFAULT_STATEMENT_TIMEOUT_MS}`);
    expect(options).toContain("default_transaction_read_only=on");
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(READ_ONLY_SESSION_OPTIONS).toBe(options);
    expect(typeof createPoolConfig(BASE_CONFIG).verify).toBe("function");
  });
});

describe("会话加固：applyReadOnlySession 与池级 verify", () => {
  it("下发 statement_timeout 与只读事务两条 SET", async () => {
    const { client, issued } = createFakePoolClient();
    await applyReadOnlySession(client);

    expect(issued).toEqual([...READ_ONLY_SESSION_STATEMENTS]);
    expect(issued[0]).toContain("statement_timeout");
    expect(issued[1]).toContain("default_transaction_read_only = on");
  });

  it("加固成功才放行连接（done 无错误）", async () => {
    const { client, issued } = createFakePoolClient();
    const error = await new Promise<Error | undefined>((resolve) => {
      createPoolConfig(BASE_CONFIG).verify?.(client, resolve);
    });
    expect(error).toBeUndefined();
    expect(issued).toHaveLength(READ_ONLY_SESSION_STATEMENTS.length);
  });

  it("加固失败时回传错误（pg-pool 会销毁该连接，不放行未加固会话）", async () => {
    const { client } = createFakePoolClient(() => {
      throw new Error("SET 失败");
    });
    const error = await new Promise<Error | undefined>((resolve) => {
      createPoolConfig(BASE_CONFIG).verify?.(client, resolve);
    });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("SET 失败");
  });
});

describe("单例与只读守卫", () => {
  it("未配置 DATABASE_URL 时取实例抛配置错误（不尝试连接）", () => {
    expect(() => getDb()).toThrow(DatabaseConfigError);
    expect(() => getKysely()).toThrow(UNSET_MSG);
  });

  it("同一进程复用同一实例，destroyDb 后可重建", async () => {
    process.env.DATABASE_URL = VALID_URL;
    const first = getDb();
    expect(getDb()).toBe(first);
    expect(getKysely()).toBe(first);

    await destroyDb();
    const second = getDb();
    expect(second).not.toBe(first);
    await destroyDb();
  });

  it("类型层不暴露写入口（写操作必须显式绕开 getDb）", () => {
    expectTypeOf<ReadOnlyDatabase>().toHaveProperty("selectFrom");
    expectTypeOf<ReadOnlyDatabase>().toHaveProperty("executeQuery");
    expectTypeOf<ReadOnlyDatabase>().not.toHaveProperty("insertInto");
    expectTypeOf<ReadOnlyDatabase>().not.toHaveProperty("replaceInto");
    expectTypeOf<ReadOnlyDatabase>().not.toHaveProperty("updateTable");
    expectTypeOf<ReadOnlyDatabase>().not.toHaveProperty("deleteFrom");
    expectTypeOf<ReadOnlyDatabase>().not.toHaveProperty("mergeInto");
  });
});

describe("checkDbHealth：探活降级", () => {
  it("未配置数据库时收敛为 down + 结构化错误，不抛出", async () => {
    const health = await checkDbHealth(500);

    expect(health.ok).toBe(false);
    expect(health.status).toBe("down");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.error?.code).toBe("DB_CONFIG_INVALID");
    expect(health.error?.message).toContain(UNSET_MSG);
    expect(DEFAULT_HEALTH_TIMEOUT_MS).toBe(5_000);
  });

  it("探活失败信息不含连接串凭据", () => {
    expect(
      redactCredentials(
        `connect ECONNREFUSED postgres://dashboard_readonly:sup3rs3cret@db-host:5432/new_api`,
      ),
    ).toBe("connect ECONNREFUSED postgres://***:***@db-host:5432/new_api");
    expect(redactCredentials("no credentials here")).toBe("no credentials here");
  });
});

describe("GET /api/health", () => {
  it("数据库不可用时返回 503 与结构化响应体", async () => {
    const response = await GET();
    const body = (await response.json()) as {
      ok: boolean;
      db: { status: string; latencyMs: number; error?: { code: string } };
    };

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.ok).toBe(false);
    expect(body.db.status).toBe("down");
    expect(typeof body.db.latencyMs).toBe("number");
    expect(body.db.error?.code).toBe("DB_CONFIG_INVALID");
  });
});

describe("int8 反序列化口径", () => {
  it("int8 解析为 number（不再是字符串）", () => {
    const parsed = types.getTypeParser(types.builtins.INT8)("1760000000");
    expect(typeof parsed).toBe("number");
    expect(parsed).toBe(1760000000);
    expect(types.getTypeParser(types.builtins.INT8)("9007199254740991")).toBe(
      9007199254740991,
    );
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformPool } from "@workspace/platform-db";

const auth = vi.hoisted(() => ({ actorId: "11111111-1111-4111-8111-111111111111" }));
vi.mock("../middlewares/platform-auth", async importOriginal => {
  const actual = await importOriginal<typeof import("../middlewares/platform-auth")>();
  return {
    ...actual,
    requirePlatformSession: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.locals.platformAuth = { userId: auth.actorId, platformRole: "PLATFORM_OWNER" }; next();
    },
    requirePlatformCsrf: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  };
});

let server: http.Server;
let baseUrl = "";
const pool = getPlatformPool();

async function api(path: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createSignup(status = "PENDING") {
  const id = randomUUID();
  await pool.query(`INSERT INTO studio_signup_requests
    (id,owner_name,studio_name,phone,email,requested_slug,requested_plan_code,status)
    VALUES ($1,'Owner','Studio','0900000000','owner@example.com',$2,'STANDARD',$3)`,
    [id, `studio-${id.slice(0, 8)}`, status]);
  return id;
}

async function approve(id: string) {
  const response = await api(`/platform-admin/api/signups/${id}/approve`, {});
  const row = await pool.query<{ tenant_id:string }>("SELECT tenant_id FROM studio_signup_requests WHERE id=$1", [id]);
  return { response, tenantId: row.rows[0]?.tenant_id };
}

async function action(tenantId: string, name: string, extra: Record<string, unknown> = {}) {
  return api(`/platform-admin/api/studios/${tenantId}/action`, { action: name, ...extra });
}

beforeAll(async () => {
  const router = (await import("../routes/platform-commercial")).default;
  const app = express(); app.use(express.json()); app.use("/api", router);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("test server unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE platform_payments,tenant_branding,tenant_domains,studio_signup_requests,
    provisioning_jobs,subscriptions,tenant_database_registry,sessions,tenant_memberships,tenants,
    auth_identities,platform_users CASCADE`);
  await pool.query(`INSERT INTO platform_users (id,display_name,status,platform_role)
    VALUES ($1,'Integration Owner','active','PLATFORM_OWNER')`, [auth.actorId]);
  await pool.query(`UPDATE plans SET setup_fee_amount=CASE id WHEN 'standard' THEN 900000 ELSE setup_fee_amount END,
    monthly_price_amount=CASE id WHEN 'standard' THEN 500000 ELSE monthly_price_amount END WHERE id='standard'`);
});

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe("commercial signup state machine over HTTP and PostgreSQL", () => {
  it("allows PENDING -> APPROVED and creates one commercial aggregate", async () => {
    const id = await createSignup(); const { response, tenantId } = await approve(id);
    expect(response.status).toBe(200); expect(tenantId).toBeTruthy();
    const counts = await pool.query(`SELECT
      (SELECT count(*) FROM tenants WHERE id=$1)::int tenants,
      (SELECT count(*) FROM subscriptions WHERE tenant_id=$1)::int subscriptions,
      (SELECT count(*) FROM platform_payments WHERE tenant_id=$1)::int payments,
      (SELECT count(*) FROM tenant_branding WHERE tenant_id=$1)::int branding`, [tenantId]);
    expect(counts.rows[0]).toMatchObject({ tenants:1, subscriptions:1, payments:1, branding:1 });
  });

  it("makes repeated approve idempotent without duplicate records", async () => {
    const id = await createSignup(); const first = await approve(id); const second = await approve(id);
    expect(first.response.status).toBe(200); expect(second.response.status).toBe(200);
    expect(second.tenantId).toBe(first.tenantId);
    expect((await pool.query("SELECT count(*)::int count FROM subscriptions WHERE tenant_id=$1", [first.tenantId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM platform_payments WHERE tenant_id=$1", [first.tenantId])).rows[0].count).toBe(1);
  });

  it.each(["APPROVED", "PROVISIONING"])("rejects %s -> REJECTED", async status => {
    const id = await createSignup(); await approve(id);
    if (status === "PROVISIONING") await pool.query("UPDATE studio_signup_requests SET status='PROVISIONING' WHERE id=$1", [id]);
    const response = await api(`/platform-admin/api/signups/${id}/reject`, {});
    expect(response.status).toBe(409);
    expect((await pool.query("SELECT status FROM studio_signup_requests WHERE id=$1", [id])).rows[0].status).toBe(status);
  });
});

describe("commercial payment and activation invariants", () => {
  it("fails mark_setup_paid when the plan has no configured setup fee", async () => {
    const id = await createSignup(); const { tenantId } = await approve(id);
    await pool.query("UPDATE plans SET setup_fee_amount=NULL WHERE id='standard'");
    const response = await action(tenantId!, "mark_setup_paid");
    expect(response.status).toBe(409);
    expect((await pool.query("SELECT status FROM platform_payments WHERE tenant_id=$1", [tenantId])).rows[0].status).toBe("PENDING");
  });

  it("serializes repeated setup payment requests into one PAID payment", async () => {
    const id = await createSignup(); const { tenantId } = await approve(id);
    const responses = await Promise.all([action(tenantId!, "mark_setup_paid"), action(tenantId!, "mark_setup_paid")]);
    expect(responses.map(r => r.status)).toEqual([200,200]);
    const payments = await pool.query("SELECT amount,status FROM platform_payments WHERE tenant_id=$1", [tenantId]);
    expect(payments.rows).toEqual([{ amount:"900000", status:"PAID" }]);
  });

  it("requires paid/waived setup and makes double activation one open job", async () => {
    const id = await createSignup(); const { tenantId } = await approve(id);
    expect((await action(tenantId!, "activate")).status).toBe(409);
    expect((await action(tenantId!, "mark_setup_paid")).status).toBe(200);
    expect((await action(tenantId!, "activate")).status).toBe(200);
    expect((await action(tenantId!, "activate")).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int count FROM provisioning_jobs WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(1);
  });

  it("rejects commercial mutations for a legacy tenant without signup", async () => {
    const tenantId = randomUUID();
    await pool.query("INSERT INTO tenants (id,name,slug,status,plan_id) VALUES ($1,'Legacy','legacy-test','active','legacy')", [tenantId]);
    await pool.query("INSERT INTO subscriptions (id,tenant_id,plan_id,status,source) VALUES ($1,$2,'legacy','active','DIRECT')", [randomUUID(),tenantId]);
    expect((await action(tenantId, "mark_setup_paid")).status).toBe(409);
    expect((await action(tenantId, "activate")).status).toBe(409);
    expect((await pool.query("SELECT count(*)::int count FROM platform_payments WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM provisioning_jobs WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(0);
  });
});

describe("commercial subscription isolation and state machine", () => {
  it("updates only tenant A current subscription, never tenant B or history", async () => {
    const a = await approve(await createSignup()); const b = await approve(await createSignup());
    const historicalId = randomUUID();
    await pool.query("INSERT INTO subscriptions (id,tenant_id,plan_id,status,source) VALUES ($1,$2,'standard','cancelled','DIRECT')", [historicalId,a.tenantId]);
    await pool.query("UPDATE subscriptions SET status='active' WHERE tenant_id IN ($1,$2) AND status='suspended'", [a.tenantId,b.tenantId]);
    expect((await action(a.tenantId!, "extend", { days: 30 })).status).toBe(200);
    expect((await pool.query("SELECT current_period_ends_at FROM subscriptions WHERE tenant_id=$1 AND status='active'", [a.tenantId])).rows[0].current_period_ends_at).toBeTruthy();
    expect((await pool.query("SELECT current_period_ends_at FROM subscriptions WHERE tenant_id=$1 AND status='active'", [b.tenantId])).rows[0].current_period_ends_at).toBeNull();
    expect((await pool.query("SELECT status FROM subscriptions WHERE id=$1", [historicalId])).rows[0].status).toBe("cancelled");
  });

  it("reactivates only SUSPENDED", async () => {
    const approved = await approve(await createSignup());
    expect((await action(approved.tenantId!, "reactivate")).status).toBe(200);
    await pool.query("UPDATE subscriptions SET status='trial' WHERE tenant_id=$1", [approved.tenantId]);
    expect((await action(approved.tenantId!, "reactivate")).status).toBe(409);
    expect((await pool.query("SELECT status FROM subscriptions WHERE tenant_id=$1", [approved.tenantId])).rows[0].status).toBe("trial");
  });

  it("does not extend or resurrect SUSPENDED", async () => {
    const approved = await approve(await createSignup());
    expect((await action(approved.tenantId!, "extend", { days:30 })).status).toBe(409);
    expect((await pool.query("SELECT status,current_period_ends_at FROM subscriptions WHERE tenant_id=$1", [approved.tenantId])).rows[0])
      .toMatchObject({ status:"suspended", current_period_ends_at:null });
  });
});

describe("migration preflight", () => {
  it("fails closed on duplicate current subscriptions before creating indexes", async () => {
    const sql = readFileSync(new URL("../../../../lib/platform-db/migrations/0005_commercial_saas_foundation.sql", import.meta.url), "utf8");
    const preflight = sql.match(/DO \$\$[\s\S]*?END \$\$;/)?.[0]; expect(preflight).toBeTruthy();
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL search_path TO pg_temp");
      await client.query("CREATE TEMP TABLE plans(id text,code text); CREATE TEMP TABLE subscriptions(tenant_id text,status text); CREATE TEMP TABLE provisioning_jobs(tenant_id text,status text)");
      await client.query("INSERT INTO subscriptions VALUES ('tenant-a','active'),('tenant-a','trial')");
      await expect(client.query(preflight!)).rejects.toThrow(/multiple current subscriptions/);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});

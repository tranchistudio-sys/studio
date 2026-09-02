import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import express from "express";
import type { PoolClient } from "pg";
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
let signupSequence = 0;
const pool = getPlatformPool();
const migrationUrls = [1,2,3,4,5,6,7].map(number => new URL(
  `../../../../lib/platform-db/migrations/000${number}_${[
    "platform_foundation", "membership_session_revocation", "tenant_database_registry_isolation",
    "staff_access_requests", "commercial_saas_foundation", "tenant_provisioning_engine", "platform_admin_commercial_dashboard",
  ][number - 1]}.sql`, import.meta.url));
const migrationSql = migrationUrls.map(url => readFileSync(url, "utf8"));

async function api(path: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createSignup(status = "PENDING", identity?: { email?:string; phone?:string; plan?:"STANDARD"|"PRO" }) {
  const id = randomUUID();
  const sequence = ++signupSequence;
  const email = identity?.email ?? `owner-${sequence}@example.com`;
  const phone = identity?.phone ?? `09${String(sequence).padStart(8,"0")}`;
  await pool.query(`INSERT INTO studio_signup_requests
    (id,owner_name,studio_name,phone,email,requested_slug,requested_plan_code,status)
    VALUES ($1,'Owner','Studio',$2,$3,$4,$5,$6)`,
    [id,phone,email,`studio-${id.slice(0, 8)}`,identity?.plan??"STANDARD",status]);
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

async function makeCommercialActive(tenantId: string) {
  await pool.query("UPDATE studio_signup_requests SET status='ACTIVE' WHERE tenant_id=$1", [tenantId]);
  await pool.query("UPDATE tenants SET status='active' WHERE id=$1", [tenantId]);
  await pool.query(`UPDATE subscriptions SET status='active',current_period_start=now(),current_period_ends_at=now()+interval '30 days'
    WHERE tenant_id=$1 AND status IN ('trial','active','past_due','suspended')`, [tenantId]);
  await pool.query(`INSERT INTO tenant_database_registry
    (tenant_id,database_ref,host_ref,database_name,role_name,secret_ref,health_status)
    VALUES ($1,$2,'test-host',$3,'test-role','test-secret','healthy')`,
    [tenantId, `db-${tenantId}`, `tenant_${tenantId.replace(/-/g, "")}`]);
}

async function withMigrationSchema(run: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  const schema = `migration_test_${randomUUID().replace(/-/g, "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const sql of migrationSql.slice(0, 4)) await client.query(sql);
    await run(client);
  } finally { await client.query("ROLLBACK"); client.release(); }
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
  signupSequence = 0;
  await pool.query(`TRUNCATE TABLE platform_payments,tenant_branding,tenant_domains,studio_signup_requests,
    provisioning_jobs,tenant_database_secrets,subscriptions,tenant_database_registry,sessions,tenant_memberships,tenants,
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

  it("serializes truly concurrent approve requests without duplicate records", async () => {
    const id = await createSignup(); const [first, second] = await Promise.all([approve(id), approve(id)]);
    expect([first.response.status, second.response.status]).toEqual([200,200]);
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
  it("only retries a FAILED provisioning job and preserves its idempotency metadata", async () => {
    const id=await createSignup();const {tenantId}=await approve(id);await action(tenantId!,"mark_setup_paid");await action(tenantId!,"activate");
    await pool.query(`UPDATE provisioning_jobs SET status='failed',step='FAILED',failed_step='RUNNING_MIGRATIONS',safe_retry='{"databaseName":"tenant_safe"}'::jsonb WHERE tenant_id=$1`,[tenantId]);
    await pool.query("UPDATE tenants SET status='provisioning_failed' WHERE id=$1",[tenantId]);
    const response=await action(tenantId!,"retry_provisioning");expect(response.status).toBe(200);
    const job=await pool.query("SELECT status,step,safe_retry FROM provisioning_jobs WHERE tenant_id=$1",[tenantId]);
    expect(job.rows[0]).toMatchObject({status:"pending",step:"QUEUED",safe_retry:{databaseName:"tenant_safe"}});
    expect((await action(tenantId!,"retry_provisioning")).status).toBe(409);
  });
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
    const audit = await pool.query(`SELECT metadata FROM platform_audit_logs WHERE tenant_id=$1
      AND action='commercial.mark_setup_paid' AND metadata->>'paymentResult'='transitioned_to_paid'`, [tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ paymentStatus:"PAID", paymentResult:"transitioned_to_paid" });
  });

  it("requires paid/waived setup and makes double activation one open job", async () => {
    const id = await createSignup(); const { tenantId } = await approve(id);
    expect((await action(tenantId!, "activate")).status).toBe(409);
    expect((await action(tenantId!, "mark_setup_paid")).status).toBe(200);
    expect((await action(tenantId!, "activate")).status).toBe(200);
    expect((await action(tenantId!, "activate")).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int count FROM provisioning_jobs WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(1);
  });

  it("creates and preserves WAIVED setup semantics through the commercial API", async () => {
    const id = await createSignup(); const { tenantId } = await approve(id);
    expect((await action(tenantId!, "waive_setup_fee")).status).toBe(200);
    expect((await action(tenantId!, "mark_setup_paid")).status).toBe(200);
    expect((await pool.query("SELECT status,paid_at FROM platform_payments WHERE tenant_id=$1", [tenantId])).rows[0])
      .toMatchObject({ status:"WAIVED", paid_at:null });
    const audit = await pool.query("SELECT action,metadata FROM platform_audit_logs WHERE tenant_id=$1 AND action IN ('commercial.waive_setup_fee','commercial.mark_setup_paid') ORDER BY created_at", [tenantId]);
    expect(audit.rows).toEqual([
      { action:"commercial.waive_setup_fee", metadata:expect.objectContaining({ paymentStatus:"WAIVED", paymentResult:"transitioned_to_waived" }) },
      { action:"commercial.mark_setup_paid", metadata:expect.objectContaining({ paymentStatus:"WAIVED", paymentResult:"preserved_waived" }) },
    ]);
    expect((await action(tenantId!, "activate")).status).toBe(200);
  });

  it("blocks a repeated canonical owner trial until Platform Owner grants an audited override", async () => {
    const identity={email:"repeat-owner@example.com",phone:"0909999999"};
    const first=await approve(await createSignup("PENDING",identity));await makeCommercialActive(first.tenantId!);
    const secondId=await createSignup("PENDING",identity);
    expect((await approve(secondId)).response.status).toBe(409);
    expect((await api(`/platform-admin/api/signups/${secondId}/trial_override`,{})).status).toBe(200);
    const approved=await approve(secondId);expect(approved.response.status).toBe(200);expect(approved.tenantId).toBeTruthy();
    const audit=await pool.query("SELECT metadata FROM platform_audit_logs WHERE action='signup.trial_override' AND target_id=$1",[secondId]);
    expect(audit.rows[0].metadata).toMatchObject({manual:true,reason:"platform_owner_override"});
  });

  it("does not downgrade a PAID setup fee to WAIVED", async () => {
    const id = await createSignup(); const { tenantId } = await approve(id);
    expect((await action(tenantId!, "mark_setup_paid")).status).toBe(200);
    expect((await action(tenantId!, "waive_setup_fee")).status).toBe(409);
    expect((await pool.query("SELECT status,paid_at FROM platform_payments WHERE tenant_id=$1", [tenantId])).rows[0])
      .toMatchObject({ status:"PAID" });
  });

  it("rejects commercial mutations for a legacy tenant without signup", async () => {
    const tenantId = randomUUID();
    await pool.query("INSERT INTO tenants (id,name,slug,status,plan_id) VALUES ($1,'Legacy','legacy-test','active','legacy')", [tenantId]);
    await pool.query("INSERT INTO subscriptions (id,tenant_id,plan_id,status,source) VALUES ($1,$2,'legacy','active','DIRECT')", [randomUUID(),tenantId]);
    const attempts = await Promise.all([
      action(tenantId, "extend", { days:30 }), action(tenantId, "change_plan", { planCode:"PRO" }),
      action(tenantId, "suspend"), action(tenantId, "reactivate"),
      action(tenantId, "mark_setup_paid"), action(tenantId, "waive_setup_fee"), action(tenantId, "activate"),
    ]);
    expect(attempts.map(response => response.status)).toEqual([409,409,409,409,409,409,409]);
    expect((await pool.query("SELECT status,plan_id FROM tenants WHERE id=$1", [tenantId])).rows[0]).toMatchObject({ status:"active", plan_id:"legacy" });
    expect((await pool.query("SELECT status,plan_id,current_period_ends_at FROM subscriptions WHERE tenant_id=$1", [tenantId])).rows[0])
      .toMatchObject({ status:"active", plan_id:"legacy", current_period_ends_at:null });
    expect((await pool.query("SELECT count(*)::int count FROM platform_payments WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM provisioning_jobs WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(0);
  });

  it("persists custom setup, trial, price, class, renewal payment and notes with audit", async () => {
    const approved=await approve(await createSignup()); const tenantId=approved.tenantId!;
    expect((await action(tenantId,"update_setup_fee",{amount:450000,status:"WAIVED",note:"pilot"})).status).toBe(200);
    await makeCommercialActive(tenantId);
    await pool.query("UPDATE subscriptions SET status='trial' WHERE tenant_id=$1",[tenantId]);
    expect((await action(tenantId,"update_trial",{trialStart:"2026-09-02",months:3,reason:"partner pilot"})).status).toBe(200);
    expect((await action(tenantId,"update_price",{basePriceAmount:1000000,customPriceAmount:750000,note:"partner price"})).status).toBe(200);
    expect((await action(tenantId,"change_class",{commercialClass:"PARTNER",reason:"launch partner"})).status).toBe(200);
    expect((await action(tenantId,"add_note",{note:"Owner prefers bank transfer"})).status).toBe(200);
    expect((await action(tenantId,"renew",{months:3,amount:2250000,paymentMethod:"BANK_TRANSFER"})).status).toBe(200);
    const subscription=(await pool.query("SELECT custom_price_amount,commercial_class,trial_ends_at FROM subscriptions WHERE tenant_id=$1",[tenantId])).rows[0];
    expect(subscription).toMatchObject({custom_price_amount:"750000",commercial_class:"PARTNER"});
    expect(new Date(subscription.trial_ends_at).toISOString()).toBe("2026-12-02T00:00:00.000Z");
    expect((await pool.query("SELECT count(*)::int count FROM tenant_commercial_notes WHERE tenant_id=$1",[tenantId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT amount,status,payment_method FROM platform_payments WHERE tenant_id=$1 AND payment_type='SUBSCRIPTION'",[tenantId])).rows[0])
      .toMatchObject({amount:"2250000",status:"PAID",payment_method:"BANK_TRANSFER"});
    expect((await pool.query("SELECT count(*)::int count FROM platform_audit_logs WHERE tenant_id=$1 AND action IN ('commercial.update_trial','commercial.update_price','commercial.change_class','commercial.add_note','commercial.renew')",[tenantId])).rows[0].count).toBe(5);
  });
});

describe("commercial subscription isolation and state machine", () => {
  it("updates only tenant A current subscription, never tenant B or history", async () => {
    const a = await approve(await createSignup()); const b = await approve(await createSignup());
    const historicalId = randomUUID();
    await pool.query("INSERT INTO subscriptions (id,tenant_id,plan_id,status,source) VALUES ($1,$2,'standard','cancelled','DIRECT')", [historicalId,a.tenantId]);
    await makeCommercialActive(a.tenantId!); await makeCommercialActive(b.tenantId!);
    await pool.query("UPDATE subscriptions SET current_period_ends_at=NULL WHERE tenant_id=$1", [b.tenantId]);
    expect((await action(a.tenantId!, "extend", { days: 30 })).status).toBe(200);
    expect((await pool.query("SELECT current_period_ends_at FROM subscriptions WHERE tenant_id=$1 AND status='active'", [a.tenantId])).rows[0].current_period_ends_at).toBeTruthy();
    expect((await pool.query("SELECT current_period_ends_at FROM subscriptions WHERE tenant_id=$1 AND status='active'", [b.tenantId])).rows[0].current_period_ends_at).toBeNull();
    expect((await pool.query("SELECT status FROM subscriptions WHERE id=$1", [historicalId])).rows[0].status).toBe("cancelled");
  });

  it("rejects reactivate for approved bootstrap and provisioning states", async () => {
    const approved = await approve(await createSignup());
    expect((await action(approved.tenantId!, "extend", { days:30 })).status).toBe(409);
    expect((await action(approved.tenantId!, "change_plan", { planCode:"PRO" })).status).toBe(409);
    expect((await action(approved.tenantId!, "suspend")).status).toBe(409);
    expect((await action(approved.tenantId!, "reactivate")).status).toBe(409);
    await pool.query("UPDATE studio_signup_requests SET status='PROVISIONING' WHERE tenant_id=$1", [approved.tenantId]);
    expect((await action(approved.tenantId!, "reactivate")).status).toBe(409);
    expect((await pool.query("SELECT status FROM tenants WHERE id=$1", [approved.tenantId])).rows[0].status).toBe("provisioning");
  });

  it("reactivates only a provisioned ACTIVE lifecycle with an unexpired period", async () => {
    const approved = await approve(await createSignup()); await makeCommercialActive(approved.tenantId!);
    expect((await action(approved.tenantId!, "suspend")).status).toBe(200);
    expect((await action(approved.tenantId!, "reactivate")).status).toBe(200);
    expect((await pool.query("SELECT status FROM tenants WHERE id=$1", [approved.tenantId])).rows[0].status).toBe("active");
  });

  it("suspends and reactivates a trial without resetting its trial clock", async () => {
    const approved=await approve(await createSignup());await makeCommercialActive(approved.tenantId!);
    await pool.query("UPDATE subscriptions SET status='trial' WHERE tenant_id=$1",[approved.tenantId]);
    const before=(await pool.query("SELECT current_period_start,current_period_ends_at FROM subscriptions WHERE tenant_id=$1",[approved.tenantId])).rows[0];
    expect((await action(approved.tenantId!,"suspend")).status).toBe(200);
    expect((await action(approved.tenantId!,"reactivate")).status).toBe(200);
    const after=(await pool.query("SELECT status,current_period_start,current_period_ends_at FROM subscriptions WHERE tenant_id=$1",[approved.tenantId])).rows[0];
    expect(after.status).toBe("trial");expect(after.current_period_start).toEqual(before.current_period_start);
    expect(after.current_period_ends_at).toEqual(before.current_period_ends_at);
  });

  it("rejects reactivation after the subscription period expires", async () => {
    const approved = await approve(await createSignup()); await makeCommercialActive(approved.tenantId!);
    expect((await action(approved.tenantId!, "suspend")).status).toBe(200);
    await pool.query("UPDATE subscriptions SET current_period_ends_at=now()-interval '1 second' WHERE tenant_id=$1", [approved.tenantId]);
    expect((await action(approved.tenantId!, "reactivate")).status).toBe(409);
    expect((await pool.query("SELECT status FROM tenants WHERE id=$1", [approved.tenantId])).rows[0].status).toBe("suspended");
  });

  it("does not extend or resurrect SUSPENDED", async () => {
    const approved = await approve(await createSignup());
    expect((await action(approved.tenantId!, "extend", { days:30 })).status).toBe(409);
    expect((await pool.query("SELECT status,current_period_ends_at FROM subscriptions WHERE tenant_id=$1", [approved.tenantId])).rows[0])
      .toMatchObject({ status:"suspended", current_period_ends_at:null });
  });
});

describe("migration preflight", () => {
  it("runs the dashboard migration twice and preserves its flexible commercial schema", async () => {
    await withMigrationSchema(async client => {
      await client.query(migrationSql[4]!); await client.query(migrationSql[5]!);
      await client.query(migrationSql[6]!); await client.query(migrationSql[6]!);
      const columns=await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='subscriptions'
        AND column_name IN ('commercial_class','custom_price_amount','trial_starts_at') ORDER BY column_name`);
      expect(columns.rows.map(row=>row.column_name)).toEqual(["commercial_class","custom_price_amount","trial_starts_at"]);
    });
  });
  it("runs the complete 0005 migration on a clean schema and is idempotent", async () => {
    await withMigrationSchema(async client => {
      await client.query(migrationSql[4]!); await client.query(migrationSql[4]!);
      expect((await client.query("SELECT code FROM plans WHERE id IN ('standard','pro') ORDER BY id")).rows).toEqual([{code:"PRO"},{code:"STANDARD"}]);
    });
  });

  it.each([
    ["multiple current subscriptions", async (client:any) => {
      const tenant=randomUUID(); await client.query("INSERT INTO tenants(id,name,slug) VALUES($1,'T','t')",[tenant]);
      await client.query("INSERT INTO subscriptions(id,tenant_id,plan_id,status) VALUES($1,$3,'legacy','active'),($2,$3,'legacy','trial')",[randomUUID(),randomUUID(),tenant]);
    }],
    ["multiple open provisioning jobs", async (client:any) => {
      const tenant=randomUUID(); await client.query("INSERT INTO tenants(id,name,slug) VALUES($1,'T','t')",[tenant]);
      await client.query("INSERT INTO provisioning_jobs(id,tenant_id,status) VALUES($1,$3,'pending'),($2,$3,'running')",[randomUUID(),randomUUID(),tenant]);
    }],
  ])("fails and rolls back the full migration for %s", async (message, arrange) => {
    await withMigrationSchema(async client => {
      await arrange(client); await client.query("SAVEPOINT before_migration");
      await expect(client.query(migrationSql[4]!)).rejects.toThrow(new RegExp(message));
      await client.query("ROLLBACK TO SAVEPOINT before_migration");
      expect((await client.query("SELECT count(*)::int count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='plans' AND column_name='code'")).rows[0].count).toBe(0);
    });
  });

  it.each([
    ["duplicate plan codes", "ALTER TABLE plans ADD COLUMN code text; INSERT INTO plans(id,name,code) VALUES('x','X','DUP'),('y','Y','dup')"],
    ["non-canonical plan owner", "ALTER TABLE plans ADD COLUMN code text; INSERT INTO plans(id,name,code) VALUES('other','Other','STANDARD')"],
    ["canonical conflicting code", "ALTER TABLE plans ADD COLUMN code text; INSERT INTO plans(id,name,code) VALUES('standard','Standard','PRO')"],
  ])("rejects %s using the complete migration", async (name, fixture) => {
    await withMigrationSchema(async client => {
      await client.query(fixture); await client.query("SAVEPOINT before_migration");
      await expect(client.query(migrationSql[4]!)).rejects.toThrow(/commercial preflight/);
      await client.query("ROLLBACK TO SAVEPOINT before_migration");
    });
  });

  it("preserves custom canonical pricing and features", async () => {
    await withMigrationSchema(async client => {
      await client.query(`ALTER TABLE plans ADD COLUMN code text; ALTER TABLE plans ADD COLUMN setup_fee_amount bigint;
        ALTER TABLE plans ADD COLUMN monthly_price_amount bigint; ALTER TABLE plans ADD COLUMN currency text DEFAULT 'VND';
        ALTER TABLE plans ADD COLUMN features jsonb DEFAULT '{}'::jsonb;
        INSERT INTO plans(id,name,code,setup_fee_amount,monthly_price_amount,currency,features)
        VALUES('standard','Custom','STANDARD',123,456,'USD','{"custom":true}')`);
      await client.query(migrationSql[4]!);
      expect((await client.query("SELECT setup_fee_amount,monthly_price_amount,currency,features FROM plans WHERE id='standard'")).rows[0])
        .toMatchObject({ setup_fee_amount:"123", monthly_price_amount:"456", currency:"USD", features:{custom:true} });
    });
  });
});

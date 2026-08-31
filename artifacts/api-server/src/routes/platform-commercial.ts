import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { getPlatformPool, normalizeEmail, withPlatformTransaction } from "@workspace/platform-db";
import { requirePlatformSession, requirePlatformCsrf, requestIsSameOrigin } from "../middlewares/platform-auth";
import { requirePlatformOwner } from "../middlewares/platform-owner";
import { verifyLoginCsrf } from "../platform/session";
import type { PlatformSessionContext } from "../platform/types";
import { getTenantEntitlements } from "../platform/entitlements";

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+(). -]{8,20}$/;
const plan = (v: unknown) => v === "STANDARD" || v === "PRO" ? v : null;
const context = (res: Parameters<typeof requirePlatformOwner>[1]) => res.locals.platformAuth as PlatformSessionContext;

router.post("/studio-signups", async (req, res) => {
  if (!requestIsSameOrigin(req) || !verifyLoginCsrf(req, req.body?.loginCsrfToken)) {
    res.status(403).json({ error: "Phiên đăng ký không hợp lệ", code: "LOGIN_CSRF_INVALID" }); return;
  }
  const ownerName = String(req.body?.ownerName ?? "").trim();
  const studioName = String(req.body?.studioName ?? "").trim();
  const phone = String(req.body?.phone ?? "").trim();
  const email = normalizeEmail(String(req.body?.email ?? ""));
  const address = String(req.body?.address ?? "").trim() || null;
  const requestedSlug = String(req.body?.requestedSlug ?? "").trim().toLowerCase();
  const requestedPlanCode = plan(req.body?.requestedPlanCode);
  if (ownerName.length < 2 || studioName.length < 2 || !PHONE.test(phone) || !EMAIL.test(email) ||
      !SLUG.test(requestedSlug) || !requestedPlanCode) {
    res.status(400).json({ error: "Thông tin đăng ký không hợp lệ" }); return;
  }
  try {
    const id = randomUUID();
    await getPlatformPool().query(
      `INSERT INTO studio_signup_requests
       (id, owner_name, studio_name, phone, email, address, requested_slug, requested_plan_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, ownerName, studioName, phone, email, address, requestedSlug, requestedPlanCode]);
    res.status(201).json({ id, status: "PENDING", message: "Đã gửi đăng ký. Chúng tôi sẽ liên hệ để xác nhận." });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "23505") { res.status(409).json({ error: "Slug này đang có yêu cầu xử lý" }); return; }
    res.status(503).json({ error: "Chưa thể nhận đăng ký" });
  }
});

router.use("/platform-admin/api", requirePlatformSession, requirePlatformOwner);

router.get("/platform-admin/api/dashboard", async (_req, res) => {
  const q = await getPlatformPool().query(`SELECT
    count(*) FILTER (WHERE status='PENDING')::int AS pending_signups,
    (SELECT count(*)::int FROM tenants WHERE status IN ('active','trial')) AS active_studios,
    (SELECT count(*)::int FROM subscriptions WHERE current_period_ends_at < now()) AS expired_studios,
    (SELECT count(*)::int FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE upper(COALESCE(p.code,p.id))='STANDARD' AND s.status='active') AS standard_count,
    (SELECT count(*)::int FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE upper(COALESCE(p.code,p.id))='PRO' AND s.status='active') AS pro_count,
    (SELECT count(*)::int FROM provisioning_jobs WHERE status IN ('failed','cleanup_required')) AS provisioning_failed
    FROM studio_signup_requests`);
  res.json(q.rows[0]);
});

router.get("/platform-admin/api/signups", async (_req, res) => {
  const q = await getPlatformPool().query(`SELECT * FROM studio_signup_requests ORDER BY created_at DESC LIMIT 200`);
  res.json(q.rows);
});

router.get("/platform-admin/api/studios", async (_req, res) => {
  const q = await getPlatformPool().query(`SELECT t.id,t.name,t.slug,t.status,p.code AS plan_code,
    s.status AS subscription_status,s.current_period_ends_at,r.health_status AS registry_status
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id AND s.status<>'cancelled'
    LEFT JOIN plans p ON p.id=s.plan_id LEFT JOIN tenant_database_registry r ON r.tenant_id=t.id
    ORDER BY t.created_at DESC LIMIT 200`);
  res.json(q.rows);
});

router.post("/platform-admin/api/signups/:id/:action", requirePlatformCsrf, async (req, res) => {
  const id = String(req.params.id); const action = String(req.params.action);
  const next = ({ contact: "CONTACTED", approve: "APPROVED", reject: "REJECTED" } as const)[action as "contact"|"approve"|"reject"];
  if (!UUID.test(id) || !next) { res.status(400).json({ error: "Yêu cầu/action không hợp lệ" }); return; }
  const actor = context(res);
  const q = await withPlatformTransaction(async client => {
    const current = await client.query<{ tenant_id:string|null; studio_name:string; requested_slug:string; requested_plan_code:string; owner_name:string }>(
      "SELECT tenant_id,studio_name,requested_slug,requested_plan_code,owner_name FROM studio_signup_requests WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return null;
    let tenantId = current.rows[0].tenant_id;
    if (next === "APPROVED" && !tenantId) {
      tenantId = randomUUID();
      const subscriptionId = randomUUID();
      await client.query(`INSERT INTO tenants (id,name,slug,status,plan_id) VALUES ($1,$2,$3,'provisioning',
        (SELECT id FROM plans WHERE upper(COALESCE(code,id))=$4 LIMIT 1))`,
        [tenantId,current.rows[0].studio_name,current.rows[0].requested_slug,current.rows[0].requested_plan_code]);
      await client.query(`INSERT INTO subscriptions (id,tenant_id,plan_id,status,source)
        SELECT $1,$2,id,'suspended','DIRECT' FROM plans WHERE upper(COALESCE(code,id))=$3 LIMIT 1`,
        [subscriptionId,tenantId,current.rows[0].requested_plan_code]);
      await client.query(`INSERT INTO platform_payments
        (id,tenant_id,signup_request_id,subscription_id,payment_type,amount,status,source,created_by)
        SELECT $1,$2,$3,$4,'SETUP_FEE',setup_fee_amount,'PENDING','DIRECT',$5 FROM plans
        WHERE upper(COALESCE(code,id))=$6 LIMIT 1`,
        [randomUUID(),tenantId,id,subscriptionId,actor.userId,current.rows[0].requested_plan_code]);
      await client.query(`INSERT INTO tenant_branding (tenant_id,public_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [tenantId,current.rows[0].studio_name]);
    }
    const updated = await client.query(`UPDATE studio_signup_requests SET status=$2, reviewed_by=$3, tenant_id=COALESCE(tenant_id,$4),
      reviewed_at=CASE WHEN $2 IN ('APPROVED','REJECTED') THEN now() ELSE reviewed_at END, updated_at=now()
      WHERE id=$1 AND status NOT IN ('ACTIVE','REJECTED') RETURNING *`, [id, next, actor.userId, tenantId]);
    if (!updated.rows[0]) return null;
    await client.query(`INSERT INTO platform_audit_logs (id,actor_user_id,action,target_type,target_id,metadata)
      VALUES ($1,$2,$3,'studio_signup_request',$4,$5::jsonb)`,
      [randomUUID(), actor.userId, `signup.${action}`, id, JSON.stringify({ status: next, tenantId })]);
    return updated.rows[0];
  });
  if (!q) { res.status(404).json({ error: "Không tìm thấy yêu cầu" }); return; }
  res.json(q);
});

router.get("/platform-admin/api/studios/:tenantId", async (req, res) => {
  const tenantId = String(req.params.tenantId);
  if (!UUID.test(tenantId)) { res.status(400).json({ error: "Studio không hợp lệ" }); return; }
  const q = await getPlatformPool().query(`SELECT t.*, s.id AS subscription_id, s.status AS subscription_status,
    s.source, s.starts_at, s.current_period_ends_at, p.code AS plan_code, p.setup_fee_amount,
    r.health_status AS registry_status, d.hostname AS domain
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id AND s.status <> 'cancelled'
    LEFT JOIN plans p ON p.id=s.plan_id LEFT JOIN tenant_database_registry r ON r.tenant_id=t.id
    LEFT JOIN tenant_domains d ON d.tenant_id=t.id AND d.status='active' WHERE t.id=$1 LIMIT 1`, [tenantId]);
  if (!q.rows[0]) { res.status(404).json({ error: "Không tìm thấy studio" }); return; }
  res.json({ ...q.rows[0], entitlements: await getTenantEntitlements(tenantId) });
});

router.post("/platform-admin/api/studios/:tenantId/action", requirePlatformCsrf, async (req, res) => {
  const tenantId = String(req.params.tenantId); const action = String(req.body?.action ?? "");
  if (!UUID.test(tenantId)) { res.status(400).json({ error: "Studio không hợp lệ" }); return; }
  const actor = context(res); const allowed = new Set(["extend","change_plan","suspend","reactivate","mark_setup_paid","activate"]);
  if (!allowed.has(action)) { res.status(400).json({ error: "Action không hợp lệ" }); return; }
  try {
    const result = await withPlatformTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`commercial:${tenantId}`]);
      const tenant = await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
      if (!tenant.rows[0]) throw new Error("Không tìm thấy studio");
      if (action === "suspend" || action === "reactivate") {
        const status = action === "suspend" ? "suspended" : "active";
        await client.query("UPDATE tenants SET status=$2, updated_at=now() WHERE id=$1", [tenantId, status]);
        await client.query("UPDATE subscriptions SET status=$2, updated_at=now() WHERE tenant_id=$1 AND status <> 'cancelled'", [tenantId, status === "active" ? "active" : "suspended"]);
      } else if (action === "extend") {
        const days = Number(req.body?.days ?? 30); if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error("Số ngày gia hạn không hợp lệ");
        await client.query(`UPDATE subscriptions SET current_period_start=COALESCE(current_period_start,now()),
          current_period_ends_at=GREATEST(COALESCE(current_period_ends_at,now()),now()) + ($2 || ' days')::interval,
          status='active', updated_at=now() WHERE tenant_id=$1 AND status <> 'cancelled'`, [tenantId, days]);
      } else if (action === "change_plan") {
        const code = plan(req.body?.planCode); if (!code) throw new Error("Plan không hợp lệ");
        await client.query(`UPDATE subscriptions SET plan_id=(SELECT id FROM plans WHERE upper(COALESCE(code,id))=$2 LIMIT 1), updated_at=now()
          WHERE tenant_id=$1 AND status <> 'cancelled'`, [tenantId, code]);
      } else if (action === "mark_setup_paid") {
        const p = await client.query("SELECT setup_fee_amount FROM plans p JOIN subscriptions s ON s.plan_id=p.id WHERE s.tenant_id=$1 AND s.status<>'cancelled' LIMIT 1", [tenantId]);
        await client.query(`INSERT INTO platform_payments (id,tenant_id,payment_type,amount,status,paid_at,created_by)
          VALUES ($1,$2,'SETUP_FEE',$3,'PAID',now(),$4)
          ON CONFLICT (tenant_id, payment_type) WHERE tenant_id IS NOT NULL AND payment_type='SETUP_FEE' AND status<>'VOID'
          DO UPDATE SET status='PAID', paid_at=COALESCE(platform_payments.paid_at,now()), updated_at=now()`,
          [randomUUID(), tenantId, Number(p.rows[0]?.setup_fee_amount ?? 900000), actor.userId]);
      } else if (action === "activate") {
        const paid = await client.query(`SELECT id FROM platform_payments WHERE tenant_id=$1 AND payment_type='SETUP_FEE'
          AND status IN ('PAID','WAIVED') LIMIT 1`, [tenantId]);
        if (!paid.rows[0]) throw new Error("Setup fee chưa được xác nhận PAID hoặc WAIVED");
        await client.query("UPDATE tenants SET status='provisioning', updated_at=now() WHERE id=$1", [tenantId]);
        await client.query(`INSERT INTO provisioning_jobs (id,tenant_id,status,step) VALUES ($1,$2,'pending','QUEUED')
          ON CONFLICT DO NOTHING`, [randomUUID(), tenantId]);
        await client.query("UPDATE studio_signup_requests SET status='PROVISIONING',updated_at=now() WHERE tenant_id=$1", [tenantId]);
      }
      await client.query(`INSERT INTO platform_audit_logs (id,actor_user_id,tenant_id,action,target_type,target_id,metadata)
        VALUES ($1,$2,$3,$4,'tenant',$3,$5::jsonb)`, [randomUUID(), actor.userId, tenantId, `commercial.${action}`, JSON.stringify({ days: req.body?.days, planCode: req.body?.planCode })]);
      return { success: true };
    });
    res.json(result);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Không thể xử lý" }); }
});

export default router;

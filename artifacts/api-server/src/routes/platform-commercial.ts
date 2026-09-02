import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { getPlatformPool, normalizeEmail, withPlatformTransaction } from "@workspace/platform-db";
import { requirePlatformSession, requirePlatformCsrf, requestIsSameOrigin } from "../middlewares/platform-auth";
import { requirePlatformOwner } from "../middlewares/platform-owner";
import { verifyLoginCsrf } from "../platform/session";
import type { PlatformSessionContext } from "../platform/types";
import { getTenantEntitlements } from "../platform/entitlements";
import { createLoginRateLimit } from "../lib/login-rate-limit";

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+(). -]{8,20}$/;
const plan = (v: unknown) => v === "STANDARD" || v === "PRO" ? v : null;
const context = (res: Parameters<typeof requirePlatformOwner>[1]) => res.locals.platformAuth as PlatformSessionContext;
const CURRENT_SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "suspended"] as const;
const studioSignupRateLimit = createLoginRateLimit({
  bucketPrefix: "studio-signup", maxAttempts: 10, windowMs: 15 * 60_000,
  errorMessage: "Bạn gửi quá nhiều yêu cầu đăng ký. Vui lòng chờ rồi thử lại.",
});

class CommercialConflictError extends Error {}
type TransactionClient = Parameters<Parameters<typeof withPlatformTransaction>[0]>[0];

async function getCommercialSignupForUpdate(client: TransactionClient, tenantId: string) {
  const result = await client.query<{ id: string; status: string }>(
    `SELECT id,status FROM studio_signup_requests WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
  if (result.rows.length !== 1) throw new CommercialConflictError("Studio không thuộc commercial signup lifecycle");
  return result.rows[0]!;
}

async function getCurrentCommercialSubscriptionForUpdate(client: TransactionClient, tenantId: string) {
  const result = await client.query<{ id:string; status:string; plan_id:string; setup_fee_amount:string|null; period_active:boolean }>(
    `SELECT s.id,s.status,s.plan_id,p.setup_fee_amount,(s.current_period_ends_at > now()) AS period_active
       FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.tenant_id=$1 AND s.source='DIRECT' AND s.status = ANY($2::text[])
      FOR UPDATE OF s`, [tenantId, CURRENT_SUBSCRIPTION_STATUSES]);
  if (result.rows.length !== 1) throw new CommercialConflictError("Studio phải có chính xác một commercial subscription hiện hành");
  return result.rows[0]!;
}

function requireState(actual: string, allowed: readonly string[], action: string): void {
  if (!allowed.includes(actual)) throw new CommercialConflictError(`Không thể ${action} từ trạng thái ${actual}`);
}

async function requireProvisionedRegistry(client: TransactionClient, tenantId: string): Promise<void> {
  const registry = await client.query("SELECT tenant_id FROM tenant_database_registry WHERE tenant_id=$1", [tenantId]);
  if (registry.rows.length !== 1) throw new CommercialConflictError("Studio chưa hoàn tất tenant database provisioning");
}

router.get("/studio-plans", async (_req, res) => {
  try {
    const result = await getPlatformPool().query(`SELECT code,name,setup_fee_amount AS "setupFee",
      monthly_price_amount AS "monthlyPrice",currency FROM plans
      WHERE upper(code) IN ('STANDARD','PRO') AND is_active=true ORDER BY monthly_price_amount`);
    res.json(result.rows);
  } catch { res.status(503).json({ error: "Chưa thể tải bảng giá" }); }
});

router.get("/platform/public-site", async (req, res) => {
  const slug = String(req.query?.tenant ?? "").trim().toLowerCase();
  if (!SLUG.test(slug)) { res.status(404).json({ error: "Không tìm thấy website studio" }); return; }
  try {
    const result = await getPlatformPool().query(`SELECT t.id,t.slug,t.name,
      COALESCE(b.public_name,t.name) AS "publicName",b.logo_url AS "logoUrl",
      b.phone,b.address,b.primary_color AS "primaryColor"
      FROM tenants t LEFT JOIN tenant_branding b ON b.tenant_id=t.id
      WHERE t.slug=$1 AND t.status IN ('active','trial') LIMIT 1`, [slug]);
    if (!result.rows[0]) { res.status(404).json({ error: "Không tìm thấy website studio" }); return; }
    res.json(result.rows[0]);
  } catch { res.status(503).json({ error: "Chưa thể tải thông tin studio" }); }
});

router.post("/studio-signups", studioSignupRateLimit, async (req, res) => {
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
    (SELECT count(*)::int FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE upper(COALESCE(p.code,p.id))='STANDARD' AND s.status IN ('trial','active')) AS standard_count,
    (SELECT count(*)::int FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE upper(COALESCE(p.code,p.id))='PRO' AND s.status IN ('trial','active')) AS pro_count,
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
    s.status AS subscription_status,s.current_period_ends_at,r.health_status AS registry_status,
    j.status AS provisioning_status,j.step AS provisioning_step,j.failed_step AS provisioning_failed_step,
    j.error_code AS provisioning_error_code,j.error_message AS provisioning_error_message,j.last_attempted_at AS provisioning_last_attempted_at
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id AND s.status<>'cancelled'
    LEFT JOIN plans p ON p.id=s.plan_id LEFT JOIN tenant_database_registry r ON r.tenant_id=t.id
    LEFT JOIN LATERAL (SELECT status,step,failed_step,error_code,error_message,last_attempted_at FROM provisioning_jobs
      WHERE tenant_id=t.id ORDER BY created_at DESC LIMIT 1) j ON true
    ORDER BY t.created_at DESC LIMIT 200`);
  res.json(q.rows);
});

router.post("/platform-admin/api/signups/:id/:action", requirePlatformCsrf, async (req, res) => {
  const id = String(req.params.id); const action = String(req.params.action);
  if (!UUID.test(id)) { res.status(400).json({ error: "Yêu cầu/action không hợp lệ" }); return; }
  const actor = context(res);
  if (action === "trial_override") {
    try {
      const signup = await withPlatformTransaction(async client => {
        const current = await client.query<{ status:string }>(
          "SELECT status FROM studio_signup_requests WHERE id=$1 FOR UPDATE", [id]);
        if (!current.rows[0]) return null;
        requireState(current.rows[0].status, ["PENDING","CONTACTED"], "cho phép trial lại");
        const existing = await client.query(`SELECT id FROM platform_audit_logs
          WHERE action='signup.trial_override' AND target_type='studio_signup_request' AND target_id=$1 LIMIT 1`, [id]);
        if (!existing.rows.length) await client.query(`INSERT INTO platform_audit_logs
          (id,actor_user_id,action,target_type,target_id,metadata)
          VALUES($1,$2,'signup.trial_override','studio_signup_request',$3,$4::jsonb)`,
          [randomUUID(),actor.userId,id,JSON.stringify({manual:true,reason:"platform_owner_override"})]);
        return (await client.query("SELECT * FROM studio_signup_requests WHERE id=$1", [id])).rows[0];
      });
      if (!signup) { res.status(404).json({ error: "Không tìm thấy yêu cầu" }); return; }
      res.json(signup);
    } catch (error) {
      res.status(error instanceof CommercialConflictError ? 409 : 400)
        .json({ error: error instanceof Error ? error.message : "Không thể xử lý" });
    }
    return;
  }
  const next = ({ contact: "CONTACTED", approve: "APPROVED", reject: "REJECTED" } as const)[action as "contact"|"approve"|"reject"];
  if (!next) { res.status(400).json({ error: "Yêu cầu/action không hợp lệ" }); return; }
  try {
    const q = await withPlatformTransaction(async client => {
      const current = await client.query<{ tenant_id:string|null; studio_name:string; requested_slug:string; requested_plan_code:string; status:string; email:string; phone:string }>(
        "SELECT tenant_id,studio_name,requested_slug,requested_plan_code,status,email,phone FROM studio_signup_requests WHERE id=$1 FOR UPDATE", [id]);
      if (!current.rows[0]) return null;
      const row = current.rows[0];
      if (row.status === next) return (await client.query("SELECT * FROM studio_signup_requests WHERE id=$1", [id])).rows[0];
      const allowedFrom: Record<string, readonly string[]> = {
        CONTACTED: ["PENDING"], APPROVED: ["PENDING", "CONTACTED"], REJECTED: ["PENDING", "CONTACTED"],
      };
      if (!allowedFrom[next].includes(row.status)) throw new CommercialConflictError(`Không thể chuyển ${row.status} sang ${next}`);
      let tenantId = row.tenant_id;
      if (next === "APPROVED" && !tenantId) {
        const priorTrial = await client.query(`SELECT previous.id FROM studio_signup_requests previous
          JOIN subscriptions previous_subscription ON previous_subscription.tenant_id=previous.tenant_id
          WHERE previous.id<>$1 AND previous.status='ACTIVE'
            AND previous_subscription.current_period_start IS NOT NULL
            AND (lower(trim(previous.email))=lower(trim($2)) OR
              regexp_replace(previous.phone,'[^0-9]+','','g')=regexp_replace($3,'[^0-9]+','','g'))
          LIMIT 1`, [id,row.email,row.phone]);
        if (priorTrial.rows.length) {
          const override = await client.query(`SELECT id FROM platform_audit_logs
            WHERE action='signup.trial_override' AND target_type='studio_signup_request' AND target_id=$1 LIMIT 1`, [id]);
          if (!override.rows.length) throw new CommercialConflictError(
            "Owner này đã dùng free trial; Platform Owner phải cấp manual override trước khi duyệt");
        }
        const selectedPlan = await client.query<{ id:string; setup_fee_amount:string|null }>(
          "SELECT id,setup_fee_amount FROM plans WHERE upper(code)=$1 AND is_active=true", [row.requested_plan_code]);
        if (selectedPlan.rows.length !== 1 || selectedPlan.rows[0]!.setup_fee_amount === null) {
          throw new CommercialConflictError("Plan đăng ký không hợp lệ hoặc chưa cấu hình setup fee");
        }
        tenantId = randomUUID();
        const subscriptionId = randomUUID();
        await client.query("INSERT INTO tenants (id,name,slug,status,plan_id) VALUES ($1,$2,$3,'provisioning',$4)",
          [tenantId,row.studio_name,row.requested_slug,selectedPlan.rows[0]!.id]);
        await client.query("INSERT INTO subscriptions (id,tenant_id,plan_id,status,source) VALUES ($1,$2,$3,'suspended','DIRECT')",
          [subscriptionId,tenantId,selectedPlan.rows[0]!.id]);
        await client.query(`INSERT INTO platform_payments
          (id,tenant_id,signup_request_id,subscription_id,payment_type,amount,status,source,created_by)
          VALUES ($1,$2,$3,$4,'SETUP_FEE',$5,'PENDING','DIRECT',$6)`,
          [randomUUID(),tenantId,id,subscriptionId,selectedPlan.rows[0]!.setup_fee_amount,actor.userId]);
        await client.query("INSERT INTO tenant_branding (tenant_id,public_name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [tenantId,row.studio_name]);
      }
      const updated = await client.query(`UPDATE studio_signup_requests SET status=$2,reviewed_by=$3,
        tenant_id=COALESCE(tenant_id,$4),reviewed_at=CASE WHEN $2 IN ('APPROVED','REJECTED') THEN now() ELSE reviewed_at END,
        updated_at=now() WHERE id=$1 AND status=$5 RETURNING *`, [id,next,actor.userId,tenantId,row.status]);
      if (!updated.rows[0]) throw new CommercialConflictError("Signup vừa được cập nhật bởi request khác");
      await client.query(`INSERT INTO platform_audit_logs (id,actor_user_id,action,target_type,target_id,metadata)
        VALUES ($1,$2,$3,'studio_signup_request',$4,$5::jsonb)`,
        [randomUUID(),actor.userId,`signup.${action}`,id,JSON.stringify({ status: next, tenantId })]);
      return updated.rows[0];
    });
    if (!q) { res.status(404).json({ error: "Không tìm thấy yêu cầu" }); return; }
    res.json(q);
  } catch (error) {
    res.status(error instanceof CommercialConflictError ? 409 : 400)
      .json({ error: error instanceof Error ? error.message : "Không thể xử lý" });
  }
});

router.get("/platform-admin/api/studios/:tenantId", async (req, res) => {
  const tenantId = String(req.params.tenantId);
  if (!UUID.test(tenantId)) { res.status(400).json({ error: "Studio không hợp lệ" }); return; }
  const q = await getPlatformPool().query(`SELECT t.*, s.id AS subscription_id, s.status AS subscription_status,
    s.source, s.starts_at, s.current_period_ends_at, p.code AS plan_code, p.setup_fee_amount,
    r.health_status AS registry_status, d.hostname AS domain,
    j.status AS provisioning_status,j.step AS provisioning_step,j.failed_step AS provisioning_failed_step,
    j.error_code AS provisioning_error_code,j.error_message AS provisioning_error_message,j.last_attempted_at AS provisioning_last_attempted_at
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id AND s.status <> 'cancelled'
    LEFT JOIN plans p ON p.id=s.plan_id LEFT JOIN tenant_database_registry r ON r.tenant_id=t.id
    LEFT JOIN tenant_domains d ON d.tenant_id=t.id AND d.status='active'
    LEFT JOIN LATERAL (SELECT status,step,failed_step,error_code,error_message,last_attempted_at FROM provisioning_jobs
      WHERE tenant_id=t.id ORDER BY created_at DESC LIMIT 1) j ON true WHERE t.id=$1 LIMIT 1`, [tenantId]);
  if (!q.rows[0]) { res.status(404).json({ error: "Không tìm thấy studio" }); return; }
  res.json({ ...q.rows[0], entitlements: await getTenantEntitlements(tenantId) });
});

router.post("/platform-admin/api/studios/:tenantId/action", requirePlatformCsrf, async (req, res) => {
  const tenantId = String(req.params.tenantId); const action = String(req.body?.action ?? "");
  if (!UUID.test(tenantId)) { res.status(400).json({ error: "Studio không hợp lệ" }); return; }
  const actor = context(res); const allowed = new Set(["extend","change_plan","suspend","reactivate","mark_setup_paid","waive_setup_fee","activate","retry_provisioning"]);
  if (!allowed.has(action)) { res.status(400).json({ error: "Action không hợp lệ" }); return; }
  try {
    const result = await withPlatformTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`commercial:${tenantId}`]);
      const tenant = await client.query<{ id:string; status:string }>("SELECT id,status FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
      if (!tenant.rows[0]) throw new Error("Không tìm thấy studio");
      const signup = await getCommercialSignupForUpdate(client, tenantId);
      const subscription = await getCurrentCommercialSubscriptionForUpdate(client, tenantId);
      let auditMetadata: Record<string, unknown> = { days: req.body?.days, planCode: req.body?.planCode };
      if (action === "retry_provisioning") {
        requireState(signup.status,["PROVISIONING"],"thử lại provisioning");
        requireState(tenant.rows[0]!.status,["provisioning_failed"],"thử lại provisioning");
        const failed=await client.query<{id:string}>("SELECT id FROM provisioning_jobs WHERE tenant_id=$1 AND status='failed' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[tenantId]);
        if(failed.rows.length!==1)throw new CommercialConflictError("Không có provisioning job FAILED để thử lại");
        await client.query(`UPDATE provisioning_jobs SET status='pending',step='QUEUED',claimed_by=NULL,last_heartbeat_at=NULL,
          error_code=NULL,error_message=NULL,failed_step=NULL,retry_after=NULL,finished_at=NULL,updated_at=now() WHERE id=$1`,[failed.rows[0]!.id]);
        await client.query("UPDATE tenants SET status='provisioning',updated_at=now() WHERE id=$1",[tenantId]);
        auditMetadata={jobId:failed.rows[0]!.id};
      } else if (action === "suspend" || action === "reactivate") {
        requireState(signup.status, ["ACTIVE"], action === "suspend" ? "tạm khóa" : "mở lại");
        await requireProvisionedRegistry(client, tenantId);
        if (action === "suspend") {
          requireState(tenant.rows[0]!.status, ["active"], "tạm khóa");
          requireState(subscription.status, ["trial","active"], "tạm khóa");
          await client.query("UPDATE tenants SET status='suspended',updated_at=now() WHERE id=$1", [tenantId]);
          if (subscription.status === "active") {
            await client.query("UPDATE subscriptions SET status='suspended',updated_at=now() WHERE id=$1", [subscription.id]);
          }
        } else {
          requireState(tenant.rows[0]!.status, ["suspended"], "mở lại");
          requireState(subscription.status, ["trial","suspended"], "mở lại");
          if (!subscription.period_active) {
            throw new CommercialConflictError("Không thể mở lại khi subscription chưa có kỳ hạn còn hiệu lực");
          }
          await client.query("UPDATE tenants SET status='active',updated_at=now() WHERE id=$1", [tenantId]);
          if (subscription.status === "suspended") {
            await client.query("UPDATE subscriptions SET status='active',updated_at=now() WHERE id=$1", [subscription.id]);
          }
        }
      } else if (action === "extend") {
        requireState(signup.status, ["ACTIVE"], "gia hạn");
        requireState(tenant.rows[0]!.status, ["active"], "gia hạn");
        await requireProvisionedRegistry(client, tenantId);
        requireState(subscription.status, ["trial","active","past_due"], "gia hạn");
        const days = Number(req.body?.days ?? 30); if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error("Số ngày gia hạn không hợp lệ");
        await client.query(`UPDATE subscriptions SET current_period_start=COALESCE(current_period_start,now()),
          current_period_ends_at=GREATEST(COALESCE(current_period_ends_at,now()),now()) + ($2 || ' days')::interval,
          status='active', updated_at=now() WHERE id=$1`, [subscription.id, days]);
      } else if (action === "change_plan") {
        requireState(signup.status, ["ACTIVE"], "đổi plan");
        requireState(tenant.rows[0]!.status, ["active","suspended"], "đổi plan");
        await requireProvisionedRegistry(client, tenantId);
        const code = plan(req.body?.planCode); if (!code) throw new Error("Plan không hợp lệ");
        const selectedPlan = await client.query<{ id:string }>("SELECT id FROM plans WHERE upper(code)=$1 AND is_active=true", [code]);
        if (selectedPlan.rows.length !== 1) throw new CommercialConflictError("Plan không tồn tại hoặc không hoạt động");
        await client.query("UPDATE subscriptions SET plan_id=$2,updated_at=now() WHERE id=$1", [subscription.id,selectedPlan.rows[0]!.id]);
        await client.query("UPDATE tenants SET plan_id=$2,updated_at=now() WHERE id=$1", [tenantId,selectedPlan.rows[0]!.id]);
      } else if (action === "mark_setup_paid" || action === "waive_setup_fee") {
        requireState(signup.status, ["APPROVED"], "xác nhận setup fee");
        requireState(tenant.rows[0]!.status, ["provisioning"], "xác nhận setup fee");
        if (subscription.setup_fee_amount === null || !/^\d+$/.test(String(subscription.setup_fee_amount))) {
          throw new CommercialConflictError("Plan chưa cấu hình setup fee hợp lệ");
        }
        const beforePayment = await client.query<{ status:string }>(`SELECT status FROM platform_payments
          WHERE tenant_id=$1 AND payment_type='SETUP_FEE' AND status<>'VOID' FOR UPDATE`, [tenantId]);
        if (action === "waive_setup_fee" && beforePayment.rows[0]?.status === "PAID") {
          throw new CommercialConflictError("Setup fee đã PAID; không thể chuyển ngược sang WAIVED");
        }
        const requestedStatus = action === "waive_setup_fee" ? "WAIVED" : "PAID";
        const payment = await client.query<{ status:"PAID"|"WAIVED" }>(`INSERT INTO platform_payments
          (id,tenant_id,signup_request_id,subscription_id,payment_type,amount,status,paid_at,created_by)
          VALUES ($1,$2,$3,$4,'SETUP_FEE',$5,$7,CASE WHEN $7='PAID' THEN now() ELSE NULL END,$6)
          ON CONFLICT (tenant_id, payment_type) WHERE tenant_id IS NOT NULL AND payment_type='SETUP_FEE' AND status<>'VOID'
          DO UPDATE SET
            status=CASE WHEN platform_payments.status='WAIVED' OR EXCLUDED.status='WAIVED' THEN 'WAIVED' ELSE 'PAID' END,
            paid_at=CASE WHEN platform_payments.status='WAIVED' OR EXCLUDED.status='WAIVED' THEN NULL ELSE COALESCE(platform_payments.paid_at,now()) END,
            updated_at=now()
          RETURNING status`,
          [randomUUID(),tenantId,signup.id,subscription.id,subscription.setup_fee_amount,actor.userId,requestedStatus]);
        const paymentStatus = payment.rows[0]!.status;
        auditMetadata = {
          paymentStatus,
          paymentResult: paymentStatus === "WAIVED" ?
            (beforePayment.rows[0]?.status === "WAIVED" ? "preserved_waived" : "transitioned_to_waived") :
            beforePayment.rows[0]?.status === "PAID" ? "preserved_paid" : "transitioned_to_paid",
        };
      } else if (action === "activate") {
        if (signup.status === "PROVISIONING") {
          const open = await client.query("SELECT id FROM provisioning_jobs WHERE tenant_id=$1 AND status IN ('pending','running','cleanup_required')", [tenantId]);
          if (open.rows.length === 1) return { success: true, idempotent: true };
          throw new CommercialConflictError("Commercial activation đang ở trạng thái không nhất quán");
        }
        requireState(signup.status, ["APPROVED"], "kích hoạt");
        requireState(tenant.rows[0]!.status, ["provisioning"], "kích hoạt");
        requireState(subscription.status, ["suspended"], "kích hoạt");
        const registry = await client.query("SELECT tenant_id FROM tenant_database_registry WHERE tenant_id=$1", [tenantId]);
        if (registry.rows.length) throw new CommercialConflictError("Studio đã có tenant database registry");
        const paid = await client.query(`SELECT id FROM platform_payments WHERE tenant_id=$1 AND signup_request_id=$2
          AND subscription_id=$3 AND payment_type='SETUP_FEE' AND status IN ('PAID','WAIVED')`,
          [tenantId,signup.id,subscription.id]);
        if (paid.rows.length !== 1) throw new CommercialConflictError("Setup fee chưa được xác nhận PAID hoặc WAIVED");
        const open = await client.query("SELECT id FROM provisioning_jobs WHERE tenant_id=$1 AND status IN ('pending','running','cleanup_required')", [tenantId]);
        if (open.rows.length) throw new CommercialConflictError("Studio đã có provisioning job đang mở");
        await client.query("UPDATE tenants SET status='provisioning', updated_at=now() WHERE id=$1", [tenantId]);
        await client.query(`INSERT INTO provisioning_jobs (id,tenant_id,status,step) VALUES ($1,$2,'pending','QUEUED')
          ON CONFLICT DO NOTHING`, [randomUUID(), tenantId]);
        const activated = await client.query("UPDATE studio_signup_requests SET status='PROVISIONING',updated_at=now() WHERE id=$1 AND status='APPROVED' RETURNING id", [signup.id]);
        if (activated.rows.length !== 1) throw new CommercialConflictError("Signup vừa được cập nhật bởi request khác");
      }
      await client.query(`INSERT INTO platform_audit_logs (id,actor_user_id,tenant_id,action,target_type,target_id,metadata)
        VALUES ($1,$2,$3,$4,'tenant',$6,$5::jsonb)`, [randomUUID(), actor.userId, tenantId, `commercial.${action}`,
        JSON.stringify(auditMetadata), tenantId]);
      return { success: true };
    });
    res.json(result);
  } catch (error) { res.status(error instanceof CommercialConflictError ? 409 : 400).json({ error: error instanceof Error ? error.message : "Không thể xử lý" }); }
});

export default router;

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformPool } from "@workspace/platform-db";
import { PostgresTenantDatabaseProvisioner } from "./tenant-database-provisioner";
import { runTenantMigrationOrchestrator } from "./tenant-migration-orchestrator";
import { EncryptedPlatformTenantSecretStore } from "./tenant-secret-store";
import { TenantProvisioningEngine } from "./tenant-provisioning-engine";

const enabled=process.env.RUN_PROVISIONING_ITEST==="1";
const {Pool}=pg;const tenantId=randomUUID();const suffix=tenantId.replace(/-/g,"").slice(0,24);const databaseName=`tenant_${suffix}`;const roleName=`tenant_${suffix}_role`;const templateName=`tenant_template_${suffix}`;
const adminUrl=process.env.TENANT_PROVISIONING_ADMIN_URL??"";
let createdSecretRef:string|undefined;
const reviewerId=randomUUID();const signupId=randomUUID();const subscriptionId=randomUUID();const jobId=randomUUID();
function databaseUrl(name:string){const url=new URL(adminUrl);url.pathname=`/${name}`;return url.toString();}
function ident(value:string){if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new Error("unsafe test identifier");return `"${value}"`;}

describe.runIf(enabled)("PostgresTenantDatabaseProvisioner on disposable PostgreSQL",()=>{
  beforeAll(async()=>{
    const url=new URL(adminUrl);if(!["127.0.0.1","localhost"].includes(url.hostname)||!url.pathname.endsWith("_test"))throw new Error("Provisioning integration is restricted to local *_test PostgreSQL");
    const admin=new Pool({connectionString:adminUrl,max:1});try{await admin.query(`CREATE DATABASE ${ident(templateName)} TEMPLATE template0`);}finally{await admin.end();}
    const template=new Pool({connectionString:databaseUrl(templateName),max:1});try{await template.query(`
      CREATE TABLE bookings(id serial PRIMARY KEY);CREATE TABLE customers(id serial PRIMARY KEY);
      CREATE TABLE wedding_cards(id serial PRIMARY KEY);CREATE TABLE service_groups(id serial PRIMARY KEY);
      CREATE TABLE cms_home_settings(id serial PRIMARY KEY);
      CREATE TABLE staff(id serial PRIMARY KEY,name text NOT NULL,phone text NOT NULL,email text,role text NOT NULL DEFAULT 'assistant',roles jsonb NOT NULL DEFAULT '[]'::jsonb);
    `);}finally{await template.end();}
    process.env.TENANT_PROVISIONING_TEMPLATE_DATABASE=templateName;
  });
  afterAll(async()=>{
    delete process.env.TENANT_PROVISIONING_TEMPLATE_DATABASE;
    const admin=new Pool({connectionString:adminUrl,max:1});try{
      for(const name of [databaseName,templateName]){await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",[name]);await admin.query(`DROP DATABASE IF EXISTS ${ident(name)}`);}
      await admin.query(`DROP ROLE IF EXISTS ${ident(roleName)}`);
      const platform=getPlatformPool();
      await platform.query("DELETE FROM platform_audit_logs WHERE tenant_id=$1 OR actor_user_id=$2",[tenantId,reviewerId]);
      await platform.query("DELETE FROM tenant_invitations WHERE tenant_id=$1",[tenantId]);await platform.query("DELETE FROM tenant_memberships WHERE tenant_id=$1",[tenantId]);
      await platform.query("DELETE FROM provisioning_jobs WHERE tenant_id=$1",[tenantId]);await platform.query("DELETE FROM platform_payments WHERE tenant_id=$1",[tenantId]);
      await platform.query("DELETE FROM studio_signup_requests WHERE tenant_id=$1",[tenantId]);await platform.query("DELETE FROM subscriptions WHERE tenant_id=$1",[tenantId]);
      await platform.query("DELETE FROM tenant_database_registry WHERE tenant_id=$1",[tenantId]);await platform.query("DELETE FROM tenant_branding WHERE tenant_id=$1",[tenantId]);
      await platform.query("DELETE FROM tenants WHERE id=$1",[tenantId]);await platform.query("DELETE FROM platform_users WHERE id=$1 OR canonical_email=$2",[reviewerId,"provisioned-owner@example.com"]);
      if(createdSecretRef)await platform.query("DELETE FROM tenant_database_secrets WHERE id=$1",[createdSecretRef.slice("platform-secret:".length)]);
    }finally{await admin.end();}
  });
  it("consumes the commercial job and activates an isolated empty tenant end to end",async()=>{
    const platform=getPlatformPool();
    await platform.query("INSERT INTO platform_users(id,display_name,platform_role) VALUES($1,'Reviewer','PLATFORM_OWNER')",[reviewerId]);
    await platform.query("INSERT INTO tenants(id,name,slug,status,plan_id) VALUES($1,'Provisioned Studio',$2,'provisioning','standard')",[tenantId,`provisioned-${suffix}`]);
    await platform.query(`INSERT INTO studio_signup_requests(id,owner_name,studio_name,phone,email,requested_slug,requested_plan_code,status,tenant_id,reviewed_by)
      VALUES($1,'Provisioned Owner','Provisioned Studio','0900000000','provisioned-owner@example.com',$2,'STANDARD','PROVISIONING',$3,$4)`,[signupId,`provisioned-${suffix}`,tenantId,reviewerId]);
    await platform.query("INSERT INTO subscriptions(id,tenant_id,plan_id,status,source) VALUES($1,$2,'standard','suspended','DIRECT')",[subscriptionId,tenantId]);
    await platform.query(`INSERT INTO platform_payments(id,tenant_id,signup_request_id,subscription_id,payment_type,amount,status,source,created_by)
      VALUES($1,$2,$3,$4,'SETUP_FEE',0,'WAIVED','DIRECT',$5)`,[randomUUID(),tenantId,signupId,subscriptionId,reviewerId]);
    await platform.query("INSERT INTO provisioning_jobs(id,tenant_id,status,step) VALUES($1,$2,'pending','QUEUED')",[jobId,tenantId]);
    const store=new EncryptedPlatformTenantSecretStore(platform);
    const provisioner=new PostgresTenantDatabaseProvisioner(store,runTenantMigrationOrchestrator,adminUrl);
    expect(await new TenantProvisioningEngine(platform,provisioner,"itest-worker").processNext()).toBe(true);
    const state=await platform.query(`SELECT t.status tenant_status,s.status subscription_status,s.current_period_start,s.current_period_ends_at,
      signup.status signup_status,j.status job_status,j.step,j.failed_step,j.error_code,j.error_message,r.secret_ref,r.health_status
      FROM tenants t JOIN subscriptions s ON s.tenant_id=t.id JOIN studio_signup_requests signup ON signup.tenant_id=t.id
      JOIN provisioning_jobs j ON j.tenant_id=t.id LEFT JOIN tenant_database_registry r ON r.tenant_id=t.id WHERE t.id=$1`,[tenantId]);
    expect(state.rows[0]).toMatchObject({tenant_status:"active",subscription_status:"active",signup_status:"ACTIVE",job_status:"succeeded",step:"COMPLETED",health_status:"healthy"});
    expect(state.rows[0].current_period_start).toBeTruthy();expect(state.rows[0].current_period_ends_at).toBeTruthy();createdSecretRef=state.rows[0].secret_ref;
    expect((await platform.query("SELECT tenant_role,status,tenant_staff_id FROM tenant_memberships WHERE tenant_id=$1",[tenantId])).rows[0]).toMatchObject({tenant_role:"OWNER",status:"active",tenant_staff_id:"1"});
    expect((await platform.query("SELECT status FROM tenant_invitations WHERE tenant_id=$1",[tenantId])).rows[0].status).toBe("pending");
    const tenant=new Pool({connectionString:await store.getTenantDatabaseSecret(createdSecretRef!),max:1});try{
      expect((await tenant.query("SELECT tenant_id::text,schema_version FROM tenant_metadata")).rows[0]).toEqual({tenant_id:tenantId,schema_version:"0007_tenant_metadata.sql"});
      expect((await tenant.query("SELECT (SELECT count(*) FROM customers)::int customers,(SELECT count(*) FROM bookings)::int bookings,(SELECT count(*) FROM staff)::int staff")).rows[0]).toEqual({customers:0,bookings:0,staff:1});
      expect((await tenant.query("SELECT to_regclass('public.tenant_schema_migrations') IS NOT NULL ok")).rows[0].ok).toBe(true);
    }finally{await tenant.end();}
  });
});

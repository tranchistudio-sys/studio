import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformPool } from "@workspace/platform-db";
import { PostgresTenantDatabaseProvisioner } from "./tenant-database-provisioner";
import { runTenantMigrationOrchestrator } from "./tenant-migration-orchestrator";
import { EncryptedPlatformTenantSecretStore } from "./tenant-secret-store";

const enabled=process.env.RUN_PROVISIONING_ITEST==="1";
const {Pool}=pg;const tenantId=randomUUID();const suffix=tenantId.replace(/-/g,"").slice(0,24);const databaseName=`tenant_${suffix}`;const roleName=`tenant_${suffix}_role`;const templateName=`tenant_template_${suffix}`;
const adminUrl=process.env.TENANT_PROVISIONING_ADMIN_URL??"";
let createdSecretRef:string|undefined;
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
      if(createdSecretRef)await getPlatformPool().query("DELETE FROM tenant_database_secrets WHERE id=$1",[createdSecretRef.slice("platform-secret:".length)]);
    }finally{await admin.end();}
  });
  it("creates an isolated empty DB, runs ordered migrations and verifies tenant metadata",async()=>{
    const store=new EncryptedPlatformTenantSecretStore(getPlatformPool());
    const provisioner=new PostgresTenantDatabaseProvisioner(store,runTenantMigrationOrchestrator,adminUrl);
    const resources=await provisioner.createRoleOrCredential(tenantId);createdSecretRef=resources.secretRef;await provisioner.createDatabase(resources);await provisioner.registerSecret(resources);
    const version=await provisioner.runMigrations(resources);await provisioner.writeTenantMetadata(resources,tenantId,version);await provisioner.healthCheck(resources,tenantId);
    const tenant=new Pool({connectionString:await store.getTenantDatabaseSecret(resources.secretRef),max:1});try{
      expect((await tenant.query("SELECT tenant_id::text,schema_version FROM tenant_metadata")).rows[0]).toEqual({tenant_id:tenantId,schema_version:"0007_tenant_metadata.sql"});
      expect((await tenant.query("SELECT (SELECT count(*) FROM customers)::int customers,(SELECT count(*) FROM bookings)::int bookings,(SELECT count(*) FROM staff)::int staff")).rows[0]).toEqual({customers:0,bookings:0,staff:0});
      expect((await tenant.query("SELECT to_regclass('public.tenant_schema_migrations') IS NOT NULL ok")).rows[0].ok).toBe(true);
    }finally{await tenant.end();}
  });
});

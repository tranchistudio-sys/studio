import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { TenantProvisioningEngine } from "./tenant-provisioning-engine";
import type { TenantDatabaseProvisioner, TenantDatabaseResources } from "./tenant-database-provisioner";

const tenantId="10000000-0000-4000-8000-000000000001";
const jobId="20000000-0000-4000-8000-000000000002";
const userId="30000000-0000-4000-8000-000000000003";
const reviewerId="40000000-0000-4000-8000-000000000004";
const resources:TenantDatabaseResources={databaseRef:`tenant-${tenantId}`,hostRef:"test:5432",databaseName:"tenant_test",roleName:"tenant_test_role",secretRef:"platform-secret:50000000-0000-4000-8000-000000000005"};

function fixture(planCode:"STANDARD"|"PRO"="STANDARD"){
  let claimed=false;const calls:string[]=[];
  const query=vi.fn(async(sql:string,_params?:unknown[])=>{
    calls.push(sql);
    if(sql.includes("WITH candidate AS")){if(claimed)return {rows:[],rowCount:0};claimed=true;return {rows:[{id:jobId,tenant_id:tenantId,safe_retry:{}}],rowCount:1};}
    if(sql.includes("FROM studio_signup_requests WHERE tenant_id"))return {rows:[{id:"signup",owner_name:"Owner",email:"owner@example.com",phone:"0900000000",reviewed_by:reviewerId,status:"PROVISIONING"}]};
    if(sql.includes("FROM platform_users WHERE"))return {rows:[{id:userId}]};
    if(sql.includes("FROM auth_identities"))return {rows:[{one:1}]};
    if(sql.includes("plan_code FROM subscriptions"))return {rows:[{plan_code:planCode}]};
    return {rows:[],rowCount:1};
  });
  const client={query,release:vi.fn()};
  const pool={query,connect:vi.fn(async()=>client)} as unknown as Pool;
  const provisioner:TenantDatabaseProvisioner={
    createRoleOrCredential:vi.fn(async()=>resources),createDatabase:vi.fn(async()=>undefined),registerSecret:vi.fn(async()=>undefined),
    runMigrations:vi.fn(async()=>"0007_tenant_metadata.sql"),writeTenantMetadata:vi.fn(async()=>undefined),
    createOwnerStaff:vi.fn(async()=>1),healthCheck:vi.fn(async()=>undefined),cleanupIncompleteProvisioning:vi.fn(async()=>undefined),
  };
  return {pool,provisioner,calls,query};
}

describe("TenantProvisioningEngine",()=>{
  beforeEach(()=>vi.restoreAllMocks());
  it("atomically lets only one concurrent worker consume a job and runs every step once",async()=>{
    const f=fixture();const a=new TenantProvisioningEngine(f.pool,f.provisioner,"worker-a");const b=new TenantProvisioningEngine(f.pool,f.provisioner,"worker-b");
    const results=await Promise.all([a.processNext(),b.processNext()]);
    expect(results.sort()).toEqual([false,true]);
    for(const operation of ["createRoleOrCredential","createDatabase","registerSecret","runMigrations","writeTenantMetadata","createOwnerStaff","healthCheck"] as const)
      expect(f.provisioner[operation]).toHaveBeenCalledTimes(1);
    expect(f.calls.join("\n")).toContain("FOR UPDATE SKIP LOCKED");
    expect(f.calls.join("\n")).toContain("step='COMPLETED'");
    expect(f.calls.join("\n")).toContain("SET status='trial'");
    expect(f.calls.join("\n")).toContain("COALESCE(current_period_start,now())");
    expect(f.calls.join("\n")).toContain("interval '1 month'");
  });

  it("fails closed with a sanitized error and never activates the tenant",async()=>{
    const f=fixture();vi.mocked(f.provisioner.runMigrations).mockRejectedValueOnce(new Error("postgresql://owner:secret@prod/db password=secret"));
    await new TenantProvisioningEngine(f.pool,f.provisioner).processNext();
    const failure=f.query.mock.calls.find(call=>String(call[0]).includes("status='failed'")&&String(call[0]).includes("claimed_by=$5"));
    expect(failure?.[1]?.[0]).toBe(jobId);expect(String(failure?.[1]?.[3])).not.toContain("secret@prod");
    expect(f.calls.join("\n")).not.toContain("UPDATE subscriptions SET status='trial'");
    expect(f.provisioner.cleanupIncompleteProvisioning).toHaveBeenCalledWith(resources);
  });

  it("starts the same one-month trial for a newly provisioned PRO studio",async()=>{
    const f=fixture("PRO");await new TenantProvisioningEngine(f.pool,f.provisioner).processNext();
    expect(f.calls.join("\n")).toContain("SET status='trial'");
    expect(f.calls.join("\n")).toContain("interval '1 month'");
  });

  it("uses an explicit bounded worker lease without changing the one-hour default",async()=>{
    const staging=fixture();await new TenantProvisioningEngine(staging.pool,staging.provisioner,"worker-staging",120).claimNext();
    const stagingExpiry=staging.query.mock.calls.find(call=>String(call[0]).includes("WORKER_LEASE_EXPIRED"));
    expect(stagingExpiry?.[1]).toEqual([120]);
    const normal=fixture();await new TenantProvisioningEngine(normal.pool,normal.provisioner,"worker-default").claimNext();
    const normalExpiry=normal.query.mock.calls.find(call=>String(call[0]).includes("WORKER_LEASE_EXPIRED"));
    expect(normalExpiry?.[1]).toEqual([3600]);
  });
});

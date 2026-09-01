import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { normalizeEmail } from "@workspace/platform-db";
import type { TenantDatabaseProvisioner, TenantDatabaseResources } from "./tenant-database-provisioner";

type Job={id:string;tenant_id:string;safe_retry:Record<string,string>};
type Signup={id:string;owner_name:string;email:string;phone:string;reviewed_by:string;status:string};
const STEPS=["CREATING_ROLE","CREATING_DATABASE","REGISTERING_SECRET","RUNNING_MIGRATIONS","WRITING_TENANT_METADATA","CREATING_OWNER","REGISTERING_DATABASE","HEALTH_CHECK"] as const;
type Step=typeof STEPS[number];

function sanitized(error:unknown):{code:string;message:string}{
  const code=String((error as {code?:unknown})?.code??"PROVISIONING_FAILED").replace(/[^A-Z0-9_]/gi,"_").slice(0,64);
  const raw=error instanceof Error?error.message:"Provisioning failed";
  return {code,message:raw.replace(/postgres(?:ql)?:\/\/\S+/gi,"[database-secret-redacted]").replace(/password\s*[=:]\s*\S+/gi,"password=[redacted]").slice(0,500)};
}

export class TenantProvisioningEngine{
  constructor(private readonly platform:Pool,private readonly provisioner:TenantDatabaseProvisioner,
    private readonly workerId=`worker-${randomUUID()}`,
    private readonly leaseSeconds=Math.max(60,Number(process.env.TENANT_PROVISIONING_LEASE_SECONDS??3600)||3600)){}

  async claimNext():Promise<Job|null>{
    await this.expireStaleJobs();
    const result=await this.platform.query<Job>(`WITH candidate AS (
      SELECT id FROM provisioning_jobs WHERE status='pending' AND (retry_after IS NULL OR retry_after<=now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE provisioning_jobs j SET status='running',claimed_by=$1,correlation_id=COALESCE(j.correlation_id,j.id),
        attempt_count=attempt_count+1,started_at=COALESCE(started_at,now()),last_attempted_at=now(),last_heartbeat_at=now(),updated_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.id,j.tenant_id,j.safe_retry`,[this.workerId]);
    return result.rows[0]??null;
  }
  async expireStaleJobs():Promise<void>{
    await this.platform.query(`WITH expired AS (UPDATE provisioning_jobs SET status='failed',failed_step=COALESCE(step,'UNKNOWN'),step='FAILED',
      error_code='WORKER_LEASE_EXPIRED',error_message='Provisioning worker heartbeat expired',finished_at=now(),updated_at=now()
      WHERE status='running' AND last_heartbeat_at<now()-($1::int*interval '1 second') RETURNING tenant_id)
      UPDATE tenants SET status='provisioning_failed',updated_at=now() WHERE id IN(SELECT tenant_id FROM expired) AND status='provisioning'`,[this.leaseSeconds]);
  }

  async processNext():Promise<boolean>{const job=await this.claimNext();if(!job)return false;await this.process(job);return true;}

  private async step(job:Job,step:Step):Promise<void>{
    const result=await this.platform.query(`UPDATE provisioning_jobs SET step=$2,last_heartbeat_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND claimed_by=$3 RETURNING id`,[job.id,step,this.workerId]);
    if(result.rowCount!==1)throw new Error("Provisioning worker lease lost");
    await this.platform.query(`INSERT INTO platform_audit_logs(id,tenant_id,action,target_type,target_id,metadata)
      VALUES($1,$2,'provisioning.step','provisioning_job',$3,$4::jsonb)`,[randomUUID(),job.tenant_id,job.id,JSON.stringify({step,correlationId:job.id})]);
  }
  private async save(job:Job,resources:TenantDatabaseResources):Promise<void>{
    job.safe_retry={databaseRef:resources.databaseRef,hostRef:resources.hostRef,databaseName:resources.databaseName,roleName:resources.roleName,secretRef:resources.secretRef};
    const result=await this.platform.query("UPDATE provisioning_jobs SET safe_retry=$2::jsonb,last_heartbeat_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND claimed_by=$3 RETURNING id",[job.id,JSON.stringify(job.safe_retry),this.workerId]);
    if(result.rowCount!==1)throw new Error("Provisioning worker lease lost");
  }

  async process(job:Job):Promise<void>{
    let activeStep:Step="CREATING_ROLE";let resources:TenantDatabaseResources|undefined;
    try{
      await this.platform.query(`INSERT INTO platform_audit_logs(id,tenant_id,action,target_type,target_id,metadata)
        VALUES($1,$2,'provisioning.started','provisioning_job',$3,$4::jsonb)`,[randomUUID(),job.tenant_id,job.id,JSON.stringify({correlationId:job.id})]);
      await this.step(job,activeStep);
      resources=await this.provisioner.createRoleOrCredential(job.tenant_id,job.safe_retry.secretRef);await this.save(job,resources);
      activeStep="CREATING_DATABASE";await this.step(job,activeStep);await this.provisioner.createDatabase(resources);
      activeStep="REGISTERING_SECRET";await this.step(job,activeStep);await this.provisioner.registerSecret(resources);
      activeStep="RUNNING_MIGRATIONS";await this.step(job,activeStep);const schemaVersion=await this.provisioner.runMigrations(resources);
      activeStep="WRITING_TENANT_METADATA";await this.step(job,activeStep);await this.provisioner.writeTenantMetadata(resources,job.tenant_id,schemaVersion);
      activeStep="CREATING_OWNER";await this.step(job,activeStep);const owner=await this.owner(job.tenant_id);const staffId=await this.provisioner.createOwnerStaff(resources,{name:owner.owner_name,email:owner.email,phone:owner.phone});
      await this.createOwnerIdentity(job.tenant_id,owner,staffId);
      activeStep="REGISTERING_DATABASE";await this.step(job,activeStep);await this.register(job.tenant_id,resources);
      activeStep="HEALTH_CHECK";await this.step(job,activeStep);await this.provisioner.healthCheck(resources,job.tenant_id);
      await this.complete(job);
    }catch(error){if(resources)await this.provisioner.cleanupIncompleteProvisioning(resources).catch(()=>undefined);await this.fail(job,activeStep,error);}
  }

  private async owner(tenantId:string):Promise<Signup>{
    const q=await this.platform.query<Signup>(`SELECT id,owner_name,email,phone,reviewed_by,status FROM studio_signup_requests WHERE tenant_id=$1`,[tenantId]);
    if(q.rows.length!==1||q.rows[0]!.status!=="PROVISIONING"||!q.rows[0]!.reviewed_by)throw new Error("Commercial signup không hợp lệ cho provisioning");return q.rows[0]!;
  }
  private async createOwnerIdentity(tenantId:string,owner:Signup,staffId:number):Promise<void>{
    const email=normalizeEmail(owner.email);const client=await this.platform.connect();
    try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`owner:${email}`]);
      let user=(await client.query<{id:string}>("SELECT id FROM platform_users WHERE lower(canonical_email)=lower($1) ORDER BY created_at LIMIT 1",[email])).rows[0];
      if(!user){user=(await client.query<{id:string}>("INSERT INTO platform_users(id,canonical_email,display_name) VALUES($1,$2,$3) RETURNING id",[randomUUID(),email,owner.owner_name])).rows[0]!;}
      const membership=await client.query("SELECT id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[tenantId,user.id]);
      if(membership.rows[0])await client.query("UPDATE tenant_memberships SET tenant_staff_id=COALESCE(tenant_staff_id,$3),updated_at=now() WHERE tenant_id=$1 AND user_id=$2",[tenantId,user.id,staffId]);
      else{await client.query(`INSERT INTO tenant_memberships(id,tenant_id,user_id,tenant_role,status,tenant_staff_id,invited_by)
        VALUES($1,$2,$3,'OWNER','active',$4,$5)`,[randomUUID(),tenantId,user.id,staffId,owner.reviewed_by]);
        await client.query(`INSERT INTO platform_audit_logs(id,actor_user_id,tenant_id,action,target_type,target_id)
          VALUES($1,$2,$3,'owner_membership.created','platform_user',$4)`,[randomUUID(),owner.reviewed_by,tenantId,user.id]);}
      const verified=await client.query("SELECT 1 FROM auth_identities WHERE user_id=$1",[user.id]);
      if(!verified.rows.length)await client.query(`INSERT INTO tenant_invitations(id,tenant_id,invited_email,invited_role,tenant_staff_id,target_user_id,expires_at,invited_by)
        VALUES($1,$2,$3,'OWNER',$4,$5,now()+interval '7 days',$6) ON CONFLICT DO NOTHING`,[randomUUID(),tenantId,email,staffId,user.id,owner.reviewed_by]);
      await client.query("UPDATE tenants SET bootstrap_owner_user_id=$2 WHERE id=$1",[tenantId,user.id]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }
  private async register(tenantId:string,r:TenantDatabaseResources):Promise<void>{
    const existing=await this.platform.query<{database_ref:string;host_ref:string;database_name:string;role_name:string;secret_ref:string}>(
      "SELECT database_ref,host_ref,database_name,role_name,secret_ref FROM tenant_database_registry WHERE tenant_id=$1",[tenantId]);
    if(existing.rows[0]){
      const row=existing.rows[0];if(row.database_ref!==r.databaseRef||row.host_ref!==r.hostRef||row.database_name!==r.databaseName||row.role_name!==r.roleName||row.secret_ref!==r.secretRef)
        throw new Error("Tenant registry hiện có không khớp provisioning resources");return;
    }
    await this.platform.query(`INSERT INTO tenant_database_registry(tenant_id,database_ref,host_ref,database_name,role_name,secret_ref,health_status)
      VALUES($1,$2,$3,$4,$5,$6,'unknown')`,[tenantId,r.databaseRef,r.hostRef,r.databaseName,r.roleName,r.secretRef]);
  }
  private async complete(job:Job):Promise<void>{const client=await this.platform.connect();try{await client.query("BEGIN");
    const billing=await client.query<{plan_code:string}>(`SELECT upper(COALESCE(p.code,p.id)) plan_code FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      JOIN platform_payments pay ON pay.subscription_id=s.id AND pay.payment_type='SETUP_FEE' AND pay.status IN('PAID','WAIVED')
      WHERE s.tenant_id=$1 AND s.status='suspended' FOR UPDATE OF s`,[job.tenant_id]);
    const planCode=billing.rows[0]?.plan_code;if(planCode!=="STANDARD"&&planCode!=="PRO")throw new Error("Commercial plan không hỗ trợ trial");
    const subscription=await client.query(`UPDATE subscriptions SET status='trial',
      current_period_start=COALESCE(current_period_start,now()),
      current_period_ends_at=COALESCE(current_period_ends_at,COALESCE(current_period_start,now())+interval '1 month'),
      updated_at=now() WHERE tenant_id=$1 AND status='suspended' RETURNING id`,[job.tenant_id]);
    const tenant=await client.query("UPDATE tenants SET status='active',bootstrap_completed_at=now(),updated_at=now() WHERE id=$1 AND status='provisioning' RETURNING id",[job.tenant_id]);
    const signup=await client.query("UPDATE studio_signup_requests SET status='ACTIVE',updated_at=now() WHERE tenant_id=$1 AND status='PROVISIONING' RETURNING id",[job.tenant_id]);
    const registry=await client.query("UPDATE tenant_database_registry SET health_status='healthy',last_health_check_at=now(),updated_at=now() WHERE tenant_id=$1 RETURNING tenant_id",[job.tenant_id]);
    const completed=await client.query("UPDATE provisioning_jobs SET status='succeeded',step='COMPLETED',finished_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND claimed_by=$2 RETURNING id",[job.id,this.workerId]);
    if([subscription,tenant,signup,registry,completed].some(result=>result.rowCount!==1))throw new Error("Provisioning completion state conflict");
    await client.query(`INSERT INTO platform_audit_logs(id,tenant_id,action,target_type,target_id,metadata)
      VALUES($1,$2,'provisioning.completed','provisioning_job',$3,$4::jsonb)`,
      [randomUUID(),job.tenant_id,job.id,JSON.stringify({subscriptionStatus:"trial",trialDuration:"1 month",planCode})]);await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}}
  private async fail(job:Job,step:Step,error:unknown):Promise<void>{const safe=sanitized(error);const failed=await this.platform.query(`UPDATE provisioning_jobs SET status='failed',step='FAILED',failed_step=$2,error_code=$3,error_message=$4,finished_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND claimed_by=$5 RETURNING id`,[job.id,step,safe.code,safe.message,this.workerId]);if(failed.rowCount!==1)return;await this.platform.query("UPDATE tenants SET status='provisioning_failed',updated_at=now() WHERE id=$1 AND status='provisioning'",[job.tenant_id]);await this.platform.query(`INSERT INTO platform_audit_logs(id,tenant_id,action,target_type,target_id,metadata) VALUES($1,$2,'provisioning.failed','provisioning_job',$3,$4::jsonb)`,[randomUUID(),job.tenant_id,job.id,JSON.stringify({failedStep:step,errorCode:safe.code})]);}
}

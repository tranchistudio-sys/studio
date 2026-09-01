import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TenantSecretStore } from "./tenant-secret-store";

const { Pool } = pg;
export interface TenantDatabaseResources {
  databaseRef: string; hostRef: string; databaseName: string; roleName: string; secretRef: string;
}

export interface TenantDatabaseProvisioner {
  createRoleOrCredential(tenantId:string, existingSecretRef?:string): Promise<TenantDatabaseResources>;
  createDatabase(resources:TenantDatabaseResources): Promise<void>;
  registerSecret(resources:TenantDatabaseResources): Promise<void>;
  runMigrations(resources:TenantDatabaseResources): Promise<string>;
  writeTenantMetadata(resources:TenantDatabaseResources, tenantId:string, schemaVersion:string): Promise<void>;
  createOwnerStaff(resources:TenantDatabaseResources, owner:{name:string;email:string;phone:string}): Promise<number>;
  healthCheck(resources:TenantDatabaseResources, tenantId:string): Promise<void>;
  cleanupIncompleteProvisioning(resources:TenantDatabaseResources): Promise<void>;
}

function identifier(value:string):string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Provisioning identifier không hợp lệ");
  return `"${value}"`;
}

export class PostgresTenantDatabaseProvisioner implements TenantDatabaseProvisioner {
  constructor(
    private readonly secrets:TenantSecretStore,
    private readonly migrate:(connectionString:string)=>Promise<string>,
    private readonly adminUrl=process.env.TENANT_PROVISIONING_ADMIN_URL?.trim(),
  ) { if (!adminUrl) throw new Error("TENANT_PROVISIONING_ADMIN_URL chưa được cấu hình"); }

  async createRoleOrCredential(tenantId:string, existingSecretRef?:string):Promise<TenantDatabaseResources> {
    const suffix=tenantId.replace(/-/g,"").slice(0,24).toLowerCase();
    const roleName=`tenant_${suffix}_role`; const databaseName=`tenant_${suffix}`;
    const admin=new URL(this.adminUrl!); const hostRef=admin.host.toLowerCase();
    let secretRef=existingSecretRef; let connectionString:string;let createdSecret=false;
    if (secretRef) connectionString=await this.secrets.getTenantDatabaseSecret(secretRef);
    else {
      const password=randomBytes(32).toString("base64url");
      const target=new URL(this.adminUrl!); target.username=roleName; target.password=password; target.pathname=`/${databaseName}`;
      connectionString=target.toString(); secretRef=await this.secrets.putTenantDatabaseSecret(connectionString);createdSecret=true;
    }
    const password=decodeURIComponent(new URL(connectionString).password);
    if(!/^[A-Za-z0-9_-]{32,128}$/.test(password))throw new Error("Tenant database credential không hợp lệ");
    const pool=new Pool({connectionString:this.adminUrl!,max:1});
    try {
      const exists=await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[roleName]);
      if (!exists.rows.length) await pool.query(`CREATE ROLE ${identifier(roleName)} LOGIN PASSWORD '${password}'`);
    } catch(error){if(createdSecret)await this.secrets.deleteUncommittedSecret(secretRef).catch(()=>undefined);throw error;}
    finally { await pool.end(); }
    return {databaseRef:`tenant-${tenantId}`,hostRef,databaseName,roleName,secretRef};
  }

  async createDatabase(resources:TenantDatabaseResources):Promise<void> {
    const template=process.env.TENANT_PROVISIONING_TEMPLATE_DATABASE?.trim();
    if(!template) throw new Error("TENANT_PROVISIONING_TEMPLATE_DATABASE chưa được cấu hình");
    identifier(template);
    const pool=new Pool({connectionString:this.adminUrl!,max:1});
    try {
      const exists=await pool.query("SELECT 1 FROM pg_database WHERE datname=$1",[resources.databaseName]);
      if (!exists.rows.length) await pool.query(`CREATE DATABASE ${identifier(resources.databaseName)} OWNER ${identifier(resources.roleName)} TEMPLATE ${identifier(template)}`);
    } finally { await pool.end(); }
    const targetAdmin=new URL(this.adminUrl!);targetAdmin.pathname=`/${resources.databaseName}`;
    const adminRole=decodeURIComponent(targetAdmin.username);
    const targetPool=new Pool({connectionString:targetAdmin.toString(),max:1});
    try{await targetPool.query(`REASSIGN OWNED BY ${identifier(adminRole)} TO ${identifier(resources.roleName)}`);}
    finally{await targetPool.end();}
  }
  async registerSecret(resources:TenantDatabaseResources):Promise<void>{ await this.secrets.commitTenantDatabaseSecret(resources.secretRef); }
  async runMigrations(resources:TenantDatabaseResources):Promise<string>{ return this.migrate(await this.secrets.getTenantDatabaseSecret(resources.secretRef)); }
  async writeTenantMetadata(resources:TenantDatabaseResources,tenantId:string,schemaVersion:string):Promise<void>{
    const pool=new Pool({connectionString:await this.secrets.getTenantDatabaseSecret(resources.secretRef),max:1});
    try { await pool.query(`INSERT INTO tenant_metadata(tenant_id,schema_version) VALUES($1,$2)
      ON CONFLICT(tenant_id) DO UPDATE SET schema_version=EXCLUDED.schema_version`,[tenantId,schemaVersion]); }
    finally { await pool.end(); }
  }
  async createOwnerStaff(resources:TenantDatabaseResources,owner:{name:string;email:string;phone:string}):Promise<number>{
    const pool=new Pool({connectionString:await this.secrets.getTenantDatabaseSecret(resources.secretRef),max:1});
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`owner:${owner.email.toLowerCase()}`]);
      const existing=await client.query<{id:number}>("SELECT id FROM staff WHERE lower(email)=lower($1) ORDER BY id LIMIT 1",[owner.email]);
      if(existing.rows[0]){await client.query("COMMIT");return existing.rows[0].id;}
      const inserted=await client.query<{id:number}>(`INSERT INTO staff(name,phone,email,role,roles)
        VALUES($1,$2,$3,'admin','["admin"]'::jsonb) RETURNING id`,[owner.name,owner.phone,owner.email]);
      await client.query("COMMIT");return inserted.rows[0]!.id;
    } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}
    finally{client.release();await pool.end();}
  }
  async healthCheck(resources:TenantDatabaseResources,tenantId:string):Promise<void>{
    const pool=new Pool({connectionString:await this.secrets.getTenantDatabaseSecret(resources.secretRef),max:1});
    try { const result=await pool.query("SELECT tenant_id::text FROM tenant_metadata LIMIT 2");
      if(result.rows.length!==1||result.rows[0].tenant_id.toLowerCase()!==tenantId.toLowerCase()) throw new Error("tenant_metadata mismatch");
      await pool.query("SELECT 1"); }
    finally { await pool.end(); }
  }
  async cleanupIncompleteProvisioning(resources:TenantDatabaseResources):Promise<void>{
    // Databases and roles are deliberately retained for safe retry; never DROP here.
    void resources;
  }
}

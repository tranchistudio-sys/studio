import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool }=pg;
const EXCLUDED_BUSINESS_SEEDS=new Set(["0004_seed_amazing_wedding_gifts.sql"]);

export async function runTenantMigrationOrchestrator(connectionString:string):Promise<string>{
  const configured=process.env.TENANT_MIGRATIONS_DIR?.trim();
  const candidates=configured?[configured]:[path.resolve(process.cwd(),"lib/db/migrations"),path.resolve(process.cwd(),"../../lib/db/migrations")];
  let directory:string|undefined;let files:string[]=[];
  for(const candidate of candidates){try{files=(await readdir(candidate)).filter(file=>/^\d+_[a-z0-9_-]+\.sql$/i.test(file)&&!EXCLUDED_BUSINESS_SEEDS.has(file)).sort();directory=candidate;break;}catch{/* Try the next trusted repository layout. */}}
  if(!directory)throw new Error("Tenant migrations directory không tồn tại");
  if(!files.includes("0007_tenant_metadata.sql")) throw new Error("Tenant metadata migration không tồn tại");
  const pool=new Pool({connectionString,max:1});
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tenant_schema_migrations(
      filename text PRIMARY KEY,checksum_sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    for(const file of files){
      const sql=await readFile(path.join(directory,file),"utf8");
      const checksum=createHash("sha256").update(sql).digest("hex");
      const existing=await pool.query<{checksum_sha256:string}>("SELECT checksum_sha256 FROM tenant_schema_migrations WHERE filename=$1",[file]);
      if(existing.rows[0]){if(existing.rows[0].checksum_sha256!==checksum)throw new Error(`Tenant migration checksum mismatch: ${file}`);continue;}
      const client=await pool.connect();
      try{await client.query("BEGIN");await client.query(sql);await client.query(
        "INSERT INTO tenant_schema_migrations(filename,checksum_sha256) VALUES($1,$2)",[file,checksum]);await client.query("COMMIT");}
      catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
    }
    return files.at(-1)!;
  } finally {await pool.end();}
}

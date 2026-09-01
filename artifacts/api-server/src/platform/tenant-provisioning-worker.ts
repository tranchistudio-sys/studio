import { getPlatformPool } from "@workspace/platform-db";
import { PostgresTenantDatabaseProvisioner } from "./tenant-database-provisioner";
import { runTenantMigrationOrchestrator } from "./tenant-migration-orchestrator";
import { TenantProvisioningEngine } from "./tenant-provisioning-engine";
import { EncryptedPlatformTenantSecretStore } from "./tenant-secret-store";

let timer:NodeJS.Timeout|undefined;

export function startTenantProvisioningWorker():void{
  if(process.env.ENABLE_TENANT_PROVISIONING_WORKER!=="1"||timer)return;
  const pool=getPlatformPool();
  const engine=new TenantProvisioningEngine(pool,new PostgresTenantDatabaseProvisioner(
    new EncryptedPlatformTenantSecretStore(pool),runTenantMigrationOrchestrator));
  const poll=async()=>{try{while(await engine.processNext()){} }catch{ /* Fail closed; the engine persists sanitized job failures. */ }};
  timer=setInterval(()=>void poll(),Number(process.env.TENANT_PROVISIONING_POLL_MS??5000));
  timer.unref();void poll();
}

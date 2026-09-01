import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedPlatformTenantSecretStore } from "./tenant-secret-store";

describe("EncryptedPlatformTenantSecretStore",()=>{
  beforeEach(()=>{process.env.TENANT_SECRET_MASTER_KEY=Buffer.alloc(32,7).toString("base64");});
  afterEach(()=>{delete process.env.TENANT_SECRET_MASTER_KEY;});
  it("round-trips an encrypted connection string without persisting plaintext",async()=>{
    let row:{ciphertext:Buffer;iv:Buffer;auth_tag:Buffer;key_version:string;committed_at?:Date}|undefined;
    const query=vi.fn(async(sql:string,values?:readonly unknown[])=>{
      if(sql.startsWith("INSERT")){row={ciphertext:values?.[1] as Buffer,iv:values?.[2] as Buffer,auth_tag:values?.[3] as Buffer,key_version:"v1"};return {rows:[],rowCount:1};}
      if(sql.startsWith("SELECT"))return {rows:row?[row]:[],rowCount:row?1:0};
      if(sql.startsWith("UPDATE")){if(row)row.committed_at=new Date();return {rows:[],rowCount:row?1:0};}
      return {rows:[],rowCount:0};
    });
    const store=new EncryptedPlatformTenantSecretStore({query} as never);const secret="postgresql://tenant:verysecret@localhost/tenant";
    const reference=await store.putTenantDatabaseSecret(secret);
    expect(reference).toMatch(/^platform-secret:/);expect(row?.ciphertext.toString("utf8")).not.toContain("verysecret");
    expect(await store.getTenantDatabaseSecret(reference)).toBe(secret);await store.commitTenantDatabaseSecret(reference);expect(row?.committed_at).toBeInstanceOf(Date);
    expect(JSON.stringify(query.mock.calls)).not.toContain(secret);
  });
  it("rejects a missing or malformed master key",async()=>{
    process.env.TENANT_SECRET_MASTER_KEY="bad";
    const store=new EncryptedPlatformTenantSecretStore({query:vi.fn()} as never);
    await expect(store.putTenantDatabaseSecret("postgresql://u:p@localhost/db")).rejects.toThrow("32 bytes");
  });
});

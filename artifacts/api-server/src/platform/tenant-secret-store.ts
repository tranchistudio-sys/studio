import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { PlatformQueryable } from "@workspace/platform-db";

export interface TenantSecretStore {
  putTenantDatabaseSecret(value: string): Promise<string>;
  getTenantDatabaseSecret(reference: string): Promise<string>;
  commitTenantDatabaseSecret(reference: string): Promise<void>;
  deleteUncommittedSecret(reference: string): Promise<void>;
}

function masterKey(): Buffer {
  const encoded = process.env.TENANT_SECRET_MASTER_KEY?.trim();
  if (!encoded) throw new Error("TENANT_SECRET_MASTER_KEY chưa được cấu hình");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("TENANT_SECRET_MASTER_KEY phải là 32 bytes base64");
  return key;
}

function secretId(reference: string): string {
  const match = /^platform-secret:([0-9a-f-]{36})$/i.exec(reference);
  if (!match) throw new Error("Tenant secret reference không hợp lệ");
  return match[1]!;
}

export class EncryptedPlatformTenantSecretStore implements TenantSecretStore {
  constructor(private readonly queryable: PlatformQueryable) {}

  async putTenantDatabaseSecret(value: string): Promise<string> {
    if (!/^postgres(?:ql)?:\/\//.test(value)) throw new Error("Tenant database secret không hợp lệ");
    const id = randomUUID(); const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    await this.queryable.query(`INSERT INTO tenant_database_secrets
      (id,ciphertext,iv,auth_tag,key_version) VALUES ($1,$2,$3,$4,'v1')`,
      [id,ciphertext,iv,cipher.getAuthTag()]);
    return `platform-secret:${id}`;
  }

  async getTenantDatabaseSecret(reference: string): Promise<string> {
    const result = await this.queryable.query<{ ciphertext:Buffer; iv:Buffer; auth_tag:Buffer; key_version:string }>(
      "SELECT ciphertext,iv,auth_tag,key_version FROM tenant_database_secrets WHERE id=$1", [secretId(reference)]);
    const row = result.rows[0]; if (!row || row.key_version !== "v1") throw new Error("Tenant secret không tồn tại");
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), row.iv);
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext),decipher.final()]).toString("utf8");
  }

  async commitTenantDatabaseSecret(reference: string): Promise<void> {
    await this.queryable.query("UPDATE tenant_database_secrets SET committed_at=COALESCE(committed_at,now()),updated_at=now() WHERE id=$1", [secretId(reference)]);
  }

  async deleteUncommittedSecret(reference: string): Promise<void> {
    await this.queryable.query("DELETE FROM tenant_database_secrets WHERE id=$1 AND committed_at IS NULL", [secretId(reference)]);
  }
}

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "baileys";
import { pool, withTransaction } from "../db.js";
import { decryptBytes, encryptBytes, type EncryptedValue } from "../security/encryption.js";

interface EncryptedRow {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
}

function decode<T>(row: EncryptedRow, aad: string): T {
  const json = decryptBytes(
    { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyVersion: row.key_version },
    aad,
  ).toString("utf8");
  return JSON.parse(json, BufferJSON.reviver) as T;
}

function encode(value: unknown, aad: string): EncryptedValue {
  return encryptBytes(Buffer.from(JSON.stringify(value, BufferJSON.replacer), "utf8"), aad);
}

/** One NUMBER's Baileys credentials/keys (E4a, migration 054: whatsapp_number_auth_*, keyed by number_id), so every number's session is fully independent. */
export async function loadBaileysAuthState(numberId: string, workspaceId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const result = await pool.query<EncryptedRow>(
    `select ciphertext, iv, tag, key_version from public.whatsapp_number_auth_credentials where number_id = $1`,
    [numberId],
  );
  // AAD strings here are deliberately NOT workspace-namespaced (unlike the
  // SQL, which is already number_id-scoped at the row/PK level): existing
  // production secrets were encrypted under these exact static AAD values
  // before multi-workspace support shipped, and AES-GCM authentication
  // fails closed (throws "Unsupported state or unable to authenticate
  // data") if the AAD used to decrypt doesn't byte-for-byte match the AAD
  // used to encrypt. Changing these would permanently break every
  // already-stored secret. Row-level workspace isolation is already fully
  // enforced by the `where number_id = $1` queries below (054 copied the rows unchanged).
  const creds = result.rows[0] ? decode<AuthenticationCreds>(result.rows[0], "whatsapp:auth:creds") : initAuthCreds();

  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      if (ids.length === 0) return {};
      const rows = await pool.query<EncryptedRow & { key_id: string }>(
        `select key_id, ciphertext, iv, tag, key_version
           from public.whatsapp_number_auth_keys
          where number_id = $1 and key_type = $2 and key_id = any($3::text[])`,
        [numberId, type, ids],
      );
      const values: Partial<Record<string, SignalDataTypeMap[T]>> = {};
      for (const row of rows.rows) {
        let value = decode<SignalDataTypeMap[T]>(row, `whatsapp:auth:key:${type}:${row.key_id}`);
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as never) as unknown as SignalDataTypeMap[T];
        }
        values[row.key_id] = value;
      }
      return values as Record<string, SignalDataTypeMap[T]>;
    },
    async set(data: SignalDataSet) {
      await withTransaction(async (db) => {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value == null) {
              await db.query(`delete from public.whatsapp_number_auth_keys where number_id = $1 and key_type = $2 and key_id = $3`, [numberId, type, id]);
              continue;
            }
            const encrypted = encode(value, `whatsapp:auth:key:${type}:${id}`);
            await db.query(
              `insert into public.whatsapp_number_auth_keys
                (number_id, workspace_id, key_type, key_id, ciphertext, iv, tag, key_version)
               values ($1,$8,$2,$3,$4,$5,$6,$7)
               on conflict (number_id, key_type, key_id) do update
                 set ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
                     key_version = excluded.key_version, updated_at = now()`,
              [numberId, type, id, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion, workspaceId],
            );
          }
        }
      });
    },
    async clear() {
      await pool.query(`delete from public.whatsapp_number_auth_keys where number_id = $1`, [numberId]);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      const encrypted = encode(creds, "whatsapp:auth:creds");
      await pool.query(
        `insert into public.whatsapp_number_auth_credentials (number_id, ciphertext, iv, tag, key_version, workspace_id)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (number_id) do update
           set ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
               key_version = excluded.key_version, updated_at = now()`,
        [numberId, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion, workspaceId],
      );
    },
  };
}

export async function clearBaileysAuthState(numberId: string) {
  await withTransaction(async (db) => {
    await db.query(`delete from public.whatsapp_number_auth_keys where number_id = $1`, [numberId]);
    await db.query(`delete from public.whatsapp_number_auth_credentials where number_id = $1`, [numberId]);
  });
}

export const baileysSerialization = { encode, decode };

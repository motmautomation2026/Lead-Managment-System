import { describe, expect, it, vi } from "vitest";

// An in-memory whatsapp_number_auth_keys table behind the store's two queries.
const table = vi.hoisted(() => new Map<string, { key_id: string; ciphertext: Buffer; iv: Buffer; tag: Buffer; key_version: number }>());
const query = vi.hoisted(() =>
  vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("insert into public.whatsapp_number_auth_keys")) {
      const [, type, id, ciphertext, iv, tag, keyVersion] = params as [string, string, string, Buffer, Buffer, Buffer, number];
      table.set(`${type}/${id}`, { key_id: id, ciphertext, iv, tag, key_version: keyVersion });
      return { rows: [] };
    }
    if (sql.includes("from public.whatsapp_number_auth_keys")) {
      const [, type, ids] = params as [string, string, string[]];
      return { rows: ids.flatMap((id) => table.get(`${type}/${id}`) ?? []) };
    }
    return { rows: [] };
  }),
);
vi.mock("../../src/db.js", () => ({
  pool: { query },
  withTransaction: async (fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }),
}));

import { loadBaileysAuthState } from "../../src/providers/baileys-auth.store.js";

describe("Baileys auth store (B6)", () => {
  it("round-trips the v7 key types lid-mapping, device-list and tctoken, encrypted", async () => {
    const { state } = await loadBaileysAuthState("number-1", "ws-1");
    const token = Buffer.from([1, 2, 3, 250]);
    await state.keys.set({
      "lid-mapping": { "919876543210": "123456789012345@lid" },
      "device-list": { "919876543210": ["0", "12"] },
      tctoken: { "123456789012345@lid": { token, timestamp: "1793160000" } },
    });

    expect([...table.keys()].sort()).toEqual(["device-list/919876543210", "lid-mapping/919876543210", "tctoken/123456789012345@lid"]);
    for (const row of table.values()) expect(row.ciphertext.toString("utf8")).not.toContain("919876543210");

    const { state: reloaded } = await loadBaileysAuthState("number-1", "ws-1");
    expect(await reloaded.keys.get("lid-mapping", ["919876543210"])).toEqual({ "919876543210": "123456789012345@lid" });
    expect(await reloaded.keys.get("device-list", ["919876543210"])).toEqual({ "919876543210": ["0", "12"] });
    const tctoken = await reloaded.keys.get("tctoken", ["123456789012345@lid"]);
    expect(Buffer.from(tctoken["123456789012345@lid"]!.token)).toEqual(token);
  });
});

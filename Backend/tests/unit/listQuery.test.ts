import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addKeyset,
  addOwnerFilter,
  addRange,
  containsPattern,
  cursorSelectSql,
  decodeCursor,
  defineSorts,
  encodeCursor,
  escapeLike,
  isoTimestamp,
  multi,
  orderBySql,
  ownerIdFilter,
  pageParams,
  searchQuery,
  sortParam,
  SqlBuilder,
  strictBoolean,
  type ListSort,
} from "../../src/lists/listQuery.js";
import { ValidationError } from "../../src/errors.js";

const ID = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-0000000000aa";

const spec = defineSorts({
  idColumn: "t.id",
  defaultSort: "createdAt:desc",
  fields: {
    createdAt: { columns: ["t.created_at"], type: "timestamptz" },
    amount: { columns: ["t.amount"], type: "numeric", nullable: true },
    name: { columns: ["t.last_name", "t.first_name"], type: "text" },
  },
});
const sortOf = (value?: string) => sortParam(spec).parse(value) as ListSort;
const raw = (b64: unknown) => Buffer.from(JSON.stringify(b64)).toString("base64url");

describe("sort whitelist", () => {
  it("uses the default and accepts whitelisted field:dir", () => {
    expect(sortOf()).toMatchObject({ key: "createdAt", dir: "desc" });
    expect(sortOf("amount:asc")).toMatchObject({ key: "amount", dir: "asc", idColumn: "t.id" });
  });

  it.each(["email:asc", "amount", "amount:up", "amount:asc:x", "toString:asc", "__proto__:asc"])("rejects %s", (value) => {
    expect(sortParam(spec).safeParse(value).success).toBe(false);
  });

  it("nulls last only for nullable fields; id breaks ties in the same direction", () => {
    expect(orderBySql(sortOf("amount:desc"))).toBe("t.amount desc nulls last, t.id desc");
    expect(orderBySql(sortOf("createdAt:asc"))).toBe("t.created_at asc, t.id asc");
    expect(orderBySql(sortOf("name:desc"))).toBe("t.last_name desc, t.first_name desc, t.id desc");
  });

  it("rejects a bad spec", () => {
    expect(() => defineSorts({ ...spec, defaultSort: "nope:asc" })).toThrow();
    expect(() => defineSorts({ ...spec, fields: { x: { columns: ["a", "b"], type: "text", nullable: true } }, defaultSort: "x:asc" })).toThrow();
  });
});

describe("cursor", () => {
  it("round-trips single, composite and NULL values", () => {
    const at = "2026-10-24 10:11:12.123456+00";
    expect(decodeCursor(sortOf("createdAt:desc"), encodeCursor(sortOf("createdAt:desc"), [at, ID]))).toEqual({ values: [at], id: ID });
    expect(decodeCursor(sortOf("name:asc"), encodeCursor(sortOf("name:asc"), ["Rao", "Asha", ID]))).toEqual({ values: ["Rao", "Asha"], id: ID });
    expect(decodeCursor(sortOf("amount:asc"), encodeCursor(sortOf("amount:asc"), [null, ID]))).toEqual({ values: [null], id: ID });
  });

  it("is base64url JSON [sortValue, id, sort]", () => {
    const cursor = encodeCursor(sortOf("amount:asc"), ["10.50", ID]);
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString())).toEqual(["10.50", ID, "amount:asc"]);
  });

  it.each([
    ["not base64 json", "amount:asc", "%%%"],
    ["wrong shape", "amount:asc", raw({ a: 1 })],
    ["bad id", "amount:asc", raw(["10", "nope", "amount:asc"])],
    ["another sort's cursor", "amount:asc", raw(["10", ID, "amount:desc"])],
    ["non-numeric value", "amount:asc", raw(["10; drop table", ID, "amount:asc"])],
    ["extra element", "amount:asc", raw(["10", ID, "amount:asc", 1])],
    ["NULL for a NOT NULL field", "createdAt:desc", raw([null, ID, "createdAt:desc"])],
    ["bad timestamp", "createdAt:desc", raw(["yesterday", ID, "createdAt:desc"])],
    ["composite with one value", "name:asc", raw(["Rao", ID, "name:asc"])],
  ])("rejects %s with 400", (_label, sortKey, cursor) => {
    expect(() => decodeCursor(sortOf(sortKey), cursor)).toThrow(ValidationError);
  });

  it("selects cursor values as text plus the id", () => {
    expect(cursorSelectSql(sortOf("name:asc"))).toBe(`json_build_array(t.last_name::text, t.first_name::text, t.id) as "__cursor"`);
  });
});

describe("keyset condition", () => {
  const keyset = (sortKey: string, values: (string | null)[]) => {
    const sort = sortOf(sortKey);
    const b = new SqlBuilder();
    addKeyset(b, sort, encodeCursor(sort, [...values, ID]));
    return { sql: b.clauses.join(" and "), params: b.params };
  };

  it("NOT NULL field: a tuple comparison in the sort direction", () => {
    expect(keyset("createdAt:desc", ["2026-10-24 10:00:00+00"])).toEqual({
      sql: "((t.created_at, t.id) < ($2::timestamptz, $1::uuid))",
      params: [ID, "2026-10-24 10:00:00+00"],
    });
    expect(keyset("name:asc", ["Rao", "Asha"]).sql).toBe("((t.last_name, t.first_name, t.id) > ($2::text, $3::text, $1::uuid))");
  });

  it("nullable field with a value: past the value, or any NULL row (NULLs last), both directions", () => {
    expect(keyset("amount:asc", ["10"]).sql).toBe("((t.amount, t.id) > ($2::numeric, $1::uuid) or t.amount is null)");
    expect(keyset("amount:desc", ["10"]).sql).toBe("((t.amount, t.id) < ($2::numeric, $1::uuid) or t.amount is null)");
  });

  it("cursor inside the NULL group: only NULL rows past the id, both directions", () => {
    expect(keyset("amount:asc", [null])).toEqual({ sql: "(t.amount is null and t.id > $1::uuid)", params: [ID] });
    expect(keyset("amount:desc", [null]).sql).toBe("(t.amount is null and t.id < $1::uuid)");
  });

  it("no cursor adds nothing", () => {
    const b = new SqlBuilder();
    addKeyset(b, sortOf(), undefined);
    expect(b.where()).toBe("");
  });
});

describe("filters", () => {
  const schema = z
    .object({ ownerId: ownerIdFilter.optional(), stage: multi(z.enum(["a", "b"])).optional(), open: strictBoolean.optional(), from: isoTimestamp.optional(), q: searchQuery.optional(), ...pageParams })
    .strict();

  it("repeats become arrays; a single value too", () => {
    expect(schema.parse({ stage: "a" }).stage).toEqual(["a"]);
    expect(schema.parse({ stage: ["a", "b"] }).stage).toEqual(["a", "b"]);
    expect(schema.safeParse({ stage: ["a", "c"] }).success).toBe(false);
  });

  it("booleans are only true/false", () => {
    expect(schema.parse({ open: "false" }).open).toBe(false);
    for (const v of ["1", "0", "yes", ""]) expect(schema.safeParse({ open: v }).success).toBe(false);
  });

  it("limit 1–100, default 50; unknown params rejected", () => {
    expect(schema.parse({}).limit).toBe(50);
    expect(schema.parse({ limit: "100" }).limit).toBe(100);
    for (const v of ["0", "101", "x", "1.5"]) expect(schema.safeParse({ limit: v }).success).toBe(false);
    expect(schema.safeParse({ ownerid: "me" }).success).toBe(false);
  });

  it("q needs 2 characters after trimming; ranges need ISO timestamps", () => {
    expect(schema.safeParse({ q: " a " }).success).toBe(false);
    expect(schema.parse({ q: " ab " }).q).toBe("ab");
    expect(schema.safeParse({ from: "2026-10-24" }).success).toBe(false);
    expect(schema.parse({ from: "2026-10-24T00:00:00+05:30" }).from).toBe("2026-10-24T00:00:00+05:30");
  });

  it("ownerId: me → the caller, none → no owner, ids", () => {
    const b = new SqlBuilder();
    addOwnerFilter(b, "t.owner_id", schema.parse({ ownerId: ["me", "none", ID, ME] }).ownerId, ME);
    expect(b.clauses).toEqual(["(t.owner_id = any($1::uuid[]) or t.owner_id is null)"]);
    expect(b.params).toEqual([[ME, ID]]);
    const none = new SqlBuilder();
    addOwnerFilter(none, "t.owner_id", ["none"], ME);
    expect(none.clauses).toEqual(["(t.owner_id is null)"]);
    expect(schema.safeParse({ ownerId: "someone" }).success).toBe(false);
  });

  it("ranges are inclusive and parameterised", () => {
    const b = new SqlBuilder();
    addRange(b, "t.amount", 10, undefined, "numeric");
    addRange(b, "t.created_at", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "timestamptz");
    expect(b.where()).toBe("where t.amount >= $1::numeric and t.created_at >= $2::timestamptz and t.created_at <= $3::timestamptz");
  });
});

describe("escapeLike", () => {
  it("escapes %, _ and backslash", () => {
    expect(escapeLike("50%_off\\x")).toBe("50\\%\\_off\\\\x");
    expect(containsPattern("a_b")).toBe("%a\\_b%");
    expect(escapeLike("plain")).toBe("plain");
  });
});

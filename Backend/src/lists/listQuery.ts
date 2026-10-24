/**
 * CRM v2 list standard (docs/crm-v2/B2-design.md §4, contract in docs/crm-v2/B4-api.md):
 * keyset cursor, whitelisted sort with NULLs last, flat .strict() filters, escaped search,
 * `{data, nextCursor}` plus a separate count. Shared by contacts, companies, deals,
 * company duplicates and saved views. Every value goes in as a bind parameter.
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import { ValidationError } from "../errors.js";
import { isUuid } from "../validation/parse.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MIN_SEARCH_LENGTH = 2;

// --- SQL builder ---------------------------------------------------------------

/** Collects bind parameters and AND-ed where clauses. `p(value)` returns its `$n` placeholder. */
export class SqlBuilder {
  readonly params: unknown[] = [];
  readonly clauses: string[] = [];

  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  and(clause: string): this {
    this.clauses.push(clause);
    return this;
  }

  where(): string {
    return this.clauses.length ? `where ${this.clauses.join(" and ")}` : "";
  }
}

/** Escapes LIKE/ILIKE wildcards so `q` matches literally (Postgres' default escape is `\`; audit B30). */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

/** `%q%` for an escaped `ilike` "contains" search. */
export const containsPattern = (q: string) => `%${escapeLike(q)}%`;

// --- Filters -------------------------------------------------------------------

/** One value or a repeated query param (`ownerId=a&ownerId=b`), always an array. */
export const multi = <T extends z.ZodTypeAny>(item: T) =>
  z.union([item, z.array(item).min(1).max(100)]).transform((v): z.infer<T>[] => (Array.isArray(v) ? v : [v]));

/** Booleans are exactly "true" or "false". */
export const strictBoolean = z
  .enum(["true", "false"], { errorMap: () => ({ message: 'Use "true" or "false".' }) })
  .transform((v) => v === "true");

/** A timestamp bound: full ISO 8601 with an offset or Z (the client picks the time zone). */
export const isoTimestamp = z.string().datetime({ offset: true, message: "Use an ISO timestamp, e.g. 2026-10-24T00:00:00+05:30." });
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-24.");
export const nonNegativeNumber = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Use a number ≥ 0.")
  .transform(Number);

/** `ownerId`: user ids, `me` (the caller) and/or `none` (no owner). */
export const ownerIdFilter = multi(z.union([z.literal("me"), z.literal("none"), z.string().uuid()]));

/** `q`: trimmed, at least 2 characters. */
export const searchQuery = z.string().trim().min(MIN_SEARCH_LENGTH, `Search needs at least ${MIN_SEARCH_LENGTH} characters.`).max(200);

/** Adds `column in (owners)` / `column is null` for an ownerId filter. */
export function addOwnerFilter(b: SqlBuilder, column: string, values: string[] | undefined, actorId: string) {
  if (!values?.length) return;
  const ids = [...new Set(values.filter((v) => v !== "none").map((v) => (v === "me" ? actorId : v)))];
  const parts = [];
  if (ids.length) parts.push(`${column} = any(${b.p(ids)}::uuid[])`);
  if (values.includes("none")) parts.push(`${column} is null`);
  b.and(`(${parts.join(" or ")})`);
}

/** Adds `from <= column <= to` for a range filter; `cast` is the bind type (timestamptz, date, numeric). */
export function addRange(b: SqlBuilder, column: string, from: unknown, to: unknown, cast: string) {
  if (from !== undefined) b.and(`${column} >= ${b.p(from)}::${cast}`);
  if (to !== undefined) b.and(`${column} <= ${b.p(to)}::${cast}`);
}

// --- Sort + cursor -------------------------------------------------------------

export type SortType = "timestamptz" | "date" | "numeric" | "int" | "text";

/** A sortable field: one or more columns (same type; tie-broken by id). Only a single column may be nullable. */
export interface SortField {
  columns: string[];
  type: SortType;
  nullable?: boolean;
}

export interface ListSort {
  key: string;
  dir: "asc" | "desc";
  field: SortField;
  idColumn: string;
}

export interface SortSpec {
  fields: Record<string, SortField>;
  idColumn: string;
  defaultSort: string;
}

const SORT_VALUE: Record<SortType, RegExp> = {
  // Postgres timestamptz::text (microseconds kept, like the AI Activity cursor).
  timestamptz: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  numeric: /^-?\d+(\.\d+)?$/,
  int: /^-?\d+$/,
  text: /^[\s\S]{0,1000}$/,
};

export function defineSorts(spec: SortSpec): SortSpec {
  for (const [key, field] of Object.entries(spec.fields)) {
    if (!field.columns.length || (field.nullable && field.columns.length > 1)) throw new Error(`Bad sort field ${key}`);
  }
  if (!parseSortKey(spec, spec.defaultSort)) throw new Error(`Bad default sort ${spec.defaultSort}`);
  return spec;
}

function parseSortKey(spec: SortSpec, value: string): ListSort | null {
  const [key, dir, extra] = value.split(":");
  if (extra !== undefined || !key || (dir !== "asc" && dir !== "desc") || !Object.hasOwn(spec.fields, key)) return null;
  return { key, dir, field: spec.fields[key]!, idColumn: spec.idColumn };
}

/** Zod for `sort=field:asc|desc` (default from the spec); the result is a resolved ListSort. */
export const sortParam = (spec: SortSpec) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const sort = parseSortKey(spec, value ?? spec.defaultSort);
      if (!sort) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Sort by one of ${Object.keys(spec.fields).map((k) => `${k}:asc|desc`).join(", ")}.` });
        return z.NEVER;
      }
      return sort;
    });

/** Paging params shared by every list endpoint. */
export const pageParams = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(4000).optional(),
};

/**
 * `order by` for a sort, then id in the same direction. A nullable field gets `nulls last`;
 * NOT NULL fields leave it out so a descending sort can still scan the (workspace_id, field, id) index backwards.
 */
export function orderBySql(sort: ListSort): string {
  const nulls = sort.field.nullable ? " nulls last" : "";
  return [...sort.field.columns.map((c) => `${c} ${sort.dir}${nulls}`), `${sort.idColumn} ${sort.dir}`].join(", ");
}

/** Select expression holding the row's cursor values as text: `json_build_array(col::text…, id)`. */
export function cursorSelectSql(sort: ListSort, alias = "__cursor"): string {
  return `json_build_array(${[...sort.field.columns.map((c) => `${c}::text`), `${sort.idColumn}`].join(", ")}) as "${alias}"`;
}

type SortValue = string | null | string[];

/** Opaque cursor: base64url(JSON [sortValue, id, "key:dir"]); a composite sort's value is an array. */
export function encodeCursor(sort: ListSort, raw: (string | null)[]): string {
  const id = raw[raw.length - 1];
  const values = raw.slice(0, -1);
  const sortValue: SortValue = sort.field.columns.length === 1 ? values[0]! : (values as string[]);
  return Buffer.from(JSON.stringify([sortValue, id, `${sort.key}:${sort.dir}`])).toString("base64url");
}

/** Decodes and validates a cursor for this sort; anything malformed, tampered or from another sort → 400. */
export function decodeCursor(sort: ListSort, cursor: string): { values: (string | null)[]; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 3 && value[2] === `${sort.key}:${sort.dir}` && isUuid(value[1])) {
      const n = sort.field.columns.length;
      const values: unknown[] = n === 1 ? [value[0]] : Array.isArray(value[0]) ? value[0] : [];
      const ok =
        values.length === n &&
        values.every((v) => (v === null ? sort.field.nullable === true : typeof v === "string" && SORT_VALUE[sort.field.type].test(v)));
      if (ok) return { values: values as (string | null)[], id: value[1] as string };
    }
  } catch {
    // falls through
  }
  throw new ValidationError("Invalid cursor.");
}

/**
 * Adds the "rows after the cursor" condition, matching orderBySql:
 * - value set: (cols, id) past (values, id), or (nullable) any NULL row — NULLs come last;
 * - value NULL (cursor inside the NULL group): only NULL rows, past the id.
 */
export function addKeyset(b: SqlBuilder, sort: ListSort, cursor: string | undefined) {
  if (!cursor) return;
  const { values, id } = decodeCursor(sort, cursor);
  const op = sort.dir === "asc" ? ">" : "<";
  const idParam = `${b.p(id)}::uuid`;
  const [first] = sort.field.columns;
  if (values[0] === null) {
    b.and(`(${first} is null and ${sort.idColumn} ${op} ${idParam})`);
    return;
  }
  const casts = values.map((v) => `${b.p(v)}::${sort.field.type}`);
  const tuple = `(${sort.field.columns.join(", ")}, ${sort.idColumn}) ${op} (${casts.join(", ")}, ${idParam})`;
  b.and(sort.field.nullable ? `(${tuple} or ${first} is null)` : `(${tuple})`);
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Runs a keyset page. `sql(where, orderBy, limit, cursorSelect)` returns the full statement;
 * the builder already holds the filters. Fetches limit + 1 to know whether there is more.
 */
export async function runPage<T>(
  db: Queryable,
  b: SqlBuilder,
  sort: ListSort,
  page: { limit: number; cursor?: string | undefined },
  sql: (parts: { where: string; orderBy: string; limit: string; cursorSelect: string }) => string,
): Promise<Page<T>> {
  addKeyset(b, sort, page.cursor);
  const limit = b.p(page.limit + 1);
  const rows = (await db.query<T & { __cursor: (string | null)[] }>(sql({ where: b.where(), orderBy: orderBySql(sort), limit, cursorSelect: cursorSelectSql(sort) }), b.params)).rows;
  const more = rows.length > page.limit;
  const data = rows.slice(0, page.limit);
  const last = data[data.length - 1];
  return {
    data: data.map(({ __cursor: _c, ...row }) => row as unknown as T),
    nextCursor: more && last ? encodeCursor(sort, last.__cursor) : null,
  };
}

/** `select count(*)` with the same filters (no cursor, no sort). */
export async function runCount(db: Queryable, b: SqlBuilder, from: string): Promise<{ count: number }> {
  const { rows } = await db.query<{ count: number }>(`select count(*)::int as count from ${from} ${b.where()}`, b.params);
  return { count: rows[0]?.count ?? 0 };
}

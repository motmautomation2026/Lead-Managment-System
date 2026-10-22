import { describe, expect, it } from "vitest";
import { sessionLockUnsupportedReason } from "../../src/db.js";

describe("sessionLockUnsupportedReason", () => {
  it("rejects the Supabase transaction pooler port 6543", () => {
    expect(sessionLockUnsupportedReason("postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres")).toMatch(
      /port 6543.*advisory locks/,
    );
  });

  it.each([
    "postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
    "postgres://u:p@db.example.supabase.co/postgres",
    "postgres://u:p@localhost:65430/postgres",
    "not a url",
  ])("allows %s", (url) => {
    expect(sessionLockUnsupportedReason(url)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { gradeDkim, gradeDmarc, gradeMx, gradeSpf, joinTxt } from "../../src/domain/emailDeliverability.js";

const d = "motm.tech";

describe("MX", () => {
  it("present → green, none → red, lookup error → amber", () => {
    expect(gradeMx(d, { records: [{ exchange: "aspmx.l.google.com" }] })).toMatchObject({ status: "green", fix: null });
    expect(gradeMx(d, { records: [] })).toMatchObject({ status: "red", fix: expect.stringContaining("Ask whoever manages motm.tech's DNS") });
    expect(gradeMx(d, { error: "timed out" })).toMatchObject({ status: "amber" });
  });
});

describe("SPF", () => {
  it("one record with ~all or -all → green", () => {
    expect(gradeSpf(d, { records: ["v=spf1 include:_spf.google.com ~all", "google-site-verification=x"] }).status).toBe("green");
    expect(gradeSpf(d, { records: ["v=spf1 include:zoho.in -all"] }).status).toBe("green");
  });
  it("+all / ?all → amber", () => {
    expect(gradeSpf(d, { records: ["v=spf1 include:x +all"] })).toMatchObject({ status: "amber", summary: expect.stringContaining('"+all"') });
    expect(gradeSpf(d, { records: ["v=spf1 ?all"] }).status).toBe("amber");
  });
  it("two SPF records → red; none → red", () => {
    expect(gradeSpf(d, { records: ["v=spf1 include:a ~all", "v=spf1 include:b ~all"] })).toMatchObject({ status: "red", summary: expect.stringContaining("2 SPF records") });
    expect(gradeSpf(d, { records: ["something"] }).status).toBe("red");
  });
  it("joins chunked TXT records", () => {
    expect(joinTxt([["v=spf1 include:_spf.goo", "gle.com ~all"]])).toEqual(["v=spf1 include:_spf.google.com ~all"]);
  });
});

describe("DKIM", () => {
  it("selector found → green and named", () => {
    expect(gradeDkim(d, { selector: "google", record: "v=DKIM1; k=rsa; p=MIIBIjAN" }, ["google"])).toMatchObject({ status: "green", summary: 'DKIM key found at selector "google".' });
  });
  it("not found → red listing what was tried", () => {
    expect(gradeDkim(d, null, ["google", "default"])).toMatchObject({ status: "red", summary: "No DKIM key found (tried google, default)." });
  });
  it("empty p= (revoked) → red", () => {
    expect(gradeDkim(d, { selector: "s1", record: "v=DKIM1; p=" }, ["s1"]).status).toBe("red");
  });
});

describe("DMARC", () => {
  it("p=none → amber, quarantine / reject → green, none → red", () => {
    expect(gradeDmarc(d, { records: ["v=DMARC1; p=none; rua=mailto:x@motm.tech"] })).toMatchObject({ status: "amber" });
    expect(gradeDmarc(d, { records: ["v=DMARC1; p=quarantine"] })).toMatchObject({ status: "green", summary: "DMARC policy is p=quarantine." });
    expect(gradeDmarc(d, { records: ["v=DMARC1;p=reject"] }).status).toBe("green");
    expect(gradeDmarc(d, { records: [] })).toMatchObject({ status: "red", fix: expect.stringContaining("_dmarc.motm.tech") });
  });
});

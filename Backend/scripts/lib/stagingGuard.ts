/** Staging-only scripts (P7): why this database must not be touched, or null for staging. */
export const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
export const STAGING_REF = "arejsxqjhzotmngrobhm";

export function stagingProblem(url: string | undefined): string | null {
  const value = url?.trim() ?? "";
  if (value.includes(PRODUCTION_REF)) return "DATABASE_URL points at the production project; refusing.";
  if (!value.includes(STAGING_REF)) return `DATABASE_URL is not the staging project (${STAGING_REF}); refusing.`;
  return null;
}

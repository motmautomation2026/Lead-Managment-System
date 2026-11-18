/** Supabase Storage answers a download of a missing object with StorageApiError "Object not found" (statusCode 404). */
export function isMissingStorageObject(error: unknown): boolean {
  const e = error as { statusCode?: unknown; message?: unknown } | null;
  return Boolean(e) && (String(e!.statusCode) === "404" || /object not found/i.test(String(e!.message ?? "")));
}

/** A file that is gone from Storage (deleted). Other download errors stay temporary. */
export class MissingStorageObjectError extends Error {
  constructor(fileName: string) {
    super(`The file "${fileName}" is missing from storage.`);
    this.name = "MissingStorageObjectError";
  }
}

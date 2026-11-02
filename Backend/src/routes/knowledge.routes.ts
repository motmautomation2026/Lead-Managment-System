import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAdmin } from "../authMiddleware.js";
import { pool } from "../db.js";
import { AppError, ValidationError } from "../errors.js";
import { detectKind } from "../knowledge/extractText.js";
import { getDefaultEmbedder } from "../providers/openai.provider.js";
import { ProviderDeferredError, toProviderHttpError } from "../providers/provider-errors.js";
import { searchKnowledge } from "../services/knowledge.service.js";
import * as library from "../services/knowledgeLibrary.service.js";
import { parseBody, uuidParam } from "../validation/parse.js";

/**
 * Knowledge base and asset library for the AI agent, per workspace (mounted in
 * crmRouter). Every CRM user can read and run test searches; only admins
 * write. Uploads are processed by the worker (knowledgeIngestion.service.ts).
 */
export const knowledgeRouter = Router();
const documents = Router();
const assets = Router();
documents.param("id", uuidParam("knowledge document"));
assets.param("id", uuidParam("asset"));
knowledgeRouter.use("/documents", documents);
knowledgeRouter.use("/assets", assets);

const MB = 1024 * 1024;

/** One multipart `file`, size-capped and type-checked; non-multipart requests pass through untouched. */
function singleFile(maxMb: number, accept: (file: Express.Multer.File) => boolean, types: string) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * MB, files: 1 },
    fileFilter: (_req, file, cb) => (accept(file) ? cb(null, true) : cb(new ValidationError(`Unsupported file type. Upload ${types}.`, { field: "file" }))),
  });
  return (req: Request, res: Response, next: NextFunction) =>
    upload.single("file")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        next(new ValidationError(err.code === "LIMIT_FILE_SIZE" ? `File is too large (max ${maxMb} MB).` : err.message, { field: "file" }));
        return;
      }
      next(err);
    });
}

const ASSET_EXTENSIONS: Record<string, string> = { pdf: "pdf", pptx: "pptx", docx: "docx", png: "png", jpg: "jpeg", jpeg: "jpeg" };
const ASSET_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
]);
const isAssetFile = (file: Express.Multer.File) =>
  ASSET_MIME_TYPES.has(file.mimetype) || Boolean(ASSET_EXTENSIONS[file.originalname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ""]);

const uploadDocument = singleFile(20, (file) => detectKind(file.mimetype, file.originalname) !== null, "a PDF, DOCX, PPTX, Markdown or text file");
const uploadAsset = singleFile(10, isAssetFile, "a PDF, PPTX, DOCX, PNG or JPEG file");

const asFile = (file: Express.Multer.File): library.UploadedFile => ({ buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype, size: file.size });

/** Tags as a JSON array or (multipart) a comma-separated string; trimmed, lower-cased, de-duplicated. */
const tagsField = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value) => [...new Set((Array.isArray(value) ? value : (value ?? "").split(",")).map((tag) => tag.trim().toLowerCase()).filter(Boolean))])
  .refine((tags) => tags.length <= 20, "At most 20 tags.")
  .refine((tags) => tags.every((tag) => tag.length <= 50), "Each tag must be 50 characters or fewer.");
const channelsField = z
  .union([z.array(z.string()), z.string()])
  .transform((value) => [...new Set((Array.isArray(value) ? value : value.split(",")).map((c) => c.trim().toLowerCase()).filter(Boolean))])
  .pipe(z.array(z.enum(library.ASSET_CHANNELS)).min(1, "Choose at least one channel."));
const title = z.string().trim().min(1, "Title is required.").max(200);
const useWhen = z.string().trim().min(1, "Describe when the agent should use this asset.").max(1000);
const docType = z.enum(library.USER_DOC_TYPES);
/** Multipart sends booleans as strings. */
const booleanField = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

// --- Documents ----------------------------------------------------------------

documents.get("/", asyncHandler(async (req, res) => res.json({ data: await library.listDocuments(req.workspaceId!) })));
documents.get("/:id", asyncHandler(async (req, res) => res.json(await library.getDocument(req.workspaceId!, req.params.id!))));

const textDocumentSchema = z.object({ title, docType, tags: tagsField, text: z.string().trim().min(1, "Paste some text.").max(1_000_000) });
const fileDocumentSchema = z.object({ title: title.optional(), docType, tags: tagsField });

documents.post(
  "/",
  requireAdmin,
  uploadDocument,
  asyncHandler(async (req, res) => {
    if (req.file) {
      const input = parseBody(fileDocumentSchema, req.body);
      const fallbackTitle = req.file.originalname.replace(/\.[^.]+$/, "").trim() || req.file.originalname;
      res.status(201).json(await library.createFileDocument(req.actor!, req.workspaceId!, { ...input, title: input.title ?? fallbackTitle, file: asFile(req.file) }));
      return;
    }
    if (req.is("multipart/form-data")) throw new ValidationError("Attach a file or paste text.", { field: "file" });
    res.status(201).json(await library.createTextDocument(req.actor!, req.workspaceId!, parseBody(textDocumentSchema, req.body)));
  }),
);

const updateDocumentSchema = z.object({ title: title.optional(), docType: docType.optional(), tags: tagsField.optional(), isActive: z.boolean().optional() });
documents.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await library.updateDocument(req.actor!, req.workspaceId!, req.params.id!, parseBody(updateDocumentSchema, req.body)))),
);
documents.post("/:id/reprocess", requireAdmin, asyncHandler(async (req, res) => res.json(await library.reprocessDocument(req.actor!, req.workspaceId!, req.params.id!))));
documents.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await library.deleteDocument(req.actor!, req.workspaceId!, req.params.id!);
    res.status(204).end();
  }),
);

// --- Assets -------------------------------------------------------------------

assets.get("/", asyncHandler(async (req, res) => res.json({ data: await library.listAssets(req.workspaceId!) })));

// E2g rule 1: a new asset goes by email only unless the admin also picks WhatsApp.
const createAssetSchema = z.object({ title, useWhen, tags: tagsField, channels: channelsField.optional().transform((c) => c ?? ["email" as const]) });
assets.post(
  "/",
  requireAdmin,
  uploadAsset,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError("Attach the asset file.", { field: "file" });
    const input = parseBody(createAssetSchema, req.body);
    res.status(201).json(await library.createAsset(req.actor!, req.workspaceId!, { ...input, file: asFile(req.file) }));
  }),
);

const updateAssetSchema = z.object({ title: title.optional(), useWhen: useWhen.optional(), tags: tagsField.optional(), channels: channelsField.optional(), isActive: booleanField.optional() });
assets.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await library.updateAsset(req.actor!, req.workspaceId!, req.params.id!, parseBody(updateAssetSchema, req.body)))),
);
assets.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await library.deleteAsset(req.actor!, req.workspaceId!, req.params.id!);
    res.status(204).end();
  }),
);

// --- Test retrieval (any CRM user) ----------------------------------------------

const searchSchema = z.object({
  query: z.string().trim().min(1, "Describe a lead or situation to search for.").max(2000),
  docTypes: z.array(z.enum(library.ALL_DOC_TYPES)).optional(),
  tags: z.array(z.string().trim().toLowerCase()).max(20).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

knowledgeRouter.post(
  "/search",
  asyncHandler(async (req, res) => {
    const { query, ...options } = parseBody(searchSchema, req.body);
    try {
      // The pool path runs the search in its own transaction (needed for the iterative HNSW scan).
      res.json({ data: await searchKnowledge(pool, getDefaultEmbedder(), req.workspaceId!, query, options) });
    } catch (error) {
      if (error instanceof ProviderDeferredError && error.message === "OpenAI is not configured") {
        throw new AppError(503, "provider_unavailable", "Knowledge search needs an OpenAI API key on the server.");
      }
      throw toProviderHttpError(error, "Knowledge search failed");
    }
  }),
);

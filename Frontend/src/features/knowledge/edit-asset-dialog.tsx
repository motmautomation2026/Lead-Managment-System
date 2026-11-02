import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { KnowledgeAsset } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const ASSET_CHANNEL_OPTIONS = [
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

// Mirrors the server (knowledge.routes.ts): title ≤ 200, "use when" ≤ 1000, at least one channel.
const schema = z.object({
  title: z.string().trim().min(1, "Give the asset a title.").max(200, "At most 200 characters."),
  useWhen: z
    .string()
    .trim()
    .min(1, "Describe when the agent should use it.")
    .max(1000, "At most 1000 characters."),
  channels: z.array(z.enum(["email", "whatsapp"])).min(1, "Choose at least one channel."),
});
type FormValues = z.infer<typeof schema>;

const valuesOf = (asset: KnowledgeAsset): FormValues => ({
  title: asset.title,
  useWhen: asset.useWhen,
  channels: asset.channels,
});

/** Channel checkboxes shared by the add and edit asset forms. */
export function ChannelChoices({
  value,
  onChange,
}: {
  value: string[];
  onChange: (channels: ("email" | "whatsapp")[]) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium">Channels</legend>
      <div className="flex gap-4 text-sm">
        {ASSET_CHANNEL_OPTIONS.map(({ value: channel, label }) => (
          <label key={channel} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.includes(channel)}
              onChange={() =>
                onChange(
                  (value.includes(channel)
                    ? value.filter((c) => c !== channel)
                    : [...value, channel]) as ("email" | "whatsapp")[],
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        The AI attaches files only once a conversation exists, and on WhatsApp only after the
        contact has replied there.
      </p>
    </fieldset>
  );
}

/** Knowledge → Assets → Edit (E2g): title, "use when" and channels, admins only. */
export function EditAssetDialog({
  asset,
  onClose,
  onSave,
}: {
  asset: KnowledgeAsset | null;
  onClose: () => void;
  onSave: (id: string, values: FormValues) => Promise<boolean>;
}) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: asset ? valuesOf(asset) : { title: "", useWhen: "", channels: ["email"] },
  });
  const { reset } = form;
  useEffect(() => {
    if (asset) reset(valuesOf(asset));
  }, [asset, reset]);
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async (values) => {
    if (asset && (await onSave(asset.id, values))) onClose();
  });

  return (
    <Dialog open={Boolean(asset)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit asset</DialogTitle>
          <DialogDescription>
            The AI sees only the title and &ldquo;use when&rdquo;, never the file&rsquo;s contents.
          </DialogDescription>
        </DialogHeader>
        <form id="edit-asset" className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="space-y-1">
            <Label htmlFor="edit-asset-title">Title</Label>
            <Input
              id="edit-asset-title"
              aria-invalid={Boolean(errors.title)}
              {...form.register("title")}
            />
            {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-asset-use-when">Use when</Label>
            <Textarea
              id="edit-asset-use-when"
              rows={2}
              aria-invalid={Boolean(errors.useWhen)}
              {...form.register("useWhen")}
            />
            {errors.useWhen && <p className="text-xs text-destructive">{errors.useWhen.message}</p>}
          </div>
          <Controller
            control={form.control}
            name="channels"
            render={({ field }) => <ChannelChoices value={field.value} onChange={field.onChange} />}
          />
          {errors.channels && (
            <p className="text-xs text-destructive" role="alert">
              {errors.channels.message}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-asset" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

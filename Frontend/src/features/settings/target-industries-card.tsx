import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Factory } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveBar } from "@/components/crm/save-bar";
import { SectionHeader } from "@/components/crm/section-layout";
import { messageFromError, useUpdateAgentSettings } from "@/store";
import { WithAgentSettings } from "./agent-settings-gate";
import { parseIndustries } from "./target-industries";

// Mirrors the server (settingsSchema.ts): ≤ 100 industries, each ≤ 60 characters.
const schema = z.object({
  industries: z
    .string()
    .refine((t) => parseIndustries(t).length <= 100, "At most 100 target industries.")
    .refine(
      (t) => parseIndustries(t).every((k) => k.length <= 60),
      "Each industry can be at most 60 characters.",
    ),
});
type FormValues = z.infer<typeof schema>;

/**
 * Settings → AI agent → Target industries (E3b-2b, admin only): the workspace's buyer industries.
 * A contact whose industry matches one gets fit points in the hot-lead score. Empty = the score
 * uses the email domain, company and revenue only.
 */
export function TargetIndustriesCard({ keywords }: { keywords: string[] }) {
  const update = useUpdateAgentSettings();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { industries: keywords.join(", ") },
  });
  const { reset } = form;
  useEffect(() => reset({ industries: keywords.join(", ") }), [keywords, reset]);
  const error = form.formState.errors.industries;
  const submit = form.handleSubmit((values) =>
    update.mutate(
      { targetIndustryKeywords: parseIndustries(values.industries) },
      {
        onSuccess: () => toast.success("Target industries saved."),
      },
    ),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Factory /> Target industries
        </CardTitle>
        <CardDescription>
          Contacts in these industries score higher on the hot-lead score. The AI never sees the
          score.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="space-y-1">
            <Label htmlFor="agent-target-industries">Industries, separated by commas</Label>
            <Input
              id="agent-target-industries"
              placeholder="engineering, steel, pumps"
              aria-invalid={Boolean(error)}
              {...form.register("industries")}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to score on email, company and revenue only.
            </p>
            {error && <p className="text-xs text-destructive">{error.message}</p>}
          </div>
          <SaveBar
            dirty={form.formState.isDirty}
            saving={update.isPending}
            onSave={() => void submit()}
            onDiscard={() => {
              update.reset();
              reset({ industries: keywords.join(", ") });
            }}
            error={update.isError ? messageFromError(update.error) : undefined}
            saveLabel="Save target industries"
          />
        </form>
      </CardContent>
    </Card>
  );
}

/** Settings → AI → Target industries (admins). */
export function IndustriesSection() {
  return (
    <>
      <SectionHeader
        title="Target industries"
        description="Industries that raise the hot-lead score."
      />
      <WithAgentSettings>
        {(s) => <TargetIndustriesCard keywords={s.targetIndustryKeywords ?? []} />}
      </WithAgentSettings>
    </>
  );
}

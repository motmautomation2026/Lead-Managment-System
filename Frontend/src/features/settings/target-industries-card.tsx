import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Factory } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { messageFromError, useUpdateAgentSettings } from "@/store";
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
        onError: (e) => toast.error(messageFromError(e)),
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
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save target industries"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

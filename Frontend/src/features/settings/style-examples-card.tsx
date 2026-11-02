import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PenLine } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { messageFromError, useUpdateAgentSettings } from "@/store";

// Mirrors the server (settingsSchema.ts).
const MAX_CHARS = 6000;
const schema = z.object({
  styleExamples: z.string().max(MAX_CHARS, `At most ${MAX_CHARS} characters.`),
});
type FormValues = z.infer<typeof schema>;

/**
 * Settings → AI agent → Style examples (E3a): text showing the style the AI should write in.
 * Admins edit; everyone else reads.
 */
export function StyleExamplesCard({ examples, editable }: { examples: string; editable: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PenLine /> Style examples
        </CardTitle>
        <CardDescription>
          The AI writes in this style. It never copies facts from these examples.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {editable ? (
          <StyleExamplesForm examples={examples} />
        ) : (
          <div className="space-y-3 text-sm">
            <p className="whitespace-pre-wrap text-muted-foreground">{examples || "None yet."}</p>
            <p className="text-xs text-muted-foreground">Only admins can change the examples.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StyleExamplesForm({ examples }: { examples: string }) {
  const update = useUpdateAgentSettings();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { styleExamples: examples },
  });
  const { reset } = form;
  useEffect(() => reset({ styleExamples: examples }), [examples, reset]);
  const error = form.formState.errors.styleExamples;

  const submit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: () => toast.success("Style examples saved."),
      onError: (e) => toast.error(messageFromError(e)),
    }),
  );

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
      <div className="space-y-1">
        <Label htmlFor="agent-style-examples">Style examples</Label>
        <Textarea
          id="agent-style-examples"
          rows={10}
          aria-invalid={Boolean(error)}
          {...form.register("styleExamples")}
        />
        <p className="text-xs text-muted-foreground">
          Up to {MAX_CHARS.toLocaleString("en-IN")} characters. Leave empty for none.
        </p>
        {error && <p className="text-xs text-destructive">{error.message}</p>}
      </div>
      <Button type="submit" disabled={update.isPending}>
        {update.isPending ? "Saving…" : "Save style examples"}
      </Button>
    </form>
  );
}

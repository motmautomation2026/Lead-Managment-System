import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ListChecks, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { AgentMessageRules } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveBar } from "@/components/crm/save-bar";
import { SectionHeader } from "@/components/crm/section-layout";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { messageFromError, useAgentStats, useIsAdmin, useUpdateAgentSettings } from "@/store";
import { StyleExamplesCard } from "./style-examples-card";
import { WithAgentSettings } from "./agent-settings-gate";

const words = z.coerce
  .number({ invalid_type_error: "Enter a number." })
  .int("Use a whole number.")
  .min(1, "At least 1 word.")
  .max(500, "At most 500 words.");

// Mirrors the server (settingsSchema.ts): ≤ 100 phrases, each ≤ 60 characters.
const schema = z.object({
  bannedPhrases: z
    .string()
    .transform((text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.string())
        .max(100, "At most 100 phrases.")
        .refine(
          (phrases) => phrases.every((p) => p.length <= 60),
          "Each phrase can be at most 60 characters.",
        ),
    ),
  whatsappMaxWords: words,
  emailMaxWords: words,
});
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

const formValues = (rules: AgentMessageRules): FormInput => ({
  bannedPhrases: rules.bannedPhrases.join("\n"),
  whatsappMaxWords: rules.whatsappMaxWords,
  emailMaxWords: rules.emailMaxWords,
});

// E3b-1b: same as the backend's whatsappTargetWords (two thirds of the hard limit); display only.
const whatsappTarget = (limit: number) => Math.round((limit * 2) / 3);
const WORDS_COUNTED = "Only the AI's own text counts, not the signature, opt-out or booking line.";

/**
 * Settings → AI agent → Message rules (E2b): banned phrases and word limits every AI message is
 * checked against. Admins edit; everyone else reads.
 */
export function MessageRulesCard({
  rules,
  editable,
}: {
  rules: AgentMessageRules;
  editable: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks /> Message rules
        </CardTitle>
        <CardDescription>
          Every AI message is checked against these. A message that breaks one is rewritten up to
          twice for simple problems, otherwise handed to the rep.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {editable ? <RulesForm rules={rules} /> : <RulesView rules={rules} />}
      </CardContent>
    </Card>
  );
}

function RulesView({ rules }: { rules: AgentMessageRules }) {
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="font-medium">Word limits</dt>
        <dd className="text-muted-foreground">
          WhatsApp {rules.whatsappMaxWords} words (the AI aims for about{" "}
          {whatsappTarget(rules.whatsappMaxWords)}) · email {rules.emailMaxWords} words
        </dd>
        <dd className="text-xs text-muted-foreground">{WORDS_COUNTED}</dd>
      </div>
      <div>
        <dt className="font-medium">Banned phrases</dt>
        <dd className="text-muted-foreground">
          {rules.bannedPhrases.length ? rules.bannedPhrases.join(", ") : "None"}
        </dd>
      </div>
      <p className="text-xs text-muted-foreground">Only admins can change these.</p>
    </dl>
  );
}

function RulesForm({ rules }: { rules: AgentMessageRules }) {
  const update = useUpdateAgentSettings();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: formValues(rules),
  });
  const { reset } = form;
  useEffect(() => reset(formValues(rules)), [rules, reset]);
  const errors = form.formState.errors;

  const submit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: () => toast.success("Message rules saved."),
    }),
  );

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="rules-whatsapp-words">WhatsApp max words</Label>
          <Input
            id="rules-whatsapp-words"
            type="number"
            inputMode="numeric"
            aria-invalid={Boolean(errors.whatsappMaxWords)}
            {...form.register("whatsappMaxWords")}
          />
          {errors.whatsappMaxWords && (
            <p className="text-xs text-destructive">{errors.whatsappMaxWords.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="rules-email-words">Email max words (body)</Label>
          <Input
            id="rules-email-words"
            type="number"
            inputMode="numeric"
            aria-invalid={Boolean(errors.emailMaxWords)}
            {...form.register("emailMaxWords")}
          />
          {errors.emailMaxWords && (
            <p className="text-xs text-destructive">{errors.emailMaxWords.message}</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          The AI aims for about {whatsappTarget(rules.whatsappMaxWords)} words on WhatsApp.{" "}
          {WORDS_COUNTED}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rules-banned">Banned phrases (one per line)</Label>
        <Textarea
          id="rules-banned"
          rows={8}
          aria-invalid={Boolean(errors.bannedPhrases)}
          {...form.register("bannedPhrases")}
        />
        <p className="text-xs text-muted-foreground">
          Matched as whole words, ignoring case and links. Up to 100 phrases, 60 characters each.
        </p>
        {errors.bannedPhrases && (
          <p className="text-xs text-destructive">{errors.bannedPhrases.message}</p>
        )}
      </div>
      <SaveBar
        dirty={form.formState.isDirty}
        saving={update.isPending}
        onSave={() => void submit()}
        onDiscard={() => {
          update.reset();
          reset(formValues(rules));
        }}
        error={update.isError ? messageFromError(update.error) : undefined}
        saveLabel="Save message rules"
      />
    </form>
  );
}

function MessageRulesReadOnly() {
  const stats = useAgentStats();
  if (stats.isError) {
    return (
      <Card>
        <CardContent className="space-y-2 py-6 text-sm">
          <p className="text-destructive">
            Couldn't load the AI message rules: {messageFromError(stats.error)}
          </p>
          <Button size="sm" variant="outline" onClick={() => void stats.refetch()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!stats.data) return <SectionSkeleton label="Loading AI message rules" />;
  return stats.data.messageRules ? (
    <div className="space-y-6">
      <MessageRulesCard rules={stats.data.messageRules} editable={false} />
      <StyleExamplesCard examples={stats.data.messageRules.styleExamples} editable={false} />
    </div>
  ) : null;
}

/** Settings → AI → Message rules: admins edit; everyone else reads (E2b). */
export function MessageRulesSection() {
  const isAdmin = useIsAdmin();
  return (
    <>
      <SectionHeader
        title="Message rules"
        description="Every AI message is checked against these."
      />
      {isAdmin ? (
        <WithAgentSettings>{(s) => <MessageRulesCard rules={s} editable />}</WithAgentSettings>
      ) : (
        <MessageRulesReadOnly />
      )}
    </>
  );
}

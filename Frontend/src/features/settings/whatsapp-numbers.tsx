import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  backend,
  type WhatsAppConnection,
  type WhatsAppNumber,
  type WhatsAppNumberInput,
} from "@/lib/backend-client";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusPill, type PillTone } from "@/components/crm/status-pill";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { keys, messageFromError, useIsAdmin, useSession } from "@/store";

const NO_OWNER = "none";

const STATUS_TONE: Record<string, PillTone> = {
  connected: "success",
  connecting: "info",
  reconnecting: "warning",
  qr_ready: "info",
  reauth_required: "danger",
  error: "danger",
  disconnected: "neutral",
};

const whole = (min: number, max: number) =>
  z.coerce.number().int("Whole numbers only.").min(min).max(max);
const numberSchema = z
  .object({
    label: z.string().trim().min(1, "Give the number a label.").max(60),
    ownerUserId: z.string(),
    dailyCap: whole(1, 10_000),
    minDelaySeconds: whole(1, 300),
    maxDelaySeconds: whole(1, 600),
    maxNewChatsPerDay: whole(0, 1000),
  })
  .refine((v) => v.minDelaySeconds <= v.maxDelaySeconds, {
    message: "The minimum can't be more than the maximum.",
    path: ["maxDelaySeconds"],
  });
type NumberForm = z.infer<typeof numberSchema>;

const formValues = (n: WhatsAppNumber): NumberForm => ({
  label: n.label,
  ownerUserId: n.ownerUserId ?? NO_OWNER,
  dailyCap: n.dailyCap,
  minDelaySeconds: n.minDelaySeconds,
  maxDelaySeconds: n.maxDelaySeconds,
  maxNewChatsPerDay: n.maxNewChatsPerDay,
});

/** "7 / 20 (warm-up day 2)" — sent today against the cap after warm-up. */
function capText(n: WhatsAppNumber) {
  return n.warmupDay !== null && n.effectiveDailyCap < n.dailyCap
    ? `${n.sentToday} / ${n.effectiveDailyCap} (warm-up day ${n.warmupDay})`
    : `${n.sentToday} / ${n.effectiveDailyCap}`;
}

/**
 * Settings → Workspace → WhatsApp → Numbers (E4a): one card per number (own QR pairing, status,
 * today's sent / cap, warm-up, owner, safety, pause/resume, remove), "Add number", and the
 * session-pooler warning (rule 12).
 */
export function WhatsAppNumbers({
  workspaceId,
  data,
}: {
  workspaceId: string;
  data: WhatsAppConnection;
}) {
  const isAdmin = useIsAdmin();
  const client = useQueryClient();
  const store = (next: WhatsAppConnection) =>
    client.setQueryData(keys.connection(workspaceId, "whatsapp"), next);
  const add = useMutation({
    mutationFn: () => backend.connections.whatsapp.addNumber(),
    onSuccess: (next) => {
      store(next);
      toast.success("Number added. Its QR code appears here in a few seconds.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const atMax = data.numbers.length >= data.maxNumbers;

  return (
    <section aria-labelledby="whatsapp-numbers" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="whatsapp-numbers" className="text-sm font-semibold">
            Numbers ({data.numbers.length} of {data.maxNumbers})
          </h3>
          <p className="text-xs text-muted-foreground">
            A contact always hears from the same number. New contacts go to their owner's number,
            else the number with the most room left today.
          </p>
        </div>
        {isAdmin && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => add.mutate()}
            disabled={atMax || add.isPending}
          >
            <Plus className="size-3.5" /> Add number
          </Button>
        )}
      </div>
      {data.sessionSlots.overHeadroom && (
        <div
          role="alert"
          className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
        >
          {data.sessionSlots.numbers} WhatsApp numbers across all workspaces need a database session
          slot each, but only {data.sessionSlots.headroom} are free for them. Raise the session
          pooler size in Supabase (Database → Connection pooling) before connecting more numbers.
        </div>
      )}
      {data.numbers.map((n) => (
        <NumberCard
          key={n.id}
          number={n}
          others={data.numbers.filter((o) => o.id !== n.id)}
          isAdmin={isAdmin}
          onSaved={store}
        />
      ))}
    </section>
  );
}

function NumberCard({
  number: n,
  others,
  isAdmin,
  onSaved,
}: {
  number: WhatsAppNumber;
  others: WhatsAppNumber[];
  isAdmin: boolean;
  onSaved: (next: WhatsAppConnection) => void;
}) {
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const command = useMutation({
    mutationFn: (c: "connect" | "restart" | "logout") =>
      backend.connections.whatsapp.command(n.id, c),
    onSuccess: (next) => {
      setLogoutOpen(false);
      onSaved(next);
      toast.success("WhatsApp command queued.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => backend.connections.whatsapp.pauseNumber(n.id, paused),
    onSuccess: (next, paused) => {
      setResumeOpen(false);
      onSaved(next);
      toast.success(paused ? `Number ${n.label} paused.` : `Number ${n.label} resumed.`);
    },
    onError: (error) => toast.error(messageFromError(error)),
  });

  return (
    <article aria-label={`WhatsApp number ${n.label}`} className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium">{n.label}</span>
          <StatusPill tone={STATUS_TONE[n.status] ?? "neutral"} dot>
            {n.status.replaceAll("_", " ")}
          </StatusPill>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {n.displayName || (n.connectedPhone ? `+${n.connectedPhone}` : "Not paired")}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">Owner: {n.ownerName ?? "None"}</span>
      </div>

      {n.pause && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <div className="font-medium">Sending on {n.label} is paused</div>
              <div>{n.pause.reason ?? "Outbound sending is turned off."}</div>
              {n.pause.at && (
                <div className="text-xs">
                  {new Date(n.pause.at).toLocaleString()}
                  {n.pause.byName ? ` · by ${n.pause.byName}` : " · automatically"}
                </div>
              )}
            </div>
          </div>
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setResumeOpen(true)}>
              Resume sending
            </Button>
          )}
        </div>
      )}
      {n.lastError && <p className="text-xs text-destructive">{n.lastError}</p>}
      {n.outboundRestricted && (
        <p className="text-xs text-destructive">
          WhatsApp reported a reach-out or new-chat restriction on this number. Its sends are halted
          automatically.
        </p>
      )}

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <Stat label="Sent today" value={capText(n)} />
        <Stat label="New chats today" value={`${n.newChatsToday} / ${n.maxNewChatsPerDay}`} />
        <Stat label="Contacts on this number" value={String(n.leadCount)} />
      </dl>

      {n.qr && (
        <div className="flex flex-col items-center rounded-lg border bg-white p-5 text-black">
          <QRCodeSVG value={n.qr} size={220} level="M" />
          <p className="mt-3 text-center text-xs">
            Scan from WhatsApp → Linked devices. This QR expires shortly.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => command.mutate("connect")}
          disabled={command.isPending}
        >
          Connect / get QR
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => command.mutate("restart")}
          disabled={command.isPending}
        >
          <RefreshCw className="size-3.5" /> Restart
        </Button>
        {isAdmin && !n.pause && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => pause.mutate(true)}
            disabled={pause.isPending}
          >
            Pause sending
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          className="sm:ml-auto"
          onClick={() => setLogoutOpen(true)}
        >
          Log out
        </Button>
        {isAdmin && others.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setRemoveOpen(true)}>
            Remove
          </Button>
        )}
      </div>

      {isAdmin ? (
        <NumberSettingsForm number={n} onSaved={onSaved} />
      ) : (
        <p className="text-xs text-muted-foreground">
          Spacing {n.minDelaySeconds}–{n.maxDelaySeconds} s · daily cap {n.dailyCap} ·{" "}
          {n.maxNewChatsPerDay} new chats per day. Only admins can change these.
        </p>
      )}

      <ConfirmDialog
        open={logoutOpen}
        onOpenChange={setLogoutOpen}
        title={`Log out WhatsApp number ${n.label}?`}
        description="Its encrypted session keys are removed and it must be paired again. Its contacts' messages wait until then."
        confirmLabel="Log out"
        disabled={command.isPending}
        onConfirm={() => command.mutate("logout")}
      />
      <ConfirmDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title={`Resume sending on ${n.label}?`}
        description="Its queued messages start going out again, with the usual spacing, caps and send window. Check why it was paused first."
        confirmLabel="Resume sending"
        disabled={pause.isPending}
        onConfirm={() => pause.mutate(false)}
      />
      {isAdmin && (
        <RemoveNumberDialog
          number={n}
          others={others}
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          onSaved={onSaved}
        />
      )}
    </article>
  );
}

function NumberSettingsForm({
  number: n,
  onSaved,
}: {
  number: WhatsAppNumber;
  onSaved: (next: WhatsAppConnection) => void;
}) {
  const { users } = useSession();
  const form = useForm<NumberForm>({
    resolver: zodResolver(numberSchema),
    defaultValues: formValues(n),
  });
  const errors = form.formState.errors;
  const save = form.handleSubmit(async (values) => {
    const input: WhatsAppNumberInput = {
      ...values,
      ownerUserId: values.ownerUserId === NO_OWNER ? null : values.ownerUserId,
    };
    try {
      const next = await backend.connections.whatsapp.updateNumber(n.id, input);
      onSaved(next);
      const saved = next.numbers.find((x) => x.id === n.id);
      if (saved) form.reset(formValues(saved));
      toast.success(`Number ${values.label} saved.`);
    } catch (error) {
      toast.error(messageFromError(error));
    }
  });
  const field = (
    name: "label" | "dailyCap" | "minDelaySeconds" | "maxDelaySeconds" | "maxNewChatsPerDay",
    label: string,
    numeric = true,
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`wa-${n.id}-${name}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`wa-${n.id}-${name}`}
        {...(numeric ? { type: "number", inputMode: "numeric" as const } : {})}
        aria-invalid={Boolean(errors[name])}
        {...form.register(name)}
      />
      {errors[name] && <p className="text-xs text-destructive">{errors[name]?.message}</p>}
    </div>
  );

  return (
    <form className="space-y-3 border-t pt-3" onSubmit={(e) => void save(e)} noValidate>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {field("label", "Label", false)}
        <div className="space-y-1">
          <Label htmlFor={`wa-${n.id}-owner`} className="text-xs">
            Owner (their contacts use this number)
          </Label>
          <Controller
            control={form.control}
            name="ownerUserId"
            render={({ field: f }) => (
              <Select value={f.value} onValueChange={f.onChange}>
                <SelectTrigger id={`wa-${n.id}-owner`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_OWNER}>No owner</SelectItem>
                  {users
                    .filter((u) => u.active)
                    .map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        {field("dailyCap", "Daily cap (IST)")}
        {field("minDelaySeconds", "Min spacing (seconds)")}
        {field("maxDelaySeconds", "Max spacing (seconds)")}
        {field("maxNewChatsPerDay", "New chats per day")}
      </div>
      <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
        Save number
      </Button>
    </form>
  );
}

/** Rule 10: with contacts on it, the admin moves them to another number or leaves them without one. */
export function RemoveNumberDialog({
  number: n,
  others,
  open,
  onOpenChange,
  onSaved,
}: {
  number: WhatsAppNumber;
  others: WhatsAppNumber[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: WhatsAppConnection) => void;
}) {
  const [choice, setChoice] = useState<"move" | "unassign">("move");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setChoice("move");
      setTarget("");
      setError(null);
    }
  }, [open]);
  const hasContacts = n.leadCount > 0 || n.queuedSends > 0;
  const remove = useMutation({
    mutationFn: () =>
      backend.connections.whatsapp.removeNumber(
        n.id,
        !hasContacts
          ? {}
          : choice === "move"
            ? { leads: "move", moveToNumberId: target }
            : { leads: "unassign" },
      ),
    onSuccess: (next) => {
      onSaved(next);
      onOpenChange(false);
      toast.success(`Number ${n.label} removed.`);
    },
    onError: (e) => setError(messageFromError(e)),
  });
  const submit = () => {
    if (hasContacts && choice === "move" && !target)
      return setError("Pick the number to move the contacts to.");
    remove.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove WhatsApp number {n.label}?</DialogTitle>
          <DialogDescription>
            It is logged out and its session keys are deleted. Its message history stays.
          </DialogDescription>
        </DialogHeader>
        {hasContacts && (
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1">
              {n.leadCount} contact(s) use this number
              {n.queuedSends ? ` and ${n.queuedSends} message(s) are queued` : ""}.
            </legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`remove-${n.id}`}
                checked={choice === "move"}
                onChange={() => setChoice("move")}
              />
              Move them to another number
            </label>
            {choice === "move" && (
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger aria-label="Number to move the contacts to">
                  <SelectValue placeholder="Pick a number" />
                </SelectTrigger>
                <SelectContent>
                  {others.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`remove-${n.id}`}
                checked={choice === "unassign"}
                onChange={() => setChoice("unassign")}
              />
              Leave them without a number (each gets one at its next message)
            </label>
          </fieldset>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={remove.isPending}>
            Remove number
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-semibold">{value}</dd>
    </div>
  );
}

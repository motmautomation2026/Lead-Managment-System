import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { backend } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { keys, messageFromError } from "@/store";
import { bookingUrlField } from "./booking-url";
import { SectionHeader } from "@/components/crm/section-layout";

const schema = z.object({ bookingUrl: bookingUrlField });
type FormValues = z.infer<typeof schema>;

/**
 * Settings → Profile (E3b-1 rule 5): every user's own booking link. When the AI asks one of
 * their contacts for a call, it adds "you can pick a time here: <link>" (never in a first WhatsApp).
 */
export function ProfilePanel() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: keys.session, queryFn: ({ signal }) => backend.me(signal) });
  const save = useMutation({
    mutationFn: backend.updateMe,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.session });
      toast.success("Booking link saved.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { bookingUrl: "" },
  });
  const { reset } = form;
  const saved = me.data?.bookingUrl ?? "";
  useEffect(() => reset({ bookingUrl: saved }), [saved, reset]);
  const error = form.formState.errors.bookingUrl;
  const submit = form.handleSubmit((values) =>
    save.mutate({ bookingUrl: values.bookingUrl.trim() || null }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock /> Profile
        </CardTitle>
        <CardDescription>
          {me.data ? `${me.data.name} · ${me.data.email}` : "Your account."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {me.isError ? (
          <p className="text-sm text-destructive">{messageFromError(me.error)}</p>
        ) : (
          <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
            <div className="space-y-1">
              <Label htmlFor="profile-booking-url">Booking link</Label>
              <Input
                id="profile-booking-url"
                type="url"
                inputMode="url"
                placeholder="https://calendly.com/your-name"
                aria-invalid={Boolean(error)}
                disabled={me.isLoading}
                {...form.register("bookingUrl")}
              />
              <p className="text-xs text-muted-foreground">
                When the AI asks your contacts for a call, it adds this link so they can pick a
                time. Leave empty for none.
              </p>
              {error && <p className="text-xs text-destructive">{error.message}</p>}
            </div>
            <Button type="submit" disabled={save.isPending || me.isLoading}>
              {save.isPending ? "Saving…" : "Save booking link"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings → Personal → My profile. */
export function ProfileSection() {
  return (
    <>
      <SectionHeader title="My profile" description="Your account and booking link." />
      <ProfilePanel />
    </>
  );
}

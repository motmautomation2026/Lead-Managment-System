import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
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
import type { CreateTaskOptions } from "@/app/add-lead-context";
import { ContactPicker } from "@/features/contacts/contact-picker";
import { dateInputValue, toIsoFromIst } from "@/lib/dates";
import { label } from "@/lib/labels";
import { messageFromError, useContact, useCreateTask, useSession } from "@/store";
import { TASK_TYPES } from "@/types";

const CONTACT_OWNER = "__contact";

const taskSchema = z.object({
  contact: z.object({ id: z.string(), name: z.string() }).nullable().refine(Boolean, {
    message: "Choose the contact this task is for.",
  }),
  type: z.enum(TASK_TYPES),
  title: z
    .string()
    .trim()
    .min(1, "Give the task a title.")
    .max(300, "Keep the title under 300 characters."),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a due date."),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/, "Pick a due time."),
  ownerId: z.string(),
});
type TaskForm = z.infer<typeof taskSchema>;

/**
 * Create task (POST /tasks), app-wide: + Create → Task, the contact record's Task quick action
 * and the deal record (contact = the deal's contact). Due date + time are IST. Owner defaults
 * to the contact's owner. The host remounts it (`key`) per opening.
 */
export function CreateTaskDialog({
  open,
  onOpenChange,
  options = {},
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options?: CreateTaskOptions;
}) {
  const create = useCreateTask();
  const { users } = useSession();
  const form = useForm<TaskForm>({
    resolver: zodResolver(taskSchema),
    defaultValues: {
      contact: options.contact ?? null,
      type: "follow_up",
      title: "",
      dueDate: dateInputValue(1),
      dueTime: "10:00",
      ownerId: CONTACT_OWNER,
    },
  });
  const errors = form.formState.errors;
  const contact = form.watch("contact");
  const detail = useContact(contact?.id ?? "");

  const submit = form.handleSubmit(async (v) => {
    const ownerId = v.ownerId === CONTACT_OWNER ? (detail.data?.ownerId ?? undefined) : v.ownerId;
    try {
      await create.mutateAsync({
        leadId: v.contact!.id,
        type: v.type,
        title: v.title.trim(),
        dueAt: toIsoFromIst(v.dueDate, `${v.dueTime}:00`),
        ...(ownerId ? { ownerId } : {}),
      });
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
      return;
    }
    toast.success("Task created");
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>Due date and time are India time (IST).</DialogDescription>
        </DialogHeader>
        <form id="create-task" className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
          <div>
            <Label htmlFor="task-contact" className="mb-1.5 block text-xs">
              Contact
            </Label>
            {options.contact ? (
              <p id="task-contact" className="type-body font-medium">
                {options.contact.name}
              </p>
            ) : (
              <Controller
                control={form.control}
                name="contact"
                render={({ field }) => (
                  <ContactPicker
                    id="task-contact"
                    value={field.value}
                    onChange={field.onChange}
                    invalid={Boolean(errors.contact)}
                  />
                )}
              />
            )}
            {errors.contact && (
              <p className="mt-1 text-xs text-destructive">{errors.contact.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="task-title" className="mb-1.5 block text-xs">
              Title
            </Label>
            <Input
              id="task-title"
              placeholder="e.g. Send the case study"
              {...form.register("title")}
              aria-invalid={Boolean(errors.title)}
            />
            {errors.title && (
              <p className="mt-1 text-xs text-destructive">{errors.title.message}</p>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-type" className="mb-1.5 block text-xs">
                Type
              </Label>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="task-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TASK_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {label(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div>
              <Label htmlFor="task-owner" className="mb-1.5 block text-xs">
                Owner
              </Label>
              <Controller
                control={form.control}
                name="ownerId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="task-owner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CONTACT_OWNER}>Contact&rsquo;s owner</SelectItem>
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
            <div>
              <Label htmlFor="task-date" className="mb-1.5 block text-xs">
                Due date
              </Label>
              <Input
                id="task-date"
                type="date"
                {...form.register("dueDate")}
                aria-invalid={Boolean(errors.dueDate)}
              />
              {errors.dueDate && (
                <p className="mt-1 text-xs text-destructive">{errors.dueDate.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="task-time" className="mb-1.5 block text-xs">
                Time (IST)
              </Label>
              <Input
                id="task-time"
                type="time"
                {...form.register("dueTime")}
                aria-invalid={Boolean(errors.dueTime)}
              />
              {errors.dueTime && (
                <p className="mt-1 text-xs text-destructive">{errors.dueTime.message}</p>
              )}
            </div>
          </div>
          {errors.root && (
            <p role="alert" className="text-sm text-destructive">
              {errors.root.message}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-task" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

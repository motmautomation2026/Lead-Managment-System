import { createFileRoute } from "@tanstack/react-router";
import { CalendarSection } from "@/features/settings/calendar-section";
import { settingsHead, validateCalendarSearch } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/calendar")({
  head: settingsHead("Google Calendar"),
  validateSearch: validateCalendarSearch,
  component: CalendarSection,
});

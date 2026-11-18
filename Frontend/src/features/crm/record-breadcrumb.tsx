import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { lastListSearch } from "@/lib/use-list-url-state";

/** "Contacts › Neha Joshi": the list link keeps the filters the list last had in this tab. */
export function RecordBreadcrumb({
  list,
  label,
  name,
}: {
  list: "/contacts" | "/companies" | "/deals";
  label: string;
  name: string;
}) {
  return (
    <nav aria-label="Record breadcrumb" className="mb-1 type-small text-muted-foreground">
      <ol className="flex min-w-0 items-center gap-1">
        <li>
          <Link
            to={list}
            search={lastListSearch(list) as never}
            className="hover:text-foreground hover:underline"
          >
            {label}
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-3" />
        </li>
        <li className="min-w-0 truncate" aria-current="page">
          {name}
        </li>
      </ol>
    </nav>
  );
}

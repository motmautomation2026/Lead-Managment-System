import type { MouseEvent, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { RECORD_ROUTES, intentHandlers, usePrefetchRecord, type RecordType } from "./prefetch";

/** A link to a contact/company/deal record that prefetches it on intent. */
export function RecordLink({
  type,
  id,
  className,
  title,
  onClick,
  children,
}: {
  type: RecordType;
  id: string;
  className?: string;
  title?: string;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const prefetch = usePrefetchRecord();
  return (
    <Link
      {...RECORD_ROUTES[type](id)}
      className={className}
      title={title}
      onClick={onClick}
      {...intentHandlers(() => prefetch(type, id))}
    >
      {children}
    </Link>
  );
}

import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMediaQuery } from "@/lib/use-media-query";

export interface RecordTab {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Record page body. lg+: left properties panel · middle tabs · right associations.
 * Below lg: one column where "About" (left) and "Related" (right) become extra tabs,
 * so each panel renders once.
 */
export function RecordLayout({
  left,
  tabs,
  right,
  defaultTab,
}: {
  left: ReactNode;
  tabs: RecordTab[];
  right?: ReactNode;
  defaultTab?: string;
}) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const allTabs = wide
    ? tabs
    : [
        { id: "about", label: "About", content: left },
        ...tabs,
        ...(right ? [{ id: "related", label: "Related", content: right }] : []),
      ];
  const middle = (
    <Tabs defaultValue={defaultTab ?? allTabs[0]?.id ?? ""} className="min-w-0">
      <div className="overflow-x-auto">
        <TabsList>
          {allTabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {allTabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="mt-4">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );

  if (!wide) return <div className="p-4">{middle}</div>;
  return (
    <div className="grid grid-cols-[18rem_minmax(0,1fr)_20rem] gap-6 p-6">
      <aside className="min-w-0 space-y-4">{left}</aside>
      {middle}
      <aside className="min-w-0 space-y-4">{right}</aside>
    </div>
  );
}

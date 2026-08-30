import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";

export function SettingsRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-4 py-3 sm:grid-cols-1 sm:items-start">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description && (
            <p className="mt-0.5 max-w-md text-muted-foreground text-xs">{description}</p>
          )}
        </div>
        <div className="flex min-w-0 items-center justify-end sm:justify-start">
          {control}
        </div>
      </div>
      <Separator />
    </div>
  );
}
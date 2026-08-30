import type { ReactNode } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export function PageView({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">
        <div className="mb-5 flex items-center justify-between">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeft className="size-4" />
            Back to chat
          </Button>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

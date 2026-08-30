import type { ReactNode } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

/**
 * Shared content-area frame for every shell-backed view (Settings, MCP,
 * Skills, Plugins, Subagents, Statistics, Cron Jobs): fills the shell's
 * content region with one consistent scroll container, header row and
 * container token instead of per-page max-w/px wrappers.
 *
 * `actions` renders top-line controls beside the title for views that
 * need them (refresh buttons, etc.); omit it for plain pages.
 */
export function PageView({
  title,
  description,
  actions,
  onBack,
  children,
}: {
  title: string;
  /** Optional muted description under the title (subagents-style pages). */
  description?: string;
  /** Optional top-right action cluster. */
  actions?: ReactNode;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">
        <div className="mb-5 flex items-center justify-between gap-4">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeft className="size-4" />
            Back to chat
          </Button>
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0 text-right">
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {title}
              </h1>
              {description && (
                <p className="text-muted-foreground text-xs">{description}</p>
              )}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

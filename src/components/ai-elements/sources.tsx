"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Book, CaretDown } from "@phosphor-icons/react";
import type { ComponentProps } from "react";

export type SourcesProps = ComponentProps<typeof Collapsible>;

export const Sources = ({ className, ...props }: SourcesProps) => (
  <Collapsible
    className={cn("not-prose mb-4 text-primary text-xs", className)}
    {...props}
  />
);

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
};

export const SourcesTrigger = ({
  className,
  count,
  children,
  ...props
}: SourcesTriggerProps) => (
  <CollapsibleTrigger
    className={cn("flex items-center gap-2", className)}
    {...props}
  >
    {children ?? (
      <>
        <p className="font-medium">Used {count} sources</p>
        <CaretDown className="size-4 shrink-0" />
      </>
    )}
  </CollapsibleTrigger>
);

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export const SourcesContent = ({
  className,
  ...props
}: SourcesContentProps) => (
  <CollapsibleContent
    className={cn(
      "mt-3 flex w-fit flex-col gap-2",
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

/**
 * Defence-in-depth: only http(s) URLs become live anchors; unsafe protocols
 * (javascript:, data:) or missing URLs render as inert text to prevent script injection.
 */
function isSafeHttpUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type SourceProps = ComponentProps<"a">;

export const Source = ({
  href,
  title,
  children,
  className,
  ...props
}: SourceProps) => {
  const content = children ?? (
    <>
      <Book className="size-4 shrink-0" />
      <span className="block font-medium">{title}</span>
    </>
  );

  if (!isSafeHttpUrl(href)) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        {content}
      </div>
    );
  }

  return (
    <a
      className={cn("flex items-center gap-2", className)}
      href={href}
      rel="noreferrer"
      target="_blank"
      {...props}
    >
      {content}
    </a>
  );
};

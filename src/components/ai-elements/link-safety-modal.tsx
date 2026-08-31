"use client";

import {
  ArrowSquareOut,
  Copy,
  Check,
  X,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LinkSafetyModalProps } from "streamdown";

/**
 * Custom link-safety modal for Streamdown.
 *
 * The library's built-in modal renders its `fixed inset-0` overlay inline
 * inside the markdown paragraph chain — `<p> → <strong> → <a> → modal →
 * <div>` — which is invalid DOM nesting (div inside p). React flags it in
 * dev as a hydration/nesting error on every external-link click. Streamdown
 * exposes `linkSafety.renderModal` precisely so hosts can replace it: this
 * component renders the same dialog through a React portal to document.body,
 * where block-level elements are legal.
 *
 * Behavior mirrors the built-in: Escape/backdrop closes, copy button with a
 * Copied confirmation, and the URL shown in a scrollable monospace box.
 */
export function LinkSafetyModal({
  isOpen,
  onClose,
  onConfirm,
  url,
}: LinkSafetyModalProps) {
  const [copied, setCopied] = useState(false);

  // Reset the copy confirmation on reopen, during render (the React-endorsed
  // "adjust state when a prop changes" pattern) rather than in an effect.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) setCopied(false);
  }

  // Escape closes — the portal sits outside the markdown tree, so keyboard
  // handling must live here rather than on the inline trigger.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked (permissions / non-secure context): leave the
      // button in its default state rather than faking success.
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/50 p-4 backdrop-blur-sm"
      data-streamdown="link-safety-modal"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label="External link"
        aria-modal="true"
        className="relative flex w-full max-w-md flex-col gap-4 rounded-xl border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="dialog"
      >
        <button
          className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
          onClick={onClose}
          title="Close"
          type="button"
        >
          <X className="size-4" />
        </button>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 font-semibold text-lg">
            <ArrowSquareOut className="size-5" />
            <span>Open external link?</span>
          </div>
          <p className="text-muted-foreground text-sm">
            You&apos;re about to visit an external website.
          </p>
        </div>

        <div className="max-h-32 overflow-y-auto rounded-md bg-muted p-3 font-mono text-sm">
          <span className="break-all">{url}</span>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            className="flex flex-1 items-center justify-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition-all hover:bg-muted"
            onClick={() => void copy()}
            type="button"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy link"}
          </button>
          <button
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            type="button"
          >
            <WarningCircle className="size-3.5" />
            Open link
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

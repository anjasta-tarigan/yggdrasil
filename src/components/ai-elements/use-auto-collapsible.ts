"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { useCallback, useEffect, useRef } from "react";

/**
 * Grace delay before a collapsible trail folds itself once the process
 * it tracks completes — lets the final step land visually before the
 * collapse animation runs ("auto minimize when the process is complete").
 */
export const AUTO_CLOSE_DELAY = 1000;

interface UseAutoCollapsibleOptions {
  /** Controlled open state; when provided, auto behavior is bypassed. */
  open?: boolean;
  /** Initial open state for the uncontrolled path. */
  defaultOpen?: boolean;
  /** Notified on every open-state change, user-driven or auto. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Whether the process this trail tracks is still running. When it
   * flips to false the trail auto-collapses after the grace delay.
   * User toggles take precedence: a manually re-opened trail is never
   * yanked away again. Ignored when `open` is controlled.
   */
  isProcessing?: boolean;
}

/**
 * Shared open-state machine for the unified CoT trail family
 * (ChainOfThought, Task):
 *
 * - processing starts → open the trail so steps land visibly
 * - processing completes → collapse after {@link AUTO_CLOSE_DELAY}ms
 * - any manual toggle → auto behavior disarms permanently for this
 *   trail instance (and cancels any pending countdown)
 * - a later processing cycle re-arms auto behavior
 * - controlled `open` prop → auto behavior bypassed entirely
 */
export function useAutoCollapsible({
  open,
  defaultOpen = false,
  onOpenChange,
  isProcessing = false,
}: UseAutoCollapsibleOptions) {
  const [isOpen, setIsOpen] = useControllableState({
    defaultProp: defaultOpen,
    onChange: onOpenChange,
    prop: open,
  });

  // Whether auto open/close still owns the open state for this trail.
  const autoDriven = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoCloseTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleUserToggle = useCallback(
    (next: boolean) => {
      autoDriven.current = false;
      clearAutoCloseTimer();
      setIsOpen(next);
    },
    [clearAutoCloseTimer, setIsOpen]
  );

  useEffect(() => {
    // Controlled `open` prop: the parent fully owns the state.
    if (open !== undefined) return;

    if (isProcessing) {
      autoDriven.current = true;
      clearAutoCloseTimer();
      setIsOpen(true);
      return;
    }

    if (!autoDriven.current) return;

    clearAutoCloseTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setIsOpen(false);
    }, AUTO_CLOSE_DELAY);

    return clearAutoCloseTimer;
  }, [isProcessing, open, clearAutoCloseTimer, setIsOpen]);

  return { isOpen, handleUserToggle };
}

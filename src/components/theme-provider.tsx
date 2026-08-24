"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * App-wide theme provider (next-themes).
 *
 * - attribute="class": toggles `.dark` on <html>, matching the
 *   `@custom-variant dark` declaration in globals.css.
 * - defaultTheme="system": follows the device preference until the user
 *   explicitly picks light or dark.
 * - disableTransitionOnChange: avoids cross-fade flicker of colors when
 *   switching.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}

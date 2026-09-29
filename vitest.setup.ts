import "@testing-library/jest-dom/vitest";

// jsdom lacks blob URL APIs; download tests stub these.
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = () => "blob:mock-" + Math.random().toString(36).slice(2);
}
if (typeof URL.revokeObjectURL === "undefined") {
  URL.revokeObjectURL = () => {};
}

// jsdom lacks ResizeObserver
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom lacks scrollIntoView; Radix portals (Select, DropdownMenu,
// Combobox…) call it whenever their content opens.
// Guarded: node-environment test files (`@vitest-environment node`) have no
// DOM, and this setup file runs for them too.
if (
  typeof Element !== "undefined" &&
  typeof Element.prototype.scrollIntoView !== "function"
) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom lacks window.matchMedia; SettingsView uses it for responsive layout.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => {
    const getMatches = () => {
      // Parse max-width/min-width from the query string.
      const maxMatch = query.match(/max-width:\s*(\d+)px/);
      const minMatch = query.match(/min-width:\s*(\d+)px/);
      if (maxMatch) {
        return window.innerWidth <= parseInt(maxMatch[1], 10);
      }
      if (minMatch) {
        return window.innerWidth >= parseInt(minMatch[1], 10);
      }
      return false;
    };
    const listeners: Set<(e: MediaQueryListEvent) => void> = new Set();
    const mql: MediaQueryList = {
      matches: getMatches(),
      media: query,
      onchange: null,
      addListener: () => {}, // deprecated
      removeListener: () => {}, // deprecated
      addEventListener: (type: string, listener: EventListener) => {
        if (type === "change") {
          const fn = listener as unknown as (e: MediaQueryListEvent) => void;
          listeners.add(fn);
        }
      },
      removeEventListener: (type: string, listener: EventListener) => {
        if (type === "change") {
          const fn = listener as unknown as (e: MediaQueryListEvent) => void;
          listeners.delete(fn);
        }
      },
      dispatchEvent: () => true,
    };
    return mql;
  };
}


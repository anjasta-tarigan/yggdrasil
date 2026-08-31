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
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}


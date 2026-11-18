import "@testing-library/jest-dom/vitest";

// jsdom lacks these; cmdk and Radix popper call them.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= function () {};

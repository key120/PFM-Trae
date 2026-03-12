import '@testing-library/jest-dom/vitest';

const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('Could not parse CSS stylesheet')) return;
  originalConsoleError(...args);
};

const originalGetComputedStyle = window.getComputedStyle;
window.getComputedStyle = ((elt: Element, pseudoElt?: string | null) => {
  return originalGetComputedStyle(elt);
}) as typeof window.getComputedStyle;

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!window.ResizeObserver) {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverMock,
  });
}

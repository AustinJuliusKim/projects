// jsdom lacks the APIs Mantine touches on mount. Guarded because the local
// backend's schema tests run under `@vitest-environment node`, where there is
// no window at all — and they never mount components.
if (typeof window !== 'undefined') {
  polyfill()
}

function polyfill() {
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
})

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}

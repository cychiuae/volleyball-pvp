// Tiny synchronous event bus shared by game logic, rendering effects, UI and audio.
// Event names and payloads are documented in docs/ARCHITECTURE.md ("Events").

export function createEventBus() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name, payload) {
      const set = handlers.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (err) { console.error(`[events] handler for "${name}" threw`, err); }
      }
    },
    clear() { handlers.clear(); },
  };
}

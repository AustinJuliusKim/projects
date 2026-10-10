import { createContext, useContext } from "react";

// {slug, base, store, cart, dispatch} for pages under /s/:slug.
export const StoreContext = createContext(null);

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside a StoreLayout");
  return ctx;
}

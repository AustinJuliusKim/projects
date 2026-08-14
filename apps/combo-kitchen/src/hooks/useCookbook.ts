import { useCallback, useState } from "react";
import type { Dish } from "../game/types.ts";
import {
  COOKBOOK_STORAGE_KEY,
  parseCookbook,
  serializeCookbook,
  recordDiscovery,
  discoveredDishes,
  type CookbookState,
} from "../game/cookbook.ts";

function readStorage(): CookbookState {
  // localStorage can throw (Safari private mode, disabled storage)
  try {
    return parseCookbook(window.localStorage.getItem(COOKBOOK_STORAGE_KEY));
  } catch {
    return parseCookbook(null);
  }
}

function writeStorage(state: CookbookState): void {
  try {
    window.localStorage.setItem(COOKBOOK_STORAGE_KEY, serializeCookbook(state));
  } catch {
    // best-effort persistence; the in-memory state still works this session
  }
}

export function useCookbook() {
  const [state, setState] = useState<CookbookState>(readStorage);

  const record = useCallback((dish: Dish): boolean => {
    const result = recordDiscovery(readStorage(), dish);
    if (result.isNew) {
      writeStorage(result.state);
      setState(result.state);
    }
    return result.isNew;
  }, []);

  return { discovered: discoveredDishes(state), record };
}

// Shared getMe cache: one fetch per TTL window no matter how many views
// (History/Premium/Settings/PlayView/CancelView/WinnerAccountLine) mount at
// once. Plain module state + a hook, matching the rest of the codebase (no
// context provider).
import { useEffect, useState } from "react";
import { getMe } from "./api.js";
import { authEnabled, hasSession } from "./auth.js";

const TTL = 30_000;

let cache = null; // { data, at }
let inflight = null;
const subscribers = new Set();

function notify() {
  for (const fn of subscribers) fn();
}

// Serves the cache when fresh unless forced; concurrent callers share one
// in-flight request.
export function fetchMe({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL) {
    return Promise.resolve(cache.data);
  }
  if (!inflight) {
    inflight = getMe()
      .then((data) => {
        cache = { data, at: Date.now() };
        inflight = null;
        notify();
        return data;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

// Call before signOut() and after a successful cancelSubscription() so the
// next fetch is guaranteed fresh.
export function invalidateMe() {
  cache = null;
}

// Guest discipline: hard-returns without ever calling the API when there's
// no session — no 401s from views that render for guests too.
export function useMe({ auto = true } = {}) {
  const signedIn = authEnabled && hasSession();
  const [me, setMe] = useState(signedIn ? cache?.data ?? null : null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(signedIn && !cache);

  function refresh(opts) {
    if (!signedIn) return Promise.resolve(null);
    setLoading(true);
    return fetchMe(opts)
      .then((data) => {
        setMe(data);
        setError(null);
        return data;
      })
      .catch((err) => {
        setError(err.message);
        throw err;
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!signedIn) return;
    const onUpdate = () => setMe(cache?.data ?? null);
    subscribers.add(onUpdate);
    if (auto) refresh().catch(() => {});
    return () => subscribers.delete(onUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, auto]);

  if (!signedIn) {
    return { me: null, error: null, loading: false, refresh: () => Promise.resolve(null) };
  }
  return { me, error, loading, refresh };
}

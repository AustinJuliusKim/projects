import { useEffect, useState } from "react";

import { secondsLeft } from "./register.js";

// Seconds until `until` (ms), ticking once a second; 0 when past or unset.
export default function useCountdown(until) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return secondsLeft(until, now);
}

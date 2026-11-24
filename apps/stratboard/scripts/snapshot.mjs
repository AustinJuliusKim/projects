// Refreshes the bundled fallback data from valorant-api.com. The app still
// fetches live data on load; this snapshot covers offline use and API outages.
import { writeFile } from "node:fs/promises";
import { fetchGameData } from "../src/lib/data.js";

const data = await fetchGameData();
data.fetchedAt = new Date().toISOString().slice(0, 10);
const out = new URL("../src/data/snapshot.json", import.meta.url);
await writeFile(out, JSON.stringify(data) + "\n");
console.log(`snapshot: ${data.maps.length} maps, ${data.agents.length} agents`);

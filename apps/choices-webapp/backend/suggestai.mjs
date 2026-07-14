// "Fill my 4" (suggestion engine Phase 3): one Bedrock Converse call turns
// the pair's own history + an occasion hint into 4 ready-to-play choices.
// Prompt/parse are pure and exported for tests; the Bedrock client is
// injectable (same seam pattern as auth.mjs/billing.mjs).
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

let bedrock = null;

function getBedrock() {
  if (!bedrock) bedrock = new BedrockRuntimeClient({});
  return bedrock;
}

export function aiEnabled() {
  return Boolean(process.env.BEDROCK_MODEL_ID);
}

const SYSTEM =
  "You fill in food options for Choices, a playful two-player elimination " +
  "game where couples decide what to eat by cutting choices until one " +
  "survives. Reply with ONLY a JSON array of exactly 4 short food choices " +
  "(2-4 words each, no emoji, no numbering). Make them distinct and " +
  "cuttable — 4 solid options, not 1 obvious winner and 3 fillers.";

// history entries: HIST# values [{ label, entryCount, winCount, lastAt }].
export function buildPrompt({ historyEntries = [], occasion = "" } = {}) {
  const lines = ["Suggest 4 food choices for the next game."];
  if (occasion) lines.push(`Occasion: ${occasion}`);
  const top = [...historyEntries]
    .sort((a, b) => b.winCount - a.winCount || b.lastAt - a.lastAt)
    .slice(0, 12);
  if (top.length) {
    lines.push(
      "They've played before. Their past entries (wins marked):",
      ...top.map(
        (e) => `- ${e.label}${e.winCount ? ` (won ${e.winCount}x)` : ""}`
      ),
      "Lean into their taste but mix in something new — don't just repeat the list."
    );
  }
  return lines.join("\n");
}

// Extract the first JSON array of exactly 4 non-empty strings, tolerant of
// code fences and surrounding prose. Returns null when the reply is unusable.
export function parseFour(text) {
  const match = String(text ?? "").match(/\[[\s\S]*?\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]);
    if (
      Array.isArray(arr) &&
      arr.length === 4 &&
      arr.every((s) => typeof s === "string" && s.trim())
    ) {
      return arr.map((s) => s.trim().slice(0, 60));
    }
  } catch {
    /* fall through */
  }
  return null;
}

// -> [4 strings] or null on an unparseable reply.
export async function fillFour({ historyEntries, occasion } = {}) {
  const res = await getBedrock().send(
    new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM }],
      messages: [
        {
          role: "user",
          content: [{ text: buildPrompt({ historyEntries, occasion }) }],
        },
      ],
      inferenceConfig: { maxTokens: 300, temperature: 0.9 },
    })
  );
  const text = (res.output?.message?.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
  return parseFour(text);
}

// Test hook (same rationale as auth.mjs's _setVerifierForTests).
export function _setBedrockForTests(fake) {
  bedrock = fake;
}

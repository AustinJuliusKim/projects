// Render-time profanity check for the one public surface we render: the
// /j/{code} OG preview. Entry submission is NEVER blocked for profanity —
// the two players' private text is theirs (design constitution: never add
// friction to play). A match simply swaps the preview description for a
// generic line; the join link works regardless.
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export function isClean(text) {
  return !matcher.hasMatch(String(text ?? ""));
}

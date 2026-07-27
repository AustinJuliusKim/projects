// Typed view over the build output of scripts/build-posts.mjs.
// Source of truth for post content is content/posts/*.md — edit those, not this.
import generated from "./generated/posts.json";

export type Post = {
  slug: string;
  title: string;
  /** ISO YYYY-MM-DD, used for sorting and RSS. */
  date: string;
  /** Pre-formatted for display, e.g. "July 26, 2026". */
  dateDisplay: string;
  description: string;
  tags: string[];
  /** Rendered HTML. Generated at build time from markdown we author. */
  html: string;
};

/** Newest first. Drafts are dropped at build time. */
export const posts: Post[] = generated;

export function findPost(slug: string | undefined): Post | undefined {
  return posts.find((p) => p.slug === slug);
}

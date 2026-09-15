/**
 * The fold food search uses on both sides of a comparison (D165).
 *
 * Here rather than in `food.repo.ts`, because it is text handling and not a
 * query: nothing about it belongs to a user, and a repository function is
 * required to take one (CLAUDE.md §3).
 */

/**
 * Accented letters folded to their base letter for search, lower case first
 * (D165). These must equal the `translate` in migration 0030, which generates
 * `search_name` with them; `food-search.test.ts` reads that file to hold the two
 * together.
 */
export const FOLD_FROM = "åäöéèêëüáàâïîôç";
export const FOLD_TO = "aaoeeeeuaaaiioc";

/** A query folded the way `search_name` is. */
export function foldForSearch(text: string): string {
  let folded = "";
  for (const char of text.toLowerCase()) {
    const at = FOLD_FROM.indexOf(char);
    folded += at === -1 ? char : FOLD_TO[at];
  }
  return folded;
}

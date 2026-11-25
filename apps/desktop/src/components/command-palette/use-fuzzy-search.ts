import { useEffect, useState } from "react";
import * as tauri from "@/lib/tauri";
import type { SearchResult } from "@/types/fs";

const SEARCH_DEBOUNCE_MS = 50;

export function useFuzzySearch(query: string, limit = 20) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const hasQuery = query.trim() !== "";

  useEffect(() => {
    if (!hasQuery) {
      return;
    }

    // Only the latest query may set results. A slower response for an older
    // query ("ab" after "abc") would otherwise replace the newer list, and
    // the palette's first-row selection would then open a stale match.
    let latest = true;
    const timer = setTimeout(() => {
      tauri
        .fuzzySearch(query, limit)
        .then((next) => {
          if (latest) setResults(next);
        })
        .catch((error: unknown) => {
          if (latest) console.error("[palette] File search failed:", error);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      latest = false;
      clearTimeout(timer);
    };
  }, [query, limit, hasQuery]);

  // Empty queries have no results — derive this during render instead of
  // clearing state in the effect, so callers never see a stale frame.
  return hasQuery ? results : [];
}

import { useSyncExternalStore } from "react";
import { subscribeRepos, repoStoreVersion } from "@/repositories/base";

/**
 * Re-render the calling component whenever ANY repository's data changes —
 * first load, live cloud sync, or a local write. Read whatever repos you need
 * directly in render (e.g. `ItemRepo.all()`, ledger helpers) — this hook only
 * drives the re-render; it returns a version number you can otherwise ignore.
 *
 * This is what makes the app safe to open before all data has loaded: a screen
 * that mounts with empty repos will re-render and fill in the moment its
 * collection's snapshot arrives, instead of showing stale/empty data forever.
 */
export function useRepoData(): number {
  return useSyncExternalStore(subscribeRepos, repoStoreVersion, () => 0);
}

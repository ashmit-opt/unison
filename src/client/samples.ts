// Sample tracks (intent revision 2026-10-11 b): original uploads streamed from Audius with artist credit.
// Beatsync's bundled tracks are commercial recordings, so they are deliberately not used.
import type { Track } from "./audius.ts";

export const SAMPLE_IDS = ["JbKjZ", "WEzwk", "pk5WY", "93v00", "ng9rl", "pz9ym", "AxVBZ5R", "2RlV2"];

type ApiTrack = {
  id: string; title: string; duration: number; is_streamable?: boolean; permalink?: string; genre?: string;
  user?: { name?: string }; artwork?: Record<string, string>;
};

let cache: Promise<Track[]> | null = null;

/** Metadata + artwork for the samples, in curated order; unavailable tracks are skipped. */
export function loadSamples(): Promise<Track[]> {
  cache ??= fetch(`https://api.audius.co/v1/tracks?${SAMPLE_IDS.map((id) => `id=${id}`).join("&")}&app_name=unison-sync`)
    .then((r) => (r.ok ? r.json() : { data: [] }))
    .then(({ data }: { data: ApiTrack[] }) => {
      const byId = new Map(data.filter((t) => t.is_streamable !== false).map((t) => [t.id, t]));
      return SAMPLE_IDS.flatMap((id) => {
        const t = byId.get(id);
        return t ? [{
          id: t.id, title: t.title, artist: t.user?.name?.trim() ?? "Unknown artist", durationS: t.duration,
          url: `https://audius.co${t.permalink ?? ""}`, art: t.artwork?.["480x480"] ?? t.artwork?.["150x150"], genre: t.genre,
        }] : [];
      });
    })
    .catch(() => { cache = null; return []; });
  return cache;
}

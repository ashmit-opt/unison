// Audius (spec §5.3): public REST API, no key, CORS-enabled through the whole stream redirect chain.
const API = "https://api.audius.co/v1";
const APP = "unison-sync";

export type Track = { id: string; title: string; artist: string; durationS: number; url: string; art?: string; genre?: string };

type ApiTrack = {
  id: string; title: string; duration: number; is_streamable?: boolean; permalink?: string; genre?: string;
  user?: { name?: string }; artwork?: Record<string, string>;
};

export async function searchTracks(query: string): Promise<Track[]> {
  const res = await fetch(`${API}/tracks/search?query=${encodeURIComponent(query)}&limit=15&app_name=${APP}`);
  if (!res.ok) throw new Error(`Audius search failed (${res.status})`);
  const { data } = (await res.json()) as { data: ApiTrack[] };
  return data
    .filter((t) => t.is_streamable !== false)
    .map((t) => ({
      id: t.id, title: t.title, artist: t.user?.name?.trim() ?? "Unknown artist", durationS: t.duration,
      url: `https://audius.co${t.permalink ?? ""}`, art: t.artwork?.["150x150"] ?? t.artwork?.["480x480"], genre: t.genre,
    }));
}

/** Authoritative metadata for one track (used to vet guest requests). Null if missing or not streamable. */
export async function getTrack(id: string): Promise<Track | null> {
  const res = await fetch(`${API}/tracks?id=${encodeURIComponent(id)}&app_name=${APP}`);
  if (!res.ok) return null;
  const t = ((await res.json()) as { data: ApiTrack[] }).data?.[0];
  if (!t || t.is_streamable === false) return null;
  return { id: t.id, title: t.title, artist: t.user?.name?.trim() ?? "Unknown artist", durationS: t.duration, url: `https://audius.co${t.permalink ?? ""}`, art: t.artwork?.["480x480"] ?? t.artwork?.["150x150"], genre: t.genre };
}

export const streamUrl = (id: string) => `${API}/tracks/${encodeURIComponent(id)}/stream?app_name=${APP}`;

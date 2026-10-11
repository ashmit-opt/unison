// Offset solver for continuous calibration with one or more microphones (spec §8.4, ADR-0007).
// Model: lag[m][i] = e[i] + b[m] + d[m][i]
//   e[i]  device i's emission error (what we correct; gauge: mean 0)
//   b[m]  microphone m's unknown input latency
//   d     acoustic travel time: 0 for a device hearing itself; unknown but symmetric when two
//         mic-enabled devices hear each other (so it cancels: two-way ranging); otherwise folded into e
//         (= align at that microphone's position).

export type Heard = Map<string, Map<string, number>>; // mic id → device id → lag ms (mic id = its device id)

export function solveOffsets(heard: Heard): { e: Map<string, number>; groups: string[][] } {
  const devs = new Set<string>(), mics = [...heard.keys()];
  for (const m of heard.values()) for (const d of m.keys()) devs.add(d);
  const dev = [...devs];
  // Connected components: devices linked through a shared microphone.
  const parent = new Map(dev.map((d) => [d, d]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const m of heard.values()) { const ids = [...m.keys()]; for (const id of ids.slice(1)) parent.set(find(id), find(ids[0])); }
  const groupsMap = new Map<string, string[]>();
  for (const d of dev) groupsMap.set(find(d), [...(groupsMap.get(find(d)) ?? []), d]);
  const groups = [...groupsMap.values()];

  // Unknown indices: e per device, b per mic, d per two-way pair.
  const idx = new Map<string, number>();
  dev.forEach((d) => idx.set(`e:${d}`, idx.size));
  mics.forEach((m) => idx.set(`b:${m}`, idx.size));
  const pairKey = (a: string, b: string) => (a < b ? `d:${a}|${b}` : `d:${b}|${a}`);
  for (const m of mics) for (const d of heard.get(m)!.keys()) {
    if (d !== m && heard.get(d)?.has(m) && !idx.has(pairKey(m, d))) idx.set(pairKey(m, d), idx.size);
  }
  const n = idx.size, A: number[][] = [], y: number[] = [];
  const row = (terms: [string, number][], v: number, w = 1) => {
    const r = new Array(n).fill(0);
    for (const [k, c] of terms) r[idx.get(k)!] += c * w;
    A.push(r);
    y.push(v * w);
  };
  for (const m of mics) for (const [d, lag] of heard.get(m)!) {
    const terms: [string, number][] = [[`e:${d}`, 1], [`b:${m}`, 1]];
    if (idx.has(pairKey(m, d)) && d !== m) terms.push([pairKey(m, d), 1]);
    row(terms, lag);
  }
  for (const g of groups) row(g.map((d) => [`e:${d}`, 1] as [string, number]), 0, 10); // gauge: mean 0 per group

  // Normal equations with a tiny ridge (keeps under-determined parts well-posed), Gaussian elimination.
  const M = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (j === n ? 0 : i === j ? 1e-6 : 0)));
  for (let r = 0; r < A.length; r++) for (let i = 0; i < n; i++) {
    if (!A[r][i]) continue;
    for (let j = 0; j < n; j++) M[i][j] += A[r][i] * A[r][j];
    M[i][n] += A[r][i] * y[r];
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[r][c]) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  const e = new Map(dev.map((d) => [d, M[idx.get(`e:${d}`)!][n] / M[idx.get(`e:${d}`)!][idx.get(`e:${d}`)!]]));
  return { e, groups };
}

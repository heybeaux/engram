import fs from 'node:fs';
export const DATA = new URL('./data/pairs.json', import.meta.url).pathname;
export const load = () => JSON.parse(fs.readFileSync(DATA, 'utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function appendJsonl(path, obj) {
  fs.appendFileSync(path, JSON.stringify(obj) + '\n');
}
export function readJsonl(path) {
  return fs.existsSync(path)
    ? fs
        .readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}
export const readSecret = (p) =>
  fs.readFileSync(p.replace('~', process.env.HOME), 'utf8').trim();

// concurrency-limited map; keeps order
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

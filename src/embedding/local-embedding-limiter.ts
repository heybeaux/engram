import { TransientEmbeddingError } from './embedding-validation.util';

// Shared across legacy, facade and ensemble entry points in this process.
// Server-side admission control is still required across multiple processes.
let active = 0;
const waiting: Array<() => void> = [];
const concurrency = Math.max(
  1,
  Number(process.env.LOCAL_EMBED_CONCURRENCY) || 1,
);
const maxPending = 64;

export async function withLocalEmbeddingSlot<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (active >= concurrency) {
    if (waiting.length >= maxPending) {
      throw new TransientEmbeddingError('Local embedding admission queue full');
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

import { TransientEmbeddingError } from './embedding-validation.util';

// Shared across legacy, facade and ensemble entry points in this process.
// Server-side admission control is still required across multiple processes.
let active = 0;
const waiting: Array<() => void> = [];
const configuredConcurrency = Number(process.env.LOCAL_EMBED_CONCURRENCY ?? 1);
const concurrency =
  Number.isInteger(configuredConcurrency) &&
  configuredConcurrency >= 1 &&
  configuredConcurrency <= 16
    ? configuredConcurrency
    : 1;
const maxPending = 64;

export async function withLocalEmbeddingSlot<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (active >= concurrency) {
    if (waiting.length >= maxPending) {
      throw new TransientEmbeddingError('Local embedding admission queue full');
    }
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(admit);
        if (index >= 0) waiting.splice(index, 1);
        reject(
          new TransientEmbeddingError('Local embedding admission timed out'),
        );
      }, 5_000);
      waiting.push(admit);
    });
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

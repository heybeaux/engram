/** Bound best-effort persistence so an unresponsive Redis cannot block app.close(). */
export async function flushAndDisconnectRedis(
  redis: { disconnect(): void } | null,
  pending: Promise<unknown>[],
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    redis?.disconnect();
  }
}

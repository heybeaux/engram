export function toValidatedVectorLiteral(
  embedding: number[],
  context: string,
): string {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(
      `Invalid embedding for ${context}: expected non-empty array`,
    );
  }

  const invalidIndex = embedding.findIndex(
    (value) => typeof value !== 'number' || !Number.isFinite(value),
  );
  if (invalidIndex !== -1) {
    throw new Error(
      `Invalid embedding for ${context}: non-finite value at index ${invalidIndex}`,
    );
  }

  return `[${embedding.join(',')}]`;
}

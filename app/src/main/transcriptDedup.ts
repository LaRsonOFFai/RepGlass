export function isLikelyTranscriptDuplicate(first: string, second: string): boolean {
  const a = normalizedWords(first);
  const b = normalizedWords(second);
  if (!a.length || !b.length) return false;
  const compactA = a.join(' ');
  const compactB = b.join(' ');
  if (Math.min(compactA.length, compactB.length) >= 10 && (compactA.includes(compactB) || compactB.includes(compactA))) {
    return true;
  }

  const left = new Set(a);
  const right = new Set(b);
  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap += 1;
  const dice = (2 * overlap) / (left.size + right.size);
  return dice >= 0.74 && overlap >= 2;
}

function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 1);
}

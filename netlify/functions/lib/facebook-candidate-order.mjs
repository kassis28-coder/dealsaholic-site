/**
 * Return Blob index positions in the order Facebook publishers should scan.
 * Site submissions are newest-first, so each run prioritizes a bounded window
 * at the front before continuing the saved rotation through older inventory.
 */
export function facebookCandidatePositions(total, cursor = 0, limit = 400, newestFirst = 200) {
  if (!Number.isInteger(total) || total <= 0 || limit <= 0) return [];

  const maximum = Math.min(limit, total);
  const priorityCount = Math.min(newestFirst, maximum, total);
  const normalizedCursor = Number.isInteger(cursor)
    ? ((cursor % total) + total) % total
    : 0;
  const positions = [];
  const seen = new Set();

  const add = (position) => {
    const normalized = ((position % total) + total) % total;
    if (!seen.has(normalized) && positions.length < maximum) {
      seen.add(normalized);
      positions.push(normalized);
    }
  };

  for (let position = 0; position < priorityCount; position += 1) add(position);
  for (let offset = 0; positions.length < maximum && offset < total; offset += 1) {
    add(normalizedCursor + offset);
  }

  return positions;
}

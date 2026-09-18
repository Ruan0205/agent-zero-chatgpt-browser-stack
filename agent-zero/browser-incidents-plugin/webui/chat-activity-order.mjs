export function pruneActivity(activity, contexts, keepId = "") {
  const valid = new Set((contexts || []).map((context) => context?.id).filter(Boolean));
  return Object.fromEntries(
    Object.entries(activity || {}).filter(([id]) => id === keepId || valid.has(id)),
  );
}

function activityScore(row, contexts, activity) {
  let score = Number(activity?.[row?.id] || 0);
  for (const context of contexts || []) {
    if (context?.parent_context_id === row?.id) {
      score = Math.max(score, Number(activity?.[context.id] || 0));
    }
  }
  return score;
}

export function sortRowsByActivity(rows, contexts, activity) {
  return [...(rows || [])].sort((left, right) =>
    activityScore(right, contexts, activity) - activityScore(left, contexts, activity)
    || String(right?.created_at || "").localeCompare(String(left?.created_at || "")),
  );
}

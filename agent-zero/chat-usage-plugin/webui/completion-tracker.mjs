export class CompletionTracker {
  constructor() {
    this.seen = new Map();
  }

  accept(snapshot) {
    const context = snapshot?.context;
    const guid = snapshot?.log_guid;
    if (!context || !guid) return false;
    const key = `${context}:${guid}`;
    const completed = (snapshot.logs || [])
      .filter((log) => log?.type === "response" && log?.kvps?.finished === true && String(log?.content || "").trim())
      .map((log) => `${log.no ?? log.id}`);
    const previous = this.seen.get(key);
    if (!previous) {
      this.seen.set(key, new Set(completed));
      return false; // History loaded on opening a chat is not a new reply.
    }
    let isNew = false;
    for (const id of completed) {
      if (!previous.has(id)) isNew = true;
      previous.add(id);
    }
    return isNew;
  }
}

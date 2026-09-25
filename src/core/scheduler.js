export class DeterministicScheduler {
  constructor(time = 0) {
    if (!Number.isSafeInteger(time) || time < 0) throw new RangeError("Scheduler time must be a non-negative safe integer");
    this.time = time;
    this.sequence = 0;
    this.queue = [];
  }

  schedule({ at, kind, actorId, payload = {}, priority = 0, tieKey = "" }) {
    if (!Number.isSafeInteger(at) || at < this.time) throw new RangeError("Event time must be a safe integer and cannot be in the past");
    if (typeof kind !== "string" || !kind) throw new TypeError("Scheduler event kind is required");
    if (typeof actorId !== "string" || !actorId) throw new TypeError("Scheduler event actorId is required");
    if (!Number.isSafeInteger(priority)) throw new TypeError("Scheduler priority must be a safe integer");
    if (typeof tieKey !== "string") throw new TypeError("Scheduler tieKey must be a string");
    if (!Number.isSafeInteger(this.sequence) || this.sequence < 0 || this.sequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Scheduler event sequence is exhausted or invalid");
    }
    const event = {
      id: `event-${this.sequence}`,
      sequence: this.sequence++,
      at,
      priority,
      tieKey,
      kind,
      actorId,
      payload: structuredClone(payload),
    };
    this.queue.push(event);
    this.#sortQueue();
    return structuredClone(event);
  }

  peek() {
    return this.queue[0] ?? null;
  }

  pop() {
    const event = this.queue.shift() ?? null;
    if (event) this.time = event.at;
    return event;
  }

  advanceTo(time) {
    if (!Number.isSafeInteger(time) || time < this.time) {
      throw new RangeError("Scheduler time must advance monotonically using safe integers");
    }
    this.time = time;
    return this.time;
  }

  cancelWhere(predicate) {
    if (typeof predicate !== "function") throw new TypeError("Cancellation predicate must be a function");
    const cancelled = [];
    const retained = [];
    for (const event of this.queue) {
      if (predicate(structuredClone(event))) cancelled.push(event);
      else retained.push(event);
    }
    this.queue = retained;
    return structuredClone(cancelled);
  }

  snapshot() {
    return structuredClone({ time: this.time, sequence: this.sequence, queue: this.queue });
  }

  static restore(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new TypeError("Scheduler snapshot is required");
    if (!Number.isSafeInteger(snapshot.time) || snapshot.time < 0) throw new RangeError("Invalid scheduler time");
    if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new RangeError("Invalid scheduler sequence");
    if (!Array.isArray(snapshot.queue)) throw new TypeError("Invalid scheduler queue");

    const queue = structuredClone(snapshot.queue);
    const eventSequences = new Set();
    for (const event of queue) {
      if (!event || typeof event !== "object") throw new TypeError("Invalid scheduler event");
      if (!Number.isSafeInteger(event.at) || event.at < snapshot.time) throw new RangeError("Scheduler event is in the past or is not a safe integer");
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Invalid scheduler event sequence");
      }
      if (event.id !== `event-${event.sequence}`) throw new Error("Scheduler event id disagrees with its sequence");
      if (event.priority === undefined) event.priority = 0;
      if (!Number.isSafeInteger(event.priority)) throw new TypeError("Invalid scheduler event priority");
      if (event.tieKey === undefined) event.tieKey = "";
      if (typeof event.tieKey !== "string") throw new TypeError("Invalid scheduler event tieKey");
      if (eventSequences.has(event.sequence)) throw new Error("Duplicate scheduler event sequence");
      if (typeof event.kind !== "string" || !event.kind) throw new TypeError("Scheduler event kind is required");
      if (typeof event.actorId !== "string" || !event.actorId) throw new TypeError("Scheduler event actorId is required");
      eventSequences.add(event.sequence);
    }
    queue.sort((a, b) => a.at - b.at || a.priority - b.priority || a.tieKey.localeCompare(b.tieKey) || a.sequence - b.sequence);
    const nextSequence = queue.reduce((maximum, event) => Math.max(maximum, event.sequence + 1), 0);
    if (snapshot.sequence < nextSequence) throw new RangeError("Scheduler sequence would reuse an existing event id");

    const scheduler = new DeterministicScheduler(snapshot.time);
    scheduler.sequence = snapshot.sequence;
    scheduler.queue = queue;
    return scheduler;
  }

  #sortQueue() {
    this.queue.sort((a, b) => a.at - b.at || a.priority - b.priority || a.tieKey.localeCompare(b.tieKey) || a.sequence - b.sequence);
  }
}

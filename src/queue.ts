// One job at a time: a local llama.cpp server usually has a single slot, and compaction must not
// run in the middle of a conversation turn.
let tail: Promise<void> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

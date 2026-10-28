/** A syntax provider module that EXITS the worker at load time (#764).
 *
 * The worker dies before it can answer a request. The parent must treat
 * that as a FAILURE — a recorded error naming the exit — and not as a call
 * that never comes back: every later call must fail instantly instead of
 * waiting for an answer that will never arrive. */

process.exit(0);

export {};

/** A syntax provider module whose LOAD never returns (#764).
 *
 * The module body blocks forever, so the worker never finishes loading the
 * provider and never answers a request. The build must still settle: the
 * host's real timer bounds the call and TERMINATES the worker, so a
 * provider that hangs while it is being loaded cannot hold the review
 * past the bound either. */

export {};

// Block the thread without spinning the CPU.
for (;;) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

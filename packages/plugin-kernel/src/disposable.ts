import type { AsyncDisposable, Disposer } from "@tabverse/tab-contracts";
import { PluginKernelError, asError } from "./errors";

function toDisposer(value: Disposer | AsyncDisposable): Disposer {
  return typeof value === "function" ? value : () => value.dispose();
}

/** Idempotent, awaitable, reverse-order resource owner. */
export class AsyncDisposerStack implements AsyncDisposable {
  readonly #disposers: Disposer[] = [];
  #disposePromise: Promise<void> | undefined;

  get disposed(): boolean {
    return this.#disposePromise !== undefined;
  }

  defer(value: Disposer | AsyncDisposable): void {
    if (this.disposed) throw new PluginKernelError("DISPOSAL_FAILED", "scope is already disposing");
    this.#disposers.push(toDisposer(value));
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeOnce();
    return this.#disposePromise;
  }

  async #disposeOnce(): Promise<void> {
    const errors: Error[] = [];
    for (const disposer of this.#disposers.reverse()) {
      try {
        await disposer();
      } catch (error) {
        errors.push(asError(error));
      }
    }
    this.#disposers.length = 0;
    if (errors.length > 0) {
      throw new PluginKernelError(
        "DISPOSAL_FAILED",
        `${errors.length} resource disposer(s) failed`,
        { errors: errors.map((error) => error.message) },
        { cause: new AggregateError(errors) },
      );
    }
  }
}

import { DestroyRef, Injectable, inject } from '@angular/core';

type RefreshHandler = () => void | Promise<unknown>;

/**
 * Call from a page component's constructor: pull-to-refresh runs `fn` while the
 * page is shown, and the handler is removed automatically when it's destroyed.
 */
export function onPullRefresh(fn: RefreshHandler): void {
  const unregister = inject(PullRefreshService).register(fn);
  inject(DestroyRef).onDestroy(unregister);
}

/**
 * Lets the current page decide what "pull to refresh" does.
 *
 * Pages register a handler that reloads their data in place (so an in-progress
 * cart survives). With no handler registered, the app does a full reload.
 */
@Injectable({ providedIn: 'root' })
export class PullRefreshService {
  private handler: RefreshHandler | null = null;

  /** Register a handler; returns a function that unregisters it (call from ngOnDestroy). */
  register(fn: RefreshHandler): () => void {
    this.handler = fn;
    return () => { if (this.handler === fn) this.handler = null; };
  }

  async run(): Promise<void> {
    if (this.handler) {
      await this.handler();
    } else {
      window.location.reload();
    }
  }
}

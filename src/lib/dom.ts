/**
 * Did this event originate inside `element`?
 *
 * `element.contains(event.target)` is the obvious check and it is wrong for
 * dismissible UI. React flushes discrete events like `pointerdown`
 * synchronously, so a handler that closes a menu has already unmounted the
 * clicked node by the time a document-level listener runs. `contains()` then
 * answers about a detached node and reports "outside" — which is how picking an
 * option inside a popup made the whole popup close.
 *
 * `composedPath()` is fixed when the event is dispatched, so it still describes
 * where the click actually happened. It also sees through shadow roots.
 */
export function eventHitsElement(event: Event, element: Element | null): boolean {
  if (!element) return false;

  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.length > 0) return path.includes(element);

  const target = event.target as Node | null;
  return Boolean(target && element.contains(target));
}

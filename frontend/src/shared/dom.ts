// Typed element lookups. index.html is the one page and holds every element
// the modules look up by id, so `byId` returns the element type the caller
// names instead of `HTMLElement | null`; use `maybeById` for an element that
// can be missing (one a module renders itself, or one only some pages have).
// Neither checks the type at runtime: the lookups behave exactly like
// document.getElementById.

export function byId<T extends Element = HTMLElement>(id: string): T {
  return document.getElementById(id) as Element as T;
}

export function maybeById<T extends Element = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as Element | null as T | null;
}

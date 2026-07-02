import { useEffect, useMemo, useRef } from "react";

export type DebouncedCallback<T extends (...args: never[]) => void> = T & {
  /** Run a pending invocation immediately (no-op when nothing is pending). */
  flush: () => void;
  /** Drop a pending invocation without running it. */
  cancel: () => void;
  isPending: () => boolean;
};

export function useDebouncedCallback<T extends (...args: never[]) => void>(
  callback: T,
  delay: number,
): DebouncedCallback<T> {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  const lastArgsRef = useRef<Parameters<T> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const debounced = useMemo(() => {
    const invoke = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      const args = lastArgsRef.current;
      lastArgsRef.current = null;
      if (args) callbackRef.current(...args);
    };

    const fn = ((...args: Parameters<T>) => {
      lastArgsRef.current = args;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(invoke, delay);
    }) as DebouncedCallback<T>;

    fn.flush = () => {
      if (timeoutRef.current) invoke();
    };

    fn.cancel = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      lastArgsRef.current = null;
    };

    fn.isPending = () => timeoutRef.current !== null;

    return fn;
  }, [delay]);

  // A pending call is flushed (not dropped) on unmount so debounced work —
  // e.g. the editor's autosave — is never lost when the component goes away.
  useEffect(() => () => debounced.flush(), [debounced]);

  return debounced;
}

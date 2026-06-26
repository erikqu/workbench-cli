import { useEffect } from "react";
import { ToastContainer, type ToastOptions, useToast } from "silvery";

type Emit = (options: ToastOptions) => void;

const subscribers = new Set<Emit>();

/**
 * Emit a toast from anywhere (including the non-React app controller). The
 * mounted `<ToastHost>` registers the live `useToast().toast` callback; if no
 * host is mounted the call is a harmless no-op.
 */
export function emitToast(options: ToastOptions) {
  for (const emit of subscribers) {
    emit(options);
  }
}

/**
 * Owns the single app-level toast store. Renders `<ToastContainer>` and bridges
 * Silvery's local `useToast()` hook to the global `emitToast()` helper so the
 * app controller can fire notifications without holding a React ref.
 */
export function ToastHost() {
  const { toast, toasts } = useToast();

  useEffect(() => {
    const emit: Emit = (options) => {
      toast(options);
    };
    subscribers.add(emit);
    return () => {
      subscribers.delete(emit);
    };
  }, [toast]);

  return <ToastContainer toasts={toasts} />;
}

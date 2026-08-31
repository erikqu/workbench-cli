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

  // ToastContainer is a normal flex child unless explicitly positioned. When
  // mounted at the end of Workbench's full-screen column it used to steal rows
  // from the active terminal while a toast appeared, then resize the PTY again
  // when it closed. Only actionable warnings/errors reach this host; overlay
  // them so notifications can never alter pane geometry.
  return (
    <ToastContainer bottom={0} left={0} position="absolute" toasts={toasts} />
  );
}

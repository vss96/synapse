/** Short, non-blocking messages at the bottom of the window, with an optional action such as Undo. */

import { byId } from "./dom.js";

const SHOWN_MS = 6000;
/** An action needs time to be read and reached. */
const SHOWN_WITH_ACTION_MS = 10000;

export interface ToastOptions {
  /** Shown as a failure. */
  error?: boolean;
  action?: { label: string; run: () => void };
}

export function toast(message: string, { error = false, action }: ToastOptions = {}): void {
  const el = document.createElement("div");
  el.className = `toast ${error ? "error" : ""}`;
  el.textContent = message;
  const dismiss = () => el.remove();
  if (action) {
    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = action.label;
    button.onclick = () => {
      dismiss();
      action.run();
    };
    el.append(button);
  }
  byId("toasts").append(el);
  setTimeout(dismiss, action ? SHOWN_WITH_ACTION_MS : SHOWN_MS);
}

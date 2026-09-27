import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export type ModalMaxWidth = "sm" | "md" | "lg";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** Action buttons, pinned to the bottom of the dialog. */
  footer?: ReactNode;
  maxWidth?: ModalMaxWidth;
  children?: ReactNode;
}

const MAX_WIDTH_CLASSES: Record<ModalMaxWidth, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-2xl",
};

// Everything inside a dialog a keyboard user can reach. Elements that are
// disabled cannot hold focus, so they are excluded here rather than filtered later.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

// Body-scroll lock shared by every open Modal. A counter rather than a boolean:
// when two dialogs overlap, the first close must not unlock the page while the
// second is still up. `previousBodyOverflow` is the value in force before the
// outermost dialog locked, so the original inline style is restored exactly.
let openModalCount = 0;
let previousBodyOverflow: string | null = null;

function lockBodyScroll(): void {
  if (openModalCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }

  openModalCount += 1;
}

function unlockBodyScroll(): void {
  openModalCount = Math.max(0, openModalCount - 1);

  if (openModalCount === 0) {
    document.body.style.overflow = previousBodyOverflow ?? "";
    previousBodyOverflow = null;
  }
}

/**
 * A modal dialog with the keyboard contract a data-entry screen needs:
 * focus moves into the dialog on open, Tab cycles inside it instead of
 * wandering onto the page behind, Escape closes it, and focus returns to the
 * control that opened it.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  description,
  footer,
  maxWidth = "md",
  children,
}: ModalProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    lockBodyScroll();

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const dialog = dialogRef.current;
    const firstFocusable = dialog === null ? undefined : focusableElements(dialog)[0];
    (firstFocusable ?? dialog)?.focus();

    return () => {
      // Hand focus back to the trigger so a keyboard user resumes where they were.
      previouslyFocusedRef.current?.focus();
      unlockBodyScroll();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const dialog = dialogRef.current;

      if (dialog === null) {
        return;
      }

      const focusable = focusableElements(dialog);

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (first === undefined || last === undefined) {
        return;
      }

      // With nothing focused yet, or at either end of the list, wrap around.
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-content-primary/40 p-4 sm:p-8"
      // Only a click on the backdrop itself closes the dialog — a click that
      // started inside it, e.g. a drag that ended on the padding, must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className={`w-full ${MAX_WIDTH_CLASSES[maxWidth]} rounded-xl border border-line bg-surface shadow-xl focus:outline-none`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="space-y-1">
            <h2 id={titleId} className="text-base font-medium text-content-primary">
              {title}
            </h2>
            {description !== undefined && (
              <p id={descriptionId} className="text-sm text-content-secondary">
                {description}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1 text-content-secondary transition-colors hover:bg-canvas hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {children !== undefined && <div className="px-6 py-5">{children}</div>}

        {footer !== undefined && (
          <div className="flex flex-wrap justify-end gap-3 border-t border-line px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

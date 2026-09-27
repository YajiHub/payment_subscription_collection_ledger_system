import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

/**
 * The Modal accessibility contract (spec S0-4): rendered only when open, a real
 * dialog with an accessible name, Escape closes, Tab cycles inside instead of
 * escaping to the page behind, focus returns to the trigger on close and on
 * unmount, a backdrop click closes while a click inside does not, and the page
 * behind cannot scroll while the dialog is up.
 */

/** The dialog is portalled inside a full-screen backdrop; that backdrop is the parent. */
function getBackdrop(): HTMLElement {
  const backdrop = screen.getByRole("dialog").parentElement;

  if (backdrop === null) {
    throw new Error("Modal dialog rendered without its backdrop");
  }

  return backdrop;
}

/** The dialog is always inside this harness, so the trigger survives closing it. */
function Harness({ isOpen }: { isOpen: boolean }): React.ReactElement {
  return (
    <>
      <button type="button">Open</button>
      <Modal isOpen={isOpen} onClose={() => undefined} title="Edit plan" />
    </>
  );
}

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Modal isOpen={false} onClose={vi.fn()} title="Edit plan" />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("is a modal dialog with an accessible name and description", () => {
    render(
      <Modal
        isOpen
        onClose={vi.fn()}
        title="Edit plan"
        description="Change the monthly fee"
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit plan" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Change the monthly fee");
  });

  it("moves focus into the dialog when it opens", () => {
    render(<Harness isOpen />);

    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<Modal isOpen onClose={onClose} title="Edit plan" />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab from the last focusable element back to the first", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit plan" footer={<button type="button">Save</button>}>
        <input aria-label="Plan name" />
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button, input"));
    const closeButton = focusable[0];
    const saveButton = focusable[focusable.length - 1];

    expect(focusable).toHaveLength(3); // close, plan name, save

    saveButton?.focus();
    expect(saveButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(closeButton).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable element to the last", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit plan" footer={<button type="button">Save</button>}>
        <input aria-label="Plan name" />
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button, input"));
    const closeButton = focusable[0];
    const saveButton = focusable[focusable.length - 1];

    closeButton?.focus();
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(saveButton).toHaveFocus();
  });

  it("returns focus to the trigger when it closes", () => {
    const { rerender } = render(<Harness isOpen={false} />);
    const trigger = screen.getByRole("button", { name: "Open" });

    trigger.focus();
    expect(trigger).toHaveFocus();

    rerender(<Harness isOpen />);
    expect(trigger).not.toHaveFocus();

    rerender(<Harness isOpen={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the trigger when it unmounts while open", () => {
    function MountHarness({ showModal }: { showModal: boolean }): React.ReactElement {
      return (
        <>
          <button type="button">Open</button>
          {showModal && <Modal isOpen onClose={() => undefined} title="Edit plan" />}
        </>
      );
    }

    const { rerender } = render(<MountHarness showModal={false} />);
    const trigger = screen.getByRole("button", { name: "Open" });

    trigger.focus();
    rerender(<MountHarness showModal />);
    expect(trigger).not.toHaveFocus();

    rerender(<MountHarness showModal={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on a backdrop click and ignores a click inside the dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Edit plan">
        <p>Plan body</p>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(getBackdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while open and restores the previous value on close", () => {
    document.body.style.overflow = "auto";

    const { rerender } = render(<Harness isOpen />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Harness isOpen={false} />);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("restores body scroll on unmount while open", () => {
    document.body.style.overflow = "auto";

    const { unmount } = render(<Modal isOpen onClose={vi.fn()} title="Edit plan" />);
    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("keeps the body locked while a second modal is still open", () => {
    function TwoModals({
      showFirst,
      showSecond,
    }: {
      showFirst: boolean;
      showSecond: boolean;
    }): React.ReactElement {
      return (
        <>
          {showFirst && <Modal isOpen onClose={() => undefined} title="First" />}
          {showSecond && <Modal isOpen onClose={() => undefined} title="Second" />}
        </>
      );
    }

    document.body.style.overflow = "auto";

    const { rerender } = render(<TwoModals showFirst showSecond />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<TwoModals showFirst={false} showSecond />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<TwoModals showFirst={false} showSecond={false} />);
    expect(document.body.style.overflow).toBe("auto");
  });
});

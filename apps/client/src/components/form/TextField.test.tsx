import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SelectField } from "./SelectField";
import { TextField } from "./TextField";

/**
 * The inline-error contract every form depends on: the message belongs to one
 * field, the field says it is invalid, and a screen reader is told which text
 * explains why.
 */
describe("the shared field components", () => {
  it("names the control with its visible label", () => {
    render(<TextField id="firstName" label="First Name" required />);

    const input = screen.getByLabelText("First Name");
    expect(input).toBeInTheDocument();
    expect(input).toBeRequired();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("describes a valid control with its hint", () => {
    render(<TextField id="password" label="Password" hint="At least 8 characters." />);

    const input = screen.getByLabelText("Password");
    const describedIds = (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);

    expect(describedIds).toHaveLength(1);
    expect(document.getElementById(describedIds[0] ?? "")).toHaveTextContent("At least 8 characters.");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks an invalid control and points it at the message beside it", () => {
    render(<TextField id="amount" label="Amount" error="The amount must be greater than zero" />);

    const input = screen.getByLabelText("Amount");
    const describedIds = (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const describedText = describedIds
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(describedText).toContain("The amount must be greater than zero");
    expect(screen.getByRole("alert")).toHaveTextContent("The amount must be greater than zero");
  });

  it("does the same for a select", () => {
    render(
      <SelectField id="plan" label="Service Plan" error="Choose a service plan">
        <option value="">Select a plan…</option>
      </SelectField>
    );

    const select = screen.getByLabelText("Service Plan");
    const describedIds = (select.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const describedText = describedIds
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(describedText).toContain("Choose a service plan");
  });
});

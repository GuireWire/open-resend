import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import SesProductionRequestHelper from "../SesProductionRequestHelper";

describe("SesProductionRequestHelper", () => {
  it("generates a production request from buyer-safe public inputs", async () => {
    render(<SesProductionRequestHelper />);

    await userEvent.type(screen.getByLabelText(/sending domain/i), "example.com");
    await userEvent.type(screen.getByLabelText(/website or app url/i), "https://example.com");
    await userEvent.type(screen.getByLabelText(/use case/i), "Password resets and account notifications");
    await userEvent.click(screen.getByRole("button", { name: /generate request/i }));

    expect(screen.getByText(/request production access for amazon ses in us-east-1/i)).toBeInTheDocument();
    expect(screen.getByText(/sending domain: example.com/i)).toBeInTheDocument();
    expect(screen.getAllByText(/password resets and account notifications/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /book deployment review/i })).toHaveAttribute(
      "href",
      "https://buy.stripe.com/3cIcN49zBcRagx5dvXaMU01"
    );
  });
});

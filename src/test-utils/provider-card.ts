import { screen } from "@testing-library/react";

/**
 * Locate a provider card's collapsible header in the Settings → Providers tab.
 *
 * Cards start collapsed, so anything in a card's models section (model rows,
 * "Add model") is only in the DOM after its header is clicked.
 *
 * The trigger is found by `aria-expanded` rather than by accessible name: the
 * Edit/Remove buttons' aria-labels also contain the provider name, so a
 * name-only match is ambiguous. `aria-expanded` is carried by the trigger
 * alone.
 *
 * Returns the element so callers pick their own click mechanism — `userEvent`
 * where the test drives a real interaction, `fireEvent` where a synchronous
 * click is enough.
 */
export function getProviderCardTrigger(providerName: string): HTMLElement {
  const trigger = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.hasAttribute("aria-expanded") &&
        button.textContent?.includes(providerName)
    );
  if (!trigger) {
    throw new Error(`No collapsible trigger found for provider "${providerName}"`);
  }
  return trigger;
}

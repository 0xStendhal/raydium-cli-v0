import assert from "node:assert/strict";
import test from "node:test";

import { runWizard, WIZARD_BACK, WIZARD_CANCEL, WizardStep } from "./wizard";

type Answers = { first: string; second: string };

test("wizard revisits the previous step when the user goes back", async () => {
  let firstPrompts = 0;
  let secondPrompts = 0;
  const steps: Array<WizardStep<Answers>> = [
    {
      key: "first",
      prompt: async () => (++firstPrompts === 1 ? "initial" : "revised")
    },
    {
      key: "second",
      prompt: async () => (++secondPrompts === 1 ? WIZARD_BACK : "complete")
    }
  ];

  const result = await runWizard<Answers>({}, steps);
  assert.deepEqual(result, {
    status: "completed",
    values: { first: "revised", second: "complete" }
  });
});

test("wizard stops without returning partial values when cancelled", async () => {
  const result = await runWizard<Answers>({}, [
    { key: "first", prompt: async () => WIZARD_CANCEL }
  ]);

  assert.deepEqual(result, { status: "cancelled" });
});

import { promptInput, promptSelect } from "./prompt";

export const WIZARD_BACK = "__wizard_back__" as const;
export const WIZARD_CANCEL = "__wizard_cancel__" as const;

export type WizardNavigation = typeof WIZARD_BACK | typeof WIZARD_CANCEL;

export type WizardPromptContext = {
  canGoBack: boolean;
  index: number;
  total: number;
};

export type WizardStep<T extends object> = {
  key: keyof T;
  prompt: (
    values: Readonly<Partial<T>>,
    context: WizardPromptContext
  ) => Promise<T[keyof T] | WizardNavigation>;
};

export type WizardResult<T extends object> =
  | { status: "completed"; values: Partial<T> }
  | { status: "cancelled" };

export function isWizardNavigation(value: unknown): value is WizardNavigation {
  return value === WIZARD_BACK || value === WIZARD_CANCEL;
}

export async function runWizard<T extends object>(
  initialValues: Partial<T>,
  steps: Array<WizardStep<T>>
): Promise<WizardResult<T>> {
  const values = { ...initialValues };
  let index = 0;

  while (index < steps.length) {
    const step = steps[index];
    const result = await step.prompt(values, {
      canGoBack: index > 0,
      index,
      total: steps.length
    });

    if (result === WIZARD_CANCEL) return { status: "cancelled" };
    if (result === WIZARD_BACK) {
      if (index > 0) index -= 1;
      continue;
    }

    values[step.key] = result as T[keyof T];
    index += 1;
  }

  return { status: "completed", values };
}

export async function promptWizardSelect<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T }>,
  options: { allowBack?: boolean; allowCancel?: boolean } = {}
): Promise<T | WizardNavigation> {
  return promptSelect<T | WizardNavigation>(message, [
    ...choices,
    ...(options.allowBack ? [{ name: "Back", value: WIZARD_BACK }] : []),
    ...(options.allowCancel !== false ? [{ name: "Cancel", value: WIZARD_CANCEL }] : [])
  ]);
}

export async function promptWizardInput(
  message: string,
  options: {
    allowBack?: boolean;
    allowCancel?: boolean;
    defaultValue?: string;
    validate?: (input: string) => true | string;
  } = {}
): Promise<string | WizardNavigation> {
  const navigationHint = [
    options.allowBack ? "back" : undefined,
    options.allowCancel !== false ? "cancel" : undefined
  ].filter((value): value is string => Boolean(value));
  const suffix = navigationHint.length ? ` (or type ${navigationHint.join("/")})` : "";
  const value = await promptInput(`${message}${suffix}`, options.defaultValue, (input) => {
    const normalized = input.trim().toLowerCase();
    if (options.allowBack && normalized === "back") return true;
    if (options.allowCancel !== false && normalized === "cancel") return true;
    return options.validate ? options.validate(input) : true;
  });

  const normalized = value.trim().toLowerCase();
  if (options.allowBack && normalized === "back") return WIZARD_BACK;
  if (options.allowCancel !== false && normalized === "cancel") return WIZARD_CANCEL;
  return value;
}

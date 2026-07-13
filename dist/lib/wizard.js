"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptWizardInput = exports.promptWizardSelect = exports.runWizard = exports.isWizardNavigation = exports.WIZARD_CANCEL = exports.WIZARD_BACK = void 0;
const prompt_1 = require("./prompt");
exports.WIZARD_BACK = "__wizard_back__";
exports.WIZARD_CANCEL = "__wizard_cancel__";
function isWizardNavigation(value) {
    return value === exports.WIZARD_BACK || value === exports.WIZARD_CANCEL;
}
exports.isWizardNavigation = isWizardNavigation;
async function runWizard(initialValues, steps) {
    const values = { ...initialValues };
    let index = 0;
    while (index < steps.length) {
        const step = steps[index];
        const result = await step.prompt(values, {
            canGoBack: index > 0,
            index,
            total: steps.length
        });
        if (result === exports.WIZARD_CANCEL)
            return { status: "cancelled" };
        if (result === exports.WIZARD_BACK) {
            if (index > 0)
                index -= 1;
            continue;
        }
        values[step.key] = result;
        index += 1;
    }
    return { status: "completed", values };
}
exports.runWizard = runWizard;
async function promptWizardSelect(message, choices, options = {}) {
    return (0, prompt_1.promptSelect)(message, [
        ...choices,
        ...(options.allowBack ? [{ name: "Back", value: exports.WIZARD_BACK }] : []),
        ...(options.allowCancel !== false ? [{ name: "Cancel", value: exports.WIZARD_CANCEL }] : [])
    ]);
}
exports.promptWizardSelect = promptWizardSelect;
async function promptWizardInput(message, options = {}) {
    const navigationHint = [
        options.allowBack ? "back" : undefined,
        options.allowCancel !== false ? "cancel" : undefined
    ].filter((value) => Boolean(value));
    const suffix = navigationHint.length ? ` (or type ${navigationHint.join("/")})` : "";
    const value = await (0, prompt_1.promptInput)(`${message}${suffix}`, options.defaultValue, (input) => {
        const normalized = input.trim().toLowerCase();
        if (options.allowBack && normalized === "back")
            return true;
        if (options.allowCancel !== false && normalized === "cancel")
            return true;
        return options.validate ? options.validate(input) : true;
    });
    const normalized = value.trim().toLowerCase();
    if (options.allowBack && normalized === "back")
        return exports.WIZARD_BACK;
    if (options.allowCancel !== false && normalized === "cancel")
        return exports.WIZARD_CANCEL;
    return value;
}
exports.promptWizardInput = promptWizardInput;

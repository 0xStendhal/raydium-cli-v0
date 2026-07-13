"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outputHelpWithAdvancedOptions = exports.addRichHelp = exports.buildHelpText = exports.AUTOMATION_HELP = exports.PASSWORD_AUTH_HELP = void 0;
function toLines(value) {
    if (!value)
        return [];
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((entry) => entry
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean));
}
function formatSection(title, value) {
    const lines = toLines(value);
    if (lines.length === 0)
        return undefined;
    const body = lines.map((line) => `  ${line}`).join("\n");
    return `${title}:\n${body}`;
}
exports.PASSWORD_AUTH_HELP = "Use --password-stdin or the interactive password prompt. --password requires --unsafe-secret-flags.";
exports.AUTOMATION_HELP = "Quote with --json first; use --json --yes --password-stdin and --approve-quote only for an approved execution.";
function buildHelpText(sections) {
    const rendered = [
        formatSection("Summary", sections.summary),
        formatSection("Auth", sections.auth),
        formatSection("Units", sections.units),
        formatSection("Defaults", sections.defaults),
        formatSection("Automation", sections.automation),
        formatSection("Examples", sections.examples),
        formatSection("Notes", sections.notes)
    ].filter((section) => Boolean(section));
    if (rendered.length === 0) {
        return "";
    }
    return `\n${rendered.join("\n\n")}\n`;
}
exports.buildHelpText = buildHelpText;
function addRichHelp(command, sections) {
    return command.addHelpText("after", buildHelpText(sections));
}
exports.addRichHelp = addRichHelp;
function outputHelpWithAdvancedOptions(command) {
    const hiddenOptions = command.options.filter((option) => option.hidden);
    hiddenOptions.forEach((option) => option.hideHelp(false));
    try {
        command.outputHelp();
    }
    finally {
        hiddenOptions.forEach((option) => option.hideHelp(true));
    }
}
exports.outputHelpWithAdvancedOptions = outputHelpWithAdvancedOptions;

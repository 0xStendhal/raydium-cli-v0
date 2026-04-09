import { Command } from "commander";

type HelpSectionValue = string | string[] | undefined;

type HelpSections = {
  summary?: HelpSectionValue;
  auth?: HelpSectionValue;
  units?: HelpSectionValue;
  defaults?: HelpSectionValue;
  nonInteractive?: HelpSectionValue;
  examples?: HelpSectionValue;
  notes?: HelpSectionValue;
};

function toLines(value: HelpSectionValue): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) =>
    entry
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
  );
}

function formatSection(title: string, value: HelpSectionValue): string | undefined {
  const lines = toLines(value);
  if (lines.length === 0) return undefined;
  const body = lines.map((line) => `  ${line}`).join("\n");
  return `${title}:\n${body}`;
}

export const PASSWORD_AUTH_HELP =
  "Use --password-stdin or the interactive password prompt. --password requires --unsafe-secret-flags.";

export const NON_INTERACTIVE_HELP =
  "Prefer --json --yes --password-stdin for non-interactive use.";

export function buildHelpText(sections: HelpSections): string {
  const rendered = [
    formatSection("Summary", sections.summary),
    formatSection("Auth", sections.auth),
    formatSection("Units", sections.units),
    formatSection("Defaults", sections.defaults),
    formatSection("Non-interactive", sections.nonInteractive),
    formatSection("Examples", sections.examples),
    formatSection("Notes", sections.notes)
  ].filter((section): section is string => Boolean(section));

  if (rendered.length === 0) {
    return "";
  }

  return `\n${rendered.join("\n\n")}\n`;
}

export function addRichHelp(command: Command, sections: HelpSections): Command {
  return command.addHelpText("after", buildHelpText(sections));
}

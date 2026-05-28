import fs from "node:fs/promises";

const YAML_SPECIAL_CHARS = /[:#\n\r\t"'[\]{}&*!|>%@`,]/;
const YAML_RESERVED_VALUES = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

export function serializeScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined || value === "") {
    return '""';
  }
  const str = String(value);
  if (
    YAML_SPECIAL_CHARS.test(str) ||
    YAML_RESERVED_VALUES.has(str.toLowerCase()) ||
    /^[\s-?]/.test(str) ||
    /^\d/.test(str)
  ) {
    const escaped = str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return str;
}

export function serializeYamlObject(value: Record<string, unknown>, indentLevel = 0): string[] {
  return Object.entries(value).flatMap(([key, nestedValue]) =>
    serializeYamlEntry(key, nestedValue, indentLevel)
  );
}

function serializeYamlEntry(key: string, value: unknown, indentLevel: number): string[] {
  const indent = " ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}${key}: []`];
    }
    return [`${indent}${key}:`, ...value.map((item) => `${indent}  - ${serializeScalar(item)}`)];
  }

  if (value && typeof value === "object") {
    const childEntries = Object.entries(value as Record<string, unknown>);
    if (childEntries.length === 0) {
      return [`${indent}${key}: {}`];
    }
    return [
      `${indent}${key}:`,
      ...childEntries.flatMap(([childKey, childValue]) =>
        serializeYamlEntry(childKey, childValue, indentLevel + 2)
      )
    ];
  }

  return [`${indent}${key}: ${serializeScalar(value)}`];
}

export function renderMarkdownDocument(
  frontmatter: Record<string, unknown>,
  sections: Record<string, string[]>
): string {
  const normalizedFrontmatter = { ...frontmatter };
  delete (normalizedFrontmatter as { body?: unknown }).body;

  const lines = ["---", ...serializeYamlObject(normalizedFrontmatter), "---", ""];

  for (const [title, items] of Object.entries(sections)) {
    lines.push(`## ${title}`, "");
    for (const item of items) {
      lines.push(item);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmpPath, content, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

type ParsedOdTag = {
  end: number | null;
  name: string;
};

function parseOdTag(input: string, start: number): ParsedOdTag | null {
  const match = /^<\/?od-([a-z][a-z0-9-]*)/i.exec(input.slice(start));
  if (!match) return null;

  const name = match[1]!.toLowerCase();
  let quote: '"' | "'" | null = null;
  for (let index = start + match[0].length; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return { end: index, name };
  }

  return { end: null, name };
}

function isPotentialOdTagPrefix(value: string): boolean {
  const lower = value.toLowerCase();
  return '<od-'.startsWith(lower) || '</od-'.startsWith(lower);
}

export function stripInternalControlTags(input: string, streaming = false): string {
  let output = '';
  let cursor = 0;

  while (cursor < input.length) {
    const tagStart = input.indexOf('<', cursor);
    if (tagStart < 0) return output + input.slice(cursor);

    output += input.slice(cursor, tagStart);
    const parsed = parseOdTag(input, tagStart);
    if (parsed) {
      if (parsed.end === null) return output;
      if (parsed.name === 'card') output += input.slice(tagStart, parsed.end + 1);
      cursor = parsed.end + 1;
      continue;
    }

    const trailing = input.slice(tagStart);
    if (streaming && isPotentialOdTagPrefix(trailing)) return output;
    output += '<';
    cursor = tagStart + 1;
  }

  return output;
}

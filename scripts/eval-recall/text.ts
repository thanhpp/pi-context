export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'");
}

export function containsToken(text: string, token: string): boolean {
  const normalizedToken = normalizeText(token);
  if (normalizedToken === '') return false;
  const escaped = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(normalizeText(text));
}

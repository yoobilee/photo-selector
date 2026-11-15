// Only observed, complete sentences are accepted. Any remaining prose stays unknown.
export const parserVersion = 2;
export function findingsFromText(text) {
  const findings = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  if (typeof text !== 'string') return { ...findings, unknown: 1 };
  const levels = ['critical', 'high', 'medium', 'low'];
  for (const badge of text.matchAll(/\[P([0-3])\]/g)) findings[levels[Number(badge[1])]] += 1;
  const declaration = /^(?:No actionable defects were found(?: in the changes against the specified base)?\.|No findings\.|No issues found\.)/i;
  const sentences = [
    /^Lint passed\./i,
    /^Lint and all \d+ focused tests passed\./i,
    /^Lint, \d+ targeted unit tests, and \d+ merge-tool tests passed; four platform-specific tests were skipped\./i,
    /^Build and E2E(?: checks)? were not run\./i,
    /^The full unit run encountered a sandbox EPERM in privacyGuard; build and E2E checks were not run\./i,
  ];
  const start = declaration.exec(text.trim());
  let rest = start ? text.trim().slice(start[0].length) : text;
  let valid = Boolean(start);
  while (valid && rest.length) {
    // Require a separator; don't accept concatenated or partially consumed sentences.
    if (!/^\s+/.test(rest)) { valid = false; break; }
    rest = rest.trimStart();
    if (!rest) break;
    const match = sentences.map(pattern => pattern.exec(rest)).find(Boolean);
    if (!match) { valid = false; break; }
    rest = rest.slice(match[0].length);
  }
  if (!valid) findings.unknown = 1;
  if (/rate limit|usage limit|quota exceeded|review (?:was )?(?:skipped|not run)|unable to (?:complete|perform) (?:the )?review/i.test(text)) findings.unknown += 1;
  if (/\[P[^\]]*\]/.test(text.replace(/\[P[0-3]\]/g, ''))) findings.unknown += 1;
  return findings;
}

/**
Slug of a rider on ProCyclingStats, built from the two name halves the world already carries. The
slug keeps only ASCII letters, digits and single hyphens, so the returned URL can never escape the
`/rider/` path no matter how hostile the input names are. `null` means nothing spellable is left.
*/
const stripParentheses = (name: string): string => name.replaceAll(/\([^)]*\)/g, ' ');

export function proCyclingStatsUrl(firstName: string, lastName: string): string | null {
  const joined = `${stripParentheses(firstName)} ${stripParentheses(lastName)}`;

  const slug = joined
    .replaceAll('ł', 'l')
    .replaceAll('Ł', 'L')
    .replaceAll('ø', 'o')
    .replaceAll('Ø', 'O')
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'D')
    .replaceAll('ß', 'ss')
    .replaceAll('æ', 'ae')
    .replaceAll('Æ', 'AE')
    .replaceAll('œ', 'oe')
    .replaceAll('Œ', 'OE')
    .replaceAll('þ', 'th')
    .replaceAll('Þ', 'TH')
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');

  return slug.length === 0 ? null : `https://www.procyclingstats.com/rider/${slug}`;
}

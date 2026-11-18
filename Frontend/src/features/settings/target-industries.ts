/** "steel, EPC ,, pumps" → ["steel", "epc", "pumps"] (the server also lower-cases and de-duplicates). */
export const parseIndustries = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
];

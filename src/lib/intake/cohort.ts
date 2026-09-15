/** Server-owned, expiring authorization. Never accept a cohort from a request body. */
export type Cohort = { mode: 'synthetic' | 'resume'; expiresAt: string; organizationId?: string; sourceId?: string; cases: { leadId: string; documentIds: string[] }[] };
export function readCohort(raw: string | undefined): Cohort | undefined {
  if (raw === undefined) return undefined;
  const c = JSON.parse(raw) as Cohort;
  if (!c || !['synthetic','resume'].includes(c.mode) || !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= Date.now() || !Array.isArray(c.cases) || c.cases.length < 1 || c.cases.length > 25) throw Error('Invalid or expired execution cohort');
  const ids = new Set<string>();
  for (const item of c.cases) {
    if (!/^[0-9a-f-]{36}$/.test(item.leadId) || ids.has(item.leadId) || !Array.isArray(item.documentIds) || item.documentIds.length > 25 || new Set(item.documentIds).size !== item.documentIds.length || item.documentIds.some(id => !/^[0-9a-f-]{36}$/.test(id))) throw Error('Invalid execution identities');
    ids.add(item.leadId);
  }
  if (c.mode === 'synthetic' && c.cases.length !== 1) throw Error('Synthetic execution requires exactly one case');
  return c;
}
export function selectCohort(raw: string | undefined, paused: boolean, exact?: { leadId: string; documentId?: string }): Cohort | undefined | null {
  const c = readCohort(raw);
  if (exact) {
    const item = c?.cases.find(x => x.leadId === exact.leadId);
    if (!c || !item || (exact.documentId && !item.documentIds.includes(exact.documentId))) throw Error('Execution is outside approved cohort');
    return { ...c, cases: [{ ...item, documentIds: exact.documentId ? [exact.documentId] : item.documentIds }] };
  }
  if (paused || c?.mode === 'synthetic') return null;
  return c;
}

import { createHash } from 'node:crypto';

/** Temporary service-restoration overlay, not the homeowner eligibility policy. */
export type RestorationPolicy = {
  version: 1; id: string; cutoff: string; expiresAt: string;
  organizationId: string; sourceId: string;
  excludedCaseIds: string[]; excludedDocumentIds: string[]; excludedChecksums: string[];
};
export type Admission = { policy: string; caseId: string; eligibleAt: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readRestorationPolicy(): RestorationPolicy | undefined {
  const raw = process.env.SCS_RESTORATION_POLICY;
  if (!raw) {
    if (process.env.SCS_RESTORATION_REQUIRED === 'true') throw Error('Restoration policy required');
    return undefined;
  }
  const p = JSON.parse(raw) as RestorationPolicy;
  if (p.version !== 1 || ![p.id,p.organizationId,p.sourceId].every(x=>typeof x==='string' && x.length>0) ||
      !Number.isFinite(Date.parse(p.cutoff)) || !Number.isFinite(Date.parse(p.expiresAt)) ||
      new Date(p.cutoff).toISOString() !== p.cutoff || Date.parse(p.cutoff) > Date.now() || Date.parse(p.expiresAt) <= Date.now() ||
      Date.parse(p.expiresAt) <= Date.parse(p.cutoff)) throw Error('Invalid or expired restoration policy');
  for (const key of ['excludedCaseIds','excludedDocumentIds','excludedChecksums'] as const) {
    const xs = p[key];
    if (!Array.isArray(xs) || new Set(xs).size !== xs.length || xs.some(x => typeof x !== 'string' || !(key === 'excludedChecksums' ? /^[a-f0-9]{64}$/.test(x) : uuid.test(x)))) throw Error('Invalid restoration exclusions');
  }
  return p;
}
/** Renewing the review deadline or adding exclusions must not readmit cases. */
export function policyKey(p: RestorationPolicy): string {
  return createHash('sha256').update(JSON.stringify([p.version,p.id,p.cutoff,p.organizationId,p.sourceId])).digest('hex');
}
export function validAdmission(p: RestorationPolicy, raw: unknown, caseId: string): raw is Admission {
  if (!raw || typeof raw !== 'object' || !uuid.test(caseId) || p.excludedCaseIds.includes(caseId)) return false;
  const a = raw as Admission;
  const time = Date.parse(a.eligibleAt);
  return a.policy === policyKey(p) && a.caseId === caseId && Number.isFinite(time) && time >= Date.parse(p.cutoff) && time <= Date.now();
}

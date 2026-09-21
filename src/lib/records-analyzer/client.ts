// Synchronized from SCS Records adapter, 2026-09-20.
import 'server-only';
export function analyzerConfigured() { return Boolean(process.env.RECORDS_ANALYZER_URL && process.env.RECORDS_ANALYZER_KEY); }
export class AnalyzerError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export function analyzerClient(caseId: string) {
  if (!analyzerConfigured()) throw new AnalyzerError('Private analyzer is unavailable. Your originals are saved.','not_configured',503);
  const base = new URL(process.env.RECORDS_ANALYZER_URL!);
  if (base.hostname === 'records.prodigyflo.ai' || base.hostname.endsWith('.records.prodigyflo.ai')) {
    throw new AnalyzerError('Private analyzer is unavailable. Your originals are saved.','not_configured',503);
  }
  if (base.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost','127.0.0.1'].includes(base.hostname))) throw Error('Analyzer must use HTTPS');
  return async function request(path: string, options: { method?: string; body?: unknown; bytes?: Buffer; requestId?: string } = {}) {
    if (!path.startsWith('/runs') && path !== '/case-reconcile' && path !== '') throw Error('Unsupported analyzer path');
    const headers: Record<string,string> = {Authorization:`Bearer ${process.env.RECORDS_ANALYZER_KEY}`, 'x-analysis-case':caseId};
    if(process.env.RECORDS_CF_ACCESS_CLIENT_ID && process.env.RECORDS_CF_ACCESS_CLIENT_SECRET) { headers['CF-Access-Client-Id']=process.env.RECORDS_CF_ACCESS_CLIENT_ID;headers['CF-Access-Client-Secret']=process.env.RECORDS_CF_ACCESS_CLIENT_SECRET; }
    if(options.requestId) headers['idempotency-key']=options.requestId;
    if(options.body !== undefined) headers['Content-Type']='application/json';
    if(options.bytes) headers['Content-Type']='image/jpeg';
    const response=await fetch(new URL(`/api/p/docai${path}`,base), {
      method:options.method ?? 'GET', headers, redirect:'error', cache:'no-store', signal:AbortSignal.timeout(235000),
      body:options.bytes ? new Uint8Array(options.bytes) : options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const result=await response.json();
    if(!response.ok) throw new AnalyzerError(result.message || result.error || 'Analyzer unavailable',result.error ?? 'analyzer_error',response.status);
    return result;
  };
}

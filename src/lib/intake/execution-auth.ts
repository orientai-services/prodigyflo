import { timingSafeEqual } from 'node:crypto';
export function executionAuthorized(request: Request): boolean {
 const expected=process.env.STAGE0_EXECUTION_TOKEN;
 const presented=request.headers.get('authorization');
 if (!expected || expected.length<32 || !presented) return false;
 const a=Buffer.from('Bearer '+expected),b=Buffer.from(presented);
 return a.length===b.length && timingSafeEqual(a,b);
}

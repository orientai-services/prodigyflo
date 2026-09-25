/** Private exact case-review / closer-pitch files. Never a document key, never a path. */
const ID_RE = /^[a-z0-9]{10,40}$/

export function closerPacketKey(clientId: string, kind: 'review' | 'pitch'): string {
  if (!ID_RE.test(clientId)) throw new Error('Invalid client id for a stored packet.')
  return `closer-packets/${clientId}/${kind}.pdf`
}

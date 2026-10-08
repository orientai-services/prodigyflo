import { db } from '@/lib/db'
import { can, getSessionUser } from '@/lib/rbac'
import { platformCredentials, telephonyCredentialsDetailed } from '@/lib/telephony'
import { fetchRecordingMedia, recordingMediaRequest } from '@/lib/telephony/recording-media'
import { canPlayRecording } from '@/lib/telephony/voice-calls'

/**
 * Plays one call recording to a signed-in staff member, streamed from Twilio.
 *
 * The recording never leaves the carrier and its URL is never stored: this
 * route rebuilds it from the call's RecordingSid and account (see
 * recording-media.ts). Anyone who may not hear it — wrong org, out of scope, a
 * guessed id — gets 404, not 403, so an id leaks nothing. ?original=1 (phone
 * managers only) returns the dual-channel file as a download.
 */
export const maxDuration = 60

const NOT_FOUND = () => new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } })

async function serve(request: Request, voiceCallId: string, method: 'GET' | 'HEAD'): Promise<Response> {
  const user = await getSessionUser()
  if (!user) return new Response('Sign in first.', { status: 401, headers: { 'Cache-Control': 'no-store' } })

  const original = new URL(request.url).searchParams.get('original') === '1'
  if (original && !can(user, 'telephony:manage')) return NOT_FOUND()

  const vc = await db.voiceCall.findUnique({ where: { id: voiceCallId } })
  if (!vc || !(await canPlayRecording(user, vc))) return NOT_FOUND()

  const detailed = await telephonyCredentialsDetailed(vc.organizationId)
  let creds = detailed.creds && detailed.creds.accountSid === vc.accountSid ? detailed.creds : null
  if (!creds) {
    const platform = platformCredentials()
    if (platform && platform.accountSid === vc.accountSid) creds = platform
  }

  const built = recordingMediaRequest(vc, creds, { mono: !original, range: request.headers.get('range') })
  if (!built.ok) return NOT_FOUND()

  const media = await fetchRecordingMedia(built.request, { method })
  if (!media.ok) {
    return new Response(media.status === 404 ? 'Not found.' : 'The recording is not available right now.', {
      status: media.status,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const headers = new Headers({
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': original ? `attachment; filename="call-${vc.id}.mp3"` : 'inline',
    'Accept-Ranges': media.headers.get('accept-ranges') ?? 'bytes',
  })
  for (const name of ['content-range', 'content-length']) {
    const value = media.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(method === 'HEAD' ? null : media.body, { status: media.status, headers })
}

export async function GET(request: Request, ctx: { params: Promise<{ voiceCallId: string }> }) {
  const { voiceCallId } = await ctx.params
  return serve(request, voiceCallId, 'GET')
}

export async function HEAD(request: Request, ctx: { params: Promise<{ voiceCallId: string }> }) {
  const { voiceCallId } = await ctx.params
  return serve(request, voiceCallId, 'HEAD')
}

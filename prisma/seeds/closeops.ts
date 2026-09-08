import type { PrismaClient } from '@prisma/client'

type Ctx = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

/**
 * Close-rate-ops demo rows: AI probability scores across the seed book so the
 * hot-leads queue and phase dashboards have real numbers, one viewed Closer
 * Brief, and a coaching + call-QA pair. Idempotent. Synthetic only — scores
 * are deterministic from the client id so reruns are stable.
 */
export async function seedCloseops(db: PrismaClient, ctx: Ctx): Promise<void> {
  const manager = ctx.users.find((u) => u.role === 'SALES_MANAGER') ?? ctx.users[0]
  const closer = ctx.users.find((u) => u.role === 'CLOSER') ?? manager
  if (!manager || !closer) return

  // ── Deterministic AI scores over the live book ─────────────────────────────
  const clients = await db.client.findMany({
    where: { organizationId: ctx.organizationId, deletedAt: null },
    select: { id: true, currentStage: { select: { position: true, isTerminal: true, category: true } } },
  })
  const maxPos = Math.max(1, ...clients.map((c) => c.currentStage.position))
  for (const c of clients) {
    // Stage depth carries most of the signal; a stable per-id wobble spreads
    // the queue, and SALES-stage clients get a lift so the hot-lead queue
    // (which works pre-submission leads) demos with a believable slice.
    const wobble = ((c.id.charCodeAt(c.id.length - 1) * 31 + c.id.charCodeAt(2)) % 23) - 11
    const salesLift = c.currentStage.category === 'SALES' ? 18 : 0
    const base = 35 + Math.round((c.currentStage.position / maxPos) * 55)
    const probability = Math.max(5, Math.min(98, base + wobble + salesLift))
    await db.client.update({
      where: { id: c.id },
      data: { aiCloseProbability: probability, aiCloseProbabilityAt: new Date() },
    })
  }

  // ── One viewed Closer Brief on the first live client ───────────────────────
  const briefClient = clients.find((c) => !c.currentStage.isTerminal)
  if (briefClient) {
    const existing = await db.closerBrief.findFirst({ where: { clientId: briefClient.id } })
    if (!existing) {
      await db.closerBrief.create({
        data: {
          organizationId: ctx.organizationId,
          clientId: briefClient.id,
          requestedById: closer.id,
          provider: 'mock',
          content: {
            situation:
              'Homeowner is mid-pipeline with verified contact info and an engaged response pattern. Payment discussion is the likely sticking point.',
            highlights: ['Responds fastest to afternoon calls', 'All requested documents already in review'],
            objections: [
              {
                objection: 'I want to talk it over with my spouse first.',
                response: 'Offer a short three-way call this week so both hear the same numbers.',
              },
            ],
            talkingPoints: ['Confirm the document review timeline', 'Walk the payment options one at a time'],
            recommendedNextStep: 'Call today and set the joint follow-up before hanging up.',
          },
          generatedAt: new Date(Date.now() - 2 * 86_400_000),
          viewedAt: new Date(Date.now() - 2 * 86_400_000 + 600_000),
          viewedById: closer.id,
        },
      })
    }
  }

  // ── Phase 2: qualifier review + nurture touch on the hot slice ─────────────
  const hotClients = await db.client.findMany({
    where: { organizationId: ctx.organizationId, aiCloseProbability: { gte: 80 }, currentStage: { isTerminal: false } },
    select: { id: true, aiCloseProbability: true },
    take: 3,
  })
  const reviewsExist = await db.hotLeadReview.count({ where: { organizationId: ctx.organizationId } })
  if (reviewsExist === 0 && hotClients.length > 0) {
    await db.hotLeadReview.create({
      data: {
        organizationId: ctx.organizationId,
        clientId: hotClients[0].id,
        reviewerId: manager.id,
        decision: 'APPROVED',
        reason: 'Verified intent and paperwork readiness on the qualifier pass.',
        probabilityAtReview: hotClients[0].aiCloseProbability,
      },
    })
    if (hotClients[1]) {
      await db.nurtureTouch.create({
        data: {
          organizationId: ctx.organizationId,
          clientId: hotClients[1].id,
          senderId: closer.id,
          kind: 'VIDEO',
          url: 'https://example.com/nurture/preview',
          note: 'Personalized 2-minute walkthrough of their numbers.',
          sentAt: new Date(Date.now() - 86_400_000),
          confirmedAt: new Date(Date.now() - 80_000_000),
        },
      })
    }
  }

  // ── Portal demo: a video touch on the portal-linked client ────────────────
  const portalClient = await db.client.findFirst({
    where: { organizationId: ctx.organizationId, portalUserId: { not: null } },
    select: { id: true },
  })
  if (portalClient) {
    const hasTouch = await db.nurtureTouch.count({ where: { clientId: portalClient.id } })
    if (hasTouch === 0) {
      await db.nurtureTouch.create({
        data: {
          organizationId: ctx.organizationId,
          clientId: portalClient.id,
          senderId: closer.id,
          kind: 'VIDEO',
          url: 'https://example.com/nurture/walkthrough',
          note: 'A short walkthrough of your numbers before our call.',
          sentAt: new Date(Date.now() - 3_600_000),
        },
      })
    }
  }

  // ── Coaching + call QA ─────────────────────────────────────────────────────
  const haveNotes = await db.coachingNote.count({ where: { organizationId: ctx.organizationId } })
  if (haveNotes === 0) {
    await db.coachingNote.create({
      data: {
        organizationId: ctx.organizationId,
        subjectId: closer.id,
        authorId: manager.id,
        kind: 'ONE_ON_ONE',
        body: 'Weekly 1-on-1: pipeline is healthy; push for the joint-decision call earlier in the conversation.',
        strengths: 'Strong rapport in first two minutes; consistent brief usage.',
        improvements: 'Asks for the close later than needed on hot leads.',
        createdAt: new Date(Date.now() - 5 * 86_400_000),
      },
    })
    await db.coachingNote.create({
      data: {
        organizationId: ctx.organizationId,
        subjectId: closer.id,
        authorId: manager.id,
        kind: 'CALL_QA',
        score: 8,
        clientId: briefClient?.id ?? null,
        body: 'QA on Tuesday afternoon call: followed the funnel steps, clean recap, one missed buying signal.',
        strengths: 'Objection handling on the spouse conversation.',
        improvements: 'Slow down on the pricing recap.',
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      },
    })
  }
}

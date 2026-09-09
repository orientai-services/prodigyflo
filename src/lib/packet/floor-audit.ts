/**
 * Grok floor-manager audit.
 *
 * Order is locked:
 *   1. Build the audit packet (fields + contract closer-win brief)
 *   2. Stamp READY only if the data gate passes AND the brief is in the packet
 *   3. Hand the packet to the human closer
 *   4. Strawberry gets payload only after the closer says YES
 *
 * C files never stamp READY. Strawberry never Submit.
 */

import type { Closeability, PacketStatus } from './schema'

export type FloorAuditInput = {
  dataReady: boolean
  closeability: Closeability
  brief: string
  closerApproved: boolean
}

export type FloorAuditResult = {
  floorStampedReady: boolean
  packet_status: PacketStatus
  strawberry_status: string
  strawberryMayRun: boolean
  holdReason: string
}

export function hasCloserWinBrief(brief: string): boolean {
  const t = brief.trim()
  return t.includes('CLOSE TALK') && t.includes('REDLINE') && t.includes('BEST-PROBABILITY PATH')
}

export function evaluateFloorAudit(input: FloorAuditInput): FloorAuditResult {
  const briefInPacket = hasCloserWinBrief(input.brief)

  if (input.closeability === 'C') {
    return {
      floorStampedReady: false,
      packet_status: 'NOT_STARTED',
      strawberry_status: 'DO NOT RUN',
      strawberryMayRun: false,
      holdReason: 'C file. Floor manager will not stamp READY. Collect identity + signed agreement.',
    }
  }

  if (!briefInPacket) {
    return {
      floorStampedReady: false,
      packet_status: 'NOT_STARTED',
      strawberry_status: 'DO NOT RUN',
      strawberryMayRun: false,
      holdReason: 'Audit packet is missing the closer-win brief. Grok floor manager will not stamp READY.',
    }
  }

  if (!input.dataReady) {
    return {
      floorStampedReady: false,
      packet_status: 'NOT_STARTED',
      strawberry_status: 'DO NOT RUN',
      strawberryMayRun: false,
      holdReason: 'Floor manager audited the brief into the packet, but the data gate is not READY. Do not pass to Strawberry.',
    }
  }

  // Data gate + brief in packet → floor stamps READY and hands to the closer.
  if (!input.closerApproved) {
    return {
      floorStampedReady: true,
      packet_status: 'PAYLOAD_READY',
      strawberry_status: 'HELD FOR CLOSER',
      strawberryMayRun: false,
      holdReason: 'Floor manager stamped READY. Waiting for the human closer to say YES before any payload goes to Strawberry.',
    }
  }

  return {
    floorStampedReady: true,
    packet_status: 'STRAWBERRY_QUEUED',
    strawberry_status: 'STRAWBERRY QUEUED',
    strawberryMayRun: true,
    holdReason: 'Closer said YES. Strawberry may type. Human Submit. WAIT FOR HUMAN.',
  }
}

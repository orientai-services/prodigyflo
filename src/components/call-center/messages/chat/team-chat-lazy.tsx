'use client'

import dynamic from 'next/dynamic'

/**
 * The team chat (conversation, media recorder, sheets, socket client) in its
 * own chunk, fetched when Messages › Team chat renders instead of with every
 * Call Center section.
 */
export const TeamChat = dynamic(() => import('./team-chat').then((m) => m.TeamChat))

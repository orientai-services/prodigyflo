'use client'

import dynamic from 'next/dynamic'

/**
 * The classic app shell, in its own chunk. With the final desk on (production)
 * the (app) layout never renders it, yet a static import still shipped it and
 * everything it pulls in (command palette with cmdk, user menu, notification
 * bell, org switcher) to every staff page. Where it does render it is still
 * server-rendered as before.
 */
export const AppShell = dynamic(() => import('./app-shell').then((m) => m.AppShell))

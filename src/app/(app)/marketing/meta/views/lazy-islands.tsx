'use client'

import dynamic from 'next/dynamic'

/**
 * The Ads dashboard's heavy client islands, split into their own chunks. The
 * dashboard also renders inside the Call Center (More › Campaigns), and static
 * imports put Recharts (~110 KB gzip) and the `fb>` console's cmdk (~17 KB
 * gzip) on every Call Center section, whether the Ads view was open or not.
 * Server-rendered as before; each chunk loads only where its island renders.
 */
export const TrendChart = dynamic(() => import('@/components/charts/trend-chart').then((m) => m.TrendChart))
export const SpendBars = dynamic(() => import('./spend-bars').then((m) => m.SpendBars))
export const MetaConsole = dynamic(() => import('../meta-console').then((m) => m.MetaConsole))

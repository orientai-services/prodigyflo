'use client'

import dynamic from 'next/dynamic'

/**
 * The Ads dashboard's two Recharts charts, split into their own chunk. The
 * dashboard also renders inside the Call Center (More › Campaigns), and a
 * static import put Recharts (~110 KB gzip) on every Call Center section,
 * charts or not. Server-rendered as before; the chunk loads only where a
 * chart is on the page.
 */
export const TrendChart = dynamic(() => import('@/components/charts/trend-chart').then((m) => m.TrendChart))
export const SpendBars = dynamic(() => import('./spend-bars').then((m) => m.SpendBars))

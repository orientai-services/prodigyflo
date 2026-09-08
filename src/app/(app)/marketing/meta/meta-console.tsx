'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { CONSOLE_COMMANDS } from '@/lib/meta/console'
import { runConsoleCommandAction } from './actions'

type Entry = { input: string; lines: string[] }

/**
 * The `fb>` console — a keyboard-first face over the SAME gated server actions
 * the buttons call. Nothing executes client-side: every line round-trips
 * through runConsoleCommandAction, which re-gates and audits.
 */
export function MetaConsole({ mode }: { mode: 'mock' | 'live' }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [value, setValue] = useState('')
  const [typed, setTyped] = useState<string[]>([]) // recall buffer for ArrowUp/Down
  const [recall, setRecall] = useState(-1)
  const [pending, startTransition] = useTransition()
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [entries, pending])

  function execute(raw: string) {
    const input = raw.trim()
    if (!input || pending) return
    setValue('')
    setTyped((t) => [...t, input])
    setRecall(-1)
    startTransition(async () => {
      const res = await runConsoleCommandAction(input)
      setEntries((e) => [...e, { input, lines: res.lines }])
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      // Enter always runs the typed line; suggestions below are click-to-fill.
      e.preventDefault()
      e.stopPropagation()
      execute(value)
    } else if (e.key === 'ArrowUp' && value === '' && typed.length > 0) {
      e.preventDefault()
      e.stopPropagation()
      const idx = recall === -1 ? typed.length - 1 : Math.max(0, recall - 1)
      setRecall(idx)
      setValue(typed[idx])
    } else if (e.key === 'Escape') {
      setValue('')
      setRecall(-1)
    }
  }

  // Suggestions only while typing a verb (no args yet) — once a space lands,
  // the operator knows where they're going.
  const showSuggestions = value.length > 0 && !value.includes(' ')

  return (
    <Card className="border-primary/20">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SquareTerminal className="text-primary size-4" />
          <h2 className="text-sm font-semibold">
            <span className="font-mono">fb&gt;</span> console
          </h2>
          {mode === 'mock' && (
            <Badge variant="outline" className="text-warning border-warning/40">mock — no money moves</Badge>
          )}
          <p className="text-muted-foreground ml-auto text-xs">
            Same permissions, same audit trail as the buttons. <span className="font-mono">help</span> lists commands.
          </p>
        </div>

        <div
          ref={logRef}
          className="bg-surface-sunk/60 max-h-64 min-h-24 overflow-y-auto rounded-lg border p-3 font-mono text-xs leading-relaxed"
          role="log"
          aria-live="polite"
        >
          {entries.length === 0 && !pending && (
            <p className="text-muted-foreground">
              fb&gt; Try <span className="text-foreground">list</span>, <span className="text-foreground">spend 7</span>,{' '}
              <span className="text-foreground">pause &lt;id&gt;</span>, or <span className="text-foreground">help</span>.
            </p>
          )}
          {entries.map((e, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <p><span className="text-primary">fb&gt;</span> {e.input}</p>
              {e.lines.map((line, j) => (
                <p key={j} className={cn('whitespace-pre-wrap', line.startsWith('✗') ? 'text-danger' : 'text-muted-foreground')}>
                  {line}
                </p>
              ))}
            </div>
          ))}
          {pending && <p className="text-muted-foreground animate-pulse">fb&gt; …</p>}
        </div>

        <Command shouldFilter className="rounded-lg! border bg-transparent p-0">
          <div className="flex items-center gap-2 px-3">
            <span className="text-primary font-mono text-sm" aria-hidden>fb&gt;</span>
            {/* cmdk's input drives suggestion filtering; Enter is intercepted to run the line. */}
            <CommandPrimitive.Input
              ref={inputRef}
              value={value}
              onValueChange={setValue}
              onKeyDown={onKeyDown}
              disabled={pending}
              placeholder="type a command…"
              aria-label="Meta console command"
              autoComplete="off"
              spellCheck={false}
              className="h-9 w-full bg-transparent font-mono text-sm outline-hidden disabled:opacity-50"
            />
          </div>
          {showSuggestions && (
            <CommandList className="border-t">
              <CommandEmpty>No matching command — try <span className="font-mono">help</span>.</CommandEmpty>
              {CONSOLE_COMMANDS.map((c) => (
                <CommandItem
                  key={c.name}
                  value={c.name}
                  onSelect={() => {
                    setValue(c.name === 'help' || c.name === 'list' ? c.name : `${c.name} `)
                    inputRef.current?.focus()
                  }}
                >
                  <span className="font-mono text-xs">{c.usage}</span>
                  <span className="text-muted-foreground ml-2 truncate text-xs">{c.description}</span>
                </CommandItem>
              ))}
            </CommandList>
          )}
        </Command>
      </CardContent>
    </Card>
  )
}

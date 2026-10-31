import * as React from 'react'
import { createPortal } from 'react-dom'
import { filterCatalog, retirementFor } from './subagent-filter.cjs'
import { NS } from './subagent-locale.cjs'
import css from './subagent-view.module.css'

type SessionId = string
type Translate = (key: string, values?: Record<string, string | number>) => string
type SubagentMode = 'one-shot' | 'continuable' | 'external' | 'unknown'
type CatalogEntry = { id: SessionId; createdAt?: number; mode: SubagentMode; label?: string; activity?: 'running' | 'inactive' }
type ProjectionSnapshot = { values?: Record<string, any>; state?: string; error?: { message?: string } | null }
type SessionsState = { projectionsBySession?: Record<string, ProjectionSnapshot>; byId?: Record<string, any>; phase?: string }
type Address = { parentSessionId: SessionId; childSessionId: SessionId; mode: SubagentMode }
type Injected = {
  openChild: (address: Address) => void
  openChildAside: (address: Address) => void
  refreshProjection: (id: SessionId) => void | Promise<void>
  removeSubagent: (authoritySessionId: SessionId, childId: string) => Promise<void>
}
type Runtime = Injected & {
  sessionId: SessionId
  lineageSessionId?: SessionId
  displayTitle?: string
  openTitle?: () => void
  useSession: (selector: (snapshot: any) => any) => any
  useSessions: (selector: (state: SessionsState) => any) => any
  useSessionStatus: (selector: (value: Map<string, any>) => any) => any
  t: Translate
}
type CatalogView = {
  state: 'loading' | 'ready' | 'error' | 'unavailable'
  entries: CatalogEntry[]
  error?: string
  retirement: { state: 'ready' | 'unavailable' | 'error'; error?: string }
}
type CatalogData = {
  projections: Record<string, ProjectionSnapshot>
  summaries: Record<string, any>
  statuses: Map<string, any>
  now: number
  catalogFor: (id: SessionId) => CatalogView
  retirementForParent: (parentId: SessionId, childId: SessionId) => ReturnType<typeof retirementFor>
}

type RetirementState = { state: 'ready' | 'unavailable' | 'error'; error?: string; values: any[] }

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

function tokenTotal(usage: any): number | undefined {
  if (usage === undefined || usage === null) return undefined
  if (typeof usage.totalTokens === 'number') return usage.totalTokens
  const values = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => usage[key])
  if (!values.every(value => typeof value === 'number')) return undefined
  return values.reduce((sum, value) => sum + value, 0)
}

function durationMs(summary: any, activity: CatalogEntry['activity'], now: number): number | undefined {
  const timing = summary?.projectionValues?.subagentTiming
  if (timing === undefined || typeof timing.settledMs !== 'number') return undefined
  if (timing.active === undefined) return timing.settledMs
  if (typeof timing.active.since !== 'number') return timing.settledMs
  const end = activity === 'running' ? now : typeof timing.active.through === 'number' ? timing.active.through : now
  return timing.settledMs + Math.max(0, end - timing.active.since)
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}`
  return `${seconds}s`
}

function modeLabel(entry: CatalogEntry, t: Translate): string {
  if (entry.mode === 'external') return t('modeExternal')
  if (entry.mode === 'one-shot') return t('modeOneShot')
  if (entry.mode === 'continuable') return t('modeContinuable')
  return t('modeUnknown')
}

function isExternal(entry: CatalogEntry): boolean { return entry.mode === 'external' }

function catalogOf(projections: Record<string, ProjectionSnapshot>, id: SessionId): CatalogView {
  const snapshot = projections[id]
  if (snapshot === undefined) return { state: 'unavailable', entries: [], error: 'projection unavailable', retirement: { state: 'unavailable', error: 'projection unavailable' } }
  if (snapshot.state === 'error') return { state: 'error', entries: [], error: snapshot.error?.message ?? 'projection error', retirement: { state: 'unavailable', error: 'projection unavailable' } }
  const values = snapshot.values ?? {}
  if (!Object.prototype.hasOwnProperty.call(values, 'subagentCatalog')) return { state: 'loading', entries: [], retirement: { state: 'unavailable', error: 'retirement projection unavailable' } }
  if (!Array.isArray(values.subagentCatalog)) return { state: 'error', entries: [], error: 'invalid subagent catalog', retirement: { state: 'unavailable', error: 'retirement projection unavailable' } }
  return { state: 'ready', entries: values.subagentCatalog as CatalogEntry[], retirement: { state: 'unavailable', error: 'retirement projection unavailable' } }
}

function ancestorIds(summaries: Record<string, any>, projections: Record<string, ProjectionSnapshot>, root: SessionId): SessionId[] {
  const ids: SessionId[] = []
  const seen = new Set<string>()
  let current: SessionId | undefined = root
  while (current !== undefined && !seen.has(current)) {
    seen.add(current); ids.push(current)
    const summary = summaries[current]
    current = summary?.parentId ?? projections[current]?.values?.subagent?.address?.parentSessionId
  }
  return ids
}

function statesFor(summaries: Record<string, any>, projections: Record<string, ProjectionSnapshot>, root: SessionId, key: string, requiredRoot: boolean): RetirementState {
  const ids = ancestorIds(summaries, projections, root)
  const states: any[] = []
  const rootValues = projections[root]?.values ?? {}
  const rootHas = Object.prototype.hasOwnProperty.call(rootValues, key)
  if (requiredRoot && !rootHas) return { state: 'unavailable', error: 'retirement projection unavailable', values: [] }
  for (const id of ids) {
    const values = projections[id]?.values ?? {}
    if (Object.prototype.hasOwnProperty.call(values, key)) states.push(values[key])
  }
  if (requiredRoot && states.length === 0) return { state: 'unavailable', error: 'retirement projection unavailable', values: [] }
  for (const value of states) {
    if (value === undefined || value === null || !Array.isArray(value.members)) return { state: 'error', error: 'invalid retirement projection', values: states }
    if (value.failure !== undefined) return { state: 'error', error: String(value.failure), values: states }
  }
  return { state: 'ready', values: states }
}

function useCatalogData(runtime: Runtime, authorityId: SessionId) {
  const projections = runtime.useSessions(state => state.projectionsBySession ?? {}) as Record<string, ProjectionSnapshot>
  const summaries = runtime.useSessions(state => state.byId ?? {}) as Record<string, any>
  const statuses = runtime.useSessionStatus(value => value) as Map<string, any>
  const [now, setNow] = React.useState(() => Date.now())
  const running = Object.values(summaries).some(summary => summary?.running === true) || [...statuses.values()].some(value => value?.running === true)
  React.useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])
  const retirementForParent = (parentId: SessionId, childId: SessionId) => {
    const authority = statesFor(summaries, projections, authorityId, 'subagentRetirements', true)
    if (authority.state !== 'ready') return { state: authority.state, error: authority.error }
    const subagent = statesFor(summaries, projections, parentId, 'subagentRetirements', true)
    const team = statesFor(summaries, projections, parentId, 'teamRetirements', false)
    const result = retirementFor(childId, subagent.state === 'ready' ? subagent.values : undefined, team.state === 'ready' ? team.values : undefined)
    return { ...result, error: subagent.error ?? team.error ?? result.error }
  }
  const catalogFor = (id: SessionId): CatalogView => {
    const raw = catalogOf(projections, id)
    const subagent = statesFor(summaries, projections, id, 'subagentRetirements', true)
    const team = statesFor(summaries, projections, id, 'teamRetirements', false)
    const retirement = subagent.state !== 'ready' ? { state: subagent.state, error: subagent.error } : team.state !== 'ready' ? { state: team.state, error: team.error } : { state: 'ready' as const }
    if (raw.state !== 'ready') return { ...raw, retirement }
    const filtered = filterCatalog(raw.entries, subagent.state === 'ready' ? subagent.values : undefined, team.state === 'ready' ? team.values : undefined)
    return { ...raw, entries: filtered.entries, retirement }
  }
  return { projections, summaries, statuses, now, catalogFor, retirementForParent }
}

function CatalogRow({ entry, parentSessionId, currentSessionId, level, data, expanded, onToggle, onOpen, onSidebar, onRemove, removing, t }: {
  entry: CatalogEntry
  parentSessionId: SessionId
  currentSessionId?: SessionId
  level: number
  data: CatalogData
  expanded: Set<string>
  onToggle: (entry: CatalogEntry, parentId: SessionId) => void
  onOpen: (entry: CatalogEntry, parentId: SessionId) => void
  onSidebar: (entry: CatalogEntry, parentId: SessionId) => void
  onRemove: (entry: CatalogEntry, parentId: SessionId) => void
  removing: boolean
  t: Translate
}) {
  const summary = data.summaries[entry.id]
  const childCatalog = isExternal(entry) ? undefined : data.catalogFor(entry.id)
  const canExpand = !isExternal(entry) && summary?.formatStatus !== 'migration-required' && (childCatalog?.state !== 'ready' || childCatalog.entries.length > 0)
  const isExpanded = expanded.has(entry.id)
  const status = data.statuses.get(entry.id)?.running ?? summary?.running
  const activity = status === true ? 'running' : 'inactive'
  const current = entry.id === currentSessionId
  const retirement = data.retirementForParent(parentSessionId, entry.id)
  const row = retirement.row
  const removed = row?.phase === 'removed'
  const removingState = row?.phase === 'removing'
  const label = entry.label ?? entry.id
  const model = summary?.projectionValues?.modelSelection?.next?.model
  const tokenCount = tokenTotal(summary?.projectionValues?.tokenUsage)
  const duration = durationMs(summary, activity, data.now)
  const secondary = [model === undefined ? undefined : t('model', { model }), modeLabel(entry, t), activity === 'running' ? t('statusRunning') : summary?.projectionValues?.subagentTiming?.lastTurnCompleted ? t('statusCompleted') : t('statusInactive')].filter(Boolean).join(' · ')
  const metrics = [tokenCount === undefined ? undefined : t('tokens', { value: formatTokens(tokenCount) }), duration === undefined ? undefined : t('duration', { value: formatDuration(duration) })].filter(Boolean).join(' · ')
  const localMode = !isExternal(entry) && entry.mode !== 'unknown'
  const canRemove = !current && localMode && !removed && retirement.state === 'ready'
  const toggle = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); onToggle(entry, parentSessionId) }
  const open = () => { if (!isExternal(entry)) onOpen(entry, parentSessionId) }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() }
    if (event.key === 'ArrowRight' && canExpand && !isExpanded) { event.preventDefault(); onToggle(entry, parentSessionId) }
    if (event.key === 'ArrowLeft' && isExpanded) { event.preventDefault(); onToggle(entry, parentSessionId) }
  }
  const hint = isExternal(entry) ? t('externalHint') : entry.mode === 'unknown' ? t('unknownHint') : undefined
  return <div className={css.node}>
    <div role="treeitem" tabIndex={isExternal(entry) ? -1 : 0} aria-level={level} aria-current={current || undefined} aria-disabled={isExternal(entry) || removed || undefined} aria-expanded={canExpand ? isExpanded : undefined} aria-label={[label, secondary, metrics].filter(Boolean).join(' ')} className={css.row} onClick={open} onKeyDown={onKeyDown}>
      {canExpand ? <button type="button" tabIndex={-1} className={`${css.disclosure} ${isExpanded ? css.disclosureOpen : ''}`} aria-label={t(isExpanded ? 'collapse' : 'expand', { label })} onClick={toggle}><span>›</span></button> : <span className={css.disclosureSpace} />}
      <span className={`${css.activity} ${activity === 'running' ? css.activityRunning : ''}`} aria-hidden="true">{activity === 'running' ? '●' : '○'}</span>
      <span className={css.clickarea}><span className={`${css.content} ${current ? css.currentLabel : ''}`}><span className={css.label}>{label}</span><span className={css.summary}>{secondary}</span></span>{metrics !== '' && <span className={css.metrics}>{metrics}</span>}</span>
      {!current && !isExternal(entry) && !removed && <button type="button" className={css.sidebarButton} aria-label={t('openSidebar')} onClick={event => { event.preventDefault(); event.stopPropagation(); onSidebar(entry, parentSessionId) }}>↗</button>}
      {!current && localMode && !removed && <button type="button" className={css.removeButton} disabled={removing || !canRemove} aria-label={t('remove', { label })} onClick={event => { event.preventDefault(); event.stopPropagation(); onRemove(entry, parentSessionId) }}>{removingState ? '…' : t('removeShort')}</button>}
      {removed && <span className={css.removed}>{t('removedState')}</span>}
    </div>
    {hint !== undefined && <div className={css.unsupported}>{hint}</div>}
    {isExpanded && childCatalog !== undefined && <div className={css.nodeChildren} role="group">
      {childCatalog.state === 'loading' && <div className={css.notice}>{t('loading')}</div>}
      {childCatalog.state === 'error' && <div className={css.error}>{t('loadFailed', { message: childCatalog.error ?? 'unknown error' })}</div>}
      {childCatalog.state === 'ready' && childCatalog.entries.map(child => <CatalogRow key={child.id} entry={child} parentSessionId={entry.id} currentSessionId={currentSessionId} level={level + 1} data={data} expanded={expanded} onToggle={onToggle} onOpen={onOpen} onSidebar={onSidebar} onRemove={onRemove} removing={removing} t={t} />)}
      {childCatalog.state === 'ready' && childCatalog.entries.length === 0 && <div className={css.notice}>{t('noChildren')}</div>}
      {childCatalog.retirement.state !== 'ready' && <div className={css.error}>{t('removeStateError', { message: childCatalog.retirement.error ?? 'unknown error' })}</div>}
    </div>}
  </div>
}

function treeItems(root: HTMLDivElement | null): HTMLElement[] {
  return root === null ? [] : Array.from(root.querySelectorAll('[role="treeitem"]:not([aria-disabled="true"])')) as HTMLElement[]
}

function CatalogDropdown(runtime: Runtime & { rootSessionId: SessionId; currentSessionId?: SessionId; displayTitle?: string; openTitle?: () => void; variant: 'count' | 'switcher' }) {
  const t = runtime.t
  const data = useCatalogData(runtime, runtime.rootSessionId)
  const [open, setOpen] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const [confirmTarget, setConfirmTarget] = React.useState<{ entry: CatalogEntry; parentId: SessionId } | null>(null)
  const [removing, setRemoving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState<{ top: number; left: number } | undefined>(undefined)
  const catalog = data.catalogFor(runtime.rootSessionId)
  const direct = catalog.entries
  const running = direct.filter(entry => (data.statuses.get(entry.id)?.running ?? data.summaries[entry.id]?.running) === true).length
  const title = runtime.currentSessionId === undefined ? runtime.displayTitle : data.summaries[runtime.currentSessionId]?.title ?? runtime.displayTitle ?? runtime.currentSessionId
  const computePosition = () => {
    const trigger = triggerRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const menu = menuRef.current?.getBoundingClientRect()
    const width = Math.min(390, window.innerWidth - 32)
    const height = menu?.height ?? Math.min(600, window.innerHeight - 96)
    setPosition({ top: Math.max(12, Math.min(rect.bottom + 5, window.innerHeight - height - 12)), left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) })
  }
  const close = (restore = false) => { setOpen(false); setPosition(undefined); setExpanded(new Set()); if (restore) queueMicrotask(() => triggerRef.current?.focus()) }
  const openMenu = () => { setOpen(true); queueMicrotask(computePosition) }
  React.useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close() }
    const place = () => computePosition()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return }
      if (!menuRef.current || (document.activeElement !== triggerRef.current && !menuRef.current.contains(document.activeElement))) return
      const items = treeItems(menuRef.current)
      const index = items.indexOf(document.activeElement as HTMLElement)
      let next = -1
      if (event.key === 'ArrowDown') next = index < 0 ? 0 : index + 1
      if (event.key === 'ArrowUp') next = index < 0 ? items.length - 1 : index - 1
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = items.length - 1
      if (next >= 0 && items.length > 0) { event.preventDefault(); items[(next + items.length) % items.length]?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    queueMicrotask(place)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open])
  const openEntry = (entry: CatalogEntry, parentId: SessionId) => { if (isExternal(entry)) return; runtime.openChild({ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode }); close() }
  const openAside = (entry: CatalogEntry, parentId: SessionId) => { if (isExternal(entry)) return; runtime.openChildAside({ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode }); close() }
  const toggle = (entry: CatalogEntry) => { setExpanded(current => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else { next.add(entry.id); if (data.catalogFor(entry.id).state !== 'ready') void runtime.refreshProjection(entry.id) } return next }) }
  const remove = (entry: CatalogEntry, parentId: SessionId) => { setError(null); setConfirmTarget({ entry, parentId }) }
  const confirm = async () => {
    if (confirmTarget === null) return
    setRemoving(true); setError(null)
    try { await runtime.removeSubagent(runtime.rootSessionId, confirmTarget.entry.id); setConfirmTarget(null); await Promise.resolve(runtime.refreshProjection(runtime.rootSessionId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setRemoving(false) }
  }
  const statusProblem = catalog.retirement.state !== 'ready' ? catalog.retirement.error ?? 'retirement projection unavailable' : undefined
  const triggerLabel = runtime.variant === 'switcher' ? title : running > 0 ? t(running === 1 ? 'runningOne' : 'runningMany', { count: running }) : t(direct.length === 1 ? 'countOne' : 'countMany', { count: direct.length })
  if (runtime.variant === 'count' && catalog.state === 'ready' && direct.length === 0) return null
  return <div className={css.root} ref={rootRef}>
    {runtime.variant === 'switcher' && runtime.openTitle !== undefined ? <>
      <button type="button" className={css.switcherTitleButton} onClick={runtime.openTitle}>{triggerLabel}</button>
      <button type="button" ref={triggerRef} className={css.switcherMenuButton} aria-haspopup="tree" aria-expanded={open} aria-label={t('trigger')} onClick={() => open ? close() : openMenu()}><span className={`${css.icon} ${open ? css.iconOpen : ''}`}>⌄</span></button>
    </> : <button type="button" ref={triggerRef} className={runtime.variant === 'switcher' ? css.switcherTrigger : css.trigger} aria-haspopup="tree" aria-expanded={open} aria-label={t('trigger')} onClick={() => open ? close() : openMenu()}><span className={css.triggerLabel}>{triggerLabel}</span><span className={`${css.icon} ${open ? css.iconOpen : ''}`}>⌄</span></button>}
    {open && position !== undefined && createPortal(<div className={css.menu} ref={menuRef} style={position} role="tree" aria-label={t('trigger')}>
      <div className={css.menuBody}>
        {confirmTarget !== null && <div className={css.confirmRemove} role="group" aria-label={t('confirmRemove', { label: confirmTarget.entry.label ?? confirmTarget.entry.id })}>
          <strong>{t('confirmRemove', { label: confirmTarget.entry.label ?? confirmTarget.entry.id })}</strong>
          <p>{t('removeHintPlain')}</p><p>{t('removeHintTeam')}</p>
          <div className={css.confirmActions}><button type="button" disabled={removing} onClick={() => setConfirmTarget(null)}>{t('removeCancel')}</button><button type="button" className={css.removeButton} disabled={removing || statusProblem !== undefined} onClick={confirm}>{t(removing ? 'removing' : 'removeConfirm')}</button></div>
        </div>}
        {error !== null && <div className={css.error} role="alert">{t('removeFailed', { message: error })}</div>}
        {statusProblem !== undefined && <div className={css.error} role="alert">{t('removeStateError', { message: statusProblem })}<button type="button" className={css.retry} onClick={() => { void runtime.refreshProjection(runtime.rootSessionId) }}>{t('retry')}</button></div>}
        {catalog.state === 'loading' && <div className={css.notice}>{t('loading')}</div>}
        {catalog.state === 'unavailable' && <div className={css.error}>{t('unavailable')}<button type="button" className={css.retry} onClick={() => { void runtime.refreshProjection(runtime.rootSessionId) }}>{t('retry')}</button></div>}
        {catalog.state === 'error' && <div className={css.error}>{t('loadFailed', { message: catalog.error ?? 'unknown error' })}<button type="button" className={css.retry} onClick={() => { void runtime.refreshProjection(runtime.rootSessionId) }}>{t('retry')}</button></div>}
        {catalog.state === 'ready' && direct.length === 0 && <div className={css.notice}>{t('noChildren')}</div>}
        {catalog.state === 'ready' && direct.map(entry => <CatalogRow key={entry.id} entry={entry} parentSessionId={runtime.rootSessionId} currentSessionId={runtime.currentSessionId} level={1} data={data} expanded={expanded} onToggle={(item) => toggle(item)} onOpen={openEntry} onSidebar={openAside} onRemove={remove} removing={removing} t={t} />)}
      </div>
    </div>, document.body)}
  </div>
}

export interface SubagentCatalogActionProps extends Runtime {}
export function SubagentCatalogAction(props: SubagentCatalogActionProps) {
  const isChild = props.useSessions(state => state.byId?.[props.sessionId]?.origin === 'subagent')
  if (isChild) return null
  return <CatalogDropdown {...props} rootSessionId={props.sessionId} variant="count" />
}

export interface SubagentHeaderLineageProps extends Runtime {}
export function SubagentHeaderLineage(props: SubagentHeaderLineageProps) {
  const address = props.useSession(snapshot => snapshot.subagent?.address)
  const sessions = props.useSessions(state => state)
  const lineageId = props.lineageSessionId ?? props.sessionId
  const parentId = (address?.childSessionId === lineageId ? address.parentSessionId : undefined) ?? Object.entries(sessions.projectionsBySession ?? {}).find(([, snapshot]) => (snapshot.values?.subagentCatalog ?? []).some((entry: CatalogEntry) => entry.id === lineageId))?.[0] ?? (sessions.byId?.[lineageId]?.origin === 'subagent' ? sessions.byId?.[lineageId]?.parentId : undefined)
  if (parentId === undefined) return null
  return <><CatalogDropdown {...props} rootSessionId={parentId} currentSessionId={lineageId} displayTitle={props.displayTitle} openTitle={props.openTitle} variant="switcher" />{props.openTitle === undefined && <CatalogDropdown {...props} rootSessionId={lineageId} currentSessionId={lineageId} variant="count" />}</>
}

export { NS }

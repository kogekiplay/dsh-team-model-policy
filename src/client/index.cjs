/** A task-board enhancement. Uses projection selectors, React and native commands only. */
'use strict'
const React = require('react')
const { useRef, useState } = React
const { NS, zh, en } = require('./locale.cjs')
const styles = require('./styles.cjs')
const h = React.createElement
const SLOT = 'conversation.session.header.actions.subagent.footer'

/** Capture one rendered revision and prevent double submission before React commits. */
function createRemovalAction(remove, task, onChange) {
  let busy = false
  return async () => {
    if (busy || task.status !== 'completed') return
    busy = true; onChange({ busy: true, error: null, removed: false })
    try { await remove(task.id, task.revision); onChange({ busy: false, error: null, removed: true }) }
    catch (error) { onChange({ busy: false, error: typeof error?.message === 'string' ? error.message : String(error), removed: false }) }
    finally { busy = false }
  }
}

function TaskRow({ task, t, remove }) {
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState({ busy: false, error: null, removed: false })
  const action = useRef(null)
  // A fresh render must never replace the in-flight guard.
  if (action.current === null || !action.current.busy) {
    const current = { busy: false, revision: task.revision }
    current.run = createRemovalAction(remove, { ...task }, next => { current.busy = next.busy; setState(next) })
    action.current = current
  }
  if (state.removed) return null
  const label = t('status.' + task.status)
  return h('li', { className: 'dtc-task', 'data-team-task': task.id, 'data-status': task.status },
    h('div', { className: 'dtc-row' },
      h('button', { type: 'button', className: 'dtc-expand', 'aria-expanded': expanded,
        onClick: () => setExpanded(value => !value), title: task.subject },
        h('span', { className: 'dtc-dot dtc-dot-' + task.status, role: 'img', 'aria-label': label }),
        h('span', { className: expanded ? 'dtc-subject dtc-subject-expanded' : 'dtc-subject' }, task.subject),
        h('span', { className: 'dtc-chevron', 'aria-hidden': true }, expanded ? '⌃' : '⌄')),
      task.status === 'completed' && remove && h('button', {
        type: 'button', className: 'dtc-remove', disabled: state.busy,
        'aria-label': t('removeAria', { id: task.id }), onClick: () => { void action.current.run() },
      }, t(state.busy ? 'removing' : 'remove'))),
    expanded && h('div', { className: 'dtc-details' },
      task.description && h('p', null, task.description),
      h('p', null, task.id + ' · ' + label + ' · ' + t('owner') + ': ' + (task.ownerName ?? task.ownerId ?? t('unowned'))),
      task.blockedBy?.length > 0 && h('p', null, t('blockedBy') + ': ' + task.blockedBy.join(', '))),
    state.error && h('div', { className: 'dtc-error', role: 'alert' }, state.error))
}

function CompletedTaskBoard({ sessionId, useProjection, useAccess, removeCompletedTask, t }) {
  const team = useProjection('agentTeam')
  const writable = useAccess('commands.execute')
  if (!team?.enabled) return null
  const tasks = team.tasks.filter(task => task.status !== 'deleted')
  if (tasks.length === 0 && !team.failure) return null
  const completed = tasks.filter(task => task.status === 'completed').length
  const remove = writable ? (id, revision) => removeCompletedTask(sessionId, id, revision) : undefined
  return h('section', { className: 'dtc-board', 'aria-label': t('title'), 'data-completed-task-cleanup': true },
    h('style', null, styles),
    h('h3', { className: 'dtc-header' }, h('span', null, t('title')), h('small', null, t('progress', { completed, total: tasks.length }))),
    team.failure && h('div', { className: 'dtc-error', role: 'alert' }, team.failure),
    h('ul', { className: 'dtc-tasks' }, tasks.map(task => h(TaskRow, { key: task.id, task, t, remove }))))
}

const inject = ['slots', 'locale', 'remote', 'remote.commands', 'sessions']
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }))
  ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
    name: SLOT, id: 'agent-team', priority: -1, locale: NS,
    inject: () => ({
      async removeCompletedTask(sessionId, taskId, revision) {
        const response = await ctx.remote.commands.execute(sessionId, '/team-task-remove ' + taskId + ' ' + revision, [])
        if (!response.ok) throw new Error(response.error.message)
        if (response.value?.result?.kind !== 'success') throw new Error(response.value?.result?.text ?? ctx.locale.bind(NS)('unavailable'))
        // The log-backed projection updates the board; a refresh failure must not imply the deletion failed.
        try { await ctx.sessions.refreshProjections(sessionId) } catch (_) { /* the next native projection publication reconciles it */ }
      },
    }),
  }, CompletedTaskBoard)))
}
module.exports = { inject, apply, createRemovalAction, CompletedTaskBoard }

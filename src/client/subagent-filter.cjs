'use strict'

/**
 * Validate one projection collection. An empty Team collection is valid when
 * the catalog has no Team ancestor; an empty ordinary-subagent collection is
 * missing the root's required retirement state.
 * @param {unknown} states
 * @param {boolean} required
 * @returns {{ state: 'ready'|'unavailable'|'error', rows: object[], error?: string }}
 */
function validateStates(states, required) {
  if (!Array.isArray(states) || (required && states.length === 0)) {
    return { state: 'unavailable', rows: [], error: 'retirement projection unavailable' }
  }
  const rows = []
  for (const state of states) {
    if (state?.failure !== undefined) return { state: 'error', rows, error: String(state.failure) }
    if (state === undefined || state === null || !Array.isArray(state.members)) {
      return { state: 'error', rows, error: 'invalid retirement projection' }
    }
    if (state.failure !== undefined) return { state: 'error', rows, error: String(state.failure) }
    rows.push(state)
  }
  return { state: 'ready', rows }
}

/**
 * Filter a catalog using committed ordinary-subagent and Team retirement
 * projections. Missing/corrupt projections preserve navigation rows while
 * disabling destructive actions in the caller.
 * @param {readonly object[]} entries
 * @param {readonly object[]|undefined} retirementStates
 * @param {readonly object[]|undefined} teamStates
 * @returns {{ entries: object[], state: 'ready'|'unavailable'|'error', error?: string }}
 */
function filterCatalog(entries, retirementStates, teamStates) {
  if (!Array.isArray(entries)) return { entries: [], state: 'unavailable', error: 'subagent catalog unavailable' }
  const retirement = validateStates(retirementStates, true)
  const teams = validateStates(teamStates, false)
  if (retirement.state !== 'ready') return { entries: [...entries], state: retirement.state, error: retirement.error }
  if (teams.state !== 'ready') return { entries: [...entries], state: teams.state, error: teams.error }

  const retirementById = new Map()
  for (const state of retirement.rows) for (const row of state.members) retirementById.set(row.id, row)
  const teamById = new Map()
  for (const state of teams.rows) for (const row of state.members) teamById.set(row.id, row)
  return {
    entries: entries.filter(entry => retirementById.get(entry.id)?.phase !== 'removed' && teamById.get(entry.id)?.phase !== 'removed'),
    state: 'ready',
  }
}

function retirementFor(id, retirementStates, teamStates) {
  const retirement = validateStates(retirementStates, true)
  const teams = validateStates(teamStates, false)
  if (retirement.state !== 'ready') return { state: retirement.state, error: retirement.error, row: undefined, kind: undefined }
  if (teams.state !== 'ready') return { state: teams.state, error: teams.error, row: undefined, kind: undefined }
  for (const state of retirement.rows) {
    const row = state.members.find(member => member.id === id)
    if (row !== undefined) return { state: 'ready', row, kind: 'subagent' }
  }
  for (const state of teams.rows) {
    const row = state.members.find(member => member.id === id)
    if (row !== undefined) return { state: 'ready', row, kind: 'team' }
  }
  return { state: 'ready', row: undefined, kind: undefined }
}

module.exports = { filterCatalog, retirementFor }

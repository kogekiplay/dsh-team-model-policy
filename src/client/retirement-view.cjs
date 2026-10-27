'use strict'

/** Filter native Team members using the committed host retirement projection. */
function visibleTeam(team, retirements) {
  if (team === undefined || retirements === undefined) return undefined
  const removed = new Set(retirements.members.filter(row => row.phase === 'removed').map(row => row.id))
  if (retirements.failure !== undefined) return { ...team, members: team.members.filter(member => !removed.has(member.id)), failure: retirements.failure }
  if (retirements.members.length === 0) return team
  const members = team.members.filter(member => !removed.has(member.id)).map(member => {
    const pending = retirements.members.find(row => row.id === member.id && row.phase === 'removing')
    return pending?.error === undefined ? member : { ...member, error: pending.error }
  })
  return { ...team, members }
}

module.exports = { visibleTeam }

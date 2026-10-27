/** Team model settings, using the Host-owned form and platform slot bindings. */
'use strict'
const { NAMESPACE, createTeamModelPolicyCard } = require('./card.cjs')
const { en, ja, zh } = require('./locale.cjs')
const { SettingsForm } = require('@deepseek-ai/dsh-client-ui-primitives')
const { createTeamModelPolicyView } = require('./view.cjs')
const TeamModelPolicyCard = createTeamModelPolicyView(SettingsForm)
const React = require('react')
const teamLocale = require('./team-locale.cjs')
const { TeamAction, styles: teamStyles } = require('./team-view.cjs')
function RetirementTeamAction(props) { return React.createElement(React.Fragment, null, React.createElement('style', null, teamStyles), React.createElement(TeamAction, props)) }
const NS = 'settings.teamModelPolicy'
const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.commands', 'configForms', 'sessions', 'uiWorkspace']
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, ja, zh }))
  ctx.effect(() => ctx.locale.register(teamLocale.NS, { en: teamLocale.en, zh: teamLocale.zh, ja: teamLocale.ja }))
  const scope = ctx.configForms.get(NAMESPACE)
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'agent-team', priority: -1, order: -20, locale: teamLocale.NS,
    inject: () => ({ openTeammate(sessionId, childSessionId) {
      if ((ctx.sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return
      const parentSessionId = ctx.sessions.binding(sessionId)?.session.getSnapshot().subagent?.address.parentSessionId ?? sessionId
      ctx.uiWorkspace.openSession(childSessionId === parentSessionId ? parentSessionId : { parentSessionId, childSessionId, mode: 'continuable' })
    }, async removeTeammate(sessionId, name) {
      const response = await ctx.remote.commands.execute(sessionId, '/team-remove ' + name, [])
      if (!response.ok) throw new Error(response.error.message)
      if (response.value?.result.kind !== 'success') throw new Error(response.value?.result.text ?? 'Team removal command is unavailable')
    } }),
  }, RetirementTeamAction)))
  const current = createTeamModelPolicyCard({ scope,
    readCatalog: () => ctx.remote.session.modelCatalog().then(response => response.ok ? response.value : undefined), t })
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { void current.refreshCatalog() }))
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { void current.refreshCatalog() }))
  ctx.effect(() => ctx.on('connection/reset', () => { void current.refreshCatalog() }))
  ctx.effect(() => () => { current.dispose() })
  ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'team-model-policy', order: 60, label: () => t('navTitle'), locale: NS,
    inject: () => ({ hooks: { teamModelPolicyCard: current }, edit: (field, text) => current.edit(field, text),
      setMode: mode => current.setMode(mode), resetField: field => current.resetField(field),
      save: () => { void current.save() }, discard: () => current.discard(), retryCatalog: () => { void current.refreshCatalog() } }),
  }, TeamModelPolicyCard))))
}
module.exports = { inject, apply }

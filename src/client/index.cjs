/** Team model settings, using the Host-owned form and platform slot bindings. */
'use strict'
const { NAMESPACE, createTeamModelPolicyCard } = require('./card.cjs')
const { en, ja, zh } = require('./locale.cjs')
const { TeamModelPolicyCard } = require('./view.cjs')
const NS = 'settings.teamModelPolicy'
const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, ja, zh }))
  const scope = ctx.configForms.get(NAMESPACE)
  const current = createTeamModelPolicyCard({ scope,
    readCatalog: () => ctx.remote.session.modelCatalog().then(response => response.ok ? response.value : undefined), t })
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { void current.refreshCatalog() }))
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { void current.refreshCatalog() }))
  ctx.effect(() => ctx.on('connection/reset', () => { void current.refreshCatalog() }))
  ctx.effect(() => () => { current.dispose() })
  ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: NAMESPACE, order: 40, label: () => t('navTitle'), locale: NS,
    inject: () => ({ hooks: { teamModelPolicyCard: current }, edit: (field, text) => current.edit(field, text),
      setMode: mode => current.setMode(mode), resetField: field => current.resetField(field),
      save: () => { void current.save() }, discard: () => current.discard(), retryCatalog: () => { void current.refreshCatalog() } }),
  }, TeamModelPolicyCard))))
}
module.exports = { inject, apply }

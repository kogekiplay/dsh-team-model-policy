/** Team policy controls; the shared SettingsForm owns save status and its action. */
'use strict'
const React = require('react')
const css = require('./styles.cjs')
const h = React.createElement

function Field(props) {
  return h('div', { className: 'dtmp-field', 'data-field': props.id },
    h('div', { className: 'dtmp-field-head' },
      h('label', { className: 'dtmp-label', htmlFor: props.id }, props.label),
      props.overridden ? h('button', { className: 'dtmp-reset', type: 'button', disabled: props.disabled,
        onClick: props.onReset, 'data-reset': props.id }, props.resetLabel) : null),
    props.children(props.disabled),
    h('p', { className: 'dtmp-hint', id: props.id + '-hint' }, props.hint))
}

function Choice(props) {
  return h('div', { className: 'dtmp-field-control' }, h('select', {
    className: 'dtmp-select', id: props.id, value: props.value, disabled: props.disabled,
    'aria-describedby': props.id + '-hint', onChange: event => props.onChange(event.target.value),
  }, h('option', { value: '' }, props.emptyLabel),
  ...props.options.map(option => h('option', { key: option.id, value: option.id }, option.name))))
}

/** Bind the platform-owned form without bundling a second copy of its styles. */
function createTeamModelPolicyView(SettingsForm) {
  return function TeamModelPolicyCard(props) {
    const { t } = props
    const state = props.useTeamModelPolicyCard(snapshot => snapshot)
    if (props.view === 'summary') return t('summary')
    const disabled = !state.writable || state.saving
    const follow = state.mode === 'follow-subagent'
    const modeCard = (value, title, description) => h('label', { key: value, className: 'dtmp-mode' },
      h('input', { type: 'radio', name: 'team-model-policy-mode', value, checked: state.mode === value,
        disabled, onChange: () => props.setMode(value) }),
      h('span', { className: 'dtmp-mode-title' }, t(title)),
      h('span', { className: 'dtmp-description' }, t(description)))
    const field = (key, id, label, hint, emptyLabel, value, options) => h(Field, {
      key, id, label: t(label), hint: t(hint), disabled, overridden: state.fields[key].overridden,
      resetLabel: t('reset'), onReset: () => props.resetField(key),
    }, blocked => h(Choice, { id, value, options, emptyLabel: t(emptyLabel), disabled: blocked,
      onChange: next => {
        props.edit(key, next)
        if (key === 'provider' && next !== state.provider.text) {
          props.edit('model', '')
          props.edit('reasoningEffort', '')
        }
      } }))
    return h('section', { className: 'dtmp', 'data-team-model-policy': state.mode,
      'data-save-state': state.saving ? 'saving' : state.dirty ? 'dirty' : 'saved', 'aria-busy': state.saving },
      h('style', null, css),
      h(SettingsForm, { state: { ...state, invalid: state.invalid || !state.writable },
        labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
        onSave: props.save, onDiscard: props.discard },
      h('div', { className: 'dtmp-body' },
        h('h3', { className: 'dtmp-heading', id: 'team-model-policy-heading' }, t('modeLabel')),
        h('div', { className: 'dtmp-modes', role: 'radiogroup', 'aria-labelledby': 'team-model-policy-heading' },
          modeCard('follow-subagent', 'modeFollow', 'modeFollowHint'), modeCard('fixed', 'modeFixed', 'modeFixedHint')),
        follow ? h('div', { className: 'dtmp-default', 'data-default-effort': state.defaultEffort },
          h('div', { className: 'dtmp-default-copy' },
            h('span', { className: 'dtmp-default-label' }, t('defaultEffortLabel')),
            h('p', { className: 'dtmp-default-hint' }, t('defaultEffortHint'))),
          h('code', { className: 'dtmp-effort-badge' }, state.defaultEffort))
        : h(React.Fragment, null,
            state.catalogStatus === 'loading' ? h('p', { className: 'dtmp-hint', role: 'status' }, t('loadingModels')) : null,
            state.catalogStatus === 'error' ? h('div', { className: 'dtmp-status', role: 'status' }, t('loadFailed'),
              h('button', { type: 'button', className: 'dtmp-reset', onClick: props.retryCatalog }, t('retry'))) : null,
            h('div', { className: 'dtmp-fields' },
              field('provider', 'team-model-policy-provider', 'providerLabel', 'providerHint', 'providerInherited', state.provider.text, state.provider.choices),
              field('model', 'team-model-policy-model', 'modelLabel', 'modelHint', 'modelInherited', state.model.text, state.model.choices),
              field('reasoningEffort', 'team-model-policy-effort', 'effortLabel', 'effortHint', 'effortDefault', state.effort.text, state.effort.choices))),
        state.required ? h('p', { className: 'dtmp-error', role: 'alert' }, state.required) : null)))
  }
}
module.exports = { createTeamModelPolicyView, Field, Choice }

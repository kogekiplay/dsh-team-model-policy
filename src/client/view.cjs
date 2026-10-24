/**
 * The card's React view, expressed with the client baseline primitives and DOM
 * elements only.
 *
 * The component receives the derived props the renderer binds for a
 * `plugins.item` contribution (`view`, `t`, `useTeamModelPolicyCard`) plus the
 * plain actions the inject face supplies; it reads no ctx and owns no
 * subscription. Every string comes from the locale dictionary.
 */

'use strict'

const React = require('react')
const { format } = require('./locale.cjs')
const h = React.createElement

/** Inline styles keeping this zero-CSS source dependency-free in the bundle. */
const styles = {
  form: { display: 'flex', flexDirection: 'column', gap: '16px' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
  field: { display: 'flex', flexDirection: 'column', gap: '4px' },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  label: { fontSize: '13px', fontWeight: 500 },
  hint: { margin: 0, fontSize: '12px', opacity: 0.72 },
  notice: { margin: 0, fontSize: '12px', opacity: 0.8 },
  error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-danger)' },
  actions: { display: 'flex', gap: '8px', alignItems: 'center' },
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  control: { font: 'inherit', width: '100%', minHeight: '44px', padding: '10px 12px', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
  badge: { fontSize: '11px', opacity: 0.72 },
}

/**
 * Render one labelled control with its override badge and reset.
 * @param {{ id: string, label: string, hint: string, disabled: boolean, overridden: boolean,
 *   invalid: boolean, overriddenLabel: string, resetLabel: string, children: object }} props
 * @returns The field row.
 */
function Field(props) {
  return h('div', { style: styles.field, 'data-field': props.id },
    h('div', { style: styles.head },
      h('label', { style: styles.label, htmlFor: props.id }, props.label),
      props.overridden === true
        ? h('span', { style: styles.badge }, props.overriddenLabel)
        : null,
      props.overridden === true
        ? h('button', {
          type: 'button',
          disabled: props.disabled,
          onClick: props.onReset,
          'data-reset': props.id,
        }, props.resetLabel)
        : null,
    ),
    props.children(props.disabled),
    props.invalid !== true && props.hint !== ''
      ? h('p', { style: styles.hint }, props.hint)
      : null,
  )
}

/**
 * A choice control over stored ids; an empty value selects the inherited/default entry.
 * @param {{ id: string, value: string, options: object[], emptyLabel: string, disabled: boolean,
 *   onChange: (value: string) => void }} props
 * @returns The select element.
 */
function Choice(props) {
  return h('select', {
    id: props.id,
    style: styles.control,
    value: props.value,
    disabled: props.disabled,
    onChange: event => { props.onChange(event.target.value) },
  },
  h('option', { value: '' }, props.emptyLabel),
  ...props.options.map(option => h('option', { key: option.id, value: option.id }, option.name)))
}

/**
 * Render the Team model policy settings card.
 * @param {object} props - `{ view, t, useTeamModelPolicyCard, edit, setMode, resetField, save, discard, retryCatalog }`.
 * @returns The one-liner for `summary`, otherwise the staged settings form.
 */
function TeamModelPolicyCard(props) {
  const t = props.t
  const text = (key, values) => format(t, key, values)
  const state = props.useTeamModelPolicyCard(snapshot => snapshot)
  if (props.view === 'summary') return t('summary')
  if (state.available !== true) {
    return h('p', { style: styles.notice, role: 'status' }, t('unavailable'))
  }
  const disabled = state.writable !== true || state.saving === true
  const follow = state.mode === 'follow-subagent'
  return h('div', { style: styles.form, 'data-team-model-policy': state.mode },
    state.writable === true ? null : h('p', { style: styles.notice, role: 'status' }, t('readOnly')),
    h('div', { style: styles.section },
      h('div', { style: styles.head }, h('span', { style: styles.label }, t('modeLabel'))),
      h('div', { style: styles.row, role: 'radiogroup', 'aria-label': t('modeLabel') },
        h('label', { style: styles.row },
          h('input', {
            type: 'radio',
            name: 'team-model-policy-mode',
            value: 'follow-subagent',
            checked: follow,
            disabled,
            onChange: () => { props.setMode('follow-subagent') },
          }),
          t('modeFollow')),
        h('label', { style: styles.row },
          h('input', {
            type: 'radio',
            name: 'team-model-policy-mode',
            value: 'fixed',
            checked: !follow,
            disabled,
            onChange: () => { props.setMode('fixed') },
          }),
          t('modeFixed')),
      ),
      follow
        ? h('div', { style: styles.section },
          h('p', { style: styles.notice }, t('modeFollowHint')),
          h('p', { style: styles.notice, 'data-default-effort': state.defaultEffort },
            text('defaultEffortHint', { effort: state.defaultEffort }),
          ),
        )
        : h('div', { style: styles.section },
          h('p', { style: styles.notice }, t('modeFixedHint')),
          state.catalogStatus === 'loading'
            ? h('p', { style: styles.notice, role: 'status' }, t('loadingModels'))
            : null,
          state.catalogStatus === 'error'
            ? h('div', { style: styles.error, role: 'alert' },
              h('span', null, t('loadFailed')),
              h('button', { type: 'button', onClick: props.retryCatalog }, t('retry')))
            : null,
          h(Field, {
            id: 'team-model-policy-provider',
            label: t('providerLabel'),
            hint: t('providerHint'),
            disabled,
            overridden: state.provider.overridden,
            invalid: state.fields.provider.invalid === true,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onReset: () => { props.resetField('provider') },
          }, isDisabled => h(Choice, {
            id: 'team-model-policy-provider',
            value: state.provider.text,
            options: state.provider.choices,
            emptyLabel: t('providerInherited'),
            disabled: isDisabled,
            onChange: next => { props.edit('provider', next) },
          })),
          h(Field, {
            id: 'team-model-policy-model',
            label: t('modelLabel'),
            hint: t('modelHint'),
            disabled,
            overridden: state.model.overridden,
            invalid: state.fields.model.invalid === true,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onReset: () => { props.resetField('model') },
          }, isDisabled => h(Choice, {
            id: 'team-model-policy-model',
            value: state.model.text,
            options: state.model.choices,
            emptyLabel: t('modelInherited'),
            disabled: isDisabled,
            onChange: next => { props.edit('model', next) },
          })),
          h(Field, {
            id: 'team-model-policy-effort',
            label: t('effortLabel'),
            hint: t('effortHint'),
            disabled,
            overridden: state.effort.overridden,
            invalid: state.fields.reasoningEffort.invalid === true,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onReset: () => { props.resetField('reasoningEffort') },
          }, isDisabled => h(Choice, {
            id: 'team-model-policy-effort',
            value: state.effort.text,
            options: state.effort.choices,
            emptyLabel: t('effortDefault'),
            disabled: isDisabled,
            onChange: next => { props.edit('reasoningEffort', next) },
          })),
        )),
    state.required !== undefined
      ? h('p', { style: styles.error, role: 'alert' }, state.required)
      : null,
    state.failed === true
      ? h('p', { style: styles.error, role: 'alert' }, t('saveFailed'))
      : null,
    h('div', { style: styles.actions },
      h('button', {
        type: 'button',
        disabled: disabled || state.dirty !== true || state.invalid === true,
        onClick: props.save,
        'data-save': 'team-model-policy',
      }, state.saving === true ? t('saving') : t('save')),
      h('button', {
        type: 'button',
        disabled: disabled || state.dirty !== true,
        onClick: props.discard,
      }, t('discard')),
    ),
  )
}

module.exports = { TeamModelPolicyCard, Field, Choice }

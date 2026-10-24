/**
 * Typed dictionary for the Team model policy card.
 *
 * The Host's locale service requires both baseline languages when a namespace
 * registers, so every non-dictionary export below is checked against the
 * English key set at module load: a missing or extra key throws instead of
 * rendering an undefined label.
 */

'use strict'

/** Every key the card renders. */
const KEYS = [
  'navTitle',
  'summary',
  'modeLabel',
  'modeFollow',
  'modeFixed',
  'modeFollowHint',
  'modeFixedHint',
  'defaultEffortLabel',
  'defaultEffortHint',
  'defaultEffortMax',
  'providerLabel',
  'providerHint',
  'providerInherited',
  'modelLabel',
  'modelHint',
  'modelInherited',
  'effortLabel',
  'effortHint',
  'effortDefault',
  'loadingModels',
  'loadFailed',
  'retry',
  'requiredProvider',
  'requiredModel',
  'overridden',
  'reset',
  'discard',
  'readOnly',
  'unavailable',
  'save',
  'saving',
  'saveFailed',
  'catalogRejected',
]

/** English copy. */
const en = {
  navTitle: 'Team model',
  summary: 'Choose whether named teammates follow the subagent model settings or use one fixed route.',
  modeLabel: 'Route mode',
  modeFollow: 'Follow subagent model settings',
  modeFixed: 'Fixed model',
  modeFollowHint: 'Teammates inherit the session authorization of ordinary subagents; the Lead picks the model per member.',
  modeFixedHint: 'Every named teammate uses the route below on its next request; the Lead keeps its own model.',
  defaultEffortLabel: 'Default reasoning effort',
  defaultEffortHint: 'Teammates created in follow mode use {effort} when no reasoning effort is given. A model that does not support it fails the request visibly.',
  defaultEffortMax: 'max',
  providerLabel: 'Provider',
  providerHint: 'Provider id registered in this deployment.',
  providerInherited: 'Composition default',
  modelLabel: 'Model',
  modelHint: 'Model id the provider interprets.',
  modelInherited: 'Composition default',
  effortLabel: 'Reasoning effort',
  effortHint: 'Leave blank to use the model default.',
  effortDefault: 'Model default',
  loadingModels: 'Loading models…',
  loadFailed: 'The model list could not be loaded.',
  retry: 'Retry',
  requiredProvider: 'A fixed route needs a provider.',
  requiredModel: 'A fixed route needs a model.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  discard: 'Discard changes',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  catalogRejected: 'The model catalog was refused.',
}

/** Simplified Chinese copy. */
const zh = {
  navTitle: '团队模型',
  summary: '选择命名的队友跟随子智能体模型设置，还是统一使用固定路由。',
  modeLabel: '路由模式',
  modeFollow: '跟随子智能体模型设置',
  modeFixed: '固定模型',
  modeFollowHint: '队友沿用普通子智能体的会话授权，由 Lead 逐个成员选择模型。',
  modeFixedHint: '每个命名队友的下一次请求都使用下方路由；Lead 保持自己的模型。',
  defaultEffortLabel: '默认推理强度',
  defaultEffortHint: '跟随模式下新建的队友在未显式指定推理强度时使用 {effort}；模型不支持时会请求失败并明确报错。',
  defaultEffortMax: 'max',
  providerLabel: '提供方',
  providerHint: '本部署已注册的 provider id。',
  providerInherited: '跟随配置默认值',
  modelLabel: '模型',
  modelHint: '由 provider 解释的模型 id。',
  modelInherited: '跟随配置默认值',
  effortLabel: '推理强度',
  effortHint: '留空表示使用模型默认值。',
  effortDefault: '模型默认',
  loadingModels: '正在加载模型…',
  loadFailed: '模型列表加载失败。',
  retry: '重试',
  requiredProvider: '固定模型必须填写提供方。',
  requiredModel: '固定模型必须填写模型。',
  overridden: '已覆盖',
  reset: '恢复默认',
  discard: '放弃修改',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  catalogRejected: '模型目录未被接受。',
}

/** Japanese copy. */
const ja = {
  navTitle: 'チームモデル',
  summary: '名前付きチームメイトがサブエージェントのモデル設定に従うか、固定ルートを使うかを選びます。',
  modeLabel: 'ルートモード',
  modeFollow: 'サブエージェントのモデル設定に従う',
  modeFixed: '固定モデル',
  modeFollowHint: 'チームメイトは通常のサブエージェントのセッション認可を引き継ぎ、Lead がメンバーごとにモデルを選びます。',
  modeFixedHint: '名前付きチームメイトの次のリクエストは下のルートを使います。Lead は自分のモデルを保ちます。',
  defaultEffortLabel: '既定の推論強度',
  defaultEffortHint: 'フォローモードで作成したチームメイトは、推論強度の指定がない場合に {effort} を使います。モデルが対応していない場合はリクエストが失敗し、エラーが表示されます。',
  defaultEffortMax: 'max',
  providerLabel: 'プロバイダー',
  providerHint: 'この配備に登録されたプロバイダー id。',
  providerInherited: '構成のデフォルト',
  modelLabel: 'モデル',
  modelHint: 'プロバイダーが解釈するモデル id。',
  modelInherited: '構成のデフォルト',
  effortLabel: '推論強度',
  effortHint: '空欄の場合はモデルのデフォルトを使います。',
  effortDefault: 'モデルのデフォルト',
  loadingModels: 'モデルを読み込み中…',
  loadFailed: 'モデル一覧を読み込めませんでした。',
  retry: '再試行',
  requiredProvider: '固定ルートにはプロバイダーが必要です。',
  requiredModel: '固定ルートにはモデルが必要です。',
  overridden: '上書き済み',
  reset: 'デフォルトに戻す',
  discard: '変更を破棄',
  readOnly: 'この配備では設定は読み取り専用です。',
  unavailable: 'このプラグインは読み込まれていないため、設定できません。',
  save: '保存',
  saving: '保存中…',
  saveFailed: 'この配備は値を受け付けませんでした。修正できるよう残しています。',
  catalogRejected: 'モデル一覧が拒否されました。',
}

/**
 * Fail loudly when a translation drifts from the English keys.
 * @param {string} id - locale id.
 * @param {Record<string, string>} dict - the dictionary to check.
 */
function assertComplete(id, dict) {
  for (const key of KEYS) {
    if (typeof dict[key] !== 'string' || dict[key] === '') {
      throw new Error('team-model-policy locale ' + id + ' is missing key ' + key)
    }
  }
  for (const key of Object.keys(dict)) {
    if (!KEYS.includes(key)) throw new Error('team-model-policy locale ' + id + ' has unknown key ' + key)
  }
}

for (const [id, dict] of Object.entries({ en, ja, zh })) assertComplete(id, dict)

/**
 * Build a translator over the registered dictionaries with English as the fallback.
 * @param {string} active - the active locale id, such as `zh` or `ja`.
 * @returns {(key: string) => string} the translator.
 */
function createTranslator(active) {
  const dict = active === 'zh' ? zh : active === 'ja' ? ja : en
  return key => (typeof dict[key] === 'string' ? dict[key] : key)
}

/**
 * Read one copy value and substitute its `{name}` placeholders.
 * @param {(key: string) => string} t - the translator.
 * @param {string} key - dictionary key.
 * @param {Record<string, string>} values - placeholder values.
 * @returns The rendered copy.
 */
function format(t, key, values) {
  return t(key).replace(/\{(\w+)\}/g, (whole, name) => (typeof values[name] === 'string' ? values[name] : whole))
}

module.exports = { KEYS, en, ja, zh, createTranslator, format }

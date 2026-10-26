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
  'defaultEffortHigh',
  'defaultEffortMedium',
  'defaultEffortLow',
  'defaultEffortOff',
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
  modeLabel: 'Model policy',
  modeFollow: 'Follow subagent model settings',
  modeFixed: 'Fixed model',
  modeFollowHint: 'The Lead chooses a model for each teammate from the authorized subagent models.',
  modeFixedHint: 'Use one model and reasoning effort for all teammates.',
  defaultEffortLabel: 'Default reasoning effort',
  defaultEffortHint: 'Used when the Lead leaves effort unspecified. Unsupported effort reports an error.',
  defaultEffortMax: 'Max (default)',
  defaultEffortHigh: 'High',
  defaultEffortMedium: 'Medium',
  defaultEffortLow: 'Low',
  defaultEffortOff: 'Off',
  providerLabel: 'Provider',
  providerHint: 'Choose an available model provider.',
  providerInherited: 'Choose a value',
  modelLabel: 'Model',
  modelHint: 'Model and effort changes apply to the next request.',
  modelInherited: 'Choose a value',
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
  modeLabel: '模型策略',
  modeFollow: '跟随子智能体模型设置',
  modeFixed: '固定模型',
  modeFollowHint: '由 Lead 从已授权的子智能体模型中，为每名队友单独选择。',
  modeFixedHint: '所有队友统一使用下方模型和推理强度。',
  defaultEffortLabel: '默认推理强度',
  defaultEffortHint: 'Lead 未指定时使用此强度；模型不支持时明确报错。',
  defaultEffortMax: '最高（max，默认）',
  defaultEffortHigh: '高（high）',
  defaultEffortMedium: '中（medium）',
  defaultEffortLow: '低（low）',
  defaultEffortOff: '关闭思考（off）',
  providerLabel: '提供方',
  providerHint: '选择已配置的模型提供方。',
  providerInherited: '请选择',
  modelLabel: '模型',
  modelHint: '模型和强度变更从下一次请求生效。',
  modelInherited: '请选择',
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
  defaultEffortHint: 'Lead が推論強度を指定しない場合に使います。非対応のモデルではエラーを表示します。',
  defaultEffortMax: '最大（max、既定）',
  defaultEffortHigh: '高（high）',
  defaultEffortMedium: '中（medium）',
  defaultEffortLow: '低（low）',
  defaultEffortOff: '推論なし（off）',
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

'use strict'
const NS = 'completedTeamTaskCleanup'
const zh = {
  title: '共享任务', progress: '已完成 {completed} / {total}',
  'status.pending': '待处理', 'status.in_progress': '进行中', 'status.completed': '已完成',
  remove: '移除', removing: '移除中…', removeAria: '移除已完成任务 {id}',
  owner: '负责人', unowned: '未分配', blockedBy: '依赖',
  unavailable: '任务移除命令未加载，请检查插件状态。',
}
const en = {
  title: 'Shared tasks', progress: '{completed} / {total} completed',
  'status.pending': 'Pending', 'status.in_progress': 'In progress', 'status.completed': 'Completed',
  remove: 'Remove', removing: 'Removing…', removeAria: 'Remove completed task {id}',
  owner: 'Owner', unowned: 'Unassigned', blockedBy: 'Depends on',
  unavailable: 'The task removal command is unavailable. Check the plugin status.',
}
module.exports = { NS, zh, en }

/**
 * Central typed message-key registry (auftrag §0.9).
 * Every key used via t() / useTranslations must appear here.
 * Keys are the dotted paths into messages/*.json.
 */
export const MESSAGE_KEYS = [
  "app.title",
  "app.chat",
  "app.projects",
  "app.connectors",
  "app.metrics",
  "app.playbooks",
  "app.queueSmoke",
  "app.newChat",
  "app.send",
  "app.themeLight",
  "app.themeDark",
  "app.themeSystem",
  "app.playbookSlug",
  "app.saveOverride",
  "app.activeOverrides",
  "app.resetOverride",
  "chat.empty",
  "chat.placeholder",
  "chat.toolRunning",
  "chat.toolCompleted",
  "chat.approvalRequired",
  "chat.approve",
  "chat.deny",
  "chat.approvalHashHint",
  "chat.costEstimate",
  "chat.resolvedValues",
  "chat.waitingApproval",
  "progress.echo_step",
  "progress.metric_snapshot_window",
  "progress.meta_report_progress",
  "progress.insight_page_fetched",
  "progress.insight_sync_completed",
  "progress.late_write_attempt",
  "progress.turn_phase",
  "progress.waiting_approval",
  "errors.insufficient_data",
  "errors.below_minimum_spend",
  "errors.token_expired",
  "errors.unauthenticated",
  "errors.not_found",
  "errors.validation_error",
  "errors.idempotency_conflict",
  "errors.approval_not_decidable",
  "errors.playbook_missing",
  "errors.export_disabled",
  "errors.forbidden",
  "errors.account_not_selected",
  "errors.meta_not_configured",
  "errors.sync_in_progress",
  "errors.base_facts_not_synced",
  "errors.base_facts_syncing",
  "errors.base_facts_ready",
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

export function isMessageKey(value: string): value is MessageKey {
  return (MESSAGE_KEYS as readonly string[]).includes(value);
}

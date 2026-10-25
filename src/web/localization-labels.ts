import { t } from './localization';
import type { MessageKey } from '../shared/localization';
const libraryKeys = {
  "chats": "labels.library.chats",
  "personas": "labels.library.personas",
  "characters": "labels.library.characters",
  "lorebooks": "labels.library.lorebooks",
  "prompts": "labels.library.prompts",
  "connections": "labels.library.connections",
  "contexts": "labels.library.contexts"
} as const satisfies Record<string, MessageKey>;
export function libraryLabel(value: keyof typeof libraryKeys) { return t(libraryKeys[value]); }
const characterFieldKeys = {
  "name": "labels.characterField.name",
  "description": "labels.characterField.description",
  "personality": "labels.characterField.personality",
  "scenario": "labels.characterField.scenario",
  "examples": "labels.characterField.examples"
} as const satisfies Record<string, MessageKey>;
export function characterFieldLabel(value: keyof typeof characterFieldKeys) { return t(characterFieldKeys[value]); }
const cardInstructionKeys = {
  "system_prompt": "labels.cardInstruction.system_prompt",
  "post_history_instructions": "labels.cardInstruction.post_history_instructions"
} as const satisfies Record<string, MessageKey>;
export function cardInstructionLabel(value: keyof typeof cardInstructionKeys) { return t(cardInstructionKeys[value]); }
const markerKeys = {
  "character": "labels.marker.character",
  "persona": "labels.marker.persona",
  "name": "labels.marker.name",
  "description": "labels.marker.description",
  "personality": "labels.marker.personality",
  "scenario": "labels.marker.scenario",
  "examples": "labels.marker.examples",
  "messages": "labels.marker.messages",
  "summary": "labels.marker.summary",
  "card_system_prompt": "labels.marker.card_system_prompt",
  "card_post_history_instructions": "labels.marker.card_post_history_instructions"
} as const satisfies Record<string, MessageKey>;
export function markerLabel(value: keyof typeof markerKeys) { return t(markerKeys[value]); }
const placementKeys = {
  "before_char": "labels.placement.before_char",
  "after_char": "labels.placement.after_char",
  "history": "labels.placement.history",
  "before_desc": "labels.placement.before_desc",
  "after_desc": "labels.placement.after_desc",
  "personality": "labels.placement.personality",
  "scenario": "labels.placement.scenario"
} as const satisfies Record<string, MessageKey>;
export function placementLabel(value: keyof typeof placementKeys) { return t(placementKeys[value]); }
const stateKeys = {
  "running": "labels.state.running",
  "succeeded": "labels.state.succeeded",
  "failed": "labels.state.failed",
  "cancelled": "labels.state.cancelled",
  "interrupted": "labels.state.interrupted",
  "awaiting_review": "labels.state.awaiting_review",
  "saved": "labels.state.saved",
  "candidate": "labels.state.candidate",
  "discarded": "labels.state.discarded",
  "prepare": "labels.state.prepare",
  "step": "labels.state.step",
  "repair": "labels.state.repair",
  "refresh": "labels.state.refresh",
  "admitted": "labels.state.admitted",
  "excluded": "labels.state.excluded",
  "system": "labels.state.system",
  "user": "labels.state.user",
  "assistant": "labels.state.assistant",
  "active": "labels.state.active",
  "retained": "labels.state.retained",
  "no_match": "labels.state.no_match",
  "invalid_regex": "labels.state.invalid_regex",
  "activate": "labels.state.activate",
  "keep_activate_after_match": "labels.state.keep_activate_after_match",
  "constant": "labels.state.constant",
  "keyword": "labels.state.keyword",
  "recursive_keyword": "labels.state.recursive_keyword",
  "secondary_condition": "labels.state.secondary_condition",
  "additional_keys": "labels.state.additional_keys",
  "exclude_keys": "labels.state.exclude_keys",
  "disabled": "labels.state.disabled",
  "probability": "labels.state.probability",
  "sticky": "labels.state.sticky",
  "cooldown": "labels.state.cooldown",
  "delay": "labels.state.delay",
  "pressure": "labels.state.pressure",
  "token_budget": "labels.state.token_budget",
  "unavailable_destination": "labels.state.unavailable_destination",
  "inactive": "labels.state.inactive",
  "fresh": "labels.state.fresh",
  "stale": "labels.state.stale"
} as const satisfies Record<string, MessageKey>;
export function stateLabel(value: keyof typeof stateKeys) { return t(stateKeys[value]); }
const newKeys = {
  "chats": "libraryActions.new.chats",
  "personas": "libraryActions.new.personas",
  "characters": "libraryActions.new.characters",
  "lorebooks": "libraryActions.new.lorebooks",
  "connections": "libraryActions.new.connections",
  "prompts": "libraryActions.new.prompts",
  "contexts": "libraryActions.new.contexts"
} as const satisfies Record<string, MessageKey>;
export function newLibraryLabel(value: keyof typeof newKeys) { return t(newKeys[value]); }
const searchKeys = {
  "chats": "libraryActions.search.chats",
  "personas": "libraryActions.search.personas",
  "characters": "libraryActions.search.characters",
  "lorebooks": "libraryActions.search.lorebooks",
  "connections": "libraryActions.search.connections",
  "prompts": "libraryActions.search.prompts",
  "contexts": "libraryActions.search.contexts"
} as const satisfies Record<string, MessageKey>;
export function searchLibraryLabel(value: keyof typeof searchKeys) { return t(searchKeys[value]); }
const sortKeys = {
  "chats": "libraryActions.sort.chats",
  "personas": "libraryActions.sort.personas",
  "characters": "libraryActions.sort.characters",
  "lorebooks": "libraryActions.sort.lorebooks",
  "connections": "libraryActions.sort.connections",
  "prompts": "libraryActions.sort.prompts",
  "contexts": "libraryActions.sort.contexts"
} as const satisfies Record<string, MessageKey>;
export function sortLibraryLabel(value: keyof typeof sortKeys) { return t(sortKeys[value]); }

const editKeys = {
  "chats": "libraryActions.edit.chats",
  "personas": "libraryActions.edit.personas",
  "characters": "libraryActions.edit.characters",
  "lorebooks": "libraryActions.edit.lorebooks",
  "connections": "libraryActions.edit.connections",
  "prompts": "libraryActions.edit.prompts",
  "contexts": "libraryActions.edit.contexts"
} as const satisfies Record<keyof typeof newKeys, MessageKey>;
export function libraryEditorTitle(value: keyof typeof newKeys, editing: boolean) {
  return editing ? t(editKeys[value]) : newLibraryLabel(value);
}
